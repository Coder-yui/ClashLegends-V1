import { useLayoutEffect, useRef } from "react";
import type { Result } from "./api";

import type { BattleEvent, EventWindow, Point } from "./presentation";
import { drawHealthBar } from "./health-bars";
import { BattleClock } from "./battle-clock";
import type { ModelResources, BattleModels } from "./battle-models";
export interface Unit {
  dormant?: boolean;
  readyTick?: number;
  deployStart?: number;
  alternateForm?: boolean;
  visual?: {
    action?: [string, number, number];
    empowered?: boolean;
    buff?: boolean;
    immune?: boolean;
    charge?: boolean;
    terrain?: boolean;
    full?: boolean;
    reload?: boolean;
    strong?: boolean;
    big?: boolean;
    castResource?: number;
    formStart?: number;
    formTicks?: number;
    activeForm?: boolean;
  };
  attack: {
    start: number;
    release: number;
    end: number;
    cycle: number;
    released: boolean;
    empowered?: boolean;
    close?: boolean;
    structureTarget?: boolean;
  } | null;
  castStart: number;
  impactTick: number;
  movementRate: number;
  facing: Point;
  target: number | null;
  activity: string;
  actionSerial: number;
  since: number;
  controls: string[];
  castEnd: number;
  equippedSkill?: string | null;
  skill: string | null;
  id: number;
  kind: string;
  name?: string;
  structure?: boolean;
  shield?: number;
  bar?: {
    shieldCapacity: number;
    bleedStacks: number;
    untargetable: boolean;
    wounds: boolean;
    forged: boolean;
    resource: [number, number] | null;
    rounds: number | null;
    recoveryTicks: number;
  } | null;
  hidden?: boolean;
  team: number;
  x: number;
  y: number;
  radius: number;
  hp: number;
  maxHp: number;
  frozen: boolean;
}
export interface Frame {
  tick: number;
  started: boolean;
  remaining: number;
  overtime: boolean;
  units: Unit[];
  protocol: typeof import("./presentation").BATTLE_PROTOCOL;
  map: {
    id: string;
    width: number;
    height: number;
    tile: number;
    terrain: string | null;
    projection: number;
    backMargin: number;
    backdropWidth: number;
    obstacles: number[][];
  };
  ruinedTowers?: { id: number; team: number; x: number; y: number }[];
  deployment: { x: number; y: number; width: number; height: number }[][];
  presentation: EventWindow;
  baseline?: number;
  cues?: BattleEvent[];
  shots: {
    born: number;
    sourceKind: string;
    id: number;
    owner: number;
    target: number;
    team: number;
    position: Point;
    origin: Point;
  }[];
  areas: {
    id: number;
    position: Point;
    direction: Point;
    shape: Record<
      string,
      {
        radius?: number;
        outer?: number;
        length?: number;
        half_width?: number;
        inner?: number;
        half_angle?: number;
      }
    >;
  }[];
  spells: {
    id: number;
    key: string;
    position: Point;
    impact: number;
    end: number;
  }[];
  pending: [number, number, number | null][];
  hand: string[];
  lastCard: string | null;
  activeCards: (string | null)[];
  costs: number[];
  next: string;
  nextCost?: number;
  active: ({ caster: number; uses: number } | null)[];
  activeWait: number[];
  buttons?: ({
    locked: boolean;
    cooldownLeft: number;
    cooldownTotal: number;
    freeRecast: boolean;
  } | null)[];
  activeCost: number[];
  skillResource?: ([number, number, boolean] | null)[];
  version: number;
  gold: number;
  ack: number;
  result: Result | null;
}

const colors = ["#6cbfff", "#ff9588"];
const glyphs: Record<string, string> = {
  anivia_egg: "蛋",
  anivia: "凰",
  scuttle_crab: "蟹",
  aurelionsol: "龙",
  imp: "鬼",
};

