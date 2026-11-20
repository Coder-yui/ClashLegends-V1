import type { Frame, Unit } from "./battle-field";

const tickMs = 50;

// Discrete state belongs to the older snapshot until the next authoritative tick.
// The renderer can interpolate ground coordinates, never combat results.
export class BattleClock {
  private frames: Frame[] = [];
  private received = 0;
  private shown = 0;
  push(frame: Frame, now: number) {
    const last = this.frames.at(-1);
    const baseline =
      !last ||
      frame.baseline !== last.baseline ||
      frame.tick < last.tick;
    if (baseline || frame.tick - last.tick > 12) {
      this.frames = [];
      this.shown = frame.tick;
    }
    if (!last || baseline || frame.tick > last.tick) {
      this.frames.push(frame);
      if (this.frames.length > 16) this.frames.shift();
      this.received = now;
    } else if (frame.tick === last.tick)
      this.frames[this.frames.length - 1] = frame;
    return baseline;
  }
  sample(now: number, rate = 1) {
    const latest = this.frames.at(-1)!;
    const target = latest.tick - 2 + ((now - this.received) * rate) / tickMs;
    const tick = Math.min(
      latest.tick,
      Math.max(this.shown, target, this.frames[0].tick),
    );
    this.shown = tick;
    while (this.frames.length > 1 && this.frames[1].tick <= tick)
      this.frames.shift();
    const [a, b] = this.frames;
    if (!b || tick <= a.tick) return { frame: a, tick };
    const fraction = (tick - a.tick) / (b.tick - a.tick);
    const units = new Map(b.units.map((u) => [u.id, u]));
    const waves = new Map(b.waves?.map((w) => [w.caster + "/" + w.start, w]));
    const shots = new Map(b.shots.map((p) => [p.id, p]));
    const lerp = (x: number, y: number) => x + (y - x) * fraction;
    const blinked = new Set(
      (b.cues ?? [])
        .filter(
          (e) =>
            e.tick > a.tick &&
            e.fact.kind === "blinked" &&
            Array.isArray(e.fact.data),
        )
        .map((e) => (e.fact.data as number[])[0]),
    );
    const interpolate = (u: Unit) => {
      const v = units.get(u.id);
      if (!v || u.kind !== v.kind || blinked.has(u.id)) return u;
      const yaw = Math.atan2(u.facing.x, u.facing.y);
      const angle = Math.atan2(v.facing.x, v.facing.y) - yaw;
      const turn =
        yaw + Math.atan2(Math.sin(angle), Math.cos(angle)) * fraction;
      return {
        ...u,
        x: lerp(u.x, v.x),
        y: lerp(u.y, v.y),
        facing: { x: Math.sin(turn), y: Math.cos(turn) },
      };
    };
    return {
      tick,
      frame: {
        ...a,
        units: a.units.map(interpolate),
        waves: a.waves?.map((w) => {
          const next = waves.get(w.caster + "/" + w.start);
          return next
            ? {
                ...w,
                travel: lerp(w.travel, next.travel),
                width: lerp(w.width, next.width),
              }
            : w;
        }),
        shots: a.shots.map((p) => {
          const q = shots.get(p.id);
          return q
            ? {
                ...p,
                position: {
                  x: lerp(p.position.x, q.position.x),
                  y: lerp(p.position.y, q.position.y),
                },
              }
            : p;
        }),
      },
    };
  }
}
