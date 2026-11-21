// Source particle units to battlefield units. The Godot game used 40 battlefield
// units per metre. Only effects with a fixed project scale belong in this table.
// Radius-dependent spells retain the scale calculated at the impact or cast.
export const fixedEffectScale: Readonly<Record<string, number>> = {
  "evolution_turret/spawn": 0.022 * 40,
  "gwen_tristana/rapid": 0.4,
  "hecarim/aoe": 120 / 517.7974672797,
  "hecarim/cas": 120 / 517.7974672797,
  "jack_in_the_box/aoe": 160 / 373,
  "jayce/swap_m": 0.38,
  "jayce/swap_r": 0.38,
  "kassadin/idle_blade": 0.0085 * 40,
  "malphite/shield": (0.0085 * 2.5 * 40) / 1.75,
  "malphite/break": (0.0085 * 2.5 * 40) / 1.75,
  "pillar_of_ice/pillar": 0.009 * 40,
  "reksai/buff": 0.32,
  "reksai/swipe": 0.32,
  "reksai/swipe_second": 0.32,
  "sivir/shield": 0.3,
  "sivir/shield_impact": 0.3,
  "thorn_spitter/buff": (0.016 * 40) / 1.2,
  "tryndamere/rage": 0.013175 * 40,
  "void_gate/death": 0.0240833333333333 * 40,
  "void_gate/idle": 0.0240833333333333 * 40,
  "void_gate/spawn": 0.0240833333333333 * 40,
  "void_gate/spit": 0.0240833333333333 * 40,
  "void_spawn/burst": 0.48,
  "void_spawn/death": 0.48,
  "void_spawn/energy": 0.24,
  "void_spawn/glow": 0.24,
  "void_spawn/spawn": 0.6,
  "void_spawn/trail": 0.6,
  "voidfish_ranged/spawn": 0.56,
};

// [end of opening, start of repeating segment, length of repeating segment].
// Some old actors start with a prewarmed sample; a zero opening models that.
const loops: Record<string, readonly [number, number, number]> = {
  aurelionsol_q: [4, 1, 3],
  "anivia/missile": [0, 0.05, 1.8],
  "gwen_tristana/missile": [0, 0.025, 2.9],
  "demacian_standard/flag": [0, 1, 8],
  "kassadin/idle_blade": [0, 2, 10],
  "pillar_of_ice/pillar": [24, 27, 20],
  "reksai/buff": [5, 1, 4],
  "samira/ready": [8, 4, 4],
  "sona/heal_self": [4, 2, 2],
  "ziggs/passive": [5, 1, 4],
};
const holds: Record<string, number> = {
  "soul_tentacle/avatar": 1,
  "gwen_tristana/rapid": 5,
  "missfortune_w/left": 3,
  "missfortune_w/right": 3,
  "thorn_spitter/buff": 6,
};
export function effectPhase(name: string, age: number, duration: number) {
  const loop = loops[name];
  if (loop) return age < loop[0] ? age : loop[1] + ((age - loop[0]) % loop[2]);
  if (holds[name] !== undefined) return Math.min(age, holds[name]);
  return age <= duration || duration <= 0
    ? age
    : duration / 2 + (age % (duration / 2));
}

const pillarRadii: Record<string, number> = {
  ice_cracks: 330,
  smoke_fall: 400,
  black_circle: 425,
};
const pillarBody = new Set(["ice_pillar", "Splash_Out", "rays", "base_glow"]);
export function pillarLayerScale(layer: string, radius: number) {
  return pillarBody.has(layer)
    ? 1
    : radius /
        ((pillarRadii[layer] ?? 450) *
          fixedEffectScale["pillar_of_ice/pillar"]);
}
export function pillarLayerAge(layer: string, age: number, deathAge?: number) {
  if (layer === "ice_pillar")
    return deathAge === undefined ? Math.min(age, 0.36) : 5.625 + deathAge;
  if (
    layer === "ice_cracks" ||
    layer === "base_glow" ||
    layer === "black_circle"
  )
    return Math.min(age, 4);
  return age;
}

const retireOnHit = new Set([
  "anivia/missile",
  "graves/missile",
  "gwen_tristana/missile",
  "ivern/basic",
  "jack_in_the_box/missile",
  "jayce/bullet",
  "samira/bullet",
  "sona/basic",
  "thorn_spitter/missile",
  "twistedfate/card",
  "twistedfate/fan",
  "twistedfate/red",
  "twistedfate/blue",
]);
export function emissionTail(name: string) {
  if (retireOnHit.has(name)) return 0;
  if (name.startsWith("ziggs/") || name === "void_gate/spawn") return Infinity;
  if (name === "sona/wave") return 1.5;
  if (name === "reksai/travel") return 1.8;
  return 0.45;
}
