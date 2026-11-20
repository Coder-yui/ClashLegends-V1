import { Group, Quaternion, Vector3, type Mesh } from "three";
import type { Frame, Unit } from "./battle-field";
import type { BattleEvent, Point } from "./presentation";
import {
  ambientEffects,
  channelSystems,
  phaseEffects,
  controlEffects,
  impacts,
  buffEffects,
  castEffects,
  deathEffects,
  missile,
  missiles,
  spawnEffects,
  spellLayers,
  type Spell,
} from "./effect-bindings";
import {
  ParticleActor,
  ParticleLibrary,
  ParticleBackdrop,
  missileOrientation,
  systems,
  type ParticleQuality,
  type Track,
} from "./native-particles";

const empty = new Set<string>();
const up = new Vector3(0, 1, 0);
const zForwardShots = new Set([
  "ziggs",
  "voidfish_ranged",
  "voidfish_ranged_single",
  "kayle",
  "kayle_ranged",
]);
const baseHeight: Record<string, number> = {
  ashe: 45,
  sona: 70,
  anivia: 62,
  ivern: 80,
  tristana: 30,
  jayce: 38,
  graves: 48,
  kayle_ranged: 80,
  ziggs: 28,
  thorn_spitter: 50,
};
const areaEffects: Record<string, string> = {
  frost_storm: "anivia/storm",
  corrosion: "corrosion/area",
  lightning_field: "jayce/field",
};
export interface Launch {
  tick: number;
  x: number;
  y: number;
  world: Vector3;
}
interface Instance {
  name: string;
  start: number;
  scale: number;
  position: Vector3;
  rotation: Quaternion;
  muzzle?: Vector3;
  actor?: ParticleActor;
  owner?: number;
  beamLength?: number;
  seen: boolean;
  persistent: boolean;
  moving: boolean;
  cutoff?: number;
  shot?: boolean;
}
interface SpellEvent extends Omit<Spell, "team" | "born"> {
  team: "Blue" | "Red";
}
export class BattleEffects {
  readonly root = new Group();
  readonly library = new ParticleLibrary();
  readonly backdrop = new ParticleBackdrop(this.library);
  needsBackdrop = false;
  readonly shots = new Set<number>();
  readonly spells = new Set<number>();
  readonly areas = new Set<number>();
  readonly metrics = { instances: 0, particles: 0 };
  quality: ParticleQuality = "high";
  private instances = new Map<string, Instance>();
  private tracks = new Map<string, Track>();
  private lastUse = new Map<string, number>();
  private nextTrim = 0;
  private waiting = new Map<string, number>();
  private spellHistory = new Map<number, Spell>();
  private lastUnits = new Map<number, Unit>();
  private cursor = 0;
  private disposed = false;
  private point = new Vector3();
  private orientation = new Quaternion();
  constructor(private seat: number) {}
  private warm(name?: string) {
    if (name) this.lastUse.set(name, performance.now());
    if (
      !name ||
      !systems[name] ||
      this.tracks.has(name) ||
      (this.waiting.get(name) ?? 0) > performance.now()
    )
      return;
    this.waiting.set(name, Infinity);
    void this.library
      .load(name)
      .then((track) => {
        if (!this.disposed) {
          this.tracks.set(name, track);
          this.waiting.delete(name);
        }
      })
      .catch((error) => {
        if (!this.disposed) {
          this.waiting.set(name, performance.now() + 10000);
          console.warn("特效资源载入失败", name, error);
        }
      });
  }
  private place(
    key: string,
    name: string,
    start: number,
    scale: number,
    point: Point,
    direction: Point,
    frame: Frame,
    height = 0,
    persistent = false,
    moving = false,
    forwardY = false,
  ) {
    if (!systems[name] || scale <= 0) return;
    this.warm(name);
    const sign = this.seat ? -1 : 1;
    this.point.set(
      (point.x - frame.map.width / 2) * sign,
      height,
      (point.y - frame.map.height / 2) * sign,
    );
    this.orientation.setFromAxisAngle(
      up,
      Math.atan2(direction.x * sign, direction.y * sign),
    );
    if (forwardY) this.orientation.multiply(missileOrientation);
    let item = this.instances.get(key);
    if (!item || item.name !== name || item.start !== start) {
      item?.actor?.dispose();
      item = {
        name,
        start,
        scale,
        position: this.point.clone(),
        rotation: this.orientation.clone(),
        seen: true,
        persistent,
        moving,
      };
      this.instances.set(key, item);
    } else {
      item.position.copy(this.point);
      item.rotation.copy(this.orientation);
      item.scale = scale;
      item.seen = true;
    }
    return item;
  }
  private facing(team: number) {
    return { x: 0, y: team ? 1 : -1 };
  }
  private cues(event: BattleEvent, frame: Frame, units: Map<number, Unit>) {
    const { kind, data } = event.fact;
    const actor = (id: number) => units.get(id) ?? this.lastUnits.get(id);
    if (kind === "spellPlayed") {
      const d = data as SpellEvent;
      this.spellHistory.set(d.id, {
        ...d,
        born: event.tick,
        team: d.team === "Blue" ? 0 : 1,
      });
    } else if (kind === "projectileHit") {
      const d = data as {
        source_kind: string;
        projectile: number;
        target: number;
        position: Point;
      };
      const sys = impacts[d.source_kind],
        target = actor(d.target);
      if (sys && d.position)
        this.place(
          "hit/" + event.seq,
          sys,
          event.tick,
          0.4,
          d.position,
          this.facing(target?.team ?? 0),
          frame,
          Math.max(10, target?.radius ?? 16),
        );
    } else if (kind === "sound") {
      const d = data as {
        source: { kind: string; team: string };
        phase: string;
        position: Point;
      };
      const team = d.source.team === "Blue" ? 0 : 1;
      const phase = phaseEffects[d.source.kind]?.[d.phase];
      if (phase) {
        const id =
          d.source.kind === "event_horizon" && team !== this.seat
            ? phase + "_red"
            : phase;
        const effect = this.place(
          "phase/" + event.seq,
          id,
          event.tick,
          0.4,
          d.position,
          this.facing(team),
          frame,
        );
        if (effect) effect.owner = (data as { target?: number }).target;
      }
      if (d.source.kind === "aurelionsol" && d.phase === "@impact") {
        const strong =
          (d.source as { action?: string }).action === "active_strong";
        this.place(
          "impact/" + event.seq,
          strong ? "aurelionsol_r/strong_impact" : "aurelionsol_r/impact",
          event.tick,
          0.4,
          d.position,
          this.facing(d.source.team === "Blue" ? 0 : 1),
          frame,
        );
      }
    } else if (kind === "health") {
      const d = data as { source: number; target: number; change: number },
        u = actor(d.target);
      if (u && d.change > 0) {
        const key = "heal/" + u.id,
          old = this.instances.get(key);
        if (!old || event.tick - old.start >= 12)
          this.place(key, "janna/heal", event.tick, 0.32, u, u.facing, frame);
      }
    } else if (kind === "damage") {
      const d = data as { source: number; target: number; contact?: unknown },
        u = actor(d.source),
        target = actor(d.target);
      const system =
        u &&
        (u.kind === "soul_tentacle"
          ? "soul_tentacle/slam"
          : u.kind === "daisy" && u.attack?.empowered
            ? "ivern/slam"
            : !missiles[u.kind]
              ? impacts[u.kind]
              : undefined);
      if (system && u && target && d.contact)
        this.place(
          "contact/" + event.seq,
          system,
          event.tick,
          0.4,
          target,
          u.facing,
          frame,
        );
    } else if (kind === "formChanged") {
      const u = actor((data as { id: number }).id);
      if (u && u.audioKind === "jayce")
        this.place(
          "form/" + event.seq,
          u.alternateForm ? "jayce/swap_r" : "jayce/swap_m",
          event.tick,
          0.4,
          u,
          u.facing,
          frame,
        );
    } else if (kind === "spawned" || kind === "died") {
      const unit = actor(Number(data));
      const system =
        unit && (kind === "died" ? deathEffects : spawnEffects)[unit.kind];
      if (unit && system)
        this.place(
          "event/" + event.seq,
          system,
          event.tick,
          0.4,
          unit,
          unit.facing,
          frame,
        );
    } else if (kind === "cast") {
      const d = data as {
        caster: number;
        skill: string;
        origin: Point;
        direction: Point;
      };
      // Zero-duration casts can begin and end between snapshots.
      const owner = actor(d.caster);
      if (
        !owner ||
        owner.castEnd <= event.tick ||
        owner.castStart !== event.tick
      )
        for (const b of castEffects[d.skill] ?? [])
          this.place(
            "cast/" + d.caster + "/" + event.tick + "/" + b.system,
            b.system,
            event.tick,
            b.scale,
            d.origin,
            d.direction,
            frame,
          );
    }
  }
  prepare(frame: Frame, deck?: readonly string[]) {
    if (this.quality === "off") return;
    for (const card of deck ?? frame.hand) {
      this.warm(missiles[card]?.system);
      if (card === "ashe") this.warm("ashe/volley");
      if (card === "sona") this.warm("sona/wave");
      const spell = {
        id: 0,
        key: card,
        team: this.seat,
        position: { x: 0, y: 0 },
        origin: { x: 0, y: 0 },
        born: 0,
        impact: 20,
        end: 60,
        radius: 100,
      };
      for (const layer of spellLayers(spell, this.seat))
        this.warm(layer.system);
    }
  }
  private trim() {
    const now = performance.now();
    if (now < this.nextTrim) return;
    this.nextTrim = now + 2000;
    let bytes = 0;
    for (const track of this.tracks.values()) bytes += track.rows.byteLength;
    const busy = new Set([...this.instances.values()].map((i) => i.name));
    const names = [...this.tracks.keys()].sort(
      (a, b) => (this.lastUse.get(a) ?? 0) - (this.lastUse.get(b) ?? 0),
    );
    for (const name of names) {
      if (bytes <= 64 * 1024 * 1024) break;
      if (busy.has(name) || now - (this.lastUse.get(name) ?? 0) < 3000)
        continue;
      bytes -= this.tracks.get(name)!.rows.byteLength;
      this.tracks.delete(name);
      this.library.release(name);
      this.lastUse.delete(name);
    }
  }
  render(
    frame: Frame,
    tick: number,
    launches: Map<number, Launch>,
    anchor: (id: number, hand?: boolean) => Vector3 | undefined,
    skin: (id: number) => readonly Mesh[] | undefined,
  ) {
    this.needsBackdrop = false;
    this.shots.clear();
    this.spells.clear();
    this.areas.clear();
    if (this.quality === "off") {
      this.reset(frame.presentation.cursor);
      return;
    }
    const units = new Map(frame.units.map((u) => [u.id, u]));
    for (const item of this.instances.values()) item.seen = false;
    for (const e of frame.cues ?? [])
      if (e.seq > this.cursor && e.tick <= tick) {
        this.cursor = e.seq;
        this.cues(e, frame, units);
      }
    for (const s of frame.spells) this.spellHistory.set(s.id, s);
    for (const [id, s] of this.spellHistory) {
      if (tick > s.end + 100) {
        this.spellHistory.delete(id);
        continue;
      }
      const dir = this.facing(s.team);
      for (const l of spellLayers(s, this.seat)) {
        this.warm(l.system);
        if (tick < l.start || (l.stop !== undefined && tick >= l.stop))
          continue;
        const age = (tick - l.start) / 20;
        let p = s.position,
          height = l.height ?? 0;
        if (l.motion === "arc") {
          const f = Math.min(
            1,
            (tick - s.born) / Math.max(1, s.impact - s.born),
          );
          p = {
            x: s.origin.x + (s.position.x - s.origin.x) * f,
            y: s.origin.y + (s.position.y - s.origin.y) * f,
          };
          height += Math.sin(f * Math.PI) * 120;
        } else if (l.motion === "tidal")
          p = {
            x: p.x,
            y: p.y + dir.y * Math.min(s.range ?? 440, (s.speed ?? 320) * age),
          };
        const entry = systems[l.system];
        if (!entry) continue;
        const loop = l.stop !== undefined;
        if (!loop && age > (entry.frames - 1) / entry.fps) continue;
        const item = this.place(
          "spell/" + id + "/" + l.system,
          l.system,
          l.start,
          l.scale,
          p,
          dir,
          frame,
          height,
          loop,
          !!l.motion,
        );
        if (item && this.tracks.has(item.name)) this.spells.add(id);
      }
    }
    for (const u of frame.units) {
      const existed = this.lastUnits.get(u.id);
      if (
        !existed ||
        existed.kind !== u.kind ||
        existed.equippedSkill !== u.equippedSkill
      ) {
        this.warm(missiles[u.kind]?.system);
        this.warm(impacts[u.kind]);
        if (u.kind === "ashe") this.warm("ashe/volley");
        if (u.kind === "sona") {
          this.warm("sona/wave");
          this.warm("sona/heal_self");
        }
        if (u.equippedSkill)
          for (const b of castEffects[u.equippedSkill] ?? [])
            this.warm(b.system);
      }
      const attach = (
        name: string,
        start: number,
        scale = 0.4,
        loop = true,
        height = 0,
      ) => {
        const entry = this.place(
          "unit/" + u.id + "/" + name,
          name,
          start,
          scale,
          u,
          u.facing,
          frame,
          height + (anchor(u.id)?.y ?? 0),
          loop,
          true,
        );
        if (entry) entry.owner = u.id;
        return entry;
      };
      for (const control of u.controls) {
        const sys = controlEffects[control];
        if (!sys) continue;
        const key = "unit/" + u.id + "/" + sys,
          start = this.instances.get(key)?.start ?? Math.floor(tick);
        attach(
          sys,
          start,
          control === "Freeze" ? 0.1 : 0.25,
          true,
          control === "Stun" || control === "Silence" ? 2 * u.radius : 0,
        );
      }
      if (u.activity === "Channeling" || u.visual?.action?.[0] === "channel") {
        const targets = u.visual?.drainTargets?.length
          ? u.visual.drainTargets
          : u.target == null
            ? []
            : [u.target];
        const system = channelSystems[u.kind];
        for (const id of targets) {
          const target = units.get(id);
          if (!target || !system) continue;
          const key = "tether/" + u.id + "/" + id;
          const item = this.place(
            key,
            system,
            this.instances.get(key)?.start ?? u.since,
            0.4,
            u,
            u.facing,
            frame,
            u.radius,
            true,
            true,
          );
          if (!item) continue;
          const start = anchor(u.id, true);
          if (start) item.position.copy(start);
          const sign = this.seat ? -1 : 1,
            end = new Vector3(
              sign * (target.x - frame.map.width / 2),
              (anchor(id)?.y ?? 0) + target.radius,
              sign * (target.y - frame.map.height / 2),
            );
          const direction = end.sub(item.position);
          item.beamLength = direction.length() / item.scale;
          if (direction.lengthSq() > 0)
            item.rotation.setFromUnitVectors(
              new Vector3(0, 0, 1),
              direction.normalize(),
            );
        }
      }
      for (const name of ambientEffects[u.kind] ?? [])
        attach(name, u.deployStart ?? 0);
      if (u.visual?.auraStart != null && u.kind === "sona")
        attach("sona/heal_self", u.visual.auraStart);
      if (u.visual?.moveSlow || u.visual?.attackSlow) {
        const name = "freeze/iceborn",
          key = "slow/" + u.id;
        this.place(
          key,
          name,
          this.instances.get(key)?.start ?? Math.floor(tick),
          0.08,
          u,
          u.facing,
          frame,
          0,
          true,
          true,
        );
      }
      if (u.visual?.buff && buffEffects[u.kind]) {
        const sys = buffEffects[u.kind],
          key = "unit/" + u.id + "/" + sys;
        attach(sys, this.instances.get(key)?.start ?? Math.floor(tick));
      }
      if (u.skill && tick >= u.castStart && tick < u.castEnd)
        for (const b of castEffects[u.skill] ?? [])
          attach(b.system, u.castStart, b.scale);
    }
    for (const s of frame.shots) {
      const b = missile(s);
      if (!b) continue;
      const target = units.get(s.target),
        source = units.get(s.owner);
      const delta = {
        x: s.position.x - s.origin.x,
        y: s.position.y - s.origin.y,
      };
      const dir =
        s.direction ??
        (Math.hypot(delta.x, delta.y) > 0.01
          ? delta
          : target
            ? { x: target.x - s.position.x, y: target.y - s.position.y }
            : (source?.facing ?? this.facing(s.team)));
      const key = "shot/" + s.id,
        launch = launches.get(s.id);
      const height =
        launch?.world.y ??
        this.instances.get(key)?.muzzle?.y ??
        baseHeight[s.sourceKind] ??
        32;
      const item = this.place(
        key,
        b.system,
        s.born,
        b.scale,
        s.position,
        dir,
        frame,
        height,
        true,
        true,
        !zForwardShots.has(s.sourceKind),
      );
      if (!item) continue;
      item.shot = true;
      if (launch && !item.muzzle) item.muzzle = launch.world.clone();
      const sign = this.seat ? -1 : 1;
      if (item.muzzle) {
        const remain =
          s.sourceKind === "sona" && s.volley
            ? 1
            : Math.max(0, 1 - (tick - s.born) / 2);
        item.position.x +=
          (item.muzzle.x - sign * (s.origin.x - frame.map.width / 2)) * remain;
        item.position.z +=
          (item.muzzle.z - sign * (s.origin.y - frame.map.height / 2)) * remain;
      }
      if (target && !s.direction) {
        const distance = Math.hypot(
          s.position.x - s.origin.x,
          s.position.y - s.origin.y,
        );
        const remaining = Math.hypot(
          target.x - s.position.x,
          target.y - s.position.y,
        );
        const targetHeight = (anchor(target.id)?.y ?? 0) + target.radius;
        item.position.y +=
          ((targetHeight - item.position.y) * distance) /
          Math.max(1, distance + remaining);
        const facing = new Vector3(
          sign * (target.x - frame.map.width / 2) - item.position.x,
          targetHeight - item.position.y,
          sign * (target.y - frame.map.height / 2) - item.position.z,
        );
        if (facing.lengthSq() > 0) {
          facing.normalize();
          const flat = Math.hypot(facing.x, facing.z);
          item.rotation
            .setFromAxisAngle(up, Math.atan2(facing.x, facing.z))
            .multiply(
              new Quaternion().setFromAxisAngle(
                new Vector3(1, 0, 0),
                -Math.atan2(facing.y, flat),
              ),
            );
          if (!zForwardShots.has(s.sourceKind))
            item.rotation.multiply(missileOrientation);
        }
      }
      if (this.tracks.has(b.system)) this.shots.add(s.id);
    }
    for (const w of frame.waves ?? []) {
      const p = {
        x: w.origin.x + w.direction.x * w.travel,
        y: w.origin.y + w.direction.y * w.travel,
      };
      this.place(
        "wave/" + w.caster + "/" + w.start,
        "kayle/native/wave",
        w.start,
        w.width / 360,
        p,
        w.direction,
        frame,
        26,
        true,
        true,
      );
    }
    for (const a of frame.areas) {
      const stellar = a.source_kind === "aurelionsol";
      const name = stellar
        ? "aurelionsol_r/" +
          (a.phase === "wave" ? "wave" : a.enhanced ? "strong_tell" : "tell")
        : areaEffects[a.effect ?? ""];
      if (!name) continue;
      const radius = Object.values(a.shape)[0]?.radius ?? 80;
      const item = this.place(
        "area/" + a.id,
        name,
        a.born ?? 0,
        stellar ? radius / 250 : 0.4,
        a.position,
        a.direction,
        frame,
        0,
        true,
      );
      if (stellar && a.phase === "warning" && a.next_tick != null) {
        this.warm(
          a.enhanced ? "aurelionsol_r/strong_impact" : "aurelionsol_r/impact",
        );
      }
      if (item && this.tracks.has(name)) this.areas.add(a.id);
    }
    let particles = 0,
      instances = 0;
    for (const [key, item] of this.instances) {
      const info = systems[item.name],
        duration = (info.frames - 1) / info.fps;
      const age = Math.max(0, (tick - item.start) / 20);
      if (
        !item.seen &&
        item.persistent &&
        item.shot &&
        item.cutoff === undefined
      )
        item.cutoff = age;
      const expired =
        item.cutoff !== undefined
          ? age >=
            Math.min(
              duration,
              item.cutoff + (item.name === "sona/wave" ? 1.5 : 0.45),
            )
          : item.persistent
            ? !item.seen
            : age > duration;
      if (expired) {
        item.actor?.dispose();
        this.instances.delete(key);
        continue;
      }
      if (!item.actor) {
        const track = this.tracks.get(item.name);
        if (!track) continue;
        item.actor = new ParticleActor(item.name, track);
        this.root.add(item.actor.root);
      }
      const a = item.actor;
      a.sources = item.owner === undefined ? undefined : skin(item.owner);
      a.beamLength = item.beamLength ?? 3410;
      a.root.position.copy(item.position);
      a.root.quaternion.copy(item.rotation);
      a.root.scale.setScalar(item.scale);
      const phase =
        item.persistent && age > duration
          ? duration * 0.5 + (age % (duration * 0.5))
          : age;
      a.sample(phase, this.quality, empty, item.moving, item.cutoff);
      this.needsBackdrop ||= a.distortion;
      particles += a.drawn;
      if (a.drawn) instances++;
    }
    this.trim();
    this.lastUnits = units;
    Object.assign(this.metrics, { instances, particles });
  }
  trace() {
    return [...this.instances]
      .filter(([, i]) => i.actor?.drawn)
      .map(([key, i]) => ({
        key,
        system: i.name,
        start: i.start,
        position: i.position.toArray(),
        orientation: i.rotation.toArray(),
        particles: i.actor!.drawn,
        cutoff: i.cutoff,
      }));
  }
  reset(cursor: number) {
    for (const i of this.instances.values()) i.actor?.dispose();
    this.cursor = cursor;
    this.instances.clear();
    this.lastUnits.clear();
    this.spellHistory.clear();
    this.needsBackdrop = false;
    this.shots.clear();
    this.areas.clear();
    this.spells.clear();
    Object.assign(this.metrics, { instances: 0, particles: 0 });
  }
  dispose() {
    this.disposed = true;
    this.reset(0);
    this.backdrop.dispose();
    this.library.dispose();
    this.tracks.clear();
    this.waiting.clear();
  }
}
