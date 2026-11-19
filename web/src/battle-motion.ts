import rosterData from "./roster-models.json" with { type: "json" };
import type { Unit } from "./battle-field";

export interface ActionClip {
  clip: string;
  ticks?: number;
  blend?: number;
  outBlend?: number;
}
interface ActionSequence {
  clips: string[];
  durations?: number[];
  clip_ranges?: [number, number][];
  blend_in?: number;
  sequence_blend?: number;
}
export interface ModelProfile {
  hands?: string[];
  roles?: Record<string, string[]>;
  actions?: Record<string, ActionSequence>;
  packs?: Record<string, string[]>;
  packFiles?: Record<string, string>;
  air?: boolean;
  timing?: {
    attack_hit_duration?: number | number[];
    attack_clip_ranges?: [number, number][];
    attack_hit_clip_ranges?: [number, number][];
    attack_stance_duration?: number;
    deploy_clip_ratio?: number;
    deploy_durations?: number[];
  };
  followup?: {
    asset: string;
    clip: string;
    ticks?: number;
    immediate: boolean;
  };
  asset: string;
  scale: number;
  groundOffset: number;
  barHeight?: number;
  yaw?: number;
  fixedFacing?: boolean;
  deploy?: string;
  channel?: string;
  channelEnter?: string;
  dormant?: string;
  intro?: { hold: string; clip: string; ticks: number };
  idleCycle?: string[];
  additive?: string;
  setupPose?: string;
  events?: Partial<Record<"hit" | "summon", ActionClip>>;
  transitions?: Record<string, ActionClip>;
  clipBlends?: Record<string, number>;
  blends?: { attack: number; idle: number };
  surfaceMode?: "tower" | "crystal" | "effigy";
  idle: string;
  run: string;
  attacks: { clip: string; marker?: number }[];
  death: {
    clip: string;
    ticks: number;
    blend: number;
    clipEnd?: number;
    holdEnd?: boolean;
  };
  hand?: string;
  casts?: Record<string, { clip: string; marker: number; action?: string }>;
}

// GLB axes are Y-up / +Z forward. Scales are in battlefield units.
const ashe: ModelProfile = {
  asset: "ashe",
  scale: 0.48,
  groundOffset: 0,
  idle: "Idle1",
  run: "Run",
  attacks: [
    { clip: "Attack1", marker: 9 / 30 },
    { clip: "Attack2", marker: 9 / 30 },
  ],
  death: { clip: "Death", ticks: 16, blend: 2 },
  hand: "R_hand",
  casts: { "ashe.volley": { clip: "Spell2", marker: 9 / 30 } },
};
const order: ModelProfile = {
  asset: "melee-order",
  deploy: "Idle1",
  scale: 0.288,
  groundOffset: -0.56,
  idle: "Idle1",
  run: "Run",
  attacks: [
    { clip: "Attack1", marker: 11.8 / 30 },
    { clip: "Attack2", marker: 11.8 / 30 },
  ],
  death: { clip: "Death", ticks: 10, blend: 0 },
};
const chaos: ModelProfile = {
  ...order,
  asset: "melee-chaos",
  scale: 0.252,
  groundOffset: 1.52,
};
function building(
  asset: string,
  scale: number,
  idle: string,
  death: string,
  options: Partial<ModelProfile> = {},
): ModelProfile {
  return {
    asset,
    scale,
    idle,
    run: idle,
    groundOffset: 0,
    attacks: [],
    death: { clip: death, ticks: 16, blend: 0 },
    ...options,
  };
}
function attacks(names: string[], frames?: number) {
  return names.map((clip) => ({
    clip,
    marker: frames === undefined ? undefined : frames / 30,
  }));
}
function teams(base: ModelProfile): [ModelProfile, ModelProfile] {
  return ["blue", "red"].map((team) => ({
    ...base,
    asset: base.asset + "-" + team,
  })) as [ModelProfile, ModelProfile];
}
function minions(
  role: string,
  scale: [number, number],
  offset: [number, number],
  clips: string[],
  marker: [number, number],
  death: string,
  hand?: string,
): [ModelProfile, ModelProfile] {
  return ["order", "chaos"].map((side, i) => ({
    ...order,
    asset: role + "-" + side,
    scale: scale[i],
    groundOffset: offset[i],
    attacks: attacks(clips, marker[i]),
    death: { clip: death, ticks: 10, blend: 0 },
    hand,
  })) as [ModelProfile, ModelProfile];
}
const standardAttacks = ["Attack1", "Attack2"],
  cannonAttacks = ["Attack1_BASE", "Attack2_BASE"];