function draw(
  ctx: CanvasRenderingContext2D,
  frame: Frame,
  me: number,
  tick: number,
  selection?: number,
  models?: BattleModels,
  focusId?: number,
) {
  const { width, height, tile } = frame.map;
  const x = (v: number) => (me ? width - v : v);
  const y = (v: number) => (me ? height - v : v);
  function rect(
    left: number,
    top: number,
    w: number,
    h: number,
    color: string,
  ) {
    ctx.fillStyle = color;
    ctx.fillRect(left, top, w, h);
  }
  ctx.clearRect(0, 0, width, height);
  if (!frame.map.terrain)
    for (const [x0, y0, x1, y1] of frame.map.obstacles) {
      rect(
        Math.min(x(x0), x(x1)),
        Math.min(y(y0), y(y1)),
        x1 - x0,
        y1 - y0,
        "#44647a",
      );
    }
  if (selection !== undefined) {
    for (const r of frame.deployment[selection]) {
      const left = r.x * tile,
        top = r.y * tile,
        w = r.width * tile,
        h = r.height * tile;
      rect(
        Math.min(x(left), x(left + w)),
        Math.min(y(top), y(top + h)),
        w,
        h,
        "rgba(102,179,255,.15)",
      );
    }
    for (let i = 0; i <= width; i += tile)
      rect(i, 0, 1, height, "rgba(255,255,255,.14)");
    for (let i = 0; i <= height; i += tile)
      rect(0, i, width, 1, "rgba(255,255,255,.14)");
  }
  for (const area of frame.areas) {
    const [kind, s] = Object.entries(area.shape)[0];
    ctx.save();
    ctx.translate(x(area.position.x), y(area.position.y));
    ctx.rotate(
      Math.atan2(area.direction.y, area.direction.x) + (me ? Math.PI : 0),
    );
    ctx.strokeStyle = "#9ed5ef";
    ctx.beginPath();
    if (kind === "Strip")
      ctx.rect(0, -s.half_width!, s.length!, s.half_width! * 2);
    else if (kind === "Fan") {
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, s.radius!, -s.half_angle!, s.half_angle!);
      ctx.closePath();
    } else {
      ctx.arc(0, 0, s.outer ?? s.radius ?? 0, 0, 2 * Math.PI);
      if (s.inner) {
        ctx.moveTo(s.inner, 0);
        ctx.arc(0, 0, s.inner, 0, 2 * Math.PI);
      }
    }
    ctx.stroke();
    ctx.restore();
  }
  for (const spell of frame.spells) {
    ctx.strokeStyle = "#f6df99";
    ctx.strokeRect(x(spell.position.x) - 8, y(spell.position.y) - 8, 16, 16);
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const u of frame.units) {
    const cx = x(u.x),
      cy = y(u.y),
      r = u.radius;
    ctx.globalAlpha = u.hidden ? 0.46 : 1;
    const color = colors[u.team === me ? 0 : 1];
    if (focusId === u.id) {
      ctx.beginPath();
      ctx.ellipse(cx, cy, r + 6, r + 4, 0, 0, 2 * Math.PI);
      ctx.strokeStyle = "#ffe189";
      ctx.lineWidth = 3;
      ctx.stroke();
    }
    if (!models?.bars.has(u.id)) {
      ctx.fillStyle = u.frozen ? "#c6f4ff" : color;
      ctx.beginPath();
      if (u.structure) ctx.rect(cx - r, cy - r, 2 * r, 2 * r);
      else ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      const cue = frame.cues?.some(({ fact, tick: eventTick }) => {
        if (eventTick + 5 < frame.tick) return false;
        if (fact.kind === "attackStarted" || fact.kind === "fired")
          return Array.isArray(fact.data) && fact.data[0] === u.id;
        if (fact.kind === "formChanged" || fact.kind === "damage") {
          const data = fact.data as { id?: number; target?: number };
          return (data.id ?? data.target) === u.id;
        }
        return false;
      });
      ctx.lineWidth = 2;
      ctx.strokeStyle = cue
        ? "#fff3b0"
        : u.castEnd > frame.tick
          ? "#c2a4ff"
          : "#132628";
      ctx.stroke();
      ctx.fillStyle = "#172728";
      ctx.font = "bold " + Math.max(16, Math.round(r * 1.05)) + "px sans-serif";
      const label = glyphs[u.kind] ?? u.name ?? u.kind;
      ctx.fillText(label, cx, cy + 1, Math.max(32, r * 2.8));
    }
  }
  ctx.globalAlpha = 1;
  for (const shot of frame.shots) {
    const { id, team, position, origin } = shot;
    const hand = models?.launches.get(id);
    const color = colors[team === me ? 0 : 1];
    if (!models || shot.sourceKind !== "ashe") {
      const t = hand ? Math.min(1, Math.max(0, (tick - hand.tick) / 2)) : 1;
      const px = (hand?.x ?? 0) * (1 - t) + x(position.x) * t;
      const py = (hand?.y ?? 0) * (1 - t) + y(position.y) * t;
      rect(px - 3, py - 3, 6, 6, color);
      continue;
    }
    // The diagnostic arrow blends from the sampled hand to the server path.
    // A reconnect uses the in-flight snapshot without replaying a launch.
    const lift =
      (22 * Math.sqrt(1 - frame.map.projection ** 2)) / frame.map.projection;
    const t = hand ? Math.min(1, Math.max(0, (tick - hand.tick) / 2)) : 1;
    const px = (hand?.x ?? 0) * (1 - t) + x(position.x) * t;
    const py = (hand?.y ?? 0) * (1 - t) + (y(position.y) - lift) * t;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(
      Math.atan2(y(position.y) - y(origin.y), x(position.x) - x(origin.x)),
    );
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-9, 0);
    ctx.lineTo(0, 0);
    ctx.lineTo(-3, -2);
    ctx.moveTo(0, 0);
    ctx.lineTo(-3, 2);
    ctx.stroke();
    ctx.restore();
  }
  for (const u of frame.units) {
    drawHealthBar(
      ctx,
      u,
      u.team === me,
      x(u.x),
      y(u.y),
      frame.map.projection,
      models?.bars.get(u.id),
      tick,
    );
  }
}

