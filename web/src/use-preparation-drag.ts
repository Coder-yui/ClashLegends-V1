import {
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
} from "react";

export type CardOrigin = { id: string; slot: number | null };
type Destination = number | "pool" | null;
interface CardDrag {
  source: CardOrigin;
  target: Destination;
  width: number;
  height: number;
}
interface Press {
  pointer: number;
  source: CardOrigin;
  button: HTMLButtonElement;
  x: number;
  y: number;
  offsetX: number;
  offsetY: number;
  dragging: boolean;
  hold?: number;
}

export function usePreparationDrag(
  disabled: boolean,
  preset: number,
  empty: number,
  begin: () => void,
  drop: (source: CardOrigin, destination: Exclude<Destination, null>) => void,
) {
  const board = useRef<HTMLDivElement>(null);
  const ghost = useRef<HTMLDivElement>(null);
  const press = useRef<Press | null>(null);
  const suppressClick = useRef(false);
  const [drag, setDrag] = useState<CardDrag | null>(null);

  function cancel() {
    const held = press.current;
    if (!held) return;
    press.current = null;
    clearTimeout(held.hold);
    if (held.button.hasPointerCapture(held.pointer))
      held.button.releasePointerCapture(held.pointer);
    setDrag(null);
  }
  useEffect(() => {
    const el = board.current!;
    function touchMove(e: TouchEvent) {
      if (press.current?.dragging && e.cancelable) e.preventDefault();
    }
    function escape(e: KeyboardEvent) {
      if (e.key === "Escape" && press.current) {
        suppressClick.current = true;
        cancel();
      }
    }
    // A quick swipe in the library scrolls natively. Once picked up, the same
    // finger can carry a card out of that scroll container.
    el.addEventListener("touchmove", touchMove, { passive: false });
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", escape);
    return () => {
      el.removeEventListener("touchmove", touchMove);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", escape);
      cancel();
    };
  }, [disabled, preset]);

  function destination(x: number, y: number, source: CardOrigin): Destination {
    const hit = document.elementFromPoint(x, y);
    if (!hit || !board.current?.contains(hit)) return null;
    const cradle = hit.closest<HTMLElement>("[data-deck-slot]");
    if (cradle) {
      const slot = Number(cradle.dataset.deckSlot);
      return slot === source.slot ? null : slot;
    }
    if (
      source.slot !== null &&
      hit.closest(".prep-pool, .prep-library-heading, .prep-filters")
    )
      return "pool";
    if (
      source.slot === null &&
      empty >= 0 &&
      hit.closest(".prep-loadout") &&
      !hit.closest("input, button")
    )
      return empty;
    return null;
  }
  function lift(held: Press) {
    if (press.current !== held || held.dragging) return;
    held.dragging = true;
    suppressClick.current = true;
    begin();
    const box = held.button.getBoundingClientRect();
    setDrag({
      source: held.source,
      target: null,
      width: box.width,
      height: box.height,
    });
  }
  function down(e: PointerEvent<HTMLDivElement>) {
    if (press.current || !e.isPrimary || e.button !== 0) return;
    suppressClick.current = false;
    if (disabled) return;
    const button = (e.target as Element).closest<HTMLButtonElement>(
      "button.prep-card[data-card]",
    );
    if (!button?.dataset.card) return;
    const index =
      button.closest<HTMLElement>("[data-deck-slot]")?.dataset.deckSlot;
    const source = {
      id: button.dataset.card,
      slot: index === undefined ? null : Number(index),
    };
    const box = button.getBoundingClientRect();
    const held: Press = {
      pointer: e.pointerId,
      source,
      button,
      x: e.clientX,
      y: e.clientY,
      offsetX: e.clientX - box.left,
      offsetY: e.clientY - box.top,
      dragging: false,
    };
    press.current = held;
    button.setPointerCapture(e.pointerId);
    if (e.pointerType === "touch" && source.slot === null)
      held.hold = window.setTimeout(() => lift(held), 240);
  }
  function move(e: PointerEvent<HTMLDivElement>) {
    const held = press.current;
    if (!held || held.pointer !== e.pointerId) return;
    if (!held.dragging) {
      if (Math.hypot(e.clientX - held.x, e.clientY - held.y) < 6) return;
      if (held.hold !== undefined) {
        suppressClick.current = true;
        cancel();
        return;
      }
      lift(held);
    }
    held.x = e.clientX;
    held.y = e.clientY;
    if (ghost.current) ghost.current.style.transform = transform(held);
    const target = destination(held.x, held.y, held.source);
    setDrag((prev) =>
      prev && prev.target !== target ? { ...prev, target } : prev,
    );
  }
  function transform(held: Press) {
    return `translate3d(${held.x - held.offsetX}px,${held.y - held.offsetY}px,0)`;
  }
  function finish(e: PointerEvent<HTMLDivElement>) {
    const held = press.current;
    if (!held || held.pointer !== e.pointerId) return;
    const target = held.dragging
      ? destination(e.clientX, e.clientY, held.source)
      : null;
    cancel();
    if (target !== null && !disabled) drop(held.source, target);
  }
  function interrupted(e: PointerEvent<HTMLDivElement>) {
    if (press.current?.pointer === e.pointerId) cancel();
  }
  return {
    drag,
    ghost,
    ghostStyle:
      drag && press.current
        ? {
            width: drag.width,
            height: drag.height,
            transform: transform(press.current),
          }
        : undefined,
    boardProps: {
      ref: board,
      onPointerDown: down,
      onPointerMove: move,
      onPointerUp: finish,
      onPointerCancel: interrupted,
      onLostPointerCapture: interrupted,
      onDragStart: (e: React.DragEvent) => {
        if (press.current) e.preventDefault();
      },
      onContextMenu: (e: MouseEvent) => {
        if (press.current) e.preventDefault();
      },
      onClickCapture: (e: MouseEvent) => {
        if (suppressClick.current && e.detail !== 0) {
          e.preventDefault();
          e.stopPropagation();
          suppressClick.current = false;
        }
      },
    },
  };
}
