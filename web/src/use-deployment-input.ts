import {
  useEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type PointerEvent,
  type RefObject,
} from "react";
import { fieldPoint } from "./battle-geometry";
import type { Frame } from "./battle-field";
import { placementAt, states, type Placement } from "./deployment-preview";
import { boundAction } from "./preferences";
import type { Point } from "./presentation";

export interface DeploymentField {
  ref: RefObject<HTMLDivElement | null>;
  events: HTMLAttributes<HTMLDivElement>;
  slot?: number;
  placement?: Placement;
}
type Press = {
  id: number;
  slot: number;
  version: number;
  hand?: {
    x: number;
    y: number;
    dragged: boolean;
    wasSelected: boolean;
  };
};

export function useDeploymentInput({
  frame,
  me,
  selected,
  skillFor,
  select,
  play,
  blocked,
  canPlay,
}: {
  frame?: Frame;
  me: number;
  selected?: number;
  skillFor: (slot: number) => string | undefined;
  select: (slot?: number) => void;
  play: (slot: number, point: Point) => void;
  blocked: (message: string) => void;
  canPlay: () => boolean;
}) {
  const field = useRef<HTMLDivElement>(null);
  const press = useRef<Press | undefined>(undefined);
  const [pointer, showPointer] = useState<Point>();
  const latest = useRef<Point | undefined>(undefined);

  function aim(point?: Point) {
    const previous = latest.current;
    latest.current = point;
    const half = (frame?.map.tile ?? 1) / 2;
    const [ox, oy] = frame?.map.tileOrigin ?? [0, 0];
    // Both odd and even footprints are stable inside each half tile.
    if (
      point &&
      previous &&
      !frame?.ruinedTowers?.length &&
      Math.floor((point.x - ox) / half) === Math.floor((previous.x - ox) / half) &&
      Math.floor((point.y - oy) / half) === Math.floor((previous.y - oy) / half)
    )
      return;
    showPointer(point);
  }
  function at(e: PointerEvent<HTMLElement>) {
    const el = field.current;
    if (
      !el ||
      !frame ||
      !el.contains(document.elementFromPoint(e.clientX, e.clientY))
    )
      return;
    return fieldPoint(el, frame.map, me, e.clientX, e.clientY);
  }
  function release(slot: number, point: Point) {
    if (!frame || !canPlay()) return;
    const target = placementAt(frame, slot, point, me, skillFor(slot));
    if (!target) return;
    if (target.state !== "legal") blocked(states[target.state].label);
    else play(slot, point);
  }
  function start(
    e: PointerEvent<HTMLElement>,
    slot: number,
    fromHand: boolean,
  ) {
    if (!frame || !e.isPrimary || e.button !== 0 || press.current || !canPlay())
      return;
    press.current = { id: e.pointerId, slot, version: frame.version };
    e.currentTarget.setPointerCapture(e.pointerId);
    if (fromHand) {
      press.current.hand = {
        x: e.clientX,
        y: e.clientY,
        dragged: false,
        wasSelected: selected === slot,
      };
      select(slot);
      aim();
    } else aim(at(e));
  }
  function track(e: PointerEvent<HTMLElement>, current: Press) {
    const hand = current.hand;
    if (hand && !hand.dragged)
      hand.dragged = Math.hypot(e.clientX - hand.x, e.clientY - hand.y) >= 6;
    return !hand || hand.dragged ? at(e) : undefined;
  }
  function move(e: PointerEvent<HTMLElement>) {
    if (!e.isPrimary) return;
    const current = press.current;
    if (current) {
      if (current.id === e.pointerId) aim(track(e, current));
    } else if (e.pointerType === "mouse" && e.currentTarget === field.current)
      aim(at(e));
  }
  function finish(e: PointerEvent<HTMLElement>) {
    const current = press.current;
    if (current?.id !== e.pointerId) return;
    press.current = undefined;
    const point = track(e, current);
    aim(e.pointerType === "mouse" ? point : undefined);
    if (
      current.slot !== selected ||
      current.version !== frame?.version ||
      !canPlay()
    )
      return;
    if (point) release(selected, point);
    else if (current.hand && (current.hand.dragged || current.hand.wasSelected))
      select();
  }
  function cancel(e: PointerEvent<HTMLElement>) {
    const current = press.current;
    if (current?.id !== e.pointerId) return;
    press.current = undefined;
    aim();
    if (current.hand && current.slot === selected) select();
  }

  // A hand rotation, keyboard cancellation or disconnect invalidates the held card.
  useEffect(() => {
    const current = press.current;
    if (
      current &&
      (current.slot !== selected || current.version !== frame?.version)
    ) {
      press.current = undefined;
      aim();
    }
  }, [selected, frame?.version]);

  const captured = {
    onPointerMove: move,
    onPointerUp: finish,
    onPointerCancel: cancel,
    onLostPointerCapture: cancel,
  };
  const board: DeploymentField = {
    ref: field,
    slot: selected,
    placement:
      frame && selected !== undefined && pointer
        ? placementAt(frame, selected, pointer, me, skillFor(selected))
        : undefined,
    events: {
      ...captured,
      tabIndex: selected === undefined ? undefined : 0,
      onPointerDown: (e) => {
        if (selected !== undefined) start(e, selected, false);
      },
      onPointerLeave: () => {
        if (!press.current) aim();
      },
      onBlur: () => {
        if (!press.current) aim();
      },
      onFocus: (e) => {
        if (
          frame &&
          selected !== undefined &&
          e.currentTarget.matches(":focus-visible")
        )
          aim(
            latest.current ?? {
              x: frame.map.width / 2,
              y: frame.map.height * (me ? 0.25 : 0.75),
            },
          );
      },
      onKeyDown: (e) => {
        if (
          selected === undefined ||
          !frame ||
          boundAction(e.code) ||
          press.current
        )
          return;
        const { width, height, tile } = frame.map;
        const point = latest.current ?? {
          x: width / 2,
          y: height * (me ? 0.25 : 0.75),
        };
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (!e.repeat) release(selected, point);
          return;
        }
        const dir = me ? -tile : tile;
        const delta: Record<string, [number, number]> = {
          ArrowLeft: [-dir, 0],
          ArrowRight: [dir, 0],
          ArrowUp: [0, -dir],
          ArrowDown: [0, dir],
        };
        const step = delta[e.key];
        if (step) {
          e.preventDefault();
          aim({
            x: Math.min(width - 1, Math.max(0, point.x + step[0])),
            y: Math.min(height - 1, Math.max(0, point.y + step[1])),
          });
        }
      },
    },
  };
  function hand(slot: number): HTMLAttributes<HTMLButtonElement> {
    return {
      ...captured,
      onPointerDown: (e) => start(e, slot, true),
      onDragStart: (e) => e.preventDefault(),
      onContextMenu: (e) => {
        if (press.current?.hand) e.preventDefault();
      },
      onClick: (e) => {
        // Pointer taps finish under capture. Native keyboard and assistive clicks still toggle.
        if (e.detail === 0 && canPlay())
          select(selected === slot ? undefined : slot);
      },
    };
  }
  return { board, hand };
}