export function Battlefield({
  frame,
  me,
  selection,
  focusId,
  playback = 1,
  diagnostics = false,
  resources,
  play,
}: {
  frame: Frame;
  me: number;
  selection?: number;
  focusId?: number;
  playback?: number;
  diagnostics?: boolean;
  resources?: ModelResources;
  play: (x: number, y: number) => void;
}) {
  const { width, height } = frame.map;
  const canvas = useRef<HTMLCanvasElement>(null);
  const layer = useRef<HTMLCanvasElement>(null);
  const current = useRef({ frame, selection, focusId, playback });
  useLayoutEffect(() => {
    current.current = { frame, selection, focusId, playback };
  }, [frame, selection, focusId, playback]);
  useLayoutEffect(() => {
    const surface = canvas.current!,
      gl = layer.current!;
    const ctx = surface.getContext("2d");
    if (!ctx) return;
    const params = new URLSearchParams(location.search);
    const trace = params.has("animationTrace");
    const collect = diagnostics || trace || params.has("battleMetrics");
    let models: BattleModels | undefined;
    let disposed = false,
      raf = 0,
      previous: Frame | undefined;
    let clock = new BattleClock();
    let endedAt = 0;
    function load() {
      if (params.get("battleView") === "debug") return;
      void import("./battle-models")
        .then(({ BattleModels }) => {
          if (!disposed && !models) {
            models = new BattleModels(gl, me, collect, resources);
            models.reset(current.current.frame.presentation.cursor);
          }
        })
        .catch((error) => console.warn("战场使用几何视图", error));
    }
    function lost(e: Event) {
      e.preventDefault();
      models?.dispose();
      models = undefined;
    }
    function resume() {
      previous = undefined;
      clock = new BattleClock();
      models?.reset();
    }
    document.addEventListener("visibilitychange", resume);
    gl.addEventListener("webglcontextlost", lost);
    gl.addEventListener("webglcontextrestored", load);
    load();
    function paint(now: number) {
      const { frame, selection, focusId, playback } = current.current;
      const start = collect ? performance.now() : 0;
      if (frame !== previous) {
        if (clock.push(frame, now)) models?.reset(frame.presentation.cursor);
        if (frame.result && !previous?.result) endedAt = now;
        previous = frame;
      }
      const { frame: shown, tick } =
        playback === 0
          ? { frame, tick: frame.tick }
          : clock.sample(now, playback);
      // The last authority tick is final. Let the destruction clip finish locally.
      const visualTick =
        shown.result && playback > 0
          ? tick + Math.min(160, (now - endedAt) / 50)
          : tick;
      models?.render(shown, tick, visualTick);
      draw(ctx!, shown, me, tick, selection, models, focusId);
      if (collect)
        surface.dispatchEvent(
          new CustomEvent("battle-render", {
            detail: {
              tick,
              ms: performance.now() - start,
              ...models?.metrics,
              action: models?.playing(focusId),
              actions: trace ? models?.traceActions() : undefined,
            },
          }),
        );
      raf = requestAnimationFrame(paint);
    }
    raf = requestAnimationFrame(paint);
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", resume);
      gl.removeEventListener("webglcontextlost", lost);
      gl.removeEventListener("webglcontextrestored", load);
      models?.dispose();
    };
  }, [me, diagnostics, resources]);
  return (
    <>
      <canvas ref={layer} className="battle-models" aria-hidden="true" />
      <canvas
        ref={canvas}
        width={width}
        height={height}
        aria-label="对战战场"
        data-tick={frame.tick}
        onClick={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          play(
            ((me ? box.right - e.clientX : e.clientX - box.left) * width) /
              box.width,
            ((me ? box.bottom - e.clientY : e.clientY - box.top) * height) /
              box.height,
          );
        }}
      />
    </>
  );
}