const dummy = teams(
  building("target_dummy", 90, "Idle1_Base", "Death", {
    groundOffset: -0.836,
    death: { clip: "Death", ticks: 20, blend: 0 },
    events: { hit: { clip: "Hit", blend: 0.8, outBlend: 1.6 } },
    deploy: "Spawn",
  }),
);
const effigy = building(
  "scarecrow",
  0.48,
  "fiddlesticks_idle1",
  "fiddlesticks_death_effigies",
  {
    run: "fiddlesticks_run",
    deploy: "fiddlesticks_respawn",
    channel: "fiddlesticks_spell2_channel",
    channelEnter: "fiddlesticks_spell2",
    transitions: {
      "fiddlesticks_run>idle": {
        clip: "fiddlesticks_idlein1",
        blend: 1,
        outBlend: 0,
      },
      "fiddlesticks_spell2_to_run>idle": {
        clip: "fiddlesticks_idlein1",
        blend: 1,
        outBlend: 0,
      },
      "fiddlesticks_spell2_channel>idle": {
        clip: "fiddlesticks_spell2_channel_toidle",
        blend: 0,
        outBlend: 0,
      },
      "fiddlesticks_spell2>idle": {
        clip: "fiddlesticks_spell2_channel_toidle",
        blend: 0,
        outBlend: 0,
      },
      "fiddlesticks_spell2_channel>run": {
        clip: "fiddlesticks_spell2_to_run",
        blend: 0,
        outBlend: 0,
      },
      "fiddlesticks_spell2>run": {
        clip: "fiddlesticks_spell2_to_run",
        blend: 0,
        outBlend: 0,
      },
      "fiddlesticks_spell2_channel_toidle>run": {
        clip: "fiddlesticks_spell2_to_run",
        blend: 2,
        outBlend: 0,
      },
    },
    clipBlends: {
      "fiddlesticks_spell2>fiddlesticks_spell2_channel": 0,
      "fiddlesticks_spell2_to_run>fiddlesticks_spell2": 1.6,
      "fiddlesticks_spell2_channel_toidle>fiddlesticks_spell2": 1.6,
    },
    death: { clip: "fiddlesticks_death_effigies", ticks: 38.8, blend: 1.6 },
    surfaceMode: "effigy",
  },
);
const models: Record<string, ModelProfile | [ModelProfile, ModelProfile]> = {
  ashe,
  melee_minion: [order, chaos],
  ranged_minion: minions(
    "ranged",
    [0.32, 0.3],
    [-0.88, -1.16],
    standardAttacks,
    [14.1, 14],
    "Death",
    "Buffbone_Glb_Weapon_1",
  ),
  siege_minion: minions(
    "siege",
    [0.484, 0.484],
    [0.04, 0.54],
    cannonAttacks,
    [9, 9],
    "Death",
    "Cannon",
  ),
  super_minion: minions(
    "super",
    [0.548, 0.548],
    [0.36, -2],
    standardAttacks,
    [15, 15],
    "Death_Base",
  ),
  princess_tower: teams(
    building("princess_tower", 0.4, "Idle1", "Destroyed", {
      surfaceMode: "tower",
      fixedFacing: true,
    }),
  ),
  nexus: teams(
    building("nexus", 0.2136, "Idle1_Base", "Death", {
      intro: {
        hold: "Nexus_spawn_hold.anm",
        clip: "Nexus_spawn.anm",
        ticks: 5.1666667 * 20,
      },
      death: { clip: "Death", ticks: 160, blend: 0 },
      surfaceMode: "crystal",
      fixedFacing: true,
    }),
  ),
  inhibitor: teams(
    building("inhibitor", 30.4, "Idle_Normal1", "Death_Base", {
      barHeight: 2.61 * 40,
      deploy: "SRUAP_ChaosInhibitor_spawn.anm",
      death: { clip: "Death_Base", ticks: 20, blend: 0, clipEnd: 5 },
      surfaceMode: "crystal",
      yaw: Math.PI,
      fixedFacing: true,
    }),
  ),
  target_dummy: dummy,
  training_dummy: dummy,
  apex_turret: building("apex_turret", 0.66, "Idle1", "Death", {
    groundOffset: 0.11,
    casts: {
      "apex_turret.hextech-piercing-laser": {
        clip: "Attack_Beam",
        marker: 0.45,
      },
    },
    deploy: "Spawn",
    attacks: attacks(["Attack1"]),
  }),
  evolution_turret: building("evolution_turret", 0.88, "Idle1", "Death", {
    hand: "Rocket",
    dormant: "Deactivate_Idle",
    transitions: {
      "*>dormant": { clip: "Deactivate" },
      "Deactivate_Idle>*": { clip: "Activate", ticks: 4 },
      "Deactivate>*": { clip: "Activate", ticks: 4 },
    },
    deploy: "Spawn",
    attacks: attacks(standardAttacks),
  }),
  demacian_standard: building(
    "demacian_standard",
    0.4,
    "summonerbeacon_idle",
    "summonerbeacon_death",
    { fixedFacing: true },
  ),
  gold_ward: building(
    "gold_ward",
    0.72,
    "sightward_base_idle",
    "sightward_base_idle_death",
    { deploy: "sightward_base_idlein" },
  ),
  jack_in_the_box: building("jack_in_the_box", 4, "Idle1", "Death", {
    hand: "head",
    attacks: attacks(["Attack1"]),
  }),
  pillar_of_ice: building("pillar_of_ice", 0.36, "Idle", "Death", {
    barHeight: 3.06 * 40,
    deploy: "Rise",
    fixedFacing: true,
  }),
  powder_keg: building("powder_keg", 0.7, "Idle1", "Death", {
    groundOffset: 2.612,
    events: { hit: { clip: "Timer", blend: 0, outBlend: 1.6 } },
    deploy: "Spawn",
  }),
  queen_nest: building(
    "queen_nest",
    0.468,
    "reksaitunnel_idle1",
    "reksaitunnel_death_open",
    {
      deploy: "reksaitunnel_spawn",
      yaw: Math.PI,
    },
  ),
  scarecrow: effigy,
  fiddlesticks: effigy,
  soul_tentacle: building(
    "soul_tentacle",
    0.4,
    "illaoiminion_idleangry",
    "illaoiminion_death",
    {
      deploy: "illaoiminion_spawn",
      attacks: attacks(["illaoiminion_attack1"]),
      blends: { attack: 2.4, idle: 3.2 },
      death: { clip: "illaoiminion_death", ticks: 16, blend: 1.6 },
    },
  ),
  sun_disc: teams(
    building("sun_disc", 0.688, "Idle1_Base", "Death", {
      hand: "joint2",
      deploy: "Spawn",
      attacks: attacks(cannonAttacks),
      idleCycle: [
        "Idle1_Base",
        "Idle1_Base",
        "Idle1_Base",
        "Idle1_Base",
        "Idle2_Base",
        "Idle1_Base",
        "Idle1_Base",
        "Idle2_Base",
        "Idle1_Base",
      ],
      clipBlends: Object.fromEntries(
        [
          "Spawn>Idle1_Base",
          "Spawn>Attack1_BASE",
          "Idle1_Base>Idle2_Base",
          "Idle2_Base>Idle1_Base",
          "Idle1_Base>Attack1_BASE",
          "Idle1_Base>Attack2_BASE",
          "Attack1_BASE>Idle1_Base",
          "Attack2_BASE>Idle1_Base",
          "Attack1_BASE>Attack2_BASE",
          "Attack2_BASE>Attack1_BASE",
        ].map((edge) => [edge, 0]),
      ),
      death: { clip: "Death", ticks: 16, blend: 0, clipEnd: 2 },
    }),
  ),
  thorn_spitter: building("thorn_spitter", 0.64, "Idle1", "Death", {
    setupPose: "Buffbones",
    hand: "Buffbone_Glb_Weapon_1",
    deploy: "Up",
    attacks: attacks(["Attack1"]),
  }),
  vine_lasher: building("vine_lasher", 0.64, "Idle1", "Death", {
    deploy: "Up",
    attacks: attacks(standardAttacks),
  }),
  tombstone: building("tombstone", 0.2, "Idle1", "Death", {
    barHeight: 1.34 * 40,
    groundOffset: 3.89,
    clipBlends: { "Spawn>Idle1": 0 },
    deploy: "Spawn",
  }),
  void_gate: building("void_gate", 68, "Idle1", "Death", {
    deploy: "Spawn",
    additive: "Spit",
    events: { summon: { clip: "Spit", ticks: 0.9333333 * 20 } },
    death: { clip: "Death", ticks: 44, blend: 0, holdEnd: true },
  }),
};
const roster = rosterData as unknown as Record<string, ModelProfile[]>;
export const modelProfiles = [
  ...new Set([
    ...Object.values(models).flat(),
    ...Object.values(roster).flat(),
  ]),
];
export function skillPacks(profile: ModelProfile) {
  return Object.keys(profile.packs ?? profile.casts ?? {});
}
export function castPack(profile: ModelProfile, skill?: string | null) {
  if (skill && (profile.packs ?? profile.casts)?.[skill])
    return (
      profile.packFiles?.[skill] ?? profile.asset + "-" + skill.split(".").pop()
    );
}
export function profileFor(
  unit: Pick<Unit, "kind" | "team" | "alternateForm" | "visual">,
): ModelProfile | undefined {
  const forms = roster[unit.kind];
  if (forms && unit.visual?.action?.[0] === "death_form") return forms[0];
  if (forms) return (unit.alternateForm && forms[1]) || forms[0];
  const entry = models[unit.kind];
  return Array.isArray(entry) ? entry[unit.team] : entry;
}
export function alternateProfile(kind: string) {
  return roster[kind]?.[1];
}
const deathBodies = new Map<string, ModelProfile>();
export function followupProfile(
  profile: ModelProfile,
): ModelProfile | undefined {
  const follow = profile.followup;
  if (!follow) return;
  const known =
    modelProfiles.find((p) => p.asset === follow.asset) ??
    deathBodies.get(follow.asset);
  if (known) return known;
  const body = {
    asset: follow.asset,
    scale: 40,
    groundOffset: 0,
    idle: follow.clip,
    run: follow.clip,
    attacks: [],
    death: { clip: follow.clip, ticks: follow.ticks ?? 20, blend: 0 },
  };
  deathBodies.set(follow.asset, body);
  return body;
}

