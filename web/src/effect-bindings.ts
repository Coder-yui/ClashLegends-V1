import type { Frame } from "./battle-field";

export type Spell = Frame["spells"][number];
export type Binding = { system: string; scale: number };
export type SpellLayer = {
  system: string;
  scale: number;
  start: number;
  stop?: number;
  height?: number;
  motion?: "arc" | "tidal";
};
export const missiles: Record<string, Binding> = {
  ashe: { system: "ashe/arrow", scale: 0.4 },
  anivia: { system: "anivia/missile", scale: 0.44 },
  sona: { system: "sona/basic", scale: 0.4 },
  jayce: { system: "jayce/bullet", scale: 0.38 },
  graves: { system: "graves/missile", scale: 0.4 },
  ivern: { system: "ivern/basic", scale: 0.4 },
  samira: { system: "samira/bullet", scale: 0.408 },
  thorn_spitter: { system: "thorn_spitter/missile", scale: 0.5333 },
  tristana: { system: "gwen_tristana/missile", scale: 0.4 },
  voidfish_ranged: { system: "voidfish_ranged/missile", scale: 0.56 },
  voidfish_ranged_single: { system: "voidfish_ranged/missile", scale: 0.56 },
  jack_in_the_box: { system: "jack_in_the_box/missile", scale: 0.4 },
  kayle_ranged: { system: "kayle/native/sword", scale: 0.12 },
  ziggs: { system: "ziggs/basic", scale: 0.4 },
};
export function missile(
  shot: Pick<
    Frame["shots"][number],
    "sourceKind" | "volley" | "form" | "empowered"
  >,
) {
  if (shot.sourceKind === "apex_turret" && shot.volley)
    return { system: "heimerdinger/charged", scale: 0.4 };
  if (shot.sourceKind === "teemo" && shot.empowered)
    return { system: "teemo/blind", scale: 0.4 };
  if (shot.sourceKind === "twitch" && shot.empowered)
    return { system: "twitch/pierce", scale: 0.4 };
  if (shot.sourceKind === "jinx" && shot.form)
    return { system: "jinx/rocket", scale: 0.4 };
  if (shot.volley) {
    const flight: Record<string, string> = {
      corki: "corki/rocket",
      twisted_fate: "twistedfate/fan",
      pantheon: "pantheon/spear",
    };
    if (flight[shot.sourceKind])
      return { system: flight[shot.sourceKind], scale: 0.4 };
  }
  if (shot.sourceKind === "ashe" && shot.volley)
    return { system: "ashe/volley", scale: 0.4 };
  if (shot.sourceKind === "sona" && shot.volley)
    return { system: "sona/wave", scale: 0.5 };
  if (shot.sourceKind === "ziggs" && shot.empowered)
    return { system: "ziggs/missile", scale: 0.4 };
  return missiles[shot.sourceKind];
}

