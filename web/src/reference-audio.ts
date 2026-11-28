import manifest from "./battle-audio-banks.json";
import type { BattleSound } from "./presentation";

export interface ClipEvent {
  pool: number[];
  volume_db?: number;
  clip_volume_db?: Partial<Record<string, number>>;
  bus?: string;
  owner?: string;
  scope?: string;
  action_time?: number;
  fade_in?: number;
  fade_out?: number;
  fade_out_curve?: string;
  natural_tail?: boolean;
}
interface Profile {
  events?: Partial<Record<string, ClipEvent>>;
  attack_swing?: number[][];
  attack_hit?: number[];
  empowered_hit?: number[];
  first_strike_hit?: number[];
  attack_hit_by_segment?: number[][];
  attack_launch_by_segment?: number[][];
  empowered_hit_by_segment?: number[][];
  empowered_swing_by_segment?: number[][];
  attack_hit_once_by_segment?: boolean[];
  attack_launch_until_impact?: boolean;
  attack_swing_lead_time?: number;
  attack_swing_volume_db?: number;
  attack_hit_volume_db?: number;
}
export const audioCatalog: {
  files: string[];
  clips: number[][];
  variants: Record<string, number>;
  profiles: Profile[];
} = manifest;
const emptyProfile: Profile = {};
export function profileForSound(
  kind: string,
  team: number,
  form = false,
): Profile {
  const index =
    audioCatalog.variants[[kind, Number(form), team].join("/")] ??
    audioCatalog.variants[[kind, 0, team].join("/")] ??
    audioCatalog.variants[kind + "/0/0"];
  return audioCatalog.profiles[index] ?? emptyProfile;
}
export interface Selection {
  name: string;
  spec: ClipEvent;
}
export function soundEvents(s: BattleSound): Selection[] {
  const profile = profileForSound(s.kind, s.team, s.form);
  const events = profile.events ?? {};
  const result: Selection[] = [];
  const add = (name: string, spec = events[name]) => {
    if (
      spec?.pool.length &&
      (spec.owner !== "result" || s.released) &&
      (spec.action_time === undefined || s.timed)
    )
      result.push({ name, spec });
  };
  const index = s.segment ?? Math.max((s.cycle ?? 1) - 1, 0);
  const segment = (pools?: number[][]) =>
    pools?.length ? pools[index % pools.length] : undefined;
  const pool = (name: string, ids?: number[], volume_db = 0) => {
    if (ids?.length) add(name, { pool: ids, volume_db });
  };
  switch (s.phase) {
    case "spawn":
      add("spawn:start");
      if (s.deploy !== false) {
        add("deploy:start");
        add("deploy:voice");
      }
      break;
    case "death":
      add("death");
      add("death:voice");
      break;
    case "windup":
    case "windup2":
      if (s.empowered && segment(profile.empowered_swing_by_segment))
        pool(
          "empowered_swing",
          segment(profile.empowered_swing_by_segment),
          profile.attack_swing_volume_db,
        );
      else if (s.empowered && events.empowered_swing) add("empowered_swing");
      else if (s.first && events["first_strike:cast"]) add("first_strike:cast");
      else if (s.immune && events["control_immunity:attack_swing"])
        add("control_immunity:attack_swing");
      else if (s.buff && events["active_buff:attack_swing"])
        add("active_buff:attack_swing");
      else if (events["attack:cast"]) add("attack:cast");
      else
        pool(
          "attack_swing",
          segment(profile.attack_swing),
          profile.attack_swing_volume_db,
        );
      break;
    case "release":
      if (s.first && events["first_strike:missile_cast"])
        add("first_strike:missile_cast");
      else add("attack_missile_cast");
      if (profile.attack_launch_until_impact) break;
      if (s.empowered && events.empowered_launch) add("empowered_launch");
      else if (s.first && events["first_strike:missile_launch"])
        add("first_strike:missile_launch");
      else if (s.buff && events["active_buff:attack_launch"])
        add("active_buff:attack_launch");
      else if (profile.attack_launch_by_segment)
        pool("attack_launch", segment(profile.attack_launch_by_segment));
      else if (events["attack:launch"]) add("attack:launch");
      else add("attack_launch");
      break;
    case "projectileFlight":
      if (profile.attack_launch_by_segment)
        pool("attack_launch", segment(profile.attack_launch_by_segment));
      else add("attack_launch");
      break;
    case "hit":
      if (s.first && profile.first_strike_hit?.length) {
        pool(
          "first_strike_hit",
          profile.first_strike_hit,
          profile.attack_hit_volume_db,
        );
        add("first_strike:hit_location");
      } else if (
        s.empowered &&
        (profile.empowered_hit_by_segment || profile.empowered_hit)
      )
        pool(
          "empowered_hit",
          segment(profile.empowered_hit_by_segment) ?? profile.empowered_hit,
          profile.attack_hit_volume_db,
        );
      else if (s.immune && events["control_immunity:attack_hit"])
        add("control_immunity:attack_hit");
      else if (s.buff && events["active_buff:attack_hit"])
        add("active_buff:attack_hit");
      else
        pool(
          "attack_hit",
          segment(profile.attack_hit_by_segment) ?? profile.attack_hit,
          profile.attack_hit_volume_db,
        );
      break;
    case "volleyStart":
      add("active:start");
      break;
    case "volleyHit":
      add("active:hit");
      break;
    case "volleyRelease":
      add("active:release");
      break;
    case "damage1":
      add("damage:stage1");
      break;
    case "damage2":
      add("damage:stage2");
      break;
    case "hurt":
      add("hit");
      break;
    default:
      add(s.phase);
  }
  return result;
}
// Keep the variant and clip index visible in the workbench. A cast can use the
// same file in several timing segments with different gain.
export function profileSelections(profile: Profile): Selection[] {
  const selections: Selection[] = [];
  for (const [name, spec] of Object.entries(profile.events ?? {})) {
    if (spec?.pool.length) selections.push({ name, spec });
  }
  const group = (name: string, pool?: number[], volume_db = 0) => {
    if (pool?.length) selections.push({ name, spec: { pool, volume_db } });
  };
  group("attack_hit", profile.attack_hit, profile.attack_hit_volume_db);
  group("empowered_hit", profile.empowered_hit, profile.attack_hit_volume_db);
  group(
    "first_strike_hit",
    profile.first_strike_hit,
    profile.attack_hit_volume_db,
  );
  const segments = (name: string, pools?: number[][], db = 0) =>
    pools?.forEach((pool, i) => group(name + " [" + (i + 1) + "]", pool, db));
  segments(
    "attack_swing",
    profile.attack_swing,
    profile.attack_swing_volume_db,
  );
  segments(
    "attack_hit",
    profile.attack_hit_by_segment,
    profile.attack_hit_volume_db,
  );
  segments("attack_launch", profile.attack_launch_by_segment);
  segments(
    "empowered_hit",
    profile.empowered_hit_by_segment,
    profile.attack_hit_volume_db,
  );
  segments(
    "empowered_swing",
    profile.empowered_swing_by_segment,
    profile.attack_swing_volume_db,
  );
  return selections;
}
export function clipGainDb(id: number, spec: ClipEvent) {
  return (spec.volume_db ?? 0) + (spec.clip_volume_db?.[id] ?? 0);
}
export function clipSlice(id: number, spec: ClipEvent) {
  const [bank, offset, samples] = audioCatalog.clips[id];
  return {
    bank,
    start: offset / 44100,
    duration: samples / 44100,
    gain: 10 ** (clipGainDb(id, spec) / 20),
  };
}
const dependencies = new WeakMap<Profile, Set<number>>();
export function profileBanks(profile: Profile) {
  let result = dependencies.get(profile);
  if (!result) {
    result = new Set<number>();
    for (const { spec } of profileSelections(profile)) {
      for (const id of spec.pool) result.add(audioCatalog.clips[id][0]);
    }
    dependencies.set(profile, result);
  }
  return result;
}