export interface Motion {
  segment?: number;
  empowered?: boolean;
  clipRatio?: number;
  clip: string;
  key: string;
  start: number;
  end?: number;
  release?: number;
  marker?: number;
  rate?: number;
  clipEnd?: number;
  clipStart?: number;
  blend?: number;
}

export function motionFor(
  u: Unit,
  profile: ModelProfile,
  tick: number,
): Motion {
  if (profile.surfaceMode === "tower") {
    const health = u.hp / u.maxHp;
    const clip =
      health <= 1 / 3 ? "State3" : health <= 2 / 3 ? "State2" : profile.idle;
    return { clip, key: clip, start: u.since };
  }
  if (profile.intro && tick < profile.intro.ticks)
    return tick <= 0
      ? { clip: profile.intro.hold, key: "hold", start: 0, end: 1, blend: 0 }
      : {
          clip: profile.intro.clip,
          key: "intro",
          start: 0,
          end: profile.intro.ticks,
          blend: 0,
        };
  if (profile.roles) {
    const native = rosterMotion(u, profile, tick);
    if (native) return native;
  }
  if (profile.channel && u.activity === "Channeling")
    return { clip: profile.channel, key: "channel:" + u.since, start: u.since };
  if (
    profile.deploy &&
    (u.activity === "Deploying" || tick < (u.readyTick ?? 0))
  )
    return {
      clip: profile.deploy,
      key: "deploy",
      start: u.since,
      end: profile.deploy === profile.idle ? undefined : u.readyTick,
    };
  if (profile.dormant && u.dormant)
    return { clip: profile.dormant, key: "dormant", start: u.since };
  const cast = u.skill && profile.casts?.[u.skill];
  if (cast && tick < u.castEnd) {
    return {
      clip: cast.clip,
      key: "cast:" + u.castStart,
      start: u.castStart,
      end: u.castEnd,
      release: u.impactTick,
      marker: cast.marker,
    };
  }
  const attack = u.attack;
  if (
    attack &&
    profile.attacks.length &&
    (u.activity === "Windup" || u.activity === "Recover") &&
    tick < attack.end
  ) {
    const clip = profile.attacks[(attack.cycle - 1) % profile.attacks.length];
    return {
      ...clip,
      blend: profile.blends?.attack,
      key: "swing:" + attack.start,
      start: attack.start,
      release: attack.release,
      end: attack.end,
    };
  }
  if (
    profile.run !== profile.idle &&
    (u.activity === "March" || u.activity === "Chase")
  ) {
    return {
      clip: profile.run,
      key: "run",
      start: u.since,
      rate: u.movementRate / 1000,
    };
  }
  return {
    clip: profile.idle,
    key: "idle",
    start: u.since,
    blend: profile.intro ? 0 : profile.blends?.idle,
  };
}

