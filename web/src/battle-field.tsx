import { drawPlacement, states } from "./deployment-preview";
import type { DeploymentField } from "./use-deployment-input";
import { fieldMargin, fieldPoint } from "./battle-geometry";
import type { CaptureFrame } from "./video-recording";
import { drawSummonFlight, type SummonFlight } from "./summon-flight";
import { useLayoutEffect, useRef, type CSSProperties } from "react";
import type { Result } from "./api";

import type {
  BattleEvent,
  BattleSound,
  EventWindow,
  Point,
} from "./presentation";
import { drawHealthBar } from "./health-bars";
import { BattleAudio } from "./battle-audio";
import { BattleClock } from "./battle-clock";
import type { ParticleQuality } from "./native-particles";
import type { ModelResources, BattleModels } from "./battle-models";
export interface Unit {
  dormant?: boolean;
  readyTick?: number;
  deployStart?: number;
  alternateForm?: boolean;
  visual?: {
    action?: [string, number, number];
    firstReady?: boolean;
    rewindReady?: boolean;
    rewindPosition?:Point;
    regenerationUntil?: number;
    lifestealStart?: number;
    sandWardUntil?: number;
    fieldUntil?: number;
    slowFieldRadius?: number;
    empowered?: boolean;
    buff?: boolean;
    auraStart?: number;
    sanctuary?: [Point, number, number];
    sunlightUntil?: number;
    burningAura?: boolean;
    poolShield?: boolean;
    explosiveShield?: boolean;
    deploymentShield?: boolean;
    drainTargets?: number[];
    moveSlow?: boolean;
    attackSlow?: boolean;
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
    segment?: number;
    released: boolean;
    empowered?: boolean;
    close?: boolean;
    structureTarget?: boolean;
    first?: boolean;
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
  audioKind?: string;
  name?: string;
  structure?: boolean;
  footprint?: number;
  air?: boolean;
  inFlight?: boolean;
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
export interface EffectPath {
  owner: number;
  team: "Blue" | "Red";
  kind: "pantheon" | "reksai" | "sacrifice" | "hook";
  target?: number | null;
  path: Point[];
  start: number;
  impact: number;
  end: number;
}
export interface Frame {
  effectPaths?: EffectPath[];
  tick: number;
  started: boolean;
  remaining: number;
  overtime: boolean;
  units: Unit[];
  protocol: typeof import("./presentation").BATTLE_PROTOCOL;
  summons?: SummonFlight[];
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
    bounce?: number;
    cycle?: number;
    form?: boolean;
    volley?: boolean;
    empowered?: boolean;
    group?: number | null;
    direction?: Point | null;
    action?: string;
    id: number;
    owner: number;
    target: number;
    team: number;
    position: Point;
    origin: Point;
  }[];
  waves?: {
    caster: number;
    team: string;
    start: number;
    origin: Point;
    direction: Point;
    travel: number;
    length: number;
    width: number;
  }[];
  areas: {
    team?: "Blue" | "Red";
    caster?: number;
    effect?: string;
    born?: number;
    source_kind?: string;
    phase?: string;
    enhanced?: boolean;
    next_tick?: number;
    audio?: [
      { kind: string; form: boolean; team: "Blue" | "Red" },
      string,
      number,
    ];
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
  soundLayers?: (BattleSound & { loop: boolean })[];
  spells: {
    team: number;
    origin: Point;
    born: number;
    id: number;
    key: string;
    position: Point;
    impact: number;
    end: number;
    radius?: number;
    enhanced?: boolean;
    range?: number;
    waveWidth?: number;
    speed?: number;
  }[];
  pending: [number, number, number | null][];
  hand: string[];
  handForms?: (string | null)[];
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
  regions?: Frame["deployment"][number],
  models?: BattleModels,
  focusId?: number,
  geometry = false,
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
  ctx.clearRect(
    -fieldMargin,
    -fieldMargin,
    width + 2 * fieldMargin,
    height + 2 * fieldMargin,
  );
  if (!frame.map.terrain && !models)
    for (const [x0, y0, x1, y1] of frame.map.obstacles) {
      rect(
        Math.min(x(x0), x(x1)),
        Math.min(y(y0), y(y1)),
        x1 - x0,
        y1 - y0,
        "#44647a",
      );
    }
  if (regions) {
    for (const r of regions) {
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
    if (!geometry && models?.effects.areas.has(area.id)) continue;
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
    if (
      !geometry ||
      (spell.key === "medium_lightning" &&
        spell.team !== me &&
        tick < spell.impact - 20)
    )
      continue;
    ctx.strokeStyle = "#f6df99";
    const sx = x(spell.position.x),
      sy = y(spell.position.y);
    if (spell.range && spell.waveWidth) {
      const forward = spell.team === me ? -1 : 1;
      ctx.strokeRect(
        sx - spell.waveWidth / 2,
        sy,
        spell.waveWidth,
        forward * spell.range,
      );
      if (spell.speed && tick >= spell.impact) {
        const travel = Math.min(
          spell.range,
          ((tick - spell.impact) * spell.speed) / 20,
        );
        ctx.fillStyle = ctx.strokeStyle;
        ctx.fillRect(
          sx - spell.waveWidth / 2,
          sy + forward * travel,
          spell.waveWidth,
          2,
        );
      }
    } else if (spell.radius) {
      ctx.beginPath();
      ctx.arc(sx, sy, spell.radius, 0, 2 * Math.PI);
      ctx.stroke();
    }
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const u of frame.units) {
    if((u.deployStart??0)>tick)continue;
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
  for (const flight of frame.summons ?? []) {
    drawSummonFlight(ctx, flight, tick, frame.map.projection, x, y);
  }
  for (const shot of frame.shots) {
    if (!geometry && models?.effects.shots.has(shot.id)) continue;
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
    if((u.deployStart??0)>tick)continue;
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
  deployment,
  focusId,
  playback = 1,
  diagnostics = false,
  effectQuality,
  geometry = false,
  connected = true,
  deck,
  resources,
  onPrepared,
  onPaint,
  cinema = false,
  play,
}: {
  frame: Frame;
  me: number;
  deployment?: DeploymentField;
  focusId?: number;
  playback?: number;
  diagnostics?: boolean;
  effectQuality?: ParticleQuality;
  geometry?: boolean;
  connected?: boolean;
  deck?: readonly string[];
  resources?: ModelResources;
  onPrepared?: () => void;
  onPaint?: CaptureFrame;
  cinema?: boolean;
  play?: (x: number, y: number) => void;
}) {
  const { width, height } = frame.map;
  const canvas = useRef<HTMLCanvasElement>(null);
  const layer = useRef<HTMLCanvasElement>(null);
  const selection = deployment?.slot;
  const placement = deployment?.placement;
  const shot = useRef({ cinema, onPaint });
  useLayoutEffect(() => {
    shot.current = { cinema, onPaint };
  }, [cinema, onPaint]);
  const current = useRef({
    frame,
    selection,
    placement,
    focusId,
    geometry,
    effectQuality,
    playback,
    connected,
    deck,
  });
  useLayoutEffect(() => {
    current.current = {
      frame,
      selection,
      placement,
      focusId,
      playback,
      connected,
      deck,
      geometry,
      effectQuality,
    };
  }, [
    frame,
    selection,
    placement,
    focusId,
    playback,
    connected,
    deck,
    geometry,
    effectQuality,
  ]);
  useLayoutEffect(() => {
    const surface = canvas.current!,
      gl = layer.current!;
    const ctx = surface.getContext("2d");
    if (!ctx) return;
    const params = new URLSearchParams(location.search);
    const trace = params.has("animationTrace");
    const collect = diagnostics || trace || params.has("battleMetrics");
    const audio = new BattleAudio(
      me,
      collect
        ? (detail) =>
            surface.dispatchEvent(new CustomEvent("battle-audio", { detail }))
        : undefined,
    );
    let models: BattleModels | undefined;
    let disposed = false,
      raf = 0,
      previous: Frame | undefined;
    let clock = new BattleClock();
    let endedAt = 0;
    let rendererReady = params.get("battleView") === "debug";
    let notifyPrepared = onPrepared;
    function load() {
      if (params.get("battleView") === "debug") return;
      void import("./battle-models")
        .then(({ BattleModels }) => {
          if (!disposed && !models) {
            models = new BattleModels(gl, me, collect, resources);
            models.reset(current.current.frame.presentation.cursor);
            models.effects.prepare(current.current.frame, current.current.deck);
          }
        })
        .catch((error) => console.warn("战场使用几何视图", error))
        .finally(() => {
          rendererReady = true;
        });
    }
    function lost(e: Event) {
      e.preventDefault();
      models?.dispose();
      models = undefined;
    }
    function resume() {
      previous = undefined;
      audio.reset(current.current.frame.presentation.cursor);
      clock = new BattleClock();
      models?.reset();
    }
    document.addEventListener("visibilitychange", resume);
    gl.addEventListener("webglcontextlost", lost);
    gl.addEventListener("webglcontextrestored", load);
    load();
    function paint(now: number) {
      const {
        frame,
        selection,
        placement,
        focusId,
        playback,
        connected,
        deck,
        geometry,
        effectQuality,
      } = current.current;
      const start = collect ? performance.now() : 0;
      if (models && effectQuality) models.effects.quality = effectQuality;
      if (frame !== previous) {
        audio.prepare(frame, deck);
        models?.effects.prepare(frame, deck);
        if (clock.push(frame, now)) {
          models?.reset(frame.presentation.cursor);
          audio.reset(frame.presentation.cursor);
        }
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
      const free = !!models && shot.current.cinema;
      models?.render(shown, tick, visualTick, free, placement);
      audio.render(shown, tick, playback, connected, frame.presentation.cursor);
      if (!free) {
        ctx!.setTransform(1, 0, 0, 1, fieldMargin, fieldMargin);
        draw(
          ctx!,
          shown,
          me,
          tick,
          selection === undefined ? undefined : frame.deployment[selection],
          models,
          focusId,
          geometry,
        );
        if (placement) drawPlacement(ctx!, placement, frame, me);
      }
      surface.style.visibility = free ? "hidden" : "";
      shot.current.onPaint?.(shown, gl, surface, free);
      if (
        notifyPrepared &&
        rendererReady &&
        !models?.preparingTerrain &&
        (frame.started || (!audio.preparing && !models?.effects.preparing))
      ) {
        notifyPrepared();
        notifyPrepared = undefined;
      }
      if (collect)
        surface.dispatchEvent(
          new CustomEvent("battle-render", {
            detail: {
              tick,
              ms: performance.now() - start,
              ...models?.metrics,
              vfx: models?.effects.metrics,
              effects: trace ? models?.effects.trace() : undefined,
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
      audio.dispose();
      document.removeEventListener("visibilitychange", resume);
      gl.removeEventListener("webglcontextlost", lost);
      gl.removeEventListener("webglcontextrestored", load);
      models?.dispose();
    };
  }, [me, diagnostics, resources, onPrepared]);
  return (
    <div
      className={"battle-input" + (cinema ? " cinema" : "")}
      style={{ "--field-margin": fieldMargin } as CSSProperties}
      aria-label="对战战场"
      data-tick={frame.tick}
      data-aiming={selection !== undefined || undefined}
      ref={deployment?.ref}
      {...deployment?.events}
      onClick={
        play &&
        ((e) => {
          const point = fieldPoint(
            e.currentTarget,
            frame.map,
            me,
            e.clientX,
            e.clientY,
          );
          if (point) play(point.x, point.y);
        })
      }
    >
      {placement && (
        <span
          className="placement-state"
          data-state={placement.state}
          style={{ color: states[placement.state].color }}
          role="status"
        >
          {placement.spell && placement.state === "legal"
            ? "可以施放"
            : states[placement.state].label}
        </span>
      )}
      <canvas ref={layer} className="battle-models" aria-hidden="true" />
      <canvas
        ref={canvas}
        className="battle-overlay"
        aria-hidden="true"
        width={width + 2 * fieldMargin}
        height={height + 2 * fieldMargin}
      />
    </div>
  );
}
