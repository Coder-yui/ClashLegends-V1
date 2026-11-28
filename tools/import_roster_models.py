"""Package the prepared reference scenes from export_roster_visuals.gd for the Three renderer."""

import argparse
from collections import defaultdict
import json
from pathlib import Path
import subprocess
import tempfile

from source_glb import Model, pack_tracks

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / "web/public/media/models"
PACK = ROOT / "web/node_modules/.bin/gltfpack"


def clips(value):
    if isinstance(value, str):
        return [value.replace("/", "_")] if value else []
    if isinstance(value, dict):
        return clips(value.get("animation", []))
    if isinstance(value, list):
        return [clip for item in value for clip in clips(item)]
    return []


def skill_owner(key, skills, role, action=False):
    for skill in skills:
        name, kind = skill.get("visual_action"), skill["kind"]
        if (
            action
            and name
            and (
                role == name
                or role.startswith(name + "_")
                or name == "active_0"
                and role.startswith("active_")
            )
        ):
            return skill["id"]
        if role.startswith("empowered_") and kind in (
            "empowered_attack",
            "bleeding_execute",
        ):
            return skill["id"]
        if role.startswith("active_buff_") and kind in (
            "buff",
            "attack_burst",
            "counter_strike",
        ):
            return skill["id"]
        if (role, kind) in {
            ("channel", "channeled_attack"),
            ("shield:explode", "explosive_shield"),
            ("effect_shield:start", "effect_shield"),
            ("charge_strike", "movement_strike"),
            ("control_immune_attack", "buff"),
        }:
            if role != "control_immune_attack" or skill.get("control_immunity"):
                return skill["id"]
        if (key, role) in {
            ("masteryi", "haste_move"),
            ("missfortune", "haste_move"),
            ("gnar", "transform_active"),
            ("aatrox", "revert"),
            ("aatrox", "transform_active"),
            ("jinx", "transform"),
        }:
            return skill["id"]
    return None


def profile(key, form, options):
    anim = form["visual_animations"]
    skills = [
        {**s, **next(r for r in options if r["name"] == s["name"])}
        for s in form["skills"]
    ]
    for skill in skills:
        skill.setdefault("id", skill["name"])
    bound = defaultdict(set)
    roles, actions, casts, bridges = {}, {}, {}, {}

    def bind(owner, names):
        bound[owner].update(names)

    for role, value in anim.items():
        if role in (
            "visual_actions",
            "transitions",
            "clip_blends",
            "transition_blends",
        ) or role.startswith("death_followup"):
            continue
        names = clips(value)
        if names:
            roles[role] = (
                [c.replace("/", "_") for c in value]
                if isinstance(value, list) and all(isinstance(c, str) for c in value)
                else names
            )
            bind(skill_owner(key, skills, role), names)
    for name, value in anim.get("visual_actions", {}).items():
        sequence = clips(value)
        if not sequence:
            continue
        owner = skill_owner(key, skills, name, True)
        bind(owner, sequence)
        spec = value if isinstance(value, dict) else {}
        actions[name] = {
            "clips": sequence,
            **{
                k: spec[k]
                for k in (
                    "durations",
                    "clip_ranges",
                    "blend_in",
                    "blend_out",
                    "sequence_blend",
                )
                if k in spec
            },
        }
        if owner:
            for s in skills:
                if s["id"] == owner and (s.get("visual_action") == name):
                    casts[owner] = {
                        "clip": sequence[0],
                        "action": name,
                        "marker": s.get("impact_delay", 0),
                    }
    for edge, value in anim.get("transitions", {}).items():
        source, target = edge.split(">", 1)
        names = clips(value)
        if not names:
            continue
        owners = [owner for owner, available in bound.items() if source in available]
        for owner in owners or [None]:
            bind(owner, names)
        spec = value if isinstance(value, dict) else {}
        bridges[
            source.replace("/", "_") + ">" + ("run" if target == "move" else target)
        ] = {
            "clip": names[0],
            **({"blend": spec["blend_in"] * 20} if "blend_in" in spec else {}),
        }
    idle = roles["idle"][0]
    result = {
        "asset": form["asset"],
        "scale": 40,
        "groundOffset": 0,
        "idle": idle,
        "run": roles.get("move", [idle])[0],
        "attacks": [
            {"clip": c}
            for c in roles.get("attack", [])
        ],
        "death": {
            "clip": roles.get("death", [idle])[0],
            "ticks": 20 * anim.get("death_duration", 0),
            "blend": 0,
        },
        "roles": roles,
        "actions": actions,
        "casts": casts,
        "air": form.get("is_air", False),
    }
    if "death_clip_end" in anim:
        result["death"]["clipEnd"] = anim["death_clip_end"]
    if "followup" in form:
        result["followup"] = {
            "asset": form["followup"],
            "clip": anim["death_followup_animation"],
            "immediate": anim.get("death_followup_immediate", False),
        }
        if "death_followup_duration" in anim:
            result["followup"]["ticks"] = 20 * anim["death_followup_duration"]
    for dest, role in [
        ("deploy", "deploy"),
        ("channel", "attack_loop"),
        ("channelEnter", "attack_enter"),
        ("dormant", "dormant_idle"),
    ]:
        if role in roles:
            result[dest] = roles[role][0]
    if form.get("hands"):
        result["hands"] = form["hands"]
    if form.get("visual_forward_yaw"):
        result["yaw"] = form["visual_forward_yaw"]
    if bridges:
        result["transitions"] = bridges
    if anim.get("clip_blends"):
        result["clipBlends"] = {k: v * 20 for k, v in anim["clip_blends"].items()}
    if anim.get("idle_cycle"):
        result["idleCycle"] = anim["idle_cycle"]
    for field in (
        "attack_clip_ranges",
        "attack_hit_clip_ranges",
        "attack_hit_duration",
        "attack_stance_duration",
        "deploy_durations",
        "deploy_clip_ratio",
    ):
        if field in anim:
            result.setdefault("timing", {})[field] = anim[field]
    return result, bound