function phaseMotion(
  sequence: ActionSequence,
  key: string,
  start: number,
  end: number,
  tick: number,
): Motion {
  const lengths = sequence.clips.map((_, i) => sequence.durations?.[i] ?? 1);
  const total = lengths.reduce((a, b) => a + b, 0) || 1;
  let phaseStart = start;
  for (let i = 0; i < lengths.length; i++) {
    const phaseEnd = phaseStart + ((end - start) * lengths[i]) / total;
    if (tick < phaseEnd || i === lengths.length - 1) {
      const range = sequence.clip_ranges?.[i];
      return {
        clip: sequence.clips[i],
        key: key + ":" + i,
        start: phaseStart,
        end: phaseEnd,
        clipStart: range?.[0],
        clipEnd: range?.[1],
        blend:
          (i ? (sequence.sequence_blend ?? 0) : (sequence.blend_in ?? 0.1)) *
          20,
      };
    }
    phaseStart = phaseEnd;
  }
  return { clip: sequence.clips[0], key, start, end };
}

function rosterMotion(
  u: Unit,
  profile: ModelProfile,
  tick: number,
): Motion | undefined {
  const roles = profile.roles!;
  const state = u.visual;
  const cast = u.skill && profile.casts?.[u.skill];
  const action = (name: string, start: number, end: number) => {
    const seq = profile.actions?.[name];
    return seq && phaseMotion(seq, name + ":" + start, start, end, tick);
  };
  if (state?.action) {
    const [name, start, end] = state.action;
    const cue = action(name, start, end);
    if (cue && tick >= start && tick < end) return cue;
  }
  if (
    state?.formStart !== undefined &&
    tick < state.formStart + (state.formTicks || 6)
  ) {
    const name = u.alternateForm
      ? state.activeForm && profile.actions?.transform_active
        ? "transform_active"
        : "transform"
      : "revert";
    const motion = action(
      name,
      state.formStart,
      state.formStart + (state.formTicks || 6),
    );
    if (motion) return motion;
  }
  if (u.activity === "Deploying" || tick < (u.readyTick ?? 0)) {
    const seq = roles.deploy;
    if (seq?.length && u.readyTick !== undefined)
      return {
        ...phaseMotion(
          { clips: seq, durations: profile.timing?.deploy_durations },
          "deploy",
          u.deployStart ?? u.since,
          u.readyTick,
          tick,
        ),
        clipRatio: profile.timing?.deploy_clip_ratio,
      };
  }
  if (cast && cast.action && tick < u.castEnd) {
    let name = cast.action;
    if (name === "active_0")
      name = "active_" + Math.min(3, Math.floor(state?.castResource ?? 0));
    else if (state?.strong && profile.actions?.[name + "_strong"])
      name += "_strong";
    else if (state?.strong && profile.actions?.[name + "_empowered"])
      name += "_empowered";
    else if (state?.big && profile.actions?.[name + "_big"]) name += "_big";
    return action(name, u.castStart, u.castEnd);
  }
  const atk = u.attack;
  if (
    atk &&
    (u.activity === "Windup" || u.activity === "Recover") &&
    tick < atk.end
  ) {
    let attackRole = "attack";
    if (atk.empowered && roles.empowered_attack)
      attackRole = "empowered_attack";
    else if (state?.buff && roles.active_buff_attack)
      attackRole = "active_buff_attack";
    else if (state?.immune && roles.control_immune_attack)
      attackRole = "control_immune_attack";
    else if (atk.structureTarget && roles.attack_structure)
      attackRole = "attack_structure";
    else if (atk.cycle === 1 && roles.first_strike_attack)
      attackRole = "first_strike_attack";
    const starts = roles[attackRole];
    if (starts?.length) {
      let i = (atk.cycle - 1) % starts.length;
      if (u.kind === "samira") i = ((atk.cycle - 1) % 2) + (atk.close ? 2 : 0);
      const prefix =
        attackRole === "empowered_attack" && roles.empowered_attack_hit
          ? "empowered_attack"
          : "attack";
      const hit = roles[prefix + "_hit"]?.[i];
      const key = "swing:" + atk.start + ":" + attackRole;
      const segment = { segment: i, empowered: atk.empowered };
      if (!hit)
        return {
          ...segment,
          clip: starts[i],
          key,
          start: atk.start,
          end: atk.end,
          release: atk.release,
          marker: profile.attacks[i]?.marker,
        };
      const range = profile.timing?.attack_clip_ranges?.[i];
      if (tick < atk.release)
        return {
          ...segment,
          clip: starts[i],
          key,
          start: atk.start,
          end: atk.release,
          clipStart: range?.[0],
          clipEnd: range?.[1],
          release: atk.release,
        };
      const tail = roles.attack_recover?.[i];
      const delay = profile.timing?.attack_hit_duration;
      const recover = Math.min(
        atk.end,
        atk.release + 20 * (Array.isArray(delay) ? delay[i] : (delay ?? 0.3)),
      );
      if (tail && tick >= recover)
        return {
          ...segment,
          clip: tail,
          key: key + ":recover",
          start: recover,
          end: atk.end,
        };
      const hitRange = profile.timing?.attack_hit_clip_ranges?.[i];
      return {
        ...segment,
        clip: hit,
        key: key + ":hit",
        start: atk.release,
        end: tail ? recover : atk.end,
        clipStart: hitRange?.[0],
        clipEnd: hitRange?.[1],
        release: atk.release,
        marker: hitRange?.[0] ?? 0,
        blend: 0,
      };
    }
    if (roles.attack_loop)
      return { clip: roles.attack_loop[0], key: "attack-loop", start: u.since };
  }
  if (u.activity === "Channeling" && profile.channel)
    return {
      clip: profile.channel,
      key: "channel:" + u.target,
      start: u.since,
    };
  if (u.activity === "Channeling" && profile.actions?.channel)
    return {
      clip: profile.actions.channel.clips[0],
      key: "channel",
      start: u.since,
    };
  const move = u.activity === "Chase" || u.activity === "March";
  const mode = move ? "move" : "idle";
  const role = [
    state?.reload && (move ? "reload_move" : "reload"),
    state?.charge && move && "charge_move",
    state?.terrain && move && "terrain_move",
    u.hidden && "stealth_" + mode,
    state?.empowered && "empowered_" + mode,
    state?.buff && "active_buff_" + mode,
    state?.full && move && "full_resource_move",
    u.movementRate > 1000 && move && "haste_move",
  ].find((key): key is string => typeof key === "string" && !!roles[key]);
  if (role)
    return {
      clip: roles[role][0],
      key: role,
      start: u.since,
      rate: move ? u.movementRate / 1000 : 1,
    };
}

