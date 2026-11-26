import {
  effectPhase,
  emissionTail,
  fixedEffectScale,
} from "./effect-calibration";
import {
  Group,
  Matrix4,
  Quaternion,
  Vector3,
  type Mesh,
  type Object3D,
} from "three";
const shockwaveParent = new Set(["Temp_Mesh1"]);
const laserCorona = new Set(["rings", "electric"]);
import { ArrivalModels, arrivalPose, arrivalScale } from "./pantheon-arrival";
import { BattleGroundEffects, StatusModels } from "./battle-status-effects";
import { BurrowRocks } from "./reksai-rocks";
import { RewindHistory } from "./rewind-history";
import type { EffectPath, Frame, Unit } from "./battle-field";
import type { BattleEvent, Point } from "./presentation";
import {
  ambientEffects,
  bearFireBones,
  strutBones,
  channelSystems,
  phaseEffects,
  controlEffects,
  impacts,
  volleyImpacts,
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
  "voidfish_ranged_army",
  "voidfish_ranged_single",
  "kayle",
  "kayle_ranged",
]);
const unitEffectSockets: Record<string, string> = {
  "gwen_tristana/rapid": "Buffbone_Glb_Weapon_1",
  "thorn_spitter/buff": "C_Buffbone_Glb_Center_Loc",
};
// These Godot projectile adapters interpolate from the firing socket to the
// target's torso. Free-flight and bouncing shots follow the published path.
const torsoShots = new Set([
  "ashe",
  "ivern",
  "jack_in_the_box",
  "thorn_spitter",
  "twisted_fate",
  "sona",
  "graves",
]);
const chestSockets = [
  "C_Buffbone_Glb_Chest_Loc",
  "Buffbone_Glb_Chest_Loc",
  "Spine2",
  "Chest",
  "Spine1",
  "Spine",
];
const baseHeight: Record<string, number> = {
  apex_turret: 46.75,
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
const phaseScales: Record<string, number> = {
  "lightning_spells/stormsurge": 90 / 1050,
  "lightning_spells/electrocute": 90 / 550,
  "event_horizon/meteor": 65 / 225,
  "event_horizon/impact": 65 / 225,
  "event_horizon/meteor_red": 65 / 225,
  "event_horizon/impact_red": 65 / 225,
  "aftershock/native/AOE": 110 / 311.40326,
  "ziggs/hit": 0.2,
  "ekko/r-Tar": 140 / 375,
};
// Old battlefield units convert to 40 world units per metre. These scales
// multiply the geometry and curves decoded from the original champion WAD.
const contactScales: Record<string, number> = {
  "hecarim/qtar": 0.2,
  "ivern/slam": 0.48,
  "azir/hit": 0.44,
  "jayce/first_hit_m": 0.38,
  "jayce/first_hit_r": 0.38,
  "blitzcrank/etar": 0.425,
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
  hitSocket?: { id: number; name: string };
  actor?: ParticleActor;
  owner?: number;
  beamLength?: number;
  onlyLayers?: ReadonlySet<string>;
  ghostSkin?: readonly Mesh[];
  cableStart?: Vector3;
  cableEnd?: Vector3;
  thrust?: { caster: number; from: Point; direction: Point; launch?: Vector3 };
  beamFrom?: number;
  beamTo?: number;
  sampleAge?: number;
  fieldRadius?: number;
  deathAge?: number;
  stop?: number;
  axes?: Vector3;
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
  needsBackdrop = 0;
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
  private delta = new Vector3();
  private orientation = new Quaternion();
  private aim = new Matrix4();
  private zero = new Vector3();
  private histories = new Map<number, RewindHistory>();
  private groundEffects = new BattleGroundEffects();
  private statuses = new StatusModels();
  private rocks = new BurrowRocks();
  private arrivals = new ArrivalModels();
  constructor(private seat: number) {
    this.root.add(
      this.rocks.root,
      this.arrivals.root,
      this.statuses.root,
      this.groundEffects.root,
    );
  }

  get preparing() {
    for (const until of this.waiting.values())
      if (until === Infinity) return true;
    return this.arrivals.loading || this.rocks.loading;
  }
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
    scale = fixedEffectScale[name] ?? scale;
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
      item.persistent = persistent;
      item.seen = true;
    }
    return item;
  }
  private facing(team: number) {
    return { x: 0, y: team ? 1 : -1 };
  }
  private cues(
    event: BattleEvent,
    frame: Frame,
    units: Map<number, Unit>,
    socket?: (id: number, name: string) => Object3D | undefined,
  ) {
    const { kind, data } = event.fact;
    const actor = (id: number) => units.get(id) ?? this.lastUnits.get(id);
    if (kind === "spellPlayed") {
      const d = data as SpellEvent;
      this.spellHistory.set(d.id, {
        ...d,
        born: event.tick,
        team: d.team === "Blue" ? 0 : 1,
      });
    } else if (kind === "skillImpact") {
      const d = data as {
        skill: string;
        enhanced: boolean;
        position: Point;
        direction: Point;
      };
      if (d.skill === "sett.haymaker") {
        const p = {
          x: d.position.x - 47 * 0.25 * d.direction.x,
          y: d.position.y - 47 * 0.25 * d.direction.y,
        };
        this.place(
          "punch/" + event.seq,
          d.enhanced ? "sett/max" : "sett/min",
          event.tick,
          0.25,
          p,
          d.direction,
          frame,
        );
      }
    } else if (kind === "spellContact") {
      const d = data as { key: string; position: Point; target: number };
      if (d.key === "field_hit" || d.key === "rewind_hit") {
        const target = actor(d.target);
        const fx = this.place(
          "skill-hit/" + event.seq,
          d.key === "field_hit" ? "jayce/field_hit" : "ekko/r-Tar_Impact",
          event.tick,
          d.key === "field_hit" ? 0.38 : 0.538,
          d.position,
          this.facing(target?.team ?? 0),
          frame,
          d.key === "field_hit" ? (target?.radius ?? 18) : 0,
        );
        if (fx) fx.owner = d.target;
      }
      const cask = d.key === "explosive_cask";
      if (cask || d.key === "severing_bolt")
        this.place(
          "spell-contact/" + event.seq,
          cask ? "explosive_cask/hit" : "severing_bolt/hit",
          event.tick,
          cask ? 0.32 : 65 / 225,
          d.position,
          this.facing(actor(d.target)?.team ?? 0),
          frame,
          cask ? 32 : 0,
        );
    } else if (kind === "effectBlocked") {
      const u = actor(Number(data));
      if (u?.kind === "sivir") {
        const blocked = this.place(
          "blocked/" + event.seq,
          "sivir/shield_impact",
          event.tick,
          0.4,
          u,
          u.facing,
          frame,
        );
        if (blocked) blocked.owner = u.id;
      }
    } else if (kind === "projectileHit") {
      const d = data as {
        source_kind: string;
        first?: boolean;
        volley?: boolean;
        projectile: number;
        target: number;
        position: Point;
      };
      const ashe = d.source_kind === "ashe";
      // Older replays recorded the shot type only on the presentation sound cue.
      const volley = d.volley ?? event.sounds?.some((s) => s.phase === "volleyHit");
      const sys =
          volley && volleyImpacts[d.source_kind]
            ? volleyImpacts[d.source_kind]
            : d.source_kind === "jayce" && d.first
            ? "jayce/first_hit_r"
            : impacts[d.source_kind],
        target = actor(d.target);
      if (sys && d.position) {
        const hit = this.place(
          "hit/" + event.seq,
          sys,
          event.tick,
          contactScales[sys] ?? 0.4,
          d.position,
          this.facing(target?.team ?? 0),
          frame,
          (ashe && target?.air ? 92 : 0) + Math.max(10, target?.radius ?? 16),
        );
        if (ashe && hit && socket) {
          const names = volley
            ? ["C_Buffbone_Glb_Center_Loc", ...chestSockets]
            : chestSockets;
          for (const name of names) {
            const bone = socket(d.target, name);
            if (bone) {
              hit.hitSocket = { id: d.target, name };
              hit.moving = true;
              bone.getWorldPosition(hit.position);
              break;
            }
          }
        }
      }
    } else if (kind === "sound") {
      const d = data as {
        source: { kind: string; team: string; action: string; owner: number };
        phase: string;
        position: Point;
      };
      const team = d.source.team === "Blue" ? 0 : 1;
      if (d.source.kind === "malzahar" && d.phase === "summon:start") {
        this.place(
          "portal/" + event.seq,
          "malzahar/portal_start",
          event.tick,
          0.4,
          d.position,
          this.facing(team),
          frame,
        );
        this.place(
          "portal-end/" + event.seq,
          "malzahar/portal_end",
          event.tick + 30,
          0.4,
          d.position,
          this.facing(team),
          frame,
        );
      }
      if (d.phase === "sacrifice:impact") {
        const burst = this.place(
          "burst/" + event.seq,
          "void_spawn/burst",
          event.tick,
          0.48,
          d.position,
          this.facing(team),
          frame,
        );
        const leap = frame.effectPaths?.find(
          (p) =>
            p.kind === "sacrifice" &&
            p.target === d.source.owner &&
            p.impact === event.tick &&
            Math.hypot(
              p.path.at(-1)!.x - d.position.x,
              p.path.at(-1)!.y - d.position.y,
            ) < 0.001,
        );
        const joint = leap && socket?.(leap.owner, "Buffbone_Glb_Channel_Loc");
        if (burst && joint) {
          joint.getWorldPosition(burst.position);
          joint.getWorldQuaternion(burst.rotation);
        }
      }
      const phase = phaseEffects[d.source.kind]?.[d.phase];
      if (phase) {
        const id =
          d.source.kind === "event_horizon" && team !== this.seat
            ? phase + "_red"
            : phase;
        const affected = (data as { target?: number }).target;
        const tower =
          id === "medium_lightning/disabled" && affected !== undefined
            ? actor(affected)
            : undefined;
        if (tower) {
          for (const name of [
            id,
            "medium_lightning/tower_hit",
            "medium_lightning/tower_crack",
          ]) {
            const overlay = this.place(
              "disabled/" + tower.id + "/" + name,
              name,
              event.tick,
              tower.radius / 325,
              tower,
              this.facing(team),
              frame,
            );
            if (overlay) {
              overlay.owner = tower.id;
              overlay.stop = event.tick + 46;
            }
          }
        } else {
          const effect = this.place(
            "phase/" + event.seq,
            id,
            event.tick,
            phaseScales[id] ?? 0.4,
            d.position,
            this.facing(team),
            frame,
          );
          if (effect) effect.owner = affected;
        }
      }
      if (
        d.source.kind === "aurelionsol" &&
        d.phase === d.source.action + ":impact"
      ) {
        const strong =
          (d.source as { action?: string }).action === "active_strong";
        this.place(
          "impact/" + event.seq,
          strong ? "aurelionsol_r/strong_impact" : "aurelionsol_r/impact",
          event.tick,
          92 / 560,
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
      const d = data as {
          source: number;
          target: number;
          contact?: {
            first: boolean;
            form: boolean;
            empowered: boolean;
            cycle: number;
          };
        },
        u = actor(d.source),
        target = actor(d.target);
      const hit = d.contact;
      let system = u && !missiles[u.kind] ? impacts[u.kind] : undefined;
      if (u && hit && target) {
        if (u.kind === "azir") {
          const beam = this.place(
            "azir-beam/" + event.seq,
            "azir/beam",
            event.tick,
            0.44,
            u,
            u.facing,
            frame,
            u.radius,
          );
          if (beam) {
            beam.beamFrom = u.id;
            beam.beamTo = target.id;
          }
        }
        if (u.kind === "hecarim") system = "hecarim/qtar";
        if (u.kind === "blitzcrank" && hit.empowered)
          system = "blitzcrank/etar";
        if (u.kind === "daisy" && hit.cycle % 3 === 0) system = "ivern/slam";
        if (u.audioKind === "jayce" && hit.first)
          system = hit.form ? "jayce/first_hit_m" : "jayce/first_hit_r";
      }
      if (system && u && target && d.contact)
        this.place(
          "contact/" + event.seq,
          system,
          event.tick,
          contactScales[system] ?? 0.4,
          target,
          u.facing,
          frame,
        );
    } else if (kind === "formChanged") {
      const u = actor((data as { id: number }).id);
      if (u && u.audioKind === "jayce")
        this.place(
          "form/" + event.seq,
          u.alternateForm ? "jayce/swap_m" : "jayce/swap_r",
          event.tick,
          0.4,
          u,
          u.facing,
          frame,
        );
    } else if (kind === "spawned" || kind === "died") {
      const unit = actor(Number(data));
      if (kind === "died" && unit?.kind === "pillar_of_ice") {
        const body = this.place(
          "pillar-death/" + event.seq,
          "pillar_of_ice/pillar",
          event.tick,
          0.36,
          unit,
          unit.facing,
          frame,
        );
        if (body) {
          body.stop = event.tick + 16;
          body.fieldRadius = unit.visual?.slowFieldRadius ?? 110;
          body.deathAge = 0;
        }
      }
      const system =
        unit && (kind === "died" ? deathEffects : spawnEffects)[unit.kind];
      if (
        unit &&
        system &&
        !(
          kind === "died" &&
          frame.effectPaths?.some(
            (p) => p.owner === unit.id && p.kind === "sacrifice",
          )
        )
      ) {
        const spawned = this.place(
          "event/" + event.seq,
          system,
          event.tick,
          system === "powder_keg/explosion" ? 0.5 : 0.4,
          unit,
          unit.facing,
          frame,
        );
        if (spawned && system.startsWith("void_gate/")) spawned.owner = unit.id;
      }
    } else if (kind === "cast") {
      const d = data as {
        caster: number;
        skill: string;
        origin: Point;
        direction: Point;
      };
      if (d.skill === "pantheon.comet-spear") {
        const spear = this.place(
          "spear/" + event.seq,
          "pantheon/spear",
          event.tick,
          0.4,
          d.origin,
          d.direction,
          frame,
          38,
          false,
          true,
          true,
        );
        if (spear) {
          spear.stop = event.tick + 7;
          spear.thrust = {
            caster: d.caster,
            from: d.origin,
            direction: d.direction,
          };
        }
      }
      // Zero-duration casts can begin and end between snapshots.
      const owner = actor(d.caster);
      if (
        !owner ||
        owner.castEnd <= event.tick ||
        owner.castStart !== event.tick
      )
        for (const b of castEffects[d.skill] ?? []) {
          if (
            owner &&
            owner.visual?.buff &&
            b.system === buffEffects[owner.kind]
          )
            continue;
          const cast = this.place(
            "cast/" + d.caster + "/" + event.tick + "/" + b.system,
            b.system,
            event.tick,
            b.scale,
            d.origin,
            d.direction,
            frame,
          );
          if (cast) cast.owner = d.caster;
        }
    }
  }
  private renderPath(
    path: EffectPath,
    tick: number,
    frame: Frame,
    socket?: (id: number, name: string) => Object3D | undefined,
  ) {
    const { start, impact, end } = path,
      from = path.path[0],
      to = path.path.at(-1)!;
    const dir = this.facing(path.team === "Blue" ? 0 : 1),
      sign = this.seat ? -1 : 1;
    const add = (
      name: string,
      born: number,
      scale: number,
      point: Point,
      height = 0,
      face = dir,
    ) =>
      this.place(
        "travel/" + path.owner + "/" + start + "/" + name,
        name,
        born,
        scale,
        point,
        face,
        frame,
        height,
        true,
        true,
      );
    const progress = Math.max(
      0,
      Math.min(1, (tick - start) / Math.max(1, impact - start)),
    );
    if (path.kind === "pantheon") {
      const p = arrivalPose(path, tick, frame, this.seat);
      const part = (
        name: string,
        offset: number,
        at: Vector3,
        rot?: Quaternion,
      ) => {
        const e = add("pantheon/" + name, start + offset, arrivalScale, from);
        if (e) {
          e.position.copy(at);
          if (rot) e.rotation.copy(rot);
        }
        return e;
      };
      if (p.age >= 0.2 && p.age < 0.65)
        part("comet", 4, p.comet, p.orientation);
      if (p.age >= 0.65 && p.age < 1.3) {
        part("landing", 13, p.landing);
        part("slide", 13, p.comet, p.orientation);
      }
      if (p.age >= 0.65 && p.age < 1.35) {
        const parent = part("damage", 13, p.damage, p.orientation);
        if (parent)
          parent.onlyLayers = p.age >= 1.3 ? shockwaveParent : undefined;
      }
      if (p.age >= 1.35) {
        // Damage_Mis/Temp_Mesh1 dies 0.70 seconds after birth at local (0,-450,0).
        const at = p.end.clone();
        at.z -= 450 * arrivalScale * p.dir;
        part(
          "aftershock",
          27,
          at,
          new Quaternion().setFromAxisAngle(up, (-p.dir * Math.PI) / 2),
        );
      }
    } else if (path.kind === "reksai") {
      const lengths = path.path
        .slice(1)
        .map((p, i) => Math.hypot(p.x - path.path[i].x, p.y - path.path[i].y));
      let distance = lengths.reduce((a, b) => a + b, 0) * progress;
      for (let i = 0; i < lengths.length; i++) {
        if (distance > lengths[i] && i < lengths.length - 1) {
          distance -= lengths[i];
          continue;
        }
        const a = path.path[i],
          b = path.path[i + 1],
          f = Math.min(1, distance / Math.max(0.001, lengths[i]));
        // A fresh four-second emission cycle lets existing free particles fade for 1.8s.
        const cycle = Math.floor((Math.min(tick, impact) - start) / 80);
        for (let n = Math.max(0, cycle - 1); n <= cycle; n++) {
          const born = start + 80 * n,
            stop = Math.min(born + 80, impact);
          if (tick >= stop + 36) continue;
          const trail = this.place(
            "burrow/" + path.owner + "/" + born,
            "reksai/travel",
            born,
            0.32,
            { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f },
            { x: b.x - a.x, y: b.y - a.y },
            frame,
            0,
            true,
            true,
          );
          if (trail && tick >= stop) trail.cutoff = (stop - born) / 20;
        }
        if (tick >= impact) {
          add("reksai/knockup", impact, 0.32, to);
          add("reksai/emerge_cast", impact, 0.32, to);
        }
        break;
      }
    } else if (path.kind === "sacrifice") {
      if (tick >= impact) return;
      for (const [particle, bone] of [
        ["energy", "C_Buffbone_Glb_Overhead_Loc"],
        ["glow", "Buffbone_Glb_Weapon_1"],
      ]) {
        const joint = socket?.(path.owner, bone);
        if (!joint) continue;
        const e = add("void_spawn/" + particle, start, 0.24, from);
        if (e) {
          joint.getWorldPosition(e.position);
          e.sampleAge = (23 / 30) * progress;
        }
      }
      const point = {
        x: from.x + (to.x - from.x) * progress,
        y: from.y + (to.y - from.y) * progress,
      };
      const trail = add("void_spawn/trail", start, 0.6, point, 20, {
        x: to.x - from.x,
        y: to.y - from.y,
      });
      if (trail)
        socket?.(path.owner, "Buffbone_Glb_Channel_Loc")?.getWorldPosition(
          trail.position,
        );
    } else if (path.kind === "hook") {
      const origin =
        socket?.(path.owner, "R_hand")?.getWorldPosition(new Vector3()) ??
        new Vector3(
          sign * (from.x - frame.map.width / 2),
          25.5,
          sign * (from.y - frame.map.height / 2),
        );
      const returning = tick >= impact;
      const tip = new Vector3(
        sign * (to.x - frame.map.width / 2),
        origin.y,
        sign * (to.y - frame.map.height / 2),
      );
      const f = returning ? (end - tick) / Math.max(1, end - impact) : progress;
      const hand = add("blitzcrank/qcas", start, 0.425, from);
      if (hand) hand.position.copy(origin);
      const face = { x: to.x - from.x, y: to.y - from.y };
      const fist = add(
        returning ? "blitzcrank/qreturn" : "blitzcrank/qmis",
        returning ? impact : start,
        0.425,
        from,
        0,
        face,
      );
      if (fist) {
        const head = origin.clone().lerp(tip, f);
        fist.position.copy(head);
        if (!returning)
          fist.position.sub(
            new Vector3(10, 60, -60)
              .multiplyScalar(0.425)
              .applyQuaternion(fist.rotation),
          );
        fist.cableStart = origin
          .clone()
          .sub(fist.position)
          .applyQuaternion(fist.rotation.clone().invert())
          .divideScalar(0.425);
        fist.beamLength = 0;
        fist.cableEnd = head
          .sub(fist.position)
          .applyQuaternion(fist.rotation.clone().invert())
          .divideScalar(0.425);
      }
    }
  }
  private rewind(
    u: Unit,
    frame: Frame,
    tick: number,
    root: Object3D,
    socket?: (id: number, name: string) => Object3D | undefined,
  ) {
    const casting =
      u.skill === "ekko.chronobreak" &&
      tick >= u.castStart &&
      tick < u.impactTick;
    if (!casting && !u.visual?.rewindReady) return;
    let history = this.histories.get(u.id);
    if (!history || history.model !== root) {
      history?.dispose();
      history = new RewindHistory(root);
      this.histories.set(u.id, history);
    }
    history.capture(Math.floor(tick));
    const add = (name: string, start: number, scale = 0.538) =>
      this.place(
        "rewind/" + u.id + "/" + name,
        "ekko/" + name,
        start,
        scale,
        u,
        u.facing,
        frame,
        0,
        true,
        true,
      );
    const source = (
      name: string,
      at: number,
      born: number,
      scale = 0.538,
      ghost = false,
    ) => {
      const p = ghost ? history.pose(at) : history.at(at);
      const item = add(name, born, scale);
      if (item && p) {
        item.position.copy(p.position);
        item.rotation.copy(p.rotation);
        if (at < p.tick && ghost && u.visual?.rewindPosition) {
          const pos = u.visual.rewindPosition,
            sign = this.seat ? -1 : 1;
          item.position.set(
            sign * (pos.x - frame.map.width / 2),
            p.position.y,
            sign * (pos.y - frame.map.height / 2),
          );
          history.anchor(item.position);
        }
        if (ghost) item.ghostSkin = history.skin;
      }
    };
    const deployed = u.deployStart ?? 0,
      enemy = u.team !== this.seat,
      age = tick - u.castStart;
    const device = add("r-TimeDevice_Active", deployed);
    if (device)
      socket?.(u.id, "Weapon_Back_Base")?.getWorldPosition(device.position);
    if (!casting) {
      source(
        enemy ? "r-TrailEnd_Red" : "r-TrailEnd",
        tick - 80,
        deployed,
        0.538,
        true,
      );
      source(
        enemy ? "r-RewindIndicator_Red" : "r-RewindIndicator",
        tick,
        deployed,
      );
    } else {
      root.visible = age < 5;
      if (age >= 5) {
        source("vanish", u.castStart, u.castStart + 5, 140 / 375);
        source("end", u.castStart - 80, u.castStart + 5, 140 / 375, true);
        for (let i = 0; i < 6; i++) {
          const born = u.castStart + 5 + (10 * i) / 6;
          if (tick >= born)
            source(
              "r-RewindPose" + (i + 1),
              u.castStart - (80 * (i + 1)) / 6,
              born,
            );
        }
      }
    }
  }
  prepare(frame: Frame, deck?: readonly string[]) {
    if (this.quality === "off") return;
    for (const card of deck ?? frame.hand) {
      if (card === "reksai") this.rocks.prepare();
      if (card === "pantheon") this.arrivals.prepare();
      this.warm(missiles[card]?.system);
      if (card === "ashe") this.warm("ashe/volley");
      this.warm(volleyImpacts[card]);
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
    socket?: (id: number, name: string) => Object3D | undefined,
    model?: (id: number) => Object3D | undefined,
  ) {
    this.needsBackdrop = 0;
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
        this.cues(e, frame, units, socket);
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
          const q = frame.map.projection;
          const screenToHeight = q / Math.sqrt(1 - q * q);
          height +=
            s.key === "mega_inferno_bomb"
              ? 4 * f * (1 - f) * 230 + (1 - f) * 100
              : screenToHeight *
                (Math.sin(f * Math.PI) * (s.key === "stasis" ? 160 : 140) +
                  (1 - f) * (s.key === "stasis" ? 60 : 45));
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
          // Team-facing spells keep their authored forward axis. Ground bursts
          // use the map axes on both teams, as in the original battle scene.
          s.key === "final_spark" ||
            s.key === "tidal_wave" ||
            (s.key === "mega_inferno_bomb" && l.system.includes("warning"))
            ? dir
            : { x: 0, y: 1 },
          frame,
          height,
          loop,
          !!l.motion,
          l.motion === "tidal",
        );
        if (item) {
          if (l.sampleRate !== undefined || l.sampleOffset !== undefined)
            item.sampleAge = age * (l.sampleRate ?? 1) + (l.sampleOffset ?? 0);
          if (l.motion === "arc" && s.key === "mega_inferno_bomb") {
            const f = Math.min(1, (age * 20) / Math.max(1, s.impact - s.born)),
              sign = this.seat ? -1 : 1;
            const tangent = this.delta.set(
              sign * (s.position.x - s.origin.x),
              4 * (1 - 2 * f) * 230 - 100,
              sign * (s.position.y - s.origin.y),
            );
            if (tangent.lengthSq())
              item.rotation.setFromRotationMatrix(
                this.aim.lookAt(this.zero, tangent, up),
              );
          }
        }
        if (item && this.tracks.has(item.name)) this.spells.add(id);
      }
    }
    const activeStatuses = new Set<number>();
    const burrows = new Set<number>();
    const pantheons = new Set<number>();
    for (const path of frame.effectPaths ?? []) {
      if (tick < path.start || tick >= path.end || !path.path.length) continue;
      this.renderPath(path, tick, frame, socket);
      if (path.kind === "reksai") {
        burrows.add(path.owner);
        this.rocks.show(path, tick, frame, this.seat);
      }
      if (path.kind === "pantheon") {
        pantheons.add(path.owner);
        this.arrivals.show(path, tick, frame, this.seat);
      }
    }
    this.rocks.retain(burrows);
    this.arrivals.retain(pantheons);
    for (const [id, h] of this.histories)
      if (!units.has(id)) {
        h.dispose();
        this.histories.delete(id);
      }
    for (const u of frame.units) {
      if (
        this.statuses.sample(
          u,
          tick,
          model?.(u.id),
          () => skin(u.id) ?? [],
          (name) => socket?.(u.id, name),
        )
      )
        activeStatuses.add(u.id);
      const existed = this.lastUnits.get(u.id);
      if (
        u.kind === "twitch" &&
        (existed
          ? !!u.hidden !== !!existed.hidden
          : u.hidden && tick <= (u.deployStart ?? 0) + 1)
      ) {
        const sign = this.seat ? -1 : 1;
        this.groundEffects.stealth(
          u.id,
          Math.floor(tick),
          !!u.hidden,
          new Vector3(
            sign * (u.x - frame.map.width / 2),
            0,
            sign * (u.y - frame.map.height / 2),
          ),
        );
      }
      if (
        !existed ||
        existed.kind !== u.kind ||
        existed.equippedSkill !== u.equippedSkill
      ) {
        this.warm(missiles[u.kind]?.system);
        this.warm(impacts[u.kind]);
        if (u.kind === "ashe") this.warm("ashe/volley");
        this.warm(volleyImpacts[u.kind]);
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
        bone?: string,
      ) => {
        bone ??= unitEffectSockets[name];
        const node = bone ? socket?.(u.id, bone) : undefined;
        if (bone && !node) return;
        const entry = this.place(
          "unit/" + u.id + "/" + name + (bone ? "/" + bone : ""),
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
        if (entry) {
          entry.owner = u.id;
          if (node) {
            node.getWorldPosition(entry.position);
            if (name === "thorn_spitter/buff")
              entry.rotation.setFromAxisAngle(up, this.seat ? Math.PI : 0);
            else node.getWorldQuaternion(entry.rotation);
          }
        }
        return entry;
      };
      const since = (name: string, bone = unitEffectSockets[name]) =>
        this.instances.get(
          "unit/" + u.id + "/" + name + (bone ? "/" + bone : ""),
        )?.start ?? Math.floor(tick);
      if (u.visual?.poolShield)
        attach(
          "pool_of_reflection/shield",
          since("pool_of_reflection/shield"),
          0.5,
        );
      else if (existed?.visual?.poolShield)
        attach("pool_of_reflection/break", Math.floor(tick), 0.5, false);
      if (u.visual?.sunlightUntil)
        attach("solar_flare/mark", u.visual.sunlightUntil - 50, 0.4, true, 48);
      if (u.visual?.explosiveShield)
        attach("sion_w/Shield", since("sion_w/Shield"));
      if (
        u.kind === "malphite" &&
        u.visual?.deploymentShield &&
        tick - (u.deployStart ?? 0) <= 80
      )
        attach("malphite/shield", u.deployStart ?? 0);
      if (u.visual?.sanctuary) {
        const [center, radius, until] = u.visual.sanctuary;
        this.place(
          "mist/" + u.id,
          "gwen_tristana/mist",
          until - 80,
          radius / 425.593,
          center,
          this.facing(u.team),
          frame,
          0,
          true,
        );
      }
      if (u.kind === "ekko") {
        const root = model?.(u.id);
        if (root) this.rewind(u, frame, tick, root, socket);
      }
      if (u.audioKind === "jayce") {
        const hammer = !!u.alternateForm;
        if (u.visual?.firstReady) {
          const name = hammer ? "jayce/ready_m" : "jayce/ready_r";
          for (const bone of hammer
            ? ["BUFFBONE_GLB_WEAPON_1"]
            : [
                "BUFFBONE_CSTM_WEAPON_1",
                "BUFFBONE_CSTM_WEAPON_GAP_1",
                "BUFFBONE_CSTM_WEAPON_GAP_2",
              ])
            attach(
              name,
              this.instances.get("unit/" + u.id + "/" + name + "/" + bone)
                ?.start ?? Math.floor(tick),
              0.38,
              true,
              0,
              bone,
            );
        }
        if (u.visual?.formStart != null) {
          for (const name of hammer
            ? ["jayce/stance_m"]
            : ["jayce/stance_r", "jayce/stance_hammer"]) {
            attach(
              name,
              u.visual.formStart,
              0.38,
              true,
              0,
              hammer ? "BUFFBONE_GLB_WEAPON_1" : "BUFFBONE_CSTM_WEAPON_1",
            );
          }
        }
      }
      if (
        (u.kind === "fiddlesticks" || u.kind === "scarecrow") &&
        u.visual?.drainTargets?.length
      )
        attach("fiddlesticks/channel", u.visual.action?.[1] ?? u.since, 0.4);
      if (u.kind === "samira" && u.visual?.full)
        attach("samira/ready", since("samira/ready"), 0.408);
      if (u.kind === "ziggs" && u.visual?.empowered) {
        const key = "unit/" + u.id + "/ziggs/passive/Bomb";
        const start = this.instances.get(key)?.start ?? Math.floor(tick);
        attach("ziggs/passive", start, 0.56, true, 0, "Bomb");
      }
      if (u.kind === "sett") {
        if (u.visual?.full) attach("sett/full_body", since("sett/full_body"));
        if (
          u.skill === "sett.haymaker" &&
          tick >= u.castStart &&
          tick < u.impactTick
        ) {
          const warning = attach("sett/warning", u.castStart, 0.25);
          if (warning)
            warning.position.add(
              this.delta
                .set(0, 0, u.radius - 47 * 0.25)
                .applyQuaternion(warning.rotation),
            );
          if (u.visual?.strong) attach("sett/cast_body", u.castStart);
        }
      }
      if (u.kind === "demacian_standard") {
        const start = u.deployStart ?? 0,
          land = start + 10;
        if (tick < land)
          attach(
            u.team ? "demacian_standard/fall_red" : "demacian_standard/fall",
            start,
          );
        else {
          attach("demacian_standard/flag", land, 0.4, true, 0, "root");
          if (tick < land + 23) attach("demacian_standard/landing", land);
        }
        if ((u.shield ?? 0) > 0)
          attach("demacian_standard/shield", since("demacian_standard/shield"));
      }
      if (u.kind === "azir" && u.attack) {
        const start = u.attack.start + 20 / 30;
        if (tick >= start && tick < start + 16)
          attach(
            "azir/cast" + (((u.attack.segment ?? 0) % 2) + 1),
            start,
            0.44,
            true,
            0,
            "Weapon",
          );
      }
      if (
        u.kind === "hecarim" &&
        u.attack &&
        !u.visual?.action?.[0]?.startsWith("charge")
      ) {
        for (const n of ["hecarim/qcas", "hecarim/qbuf"]) {
          const q = attach(
            n,
            u.attack.start,
            85 / (199.7413454464 * 1.6),
            true,
            0,
          );
          if (q) {
            q.position.y =
              socket?.(u.id, "root")?.getWorldPosition(this.delta).y ?? 42;
            q.sampleAge =
              ((tick - u.attack.start) * 0.96774149) /
              Math.max(1, u.attack.end - u.attack.start);
          }
        }
      }
      if ((u.kind === "olaf" || u.kind === "olaf_single") && u.visual?.buff) {
        const base = u.visual.immune ? "olaf/r_buf" : "olaf/buf_blood";
        const start = since(base);
        attach(base, start, 0.34);
        if (u.visual.immune) attach("olaf/r_cas", start, 0.34);
        else if ((u.shield ?? 0) > 0) attach("olaf/shield", start, 0.255);
        for (const side of ["R", "L"]) {
          const hand = side + "_BUFFBONE_GLB_HAND_LOC";
          if (u.visual.immune)
            attach("olaf/r_buff_weap", start, 0.34, true, 0, hand);
          else {
            attach("olaf/cas", start, 0.204, true, 0, hand);
            attach("olaf/buf_glow", start, 0.17, true, 0, side + "_weapon");
          }
        }
      }
      if (u.visual?.fieldUntil)
        attach("jayce/field", u.visual.fieldUntil - 80, 0.38);
      if (u.audioKind === "jayce" && u.visual?.buff && !u.visual.fieldUntil) {
        for (const n of [1, 2])
          attach(
            "jayce/w_ready2",
            since("jayce/w_ready2", "BUFFBONE_CSTM_WEAPON_GAP_" + n),
            0.38,
            true,
            0,
            "BUFFBONE_CSTM_WEAPON_GAP_" + n,
          );
      }
      if (u.kind === "tibbers" && u.visual?.burningAura) {
        attach("airdrop_bear/aura", u.deployStart ?? 0, 100 / 280);
        for (const [part, bones] of Object.entries(bearFireBones))
          for (const bone of bones)
            attach(
              "airdrop_bear/" + part,
              u.deployStart ?? 0,
              0.4,
              true,
              0,
              bone,
            );
      }
      if (u.kind === "kassadin")
        attach(
          "kassadin/idle_blade",
          u.deployStart ?? 0,
          0.4,
          true,
          0,
          "BUFFBONE_GLB_WEAPON_1",
        );
      if (u.kind === "missfortune") {
        if (u.visual?.buff)
          attach("missfortune_w/trail", since("missfortune_w/trail"), 0.56);
        for (const [side, bone] of Object.entries(strutBones)) {
          if (u.visual?.buff)
            attach(
              "missfortune_w/" + side,
              since("missfortune_w/trail"),
              0.56,
              true,
              0,
              bone,
            );
          else if (existed?.visual?.buff)
            attach(
              "missfortune_w/end_" + side,
              Math.floor(tick),
              0.56,
              false,
              0,
              bone,
            );
        }
      }
      if (
        u.kind === "soul_tentacle" &&
        u.attack &&
        tick >= u.attack.start &&
        tick < u.attack.end
      ) {
        const slam = tick >= u.attack.release,
          ally = u.team === this.seat;
        const system = slam
          ? "slam"
          : ally
            ? "indicator_blue"
            : "indicator_red";
        const halfLength = slam ? 517.5 : ally ? 506 : 540.5;
        const entry = attach(
          "soul_tentacle/" + system,
          slam ? u.attack.release : u.attack.start,
        );
        if (entry) {
          const z = 360 / (2 * halfLength);
          entry.axes = new Vector3(
            80 / (slam ? 500 : ally ? 240 : 280),
            0.4,
            z,
          );
          entry.position.add(
            this.delta
              .set(0, 0, (halfLength - (slam ? 430 : 460)) * z)
              .applyQuaternion(entry.rotation),
          );
        }
      }
      if (u.kind === "reksai" || u.kind === "enraged_reksai") {
        if (u.attack?.empowered) {
          const swipe = attach(
            "reksai/" +
              ((u.attack.segment ?? 0) % 3 === 1 ? "swipe_second" : "swipe"),
            u.attack.start,
          );
          if (swipe)
            swipe.sampleAge =
              (2 * (tick - u.attack.start)) /
              Math.max(1, u.attack.end - u.attack.start);
        }
      }
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
            u.kind === "aurelionsol" ? 0.24 : 0.4,
            u,
            u.facing,
            frame,
            u.radius,
            true,
            true,
          );
          if (!item) continue;
          const chest = socket?.(u.id, "Chest"),
            head = socket?.(u.id, "head");
          const start =
            system === "fiddlesticks/tether" && chest
              ? chest.getWorldPosition(new Vector3())
              : system === "malzahar/grasp" && head
                ? head.localToWorld(new Vector3(0, 5, 10))
                : anchor(u.id, true);
          if (start) item.position.copy(start);
          const sign = this.seat ? -1 : 1,
            end = new Vector3(
              sign * (target.x - frame.map.width / 2),
              (anchor(id)?.y ?? 0) + target.radius,
              sign * (target.y - frame.map.height / 2),
            );
          if (u.kind === "aurelionsol") {
            const hit = this.place(
              "channel-end/" + u.id + "/" + id,
              "aurelionsol_q/end",
              item.start,
              0.24,
              target,
              u.facing,
              frame,
              0,
              true,
              true,
            );
            if (hit) hit.position.copy(end);
          }
          const direction = end.sub(item.position);
          item.beamLength = direction.length() / item.scale;
          if (direction.lengthSq() > 0)
            item.rotation.setFromRotationMatrix(
              this.aim.lookAt(direction, this.zero, up),
            );
        }
      }
      for (const name of ambientEffects[u.kind] ?? []) {
        const start = u.deployStart ?? 0;
        if (name === "void_gate/idle" && tick < (u.readyTick ?? start))
          continue;
        const item = attach(
          name,
          name === "void_gate/idle" ? (u.readyTick ?? start) : start,
        );
        if (item && name === "pillar_of_ice/pillar")
          item.fieldRadius = u.visual?.slowFieldRadius ?? 110;
      }
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
        const sys = buffEffects[u.kind];
        if (sys === "reksai/buff") {
          for (const hand of [
            "L_Buffbone_Glb_Hand_Loc",
            "R_Buffbone_Glb_Hand_Loc",
          ])
            attach(sys, since(sys, hand), 0.32, true, 0, hand);
        } else attach(sys, since(sys));
      }
      if (u.skill && tick >= u.castStart && tick < u.castEnd)
        for (const b of castEffects[u.skill] ?? [])
          if (!(b.system === buffEffects[u.kind] && u.visual?.buff))
            attach(b.system, u.castStart, b.scale);
    }
    this.statuses.retain(activeStatuses);
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
        s.bounce
          ? this.instances.get(key)?.name === b.system
            ? this.instances.get(key)!.start
            : Math.floor(tick)
          : s.born,
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
      const torso = !!target && !s.direction && torsoShots.has(s.sourceKind);
      if (item.muzzle && !torso && s.sourceKind !== "ashe") {
        const remain =
          s.sourceKind === "sona" && s.volley
            ? 1
            : Math.max(0, 1 - (tick - s.born) / 2);
        item.position.x +=
          (item.muzzle.x - sign * (s.origin.x - frame.map.width / 2)) * remain;
        item.position.z +=
          (item.muzzle.z - sign * (s.origin.y - frame.map.height / 2)) * remain;
      }
      if (s.sourceKind === "apex_turret" && s.volley) {
        const corona = this.place(
          key + "/corona",
          "heimerdinger/charged",
          s.born,
          0.4,
          s.position,
          dir,
          frame,
          height,
          true,
          true,
          true,
        );
        if (corona) {
          corona.position.copy(item.position);
          corona.rotation.copy(item.rotation);
          corona.onlyLayers = laserCorona;
        }
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
        const targetPoint = new Vector3(
          sign * (target.x - frame.map.width / 2),
          (anchor(target.id)?.y ?? 0) + target.radius,
          sign * (target.y - frame.map.height / 2),
        );
        if (torso && socket) {
          for (const name of chestSockets) {
            const chest = socket(target.id, name);
            if (chest) {
              chest.getWorldPosition(targetPoint);
              break;
            }
          }
        }
        const fraction = distance / Math.max(1, distance + remaining);
        if (torso) {
          const origin =
            item.muzzle ??
            new Vector3(
              sign * (s.origin.x - frame.map.width / 2),
              height,
              sign * (s.origin.y - frame.map.height / 2),
            );
          item.position.lerpVectors(origin, targetPoint, fraction);
          if (remaining < 0.001) item.position.copy(targetPoint);
        } else item.position.y += (targetPoint.y - item.position.y) * fraction;
        const facing = targetPoint.sub(item.position);
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
      // A newly published shot has already advanced one simulation step.
      if (s.sourceKind === "ashe" && item.muzzle)
        item.position.lerp(item.muzzle, Math.max(0, 1 - (tick - s.born) / 2));
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
    const zones = new Set<number>();
    for (const a of frame.areas) {
      const stellar = a.source_kind === "aurelionsol";
      const radius = Object.values(a.shape)[0]?.radius ?? 80;
      const born = a.born ?? 0;
      if (a.source_kind === "malzahar" && a.effect === "channel") {
        const sign = this.seat ? -1 : 1;
        this.groundEffects.zone(
          a.id,
          new Vector3(
            sign * (a.position.x - frame.map.width / 2),
            1.2,
            sign * (a.position.y - frame.map.height / 2),
          ),
          radius,
          (tick - born) / 20,
        );
        zones.add(a.id);
        this.areas.add(a.id);
        continue;
      }
      const shrine =
        a.source_kind === "scuttle_crab" ||
        a.source_kind === "void_scuttle_crab";
      const voidShrine = a.source_kind === "void_scuttle_crab";
      const ally = (a.team === "Red" ? 1 : 0) === this.seat;
      const name = stellar
        ? "aurelionsol_r/" +
          (a.phase === "wave" ? "wave" : a.enhanced ? "strong_tell" : "tell")
        : shrine
          ? "scuttle_crab/" +
            (voidShrine ? "void_z_visionring_" : "shrine_") +
            (ally ? "green" : "red")
          : areaEffects[a.effect ?? ""];
      if (!name) continue;
      let scale = 0.4,
        start = born;
      if (a.effect === "frost_storm") scale = radius / 395.5019;
      if (shrine) {
        // Both old shrine players start at the shrine cue, after the death leap.
        const delay = 40;
        if (tick < born + delay) continue;
        start = born + delay;
        scale = radius / 250.15558;
        this.place(
          "antenna/" + a.id,
          "scuttle_crab/" +
            (voidShrine ? "void" : "normal") +
            "_ward_antenna_wake",
          start,
          scale,
          a.position,
          a.direction,
          frame,
          0,
          true,
        );
      }
      if (stellar) {
        scale = radius / 350;
        if (a.phase === "wave") {
          const age = (radius * 2.8) / 1500;
          start = (a.next_tick ?? Math.floor(tick) + 1) - Math.round(age * 20);
          scale = radius / (30.553667 * (14.977777 + 61.333333 * age));
        }
      }
      const item = this.place(
        "area/" + a.id,
        name,
        start,
        scale,
        a.position,
        a.direction,
        frame,
        0,
        true,
      );
      if (stellar && a.phase === "warning" && a.next_tick != null) {
        const progress = Math.max(
          0,
          Math.min(1, (tick - born) / Math.max(1, a.next_tick - born)),
        );
        if (item) item.sampleAge = progress * (a.enhanced ? 2.4 : 1.4);
        const q = frame.map.projection;
        const falling = this.place(
          "meteor/" + a.id,
          "aurelionsol_r/" + (a.enhanced ? "strong_missile" : "missile"),
          born,
          radius / 420,
          a.position,
          a.direction,
          frame,
          (420 * (1 - progress) * q) / Math.sqrt(1 - q * q),
          true,
          true,
        );
        falling?.rotation.multiply(
          new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI),
        );
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
      if (
        item.name === "void_gate/spawn" &&
        item.owner !== undefined &&
        item.cutoff === undefined
      ) {
        const until = units.get(item.owner)?.readyTick;
        if (until !== undefined && tick >= until)
          item.cutoff = Math.max(0, (until - item.start) / 20);
      }
      const expired =
        item.cutoff !== undefined
          ? age >= Math.min(duration, item.cutoff + emissionTail(item.name))
          : item.persistent
            ? !item.seen
            : age > duration;
      if (
        expired ||
        (item.stop !== undefined &&
          (tick >= item.stop ||
            (item.owner !== undefined && !units.has(item.owner))))
      ) {
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
      if (tick < item.start) {
        item.actor.root.visible = false;
        continue;
      }
      item.actor.root.visible = true;
      if (item.thrust) {
        const sign = this.seat ? -1 : 1,
          f = Math.min(1, (tick - item.start) / 6);
        const p = item.thrust.from,
          d = item.thrust.direction;
        item.thrust.launch ??=
          socket?.(
            item.thrust.caster,
            "Buffbone_Glb_Spear_Loc",
          )?.getWorldPosition(new Vector3()) ?? item.position.clone();
        const end = new Vector3(
          sign * (p.x + d.x * 120 - frame.map.width / 2),
          item.thrust.launch.y,
          sign * (p.y + d.y * 120 - frame.map.height / 2),
        );
        item.position.copy(item.thrust.launch).lerp(end, f);
      }
      const a = item.actor;
      if (item.hitSocket) {
        const { id, name } = item.hitSocket;
        socket?.(id, name)?.getWorldPosition(item.position);
      }
      if (item.owner !== undefined) {
        const gate = item.name.startsWith("void_gate/");
        const shield =
          item.name === "sivir/shield" || item.name === "sivir/shield_impact";
        if (gate || shield) {
          const node = socket?.(
            item.owner,
            gate ? "Buffbone_Ground" : "shieldRestCenter",
          );
          if (node) {
            node.getWorldPosition(item.position);
            if (gate) node.getWorldQuaternion(item.rotation);
            else item.position.y -= 85 * item.scale;
          }
        }
      }
      a.onlyLayers = item.onlyLayers;
      a.sources =
        item.ghostSkin ??
        (item.owner === undefined ? undefined : skin(item.owner));
      a.cableStart = item.cableStart;
      a.cableEnd = item.cableEnd;
      a.beamLength = item.beamLength ?? 3410;
      if (item.beamFrom !== undefined && item.beamTo !== undefined) {
        const from = anchor(item.beamFrom, true),
          target = units.get(item.beamTo);
        if (from) item.position.copy(from);
        if (target) {
          const sign = this.seat ? -1 : 1;
          this.delta
            .set(
              sign * (target.x - frame.map.width / 2),
              (anchor(target.id)?.y ?? 0) + target.radius,
              sign * (target.y - frame.map.height / 2),
            )
            .sub(item.position);
          a.beamLength = this.delta.length() / item.scale;
          if (this.delta.lengthSq())
            item.rotation.setFromRotationMatrix(
              this.aim.lookAt(this.delta, this.zero, up),
            );
        }
      }
      a.root.position.copy(item.position);
      a.root.quaternion.copy(item.rotation);
      if (item.axes) a.root.scale.copy(item.axes);
      else a.root.scale.setScalar(item.scale);
      a.fieldRadius = item.fieldRadius;
      a.overlayTime = item.name === "soul_tentacle/avatar" ? age : undefined;
      a.deathAge = item.deathAge === undefined ? undefined : age;
      const phase = item.persistent
        ? effectPhase(item.name, age, duration)
        : age;
      a.sample(
        item.sampleAge ?? phase,
        this.quality,
        empty,
        item.moving,
        item.cutoff,
      );
      this.needsBackdrop |= a.inputs;
      particles += a.drawn;
      if (a.drawn) instances++;
    }
    this.groundEffects.sample(tick, zones);
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
        scale: i.actor!.root.scale.toArray(),
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
    for (const h of this.histories.values()) h.dispose();
    this.histories.clear();
    this.rocks.retain(new Set());
    this.arrivals.retain(new Set());
    this.statuses.retain(new Set());
    this.groundEffects.reset();
    this.spellHistory.clear();
    this.needsBackdrop = 0;
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