// Project adaptations use source-space radii. Timings are relative to authoritative release/impact.
export function spellLayers(s: Spell, seat: number): SpellLayer[] {
  const enemy = s.team !== seat,
    red = enemy ? "_red" : "",
    r = s.radius ?? 100;
  const layer = (
    name: string,
    scale: number,
    start = s.born,
    stop?: number,
  ): SpellLayer => ({ system: s.key + "/" + name, scale, start, stop });
  switch (s.key) {
    case "final_spark":
      return ["cast", "beam"].map((n) => ({
        ...layer(n, (s.range ?? 800) / 3410),
        height: (160 * (s.range ?? 800)) / 3410,
      }));
    case "solar_flare":
      return [
        layer("warning" + red, r / 250, s.born + 5, s.impact),
        layer("impact", r / 250, s.impact),
      ];
    case "medium_lightning":
      return [
        layer(
          enemy ? "warning_enemy" : "warning",
          r / 325,
          enemy ? Math.max(s.born, s.impact - 20) : s.born,
          s.impact,
        ),
        layer("strike", r / 325, s.impact),
      ];
    case "event_horizon":
      return [
        layer("warning" + red, r / 390, s.born, s.impact),
        layer("cage" + red, r / 390, s.impact, s.end),
      ];
    case "stellar_convergence":
      return [
        layer("zone" + red, r / 377.428, s.born, s.end),
        layer("core" + red, 80 / 255.28, s.born, s.end),
      ];
    case "pool_of_reflection":
      return [
        layer("area", r / 350, s.born, s.end),
        ...(enemy ? [layer("area_red", r / 350, s.born, s.end)] : []),
      ];
    case "convergent_pulse":
      return ["pulse", "ball"].map((n) => ({
        ...layer(n, r / 378.6847),
        height: (30 * r) / 378.6847,
      }));
    case "severing_bolt":
      return [
        layer("warning" + red, r / 225, s.born, s.impact),
        layer("impact", r / 225, s.impact),
      ];
    case "mega_inferno_bomb":
      return [
        layer(
          enemy ? "warning_enemy" : "warning_ally",
          r / 476,
          s.born,
          s.impact,
        ),
        { ...layer("missile", r / 476, s.born, s.impact), motion: "arc" },
        layer("impact", r / 476, s.impact),
      ];
    case "stasis":
      return [
        layer("native/warning", r / 200, s.born, s.impact),
        { ...layer("native/flight", r / 350, s.born, s.impact), motion: "arc" },
        layer("native/impact", r / 350, s.impact),
      ];
    case "freeze":
      return [
        layer(
          s.enhanced ? "trundle" : "iceborn",
          r / (s.enhanced ? 790 : 310),
          s.impact,
        ),
      ];
    case "tidal_wave":
      return [
        {
          ...layer("wave", (s.waveWidth ?? 160) / 600, s.impact, s.end),
          motion: "tidal",
        },
      ];
    case "airdrop_bear":
      return [layer("impact", r / 260, s.impact)];
    case "heal":
      return [{ system: "janna/heal", scale: 0.4, start: s.impact }];
    case "corrosion":
      return [layer("area", r / 300, s.impact, s.end)];
    case "explosive_cask":
      return [
        { ...layer("flight", r / 350, s.born, s.impact), motion: "arc" },
        layer("native_end", r / 350, s.impact),
      ];
    case "void_summoning":
      return [
        {
          system: "void_summoning",
          scale: r / 400,
          start: s.impact,
          stop: s.end,
        },
      ];
    default:
      return [];
  }
}
export const castEffects: Record<string, Binding[]> = {
  "sona.crescendo": [{ system: "sona/cast", scale: 0.4 }],
  "malphite.ground-slam": [{ system: "malphite/cas", scale: 0.4 }],
  "hecarim.spirit-of-dread": [{ system: "hecarim/cas", scale: 0.4 }],
  "samira.inferno-trigger": [{ system: "samira/cas", scale: 0.4 }],
  "sett.haymaker": [
    { system: "sett/cast_body", scale: 0.4 },
    { system: "sett/warning", scale: 0.4 },
  ],
  "sion.soul-furnace": [{ system: "sion_w/Cas", scale: 0.4 }],
  "graves.quickdraw": [{ system: "graves/dash", scale: 0.4 }],
  "kassadin.riftwalk": [{ system: "kassadin/vanish", scale: 0.4 }],
  "azir.arise": [{ system: "azir/cast1", scale: 0.4 }],
  "ekko.chronobreak": [{ system: "ekko/r-ChargeUp", scale: 0.4 }],
  "demacian_standard.golden-aegis": [
    { system: "demacian_standard/nova", scale: 0.4 },
  ],
  "olaf.vicious-strikes": [{ system: "olaf/cas", scale: 0.4 }],
  "olaf.ragnarok": [{ system: "olaf/r_cas", scale: 0.4 }],
  "reksai.queen-s-wrath": [{ system: "reksai/buff", scale: 0.4 }],
  "xin.audacious-charge": [{ system: "xin_dash/buff", scale: 0.4 }],
  "jax.counter-strike": [{ system: "jax/buf", scale: 0.4 }],
};
export const buffEffects: Record<string, string> = {
  jax: "jax/buf",
  sion: "sion_w/Shield",
  samira: "samira/ready",
  tristana: "gwen_tristana/rapid",
  hecarim: "hecarim/aoe",
  gwen: "gwen_tristana/mist",
  missfortune: "missfortune_w/trail",
  thorn_spitter: "thorn_spitter/buff",
  vine_lasher: "thorn_spitter/buff",
  target_dummy: "aftershock/native/Buff",
};
export const spawnEffects: Record<string, string> = {
  void_gate: "void_gate/spawn",
  daisy: "ivern/spawn",
  voidling: "malzahar/spawn",
  evolution_turret: "evolution_turret/spawn",
  void_spawn_single: "void_spawn/spawn",
  voidfish_ranged: "voidfish_ranged/spawn",
  sand_soldier: "azir/spawn",
};
export const deathEffects: Record<string, string> = {
  void_gate: "void_gate/death",
  void_spawn: "void_spawn/death",
  void_spawn_single: "void_spawn/death",
  powder_keg: "powder_keg/explosion",
};
export const ambientEffects: Record<string, string[]> = {
  soul_tentacle: ["soul_tentacle/base_active"],
  void_gate: ["void_gate/idle"],
  kassadin: ["kassadin/idle_blade"],
  pillar_of_ice: ["pillar_of_ice/pillar"],
  demacian_standard: ["demacian_standard/flag"],
};