export function clipTime(motion: Motion, tick: number, duration: number) {
  duration = Math.min(
    duration * (motion.clipRatio ?? 1),
    motion.clipEnd ?? duration,
  );
  if (duration <= 0) return 0;
  const age = Math.max(0, tick - motion.start);
  if (motion.end === undefined)
    return ((age * (motion.rate ?? 1)) / 20) % duration;
  if (motion.marker !== undefined && motion.release !== undefined) {
    const marker = Math.min(motion.marker, duration);
    if (tick < motion.release) {
      const from = Math.min(motion.clipStart ?? 0, marker);
      return (
        from +
        ((marker - from) * age) / Math.max(1, motion.release - motion.start)
      );
    }
    const tail = Math.min(
      1,
      (tick - motion.release) / Math.max(1, motion.end - motion.release),
    );
    return marker + tail * (duration - marker);
  }
  const from = Math.min(motion.clipStart ?? 0, duration);
  return (
    from +
    (duration - from) *
      Math.min(1, age / Math.max(1, motion.end - motion.start))
  );
}

// Every bridge and event action is interruptible by a new authority state.
// Durations are read from the loaded clip unless the card selected a shorter window.
export class MotionSequence {
  private goal?: string;
  private lastClip?: string;
  private bridge?: Motion;
  private event?: Motion;
  private outBlend?: number;
  private previousTick?: number;
  private displayed?: Motion;
  private lastSwing?: { index: number; at: number; empowered: boolean };
  private sheathed = false;
  private channelStart?: number;
  private channelRetarget = false;