def build(folder):
    forms = json.loads((folder / "profiles.json").read_text())
    rules = json.loads((ROOT / "content/battle_rules.json").read_text())
    profiles = {}
    assets = defaultdict(lambda: defaultdict(set))
    for key, variants in forms.items():
        profiles[key] = []
        for variant in variants:
            entry, groups = profile(key, variant, rules[key].get("active_skills", []))
            profiles[key].append(entry)
            for owner, names in groups.items():
                assets[entry["asset"]][owner].update(names)
            followup = entry.get("followup")
            if followup:
                assets[followup["asset"]][None].add(followup["clip"])
    with tempfile.TemporaryDirectory() as directory:
        tmp = Path(directory)
        for asset, groups in sorted(assets.items()):
            model = Model(folder / (asset + ".glb"))
            native = {a["name"] for a in model.doc["animations"]}
            required = set.union(*groups.values())
            if required - native:
                raise ValueError((asset, required - native))
            packages = defaultdict(set)

            def package(owner):
                # Workbench-only single summons use the localized ability name in
                # the rules. Share the same file with the selectable card.
                name = next(
                    (
                        s["id"]
                        for s in rules.get(asset, {}).get("active_skills", [])
                        if s["name"] == owner and "id" in s
                    ),
                    owner,
                )
                return asset + "-" + name.split(".")[-1]

            for owner, names in groups.items():
                if owner and names - groups[None]:
                    packages[package(owner)].update(names - groups[None])
            for kind, variants in profiles.items():
                for entry in variants:
                    if entry["asset"] == asset:
                        entry["packs"] = {
                            owner: sorted(packages[name])
                            for owner in groups
                            if owner
                            and (name := package(owner)) in packages
                            and owner
                            in {
                                s.get("id", s["name"])
                                for s in rules[kind].get("active_skills", [])
                            }
                        }
                        entry["packFiles"] = {
                            owner: package(owner) for owner in entry["packs"]
                        }
            for name, names in packages.items():
                pack_tracks(model, names, name, tmp, PACK, DEST)
            model.doc["animations"] = [
                a for a in model.doc["animations"] if a["name"] in groups[None]
            ]
            path = tmp / (asset + ".glb")
            model.write(path)
            subprocess.run(
                [
                    PACK,
                    "-i",
                    path,
                    "-o",
                    DEST / path.name,
                    "-kn",
                    "-km",
                    "-ac",
                    "-cc",
                    "-ce",
                    "ext",
                    "-ar",
                    "16",
                ],
                check=True,
            )
    (ROOT / "web/src/roster-models.json").write_text(
        json.dumps(profiles, ensure_ascii=False, indent=2) + "\n"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("export", type=Path)
    build(parser.parse_args().export)