// Game identities may refer to the same native character in several deployed forms.
const additionalMissiles: Record<string, string> = {
  lulu: "lulu/bolt",
  pix: "lulu/pix",
  pix_single: "lulu/pix",
  corki: "corki/bullet",
  jinx: "jinx/bullet",
  teemo: "teemo/bolt",
  sivir: "sivir/blade",
  gnar: "gnar/boomerang",
  twitch: "twitch/bolt",
  twisted_fate: "twistedfate/card",
  malzahar: "malzahar/basic",
  missfortune: "missfortune/bullet",
  evolution_turret: "heimerdinger/turret",
  apex_turret: "heimerdinger/apex",
  ranged_minion: "sru_orderminionranged/bolt",
  siege_minion: "sru_orderminionranged/bolt",
  pantheon: "pantheon/spear",
  kayle: "kayle/native/sword",
  blitzcrank: "blitzcrank/qmis",
};
for (const [kind, system] of Object.entries(additionalMissiles))
  missiles[kind] = { system, scale: 0.4 };

const nativeCasts: Record<string, string> = {
  "aatrox.world-ender": "aatrox/empowered",
  "belveth.void-surge": "belveth/dash",
  "blitzcrank.power-fist": "blitzcrank/ebuf",
  "darius.noxian-guillotine": "darius/execute",
  "garen.decisive-strike": "garen/strike",
  "garen.judgment": "garen/spin",
  "gwen.snip-snip": "gwen/snip",
  "gwen.hallowed-mist": "gwen_tristana/mist",
  "gnar.rage-burst": "gnar/transform",
  "jack_in_the_box.fright": "jack_in_the_box/aoe",
  "jayce.hyper-charge-lightning-field": "jayce/w_ready2",
  "lulu.wild-growth": "lulu/growth",
  "masteryi.highlander": "masteryi/rush",
  "malzahar.void-swarm": "malzahar/cast",
  "missfortune.strut": "missfortune_w/left",
  "nocturne.shroud-of-darkness": "nocturne/shield",
  "nocturne.umbra-blades": "nocturne/cleave",
  "pillar_of_ice.frozen-domain": "trundle/domain",
  "scuttle_crab.humility": "scuttle_crab/randuin",
  "shurima_guard.sand-aegis": "azir/shield",
  "sivir.spell-shield": "sivir/shield",
  "sun_disc.solar-aegis": "azir/shield",
  "target_dummy.aftershock": "aftershock/native/Buff",
  "thorn_spitter.deadly-spines": "thorn_spitter/buff",
  "tombstone.gather-the-fallen": "malzahar/portal_start",
  "tristana.rapid-fire": "gwen_tristana/rapid",
  "tryndamere.undying-rage": "tryndamere/rage",
  "vine_lasher.grasping-roots": "thorn_spitter/buff",
  "void_gate.void-burst": "void_gate/spit",
  "void_spawn.void-empowerment": "void_spawn/energy",
  "yorick.last-rites": "yorick/rites",
  "rift_herald.sweeping-strike": "sru_riftherald/swipe",
  "soul_tentacle.faith-beyond-bounds": "soul_tentacle/activation",
  "queen_nest.queen-s-wrath": "reksai/emerge_cast",
  "kayle.celestial-blessing": "kayle/blessing",
};
for (const [id, system] of Object.entries(nativeCasts))
  castEffects[id] = [{ system, scale: 0.4 }];