  private profile: ModelProfile;
  private duration: (clip: string) => number;
  constructor(profile: ModelProfile, duration: (clip: string) => number) {
    this.profile = profile;
    this.duration = duration;
  }

  trigger(action: ActionClip | undefined, tick: number, serial: number) {
    if (!action) return;
    this.event = this.once(action, tick, "event:" + serial);
    this.outBlend = action.outBlend;
  }

  private once(action: ActionClip, start: number, key: string): Motion {
    return {
      clip: action.clip,
      key,
      start,
      end: start + (action.ticks ?? this.duration(action.clip) * 20),
      blend: action.blend,
    };
  }

  resolve(goal: Motion, tick: number, frozen = false): Motion {
    const previous = this.previousTick ?? tick;
    this.previousTick = tick;
    if (frozen && this.displayed) {
      // The authority owns attack timings. Only pause our local one-shots.
      for (const pending of [this.event, this.bridge]) {
        if (!pending || pending.end === undefined) continue;
        const delta = Math.max(0, tick - Math.max(previous, pending.start));
        pending.start += delta;
        pending.end += delta;
      }
      return this.displayed;
    }
    const profile = this.profile;
    const roles = profile.roles;
    if (goal.segment !== undefined) {
      this.lastSwing = {
        index: goal.segment,
        at: tick,
        empowered: !!goal.empowered,
      };
      this.sheathed = false;
    }
    const move = goal.key === "run";
    const locomotion = move || goal.key === "idle";
    let entry: string | undefined;
    if (roles && locomotion) {
      const swing = this.lastSwing;
      if (move && !swing && roles.initial_move)
        goal = { ...goal, clip: roles.initial_move[0] };
      if (move && this.goal !== "run") entry = roles.move_enter?.[0];
      if (swing && !this.sheathed) {
        const previousAttack = this.goal?.startsWith("swing:");
        const index = swing.index;
        const stance = profile.timing?.attack_stance_duration;
        if (stance && tick >= swing.at + stance * 20) {
          entry =
            roles[move ? "attack_sheath_move" : "attack_sheath_idle"]?.[index];
          this.sheathed = true;
        } else {
          if (previousAttack)
            entry =
              roles[
                move
                  ? swing.empowered && roles.empowered_attack_to_move
                    ? "empowered_attack_to_move"
                    : "attack_to_move"
                  : "attack_idle_enter"
              ]?.[index] ?? entry;
          const loop = roles[move ? "attack_move" : "attack_idle"]?.[index];
          if (loop) goal = { ...goal, clip: loop };
        }
      }
    }
    let next = goal;
    if (goal.key !== this.goal || (entry && this.sheathed && !this.bridge)) {
      if (goal.key.startsWith("channel:")) {
        this.channelRetarget = !!this.goal?.startsWith("channel:");
        this.channelStart = this.channelRetarget ? tick : goal.start;
      }
      const edges = profile.transitions;
      const edge =
        this.goal &&
        edges &&
        (edges[this.lastClip + ">" + goal.key] ??
          edges["*>" + goal.key] ??
          edges[this.lastClip + ">*"]);
      const bridge = edge || (entry && { clip: entry });
      this.bridge = bridge
        ? this.once(bridge, tick, "bridge:" + tick)
        : undefined;
      if (edge) this.outBlend = edge.outBlend;
      this.goal = goal.key;
    }
    if (this.event && tick < this.event.end!) {
      next = this.event;
    } else if (this.bridge && tick < this.bridge.end!) {
      next = this.bridge;
    } else {
      this.event = this.bridge = undefined;
      if (goal.clip === profile.channel && profile.channelEnter) {
        const sequence = (this.channelRetarget &&
          roles?.attack_retarget_enter) ||
          roles?.attack_enter || [profile.channelEnter];
        let start = this.channelStart ?? goal.start;
        for (const clip of sequence) {
          const enter = this.once(
            { clip },
            start,
            "enter:" + clip + ":" + start,
          );
          if (tick < enter.end!) {
            next = enter;
            break;
          }
          start = enter.end!;
          next = { ...goal, start };
        }
      } else if (
        (goal.key === "idle" && profile.idleCycle) ||
        (move && roles?.move_cycle && goal.clip === profile.run)
      ) {
        const cycle = move ? roles!.move_cycle : profile.idleCycle!;
        const period = cycle.reduce(
          (total, clip) => total + this.duration(clip) * 20,
          0,
        );
        if (period > 0) {
          const rate = goal.rate || 1;
          let phase = (Math.max(0, tick - goal.start) * rate) % period;
          for (const clip of cycle) {
            const length = this.duration(clip) * 20;
            if (phase < length) {
              next = {
                ...goal,
                clip,
                start: tick - phase / rate,
                key: "cycle:" + clip,
              };
              break;
            }
            phase -= length;
          }
        }
      }
      if (this.outBlend !== undefined) {
        next = { ...next, blend: this.outBlend };
        this.outBlend = undefined;
      }
    }
    this.lastClip = next.clip;
    this.displayed = next;
    return next;
  }
}

