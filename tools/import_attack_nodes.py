"""Calibrate shipped attack clips against local League property bins and published GLBs."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import struct
import subprocess
import tempfile
from card_attack_timing import enrich_card_timings

ROOT = Path(__file__).resolve().parents[1]
CONTENT = ROOT / "content"
MODELS = ROOT / "web/public/media/models"
ROLES = ("attack", "empowered_attack", "active_buff_attack", "control_immune_attack",
         "attack_structure", "first_strike_attack")
# Character BIN owner where it differs from the model asset.
OWNERS = {
    "aatrox-alt": "aatrox", "apex_turret": "heimertblue", "daisy": "ivernminion",
    "evolution_turret": "heimertyellow", "gnar-alt": "gnarbig", "imp": "yorickghoulmelee",
    "jack_in_the_box": "shaco", "jayce-alt": "jayce", "jinx-alt": "jinx",
    "kayle_ranged": "kayle", "kayn_assassin": "kayn", "kayn_slayer": "kayn",
    "enraged_reksai": "reksai", "nest_reksai": "reksai", "rift_herald": "sru_riftherald",
    "sand_soldier": "azirsoldier", "sion-alt": "sion", "sun_disc-blue": "azirsundisc",
    "sun_disc-red": "azirsundisc", "thorn_spitter": "zyra", "tibbers": "annietibbers",
    "twisted_fate": "twistedfate", "vine_lasher": "zyra", "voidfish": "belvethvoidling",
    "voidfish_ranged": "belvethvoidling", "voidling": "malzaharvoidling",
    "voidmite": "sru_horde_mini", "xin": "xinzhao", "soul_tentacle": "illaoiminion",
    "pix": "lulufaerie",
}
PACKS = {
    "heimertblue": "Heimerdinger", "heimertyellow": "Heimerdinger", "ivernminion": "Ivern",
    "gnarbig": "Gnar", "yorickghoulmelee": "Yorick", "azirsoldier": "Azir",
    "azirsundisc": "Azir", "annietibbers": "Annie", "belvethvoidling": "Belveth",
    "turret": "Map11", "jade_voidspawn": "Map12", "shacobox": "Shaco",
    "zyrathornplant": "Zyra", "zyragraspingplant": "Zyra",
    "malzaharvoidling": "Malzahar", "illaoiminion": "Illaoi", "lulufaerie": "Lulu",
}
# Explicit bindings for renamed, shared, repurposed and empowered clips.
# A bare number selects the owner's BasicAttack variant (1 is the default slot).
BINDINGS = {
    "aatrox": "1 2 3 AatroxPassiveAttack",
    "aatrox-alt": "AatroxPassiveAttack AatroxRAttack1 AatroxRAttack2",
    "belveth": "1 2", "blitzcrank/empowered_attack": "PowerFistAttack",
    "darius/empowered_attack": "DariusExecute", "ekko": "EkkoBasicAttackP1 EkkoBasicAttackP2 EkkoBasicAttackP3",
    "enraged_reksai": "RekSaiQAttack RekSaiQAttack2",
    "garen/empowered_attack": "GarenQAttack", "gnar-alt/attack_structure": "gnar:GnarBigAttackTower",
    "hecarim": "HecarimRapidSlash", "ivern": "IvernBasicAttackRanged IvernBasicAttackRanged2",
    "jack_in_the_box": "ShacoBoxSpell", "jax/active_buff_attack": "1 2 1",
    "jayce": "JayceRangedAttack JayceRangedAttack2",
    "jayce/first_strike_attack": "JaycePassiveRangedAttack",
    "jayce/active_buff_attack": "JayceHyperChargeRangedAttack JayceHyperChargeRangedAttack",
    "jayce-alt/first_strike_attack": "JaycePassiveMeleeAttack",
    "jinx": "JinxQAttack JinxQAttack2", "kayle_ranged": "3 4",
    "masteryi": "1 2 MasterYiDoubleStrike", "nocturne/empowered_attack": "NocturneUmbraBladesAttack",
    "olaf/control_immune_attack": "3 3", "pantheon": "1 2 3 2",
    "samira": "1 2 SamiraBasicAttackMelee SamiraBasicAttackMelee2",
    "sand_soldier": "1 1 1", "sion": "SionBasicAttackTower2 SionBasicAttackTower",
    "sion-alt": "SionBasicAttackPassive SionBasicAttackPassive2", "sivir": "SivirQMissile",
    "sona": "1 2 1", "teemo/empowered_attack": "TeemoQ",
    "thorn_spitter": "ZyraQPlantMissile", "tryndamere": "1 2 TryndamereCritAttack",
    "twisted_fate": "1 2 3 4 TwistedFateCritAttack", "twitch/active_buff_attack": "TwitchSprayAndPrayAttack",
    "vine_lasher": "ZyraEPlantAttack ZyraEPlantAttack2",
    "voidfish": "BelvethVoidlingMeleeAttack", "voidfish_ranged": "BelvethVoidlingRangedAttack",
    "xin": "1 2 XinZhaoPassiveCritAttack", "yorick": "1 2 1",
    "yorick/empowered_attack": "YorickQAttack", "ziggs/empowered_attack": "ZiggsQ",
    "sun_disc-blue": "1 1", "sun_disc-red": "1 1",
}
for variant in ("reksai", "nest_reksai", "enraged_reksai"):
    BINDINGS[variant + "/empowered_attack"] = "RekSaiQAttack RekSaiQAttack2 RekSaiQAttack3"

MODEL_ATTACKS = {
    "ashe": ["Attack1", "Attack2"], "apex_turret": ["Attack1"],
    "evolution_turret": ["Attack1", "Attack2"], "jack_in_the_box": ["Attack1"],
    "soul_tentacle": ["illaoiminion_attack1"], "thorn_spitter": ["Attack1"],
    "vine_lasher": ["Attack1", "Attack2"],
}
for team in ("blue", "red"):
    MODEL_ATTACKS["sun_disc-" + team] = ["Attack1_BASE", "Attack2_BASE"]
for side in ("order", "chaos"):
    for unit in ("melee", "ranged", "siege", "super"):
        asset = unit + "-" + side
        OWNERS[asset] = "sru_" + side + "minion" + unit
        MODEL_ATTACKS[asset] = ["Attack1_BASE", "Attack2_BASE"] if unit == "siege" else ["Attack1", "Attack2"]
        if unit == "siege":
            BINDINGS[asset] = "1 1"

# Preserve intentionally authored split windows. The source mark in a start
# segment and the start of its separate hit clip have different local times.
SPLIT = {"azir", "belveth", "ekko", "malzahar", "samira", "sett", "teemo", "xin"}
FPS = {"blitzcrank": 31, "malzahar": 61, "voidling": 60, "thorn_spitter": 31, "vine_lasher": 31}


class Source:
    def __init__(self, final, cache):
        self.cache = cache
        self.final = final
        self.wads = {p.stem.split(".")[0].lower(): p for p in (final / "Champions").glob("*.wad.client") if p.name.count(".") == 2}
        for name in ("Map11", "Map12"):
            self.wads[name.lower()] = final / "Maps/Shipping" / (name + ".wad.client")
        self.texts = {}
        self.spells = {}
        self.paths = {}

    def read(self, owner, graph=False):
        key = (owner, graph)
        if key not in self.texts:
            pack = PACKS.get(owner, "Map11" if owner.startswith("sru_") else owner).lower()
            wad = self.wads[pack]
            rel = "data/characters/" + owner + "/" + ("animations/skin0" if graph else owner) + ".bin"
            source = self.cache / wad.name / rel
            if not source.exists():
                subprocess.run(["wadtools", "extract", "-i", wad, "-o", self.cache / wad.name,
                                "-x", "^" + re.escape(rel) + "$", "--stats=false"], check=True, stdout=subprocess.DEVNULL)
            self.paths[str(wad.relative_to(self.final)) + " / " + rel] = hashlib.sha256(source.read_bytes()).hexdigest()
            output = source.with_suffix(".rito")
            if not output.exists():
                subprocess.run(["ritobin-tools", "convert", source, "-o", output], check=True, stdout=subprocess.DEVNULL)
            self.texts[key] = output.read_text()
        return self.texts[key]

    def spell(self, owner, name):
        if owner not in self.spells:
            spells = {}
            for block in re.findall(r'^    [^\n]+ = SpellObject \{\n(.*?)^    \}', self.read(owner), re.M | re.S):
                match = re.search(r'ObjectName: string = "([^"]+)"', block)
                if match:
                    spells[match[1].lower()] = (match[1], block)
            self.spells[owner] = spells
        return self.spells[owner][name.lower()]


def clip_lengths(profile):
    lengths = {}
    asset = profile["asset"]
    for stem in [asset, *profile.get("packFiles", {}).values(), *(asset + "-" + k.split(".")[-1] for k in profile.get("packs", {}))]:
        path = MODELS / (stem + ".glb")
        if not path.is_file():
            continue
        with path.open("rb") as f:
            f.seek(12)
            length = struct.unpack("<I", f.read(4))[0]
            f.read(4)
            doc = json.loads(f.read(length))
        for anim in doc.get("animations", []):
            lengths[anim["name"]] = max(doc["accessors"][s["input"]]["max"][0] for s in anim["samplers"])
    return lengths


GRAPH_OWNERS = {"jack_in_the_box": "shacobox", "thorn_spitter": "zyrathornplant",
                "vine_lasher": "zyragraspingplant"}
# Some game actions reuse a common slot, or use an ability's animation for a
# basic attack. Record that evidence separately from independently named slots.
SHARED = {
    ("aatrox-alt", "Passive_Attack_Ult"), ("jax", "Spell3_Attack1"),
    ("jax", "Spell3_Attack2"), ("jax", "Spell3_Attack3"),
    ("jayce", "Ranged_Spell2_Attack1"), ("jayce", "Ranged_Spell2_Attack2"),
    ("sand_soldier", "Attack2_BASE"), ("sand_soldier", "AzirSoldier_Attack3_anm"),
    ("sona", "Attack3"), ("yorick", "Attack3"), ("sun_disc-blue", "Attack2_BASE"),
    ("sun_disc-red", "Attack2_BASE"), ("siege-order", "Attack2_BASE"),
    ("siege-chaos", "Attack2_BASE"), ("voidmite", "Ranged_Attack1"),
}


def sample(source, owner, asset, binding, graph, clip):
    if ":" in binding:
        owner, binding = binding.split(":")
    if binding.isdigit():
        binding = owner + "BasicAttack" + (binding if binding != "1" else "")
    name, block = source.spell(owner, binding)
    frame = re.search(r'\bcastFrame: f32 = ([\d.]+)', block)
    if not frame:
        assert binding == "ZyraEPlantAttack"
        seconds = float(re.search(r'spellCastTime: f32 = ([\d.]+)', block)[1])
        return seconds, name + " spellCastTime"
    fps = FPS.get(asset, 30)
    if "useAnimatorFramerate: bool = true" in block:
        anim = re.search(r'mAnimationName: string = "([^"]+)"', block)
        for label in (clip, anim[1] if anim else "Attack1"):
            entry = re.search(r'^            "' + re.escape(label)
                              + r'" = \w+ \{(.*?)^            \}', graph, re.M | re.S | re.I)
            if entry:
                duration = re.search(r'mTickDuration: f32 = ([\d.]+)', entry[1])
                if duration:
                    fps = round(1 / float(duration[1]), 3)
                break
    ref = f"{name} {frame[1]}/{fps:g}"
    if (asset, clip) in SHARED:
        ref += " / shared reference"
    return float(frame[1]) / fps, ref


def calibrate(source, profile, stats):
    asset = profile["asset"]
    owner = OWNERS.get(asset, asset)
    graph = source.read(GRAPH_OWNERS.get(asset, owner), graph=True)
    lengths = clip_lengths(profile)
    result = {}
    for role in ROLES:
        clips = profile["roles"].get(role, [])
        if not clips:
            continue
        key = asset if role == "attack" else asset + "/" + role
        bindings = BINDINGS.get(key, " ".join(str(i + 1) for i in range(len(clips)))).split()
        nodes = []
        for i, (clip, binding) in enumerate(zip(clips, bindings, strict=True)):
            window = lengths[clip]
            if asset == "pix":
                source.read(owner)
                assert f'"{clip}" = AtomicClipData' in graph
                # Faerie attacks have no per-clip castFrame. LuluPassiveMissile
                # belongs to the champion Spell1 and cannot identify either clip.
                ratio = stats["first_hit"] / stats["interval"]
                marker, ref = ratio * window, "LuluFaerie AttackSlotData / project windup"
            elif asset == "soul_tentacle":
                attack = graph.split('"Attack1_BASE" = AtomicClipData {', 1)[1].split("mAnimationResourceData:", 1)[0]
                assert "mStartFrame: f32 = 22" in attack
                marker, ref = 22 / 30, "IllaoiMinion Attack1_BASE ground impact 22/30"
            else:
                marker, ref = sample(source, owner, asset, binding, graph, clip)
            if asset in ("ranged-order", "ranged-chaos"):
                # Keep the native castFrame in the evidence; both teams release
                # on frame 14 in the shipped clips and in the simulation.
                marker = 14 / 30
                ref += " / shared release 14/30"
            if asset == "tryndamere":
                marker = 0.4 + marker * 1.07 / (32 / 30)
            if asset == "pantheon":
                window = profile["timing"]["attack_clip_ranges"][i][1]
            if asset in SPLIT:
                ranges = profile.get("timing", {}).get("attack_clip_ranges", [])
                end = ranges[i][1] if i < len(ranges) and ranges[i] else window
                # Separate start/hit clips have an authored handoff. A
                # castFrame later than this exported start (e.g. Teemo Q)
                # cannot be sampled as an offset into that short clip.
                if abs(marker - end) > 0.001:
                    ref += " / project split"
                marker = end
                if asset == "malzahar":
                    # Two ranges on the same continuous source, 18/60 and
                    # 16/60 of the full authored action respectively.
                    ratio = marker / profile["timing"]["attack_hit_clip_ranges"][i][1]
                else:
                    interval = stats["attack_pattern"][i] if asset == "sett" else stats["interval"]
                    windup = stats["first_hit"]
                    if role == "empowered_attack":
                        windup = stats.get("empowered_first_hit", windup)
                    ratio = windup / interval
            elif asset == "rift_herald":
                assert "mAttackCastTime: option[f32] = { 0.5 }" in source.read(owner)
                ratio = 0.5 / 2
                ref += " + AttackSlot 0.5/2"
            else:
                ratio = marker / window
            if not 0 <= marker <= window + 0.001 or not 0 < ratio <= 1:
                raise ValueError((asset, role, clip, marker, window, ratio))
            nodes.append(dict(clip=clip, markerUs=round(marker * 1e6), windupPpm=round(ratio * 1e6), source=ref))
        result[role] = nodes
    return result


def generate(source):
    roster = json.loads((ROOT / "web/src/roster-models.json").read_text())
    rules = json.loads((CONTENT / "battle_rules.json").read_text())
    profiles, units = {}, {}
    for key, forms in roster.items():
        for form, profile in enumerate(forms):
            asset = profile["asset"]
            if not profile.get("roles", {}).get("attack") or asset == "void_spawn":
                continue
            units.setdefault(key, {})["alternate" if form else "base"] = asset
            if asset not in profiles:
                stats = rules[key]["transformed_stats"] if form else rules[key]
                profiles[asset] = calibrate(source, profile, stats)
    for asset, clips in MODEL_ATTACKS.items():
        key, _, side = asset.partition("-")
        if side in ("order", "chaos"):
            key += "_minion"
        units.setdefault(key, {})["red" if side in ("red", "chaos") else "base"] = asset
        profiles[asset] = calibrate(source, {"asset": asset, "roles": {"attack": clips}}, rules[key])
    # This tower fires from a static body. Keep all four native launch slots
    # for the simulation without injecting an attack clip into its damage poses.
    tower = []
    tower_graph = source.read("turret", graph=True)
    for variant in range(1, 5):
        marker, ref = sample(source, "turret", "princess_tower", str(variant), tower_graph, "")
        tower.append(dict(clip="", markerUs=round(marker * 1e6),
                          windupPpm=round(marker / 0.8 * 1e6), source=ref))
    units["princess_tower"] = {"base": "princess_tower"}
    profiles["princess_tower"] = {"attack": tower}
    # The self-sacrificing model explodes during its independent jump.
    graph = source.read("jade_voidspawn", graph=True)
    assert re.search(r'mStartFrame: f32 = 23\s+mEffectKey: hash = "Jade_VoidSpawn_TurretDeath"', graph)
    for k in ("void_spawn", "void_spawn_single"):
        assert rules[k]["sacrifice_delay"] == 16 / 20
    # Fail closed when a new damaging discrete attacker has no mapping.
    for key, stats in rules.items():
        if stats.get("type") not in ("unit", "building"):
            continue
        if stats.get("damage", 0) and not stats.get("is_continuous_attack") and not stats.get("sacrifice_damage") and stats.get("can_attack", True):
            if key not in units:
                raise ValueError(f"Unreviewed attacker: {key}")
    # Only gameplay forms get separate timings. Both teams use the base form's
    # calibration, even when their own clips have different lengths or castFrames.
    timings = {}
    for key, forms in units.items():
        timings[key] = {
            form: {
                role: [node["windupPpm"] for node in nodes]
                for role, nodes in profiles[forms[form]].items()
            }
            for form in ("base", "alternate") if form in forms
        }
    for roles in profiles.values():
        for nodes in roles.values():
            for node in nodes:
                del node["windupPpm"]
    return timings, {"units": units, "profiles": profiles, "sourceFiles": dict(sorted(source.paths.items()))}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--final", type=Path, default=Path.home() / "Downloads/LOL_Asset_Source/Game/DATA/FINAL")
    p.add_argument("--check", action="store_true")
    args = p.parse_args()
    with tempfile.TemporaryDirectory() as tmp:
        timings, data = generate(Source(args.final, Path(tmp)))
    # One complete, reviewable record per line.
    formatted = json.dumps(data, ensure_ascii=False, indent=2)
    formatted = re.sub(r'\{\n\s+"clip": [^}]+\}', lambda m: json.dumps(json.loads(m[0]), ensure_ascii=False), formatted) + "\n"
    prep = ROOT / "web/src/preparation-data.json"
    cards = enrich_card_timings(json.loads(prep.read_text()),
                                json.loads((CONTENT / "battle_rules.json").read_text()), timings)
    for output, contents in [(CONTENT / "attack_nodes.json", formatted),
                             (CONTENT / "attack_timing.json", json.dumps(timings, indent=2) + "\n"),
                             (prep, json.dumps(cards, ensure_ascii=False, separators=(",", ":")) + "\n")]:
        if args.check:
            if output.read_text() != contents:
                raise SystemExit(f"{output.name} differs from the calibrated data")
        else:
            output.write_text(contents)
    print(sum(len(role) for p in data["profiles"].values() for role in p.values()), "calibrated attack segments")


if __name__ == "__main__":
    main()