Object.assign(buffEffects, {
  melee_minion: "void_spawn/glow",
  ranged_minion: "void_spawn/glow",
  siege_minion: "void_spawn/glow",
  super_minion: "void_spawn/glow",
  nocturne: "nocturne/shield",
  sivir: "sivir/shield",
  xin: "xinzhao/guard",
  tryndamere: "tryndamere/rage",
  olaf: "olaf/buf_glow",
  pix: "lulu/pix",
  voidfish_ranged: "void_spawn/energy",
  voidfish_ranged_single: "void_spawn/energy",
  reksai: "reksai/buff",
  void_spawn: "void_spawn/energy",
  soul_tentacle: "soul_tentacle/activation",
});
Object.assign(castEffects, {
  "xin.crescent-guard": [{ system: "xinzhao/crescent", scale: 0.4 }],
  "ornn.searing-charge": [{ system: "ornn/charge", scale: 0.4 }],
  "kayn.reaping-slash": [{ system: "kayn/dash", scale: 0.4 }],
  "apex_turret.hextech-piercing-laser": [
    { system: "heimerdinger/beam_charge", scale: 0.4 },
  ],
  "twitch.spray-and-pray": [{ system: "twitch/spray", scale: 0.4 }],
  "evolution_turret.hextech-repair": [{ system: "janna/heal", scale: 0.3 }],
  "void_scuttle_crab.return-to-the-void": [
    { system: "void_spawn/burst", scale: 0.4 },
  ],
  "gold_ward.perfect-timing": [{ system: "stasis/native/impact", scale: 0.2 }],
});
export const impacts: Record<string, string> = {
  ashe: "ashe/hit",
  azir: "azir/hit",
  aatrox: "aatrox/hit",
  daisy: "ivern/slam",
  sand_soldier: "azir/hit",
};
export const controlEffects: Record<string, string> = {
  Root: "morgana/rooted",
  Stun: "annie/stunned",
  Silence: "garen/silence",
  Freeze: "freeze/iceborn",
  Stasis: "stasis/native/impact",
};

// Additional independent effects use a public, position-bearing combat phase.
export const phaseEffects: Record<string, Record<string, string>> = {
  lightning: { "spell:strike": "lightning_spells/stormsurge" },
  zap: { "spell:strike": "lightning_spells/electrocute" },
  event_horizon: {
    "spell:meteor": "event_horizon/meteor",
    "spell:impact": "event_horizon/impact",
  },
  medium_lightning: { "spell:tower_disable": "medium_lightning/disabled" },
  solar_flare: { "spell:sunlight": "solar_flare/consume" },
  severing_bolt: { "spell:hit": "severing_bolt/hit" },
  stellar_convergence: { "spell:execute": "stellar_convergence/execute" },
  ornn: { "charge:impact": "ornn/impact" },
  sion: { "explosive_shield:break": "sion_w/Nova" },
  malphite: { "deployment_shield:break": "malphite/break" },
  ziggs: { "bomb:impact": "ziggs/hit", "bomb:basic_impact": "ziggs/hit" },
};
export const channelSystems: Record<string, string> = {
  aurelionsol: "aurelionsol_q",
  malzahar: "malzahar/grasp",
  fiddlesticks: "fiddlesticks/tether",
  scarecrow: "fiddlesticks/tether",
};
const relatedForms: Record<string, string[]> = {
  voidfish_ranged_army: ["voidfish_ranged"],
  ivern: ["daisy"],
  inhibitor: ["super_minion"],
  kayle: ["kayle_ranged"],
};
export function associatedSystems(
  kind: string,
  skills: readonly string[],
  members: readonly string[] = [],
) {
  const result = new Set<string>();
  for (const id of new Set([kind, ...members, ...(relatedForms[kind] ?? [])])) {
    for (const name of [
      channelSystems[id],
      missiles[id]?.system,
      spawnEffects[id],
      deathEffects[id],
      buffEffects[id],
      impacts[id],
      ...(ambientEffects[id] ?? []),
      ...Object.values(phaseEffects[id] ?? {}),
    ])
      if (name) result.add(name);
    for (const volley of [false, true])
      for (const form of [false, true])
        for (const empowered of [false, true]) {
          const flight = missile({ sourceKind: id, volley, form, empowered });
          if (flight) result.add(flight.system);
        }
    for (const team of [0, 1])
      for (const enhanced of [false, true]) {
        for (const layer of spellLayers(
          {
            id: 0,
            key: id,
            team,
            born: 0,
            impact: 20,
            end: 60,
            radius: 100,
            enhanced,
            origin: { x: 0, y: 0 },
            position: { x: 0, y: 0 },
          },
          0,
        ))
          result.add(layer.system);
      }
  }
  for (const skill of skills)
    for (const b of castEffects[skill] ?? []) result.add(b.system);
  return [...result];
}