export function clipRoles(profile: ModelProfile): Map<string, string> {
  const roles = new Map<string, string>();
  function add(clip: string | undefined, role: string) {
    if (!clip) return;
    const prior = roles.get(clip);
    if (!prior) roles.set(clip, role);
    else if (!prior.split(" / ").includes(role))
      roles.set(clip, prior + " / " + role);
  }
  for (const [role, names] of Object.entries(profile.roles ?? {}))
    for (const name of names) add(name, nativeRoleLabel(role));
  for (const [name, seq] of Object.entries(profile.actions ?? {}))
    for (const clip of seq.clips) add(clip, "动作 · " + name);
  add(profile.idle, "待机");
  add(profile.deploy, "部署");
  if (profile.intro) {
    add(profile.intro.hold, "开场保持");
    add(profile.intro.clip, "开场升起");
  }
  if (profile.run !== profile.idle) add(profile.run, "移动");
  for (const clip of profile.idleCycle ?? []) add(clip, "待机轮换");
  for (const action of profile.attacks) add(action.clip, "普攻");
  for (const action of Object.values(profile.casts ?? {}))
    add(action.clip, "施法");
  add(profile.dormant, "休眠");
  add(profile.events?.hit?.clip, "受击");
  add(profile.events?.summon?.clip, "召唤");
  add(profile.setupPose, "挂点基础姿态");
  add(profile.channelEnter, "引导起手");
  add(profile.channel, "持续引导");
  for (const [edge, action] of Object.entries(profile.transitions ?? {})) {
    const role = edge.endsWith(">dormant")
      ? "进入休眠"
      : edge.endsWith(">*")
        ? "唤醒"
        : edge.endsWith(">run")
          ? "衔接移动"
          : "衔接待机";
    add(action.clip, role);
  }
  if (profile.surfaceMode === "tower") {
    add("State2", "受损");
    add("State3", "重损");
    for (let i = 1; i <= 3; i++)
      add("NativeBreak" + i, ["受损掉块", "重损掉块", "摧毁掉块"][i - 1]);
  }
  if (profile.death.ticks > 0)
    add(profile.death.clip, profile.surfaceMode === "tower" ? "废墟" : "死亡");
  return roles;
}

function nativeRoleLabel(role: string) {
  const labels: Record<string, string> = {
    idle: "待机",
    move: "移动",
    deploy: "部署",
    attack: "普攻",
    death: "死亡",
    attack_enter: "攻击起手",
    attack_hit: "攻击命中",
    attack_recover: "攻击收势",
    attack_to_move: "攻击转移动",
    move_enter: "起步",
    move_cycle: "移动轮换",
    empowered_attack: "强化普攻",
    empowered_move: "强化移动",
    attack_structure: "攻击建筑",
    reload: "装填",
    reload_move: "移动装填",
    terrain_move: "穿越地形",
    attack_loop: "持续攻击",
  };
  return labels[role] ?? role;
}
