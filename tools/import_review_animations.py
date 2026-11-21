"""Build workbench-only animation packs from the selected League skins and prepared scenes."""

import argparse
from collections import defaultdict
from functools import cache
import gzip
import hashlib
import json
from pathlib import Path
import re
import shutil
from statistics import median
import struct
import subprocess
import tempfile

from import_battle_models import MODELS
from import_building_models import SOURCES
from source_glb import Model, pack_tracks

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"
BODIES = WEB / "public/media/models"
DEST = WEB / "public/review-animations"
MAP = "Map11"
# Default for champions is their own WAD and character name. Alternate forms can
# share a skeleton, use a different character, or come from a specific map skin.
ORIGINS = {
    "twisted_fate": ("TwistedFate", "twistedfate"),
    "xin": ("XinZhao", "xinzhao"),
    "gnar-alt": ("Gnar", "gnarbig"),
    "anivia_egg": ("Anivia", "aniviaegg"),
    "pix": ("Lulu", "lulufaerie"),
    "daisy": ("Ivern", "ivernminion"),
    "tibbers": ("Annie", "annietibbers"),
    "sand_soldier": ("Azir", "azirsoldier"),
    "imp": ("Yorick", "yorickghoulmelee"),
    "tombstone": ("Yorick", "yorickwghoul"),
    "voidling": ("Malzahar", "malzaharvoidling"),
    "rift_herald": (MAP, "sru_riftherald"),
    "voidmite": (MAP, "sru_horde_mini"),
    "voidfish": ("Belveth", "belvethvoidling"),
    "voidfish_ranged": ("Belveth", "belvethvoidling"),
    "scarecrow": ("FiddleSticks", "fiddlesticks"),
    "queen_nest": ("RekSai", "reksaitunnel"),
    "gold_ward": (MAP, "sightward"),
    "evolution_turret": ("Heimerdinger", "heimertyellow"),
    "apex_turret": ("Heimerdinger", "heimertblue"),
    "jack_in_the_box": ("Shaco", "shacobox"),
    "powder_keg": ("Gangplank", "gangplankbarrel"),
    "demacian_standard": ("JarvanIV", "jarvanivstandard"),
    "thorn_spitter": ("Zyra", "zyrathornplant"),
    "vine_lasher": ("Zyra", "zyragraspingplant"),
    "soul_tentacle": ("Illaoi", "illaoiminion"),
    "void_gate": ("Map12", "jade_voidgate"),
    "void_spawn": ("Map12", "jade_voidspawn"),
}
for asset in ("aatrox", "sion", "jinx", "jayce"):
    ORIGINS[asset + "-alt"] = (asset, asset)
for asset in (
    "enraged_reksai",
    "nest_reksai",
    "kayn_assassin",
    "kayn_slayer",
    "kayle_ranged",
):
    champion = "reksai" if asset.endswith("reksai") else asset.split("_")[0]
    ORIGINS[asset] = (champion, champion)
for side in ("blue", "red"):
    ORIGINS.update(
        {
            "sun_disc-" + side: ("Azir", "azirsundisc"),
            "inhibitor-" + side: (MAP, "inhibitor", 2),
            "target_dummy-" + side: (MAP, "practicetool_targetdummy"),
            "princess_tower-" + side: (MAP, "turret"),
            "nexus-" + side: (MAP, "nexus"),
        }
    )
for name, character, *_ in MODELS:
    if name != "ashe":
        ORIGINS[name] = (MAP, character)
for suffix in ("", "-death"):
    ORIGINS["scuttle_crab" + suffix] = (MAP, "sru_crab")
    ORIGINS["void_scuttle_crab" + suffix] = (MAP, "sru_crab", 5)


def command(*args):
    result = subprocess.run(args, capture_output=True)
    if result.returncode:
        raise RuntimeError(
            f"{args[0]}: {(result.stdout + result.stderr).decode()[-3000:]}"
        )
    return result.stdout


@cache
def wad_index(wad):
    raw = command("wadtools", "list", "-i", wad, "-F", "json")
    chunks = json.JSONDecoder().raw_decode(raw[raw.index(b"{") :].decode())[0]["chunks"]
    return {c["path"]: c["hash"] for c in chunks if c.get("path")}


def extract(wad, folder, paths):
    index = wad_index(wad)
    if paths:
        command(
            "wadtools",
            "extract",
            "-i",
            wad,
            "-o",
            folder,
            "--no-bin-paths",
            "--hash",
            *[index[p] for p in sorted(set(paths))],
        )


def native_sources(wad, character, skin, folder):
    index = wad_index(wad)
    root = f"assets/characters/{character}/"
    base = root + ("skins/base/" if skin == 0 else f"skins/skin{skin:02d}/")
    graph = f"data/characters/{character}/animations/skin{skin}.bin"
    if graph not in index:
        graph = f"data/characters/{character}/animations/skin0.bin"
    skeletons = sorted(
        p
        for p in index
        if p.endswith(".skl") and str(Path(p).parent) in (base[:-1], root[:-1])
    )
    skeleton = next(p for p in skeletons if p[:-1] + "n" in index)
    extract(wad, folder, [graph])
    by_hash = {v: k for k, v in index.items()}
    files = defaultdict(list)
    # The skin graph may reference a shared/base ANM outside the skin directory.
    output = folder / "graph.txt"
    command("ritobin-tools", "convert", folder / graph, "-o", output)
    for match in re.finditer(
        r'^            (?:"([^"]+)"|(0x[0-9a-f]+)) = AtomicClipData \{(.*?)^            \}',
        output.read_text(),
        re.M | re.S,
    ):
        ref = re.search(r"mAnimationFilePath: file = 0x([a-f0-9]+)", match[3])
        if ref:
            files[by_hash[ref[1].zfill(16)]].append(match[1] or match[2])
    directories = [base, root + "animations/", root + "anims/"]
    if skin and any(path.startswith(root + "skins/base/") for path in files):
        directories.append(root + "skins/base/animations/")
    for p in index:
        if (
            not p.endswith(".anm")
            or not p.startswith(tuple(directories))
            or "/particles/" in p
        ):
            continue
        # Jax's fishing line and bobber are separate particle meshes with their
        # own skeletons, although their ANMs live next to the champion clips.
        prop = base + "particles/" + Path(p).stem + ".skl"
        if prop not in index:
            files[p]
    # Skin0 references a Zyra setup track with an all-zero mask. Its bones are
    # absent from the Illaoi tentacle and it produces no animation on this rig.
    files.pop(
        root + "skins/base/animations/zyra_plant_thorn_skin02_buffbones.anm", None
    )
    return files, skeleton


def key(name):
    return re.sub(r"(?:\.anm|_anm)$", "", name.lower())


def convert_missing(wad, tmp, skeleton, wanted):
    extract(wad, tmp, [skeleton, skeleton[:-1] + "n", *wanted])
    clips = tmp / "clips"
    clips.mkdir()
    for path, name in wanted.items():
        shutil.copyfile(tmp / path, clips / (name + ".anm"))
    model = tmp / "native.glb"
    command(
        "lol2gltf",
        "skn2gltf",
        "-m",
        tmp / (skeleton[:-1] + "n"),
        "-s",
        tmp / skeleton,
        "-a",
        clips,
        "-g",
        model,
    )
    result = Model(model)
    converted = {a["name"] for a in result.doc.get("animations", [])}
    if missing := set(wanted.values()) - converted:
        raise ValueError(f"{wad.name}: no converted tracks for {sorted(missing)}")
    return result


def bind_native(model, body):
    # The two source exporters use either League units, or reflected X and
    # 0.0085 units per League unit. Measure this against the shipped bind pose.
    targets = {n["name"].lower(): n for n in body.doc["nodes"] if "name" in n}
    nodes = model.doc["nodes"]
    pairs = [
        (n, targets[n["name"].lower()])
        for skin in model.doc["skins"]
        for i in skin["joints"]
        if (n := nodes[i])["name"].lower() in targets
    ]
    ratios = [
        b["translation"][i] / a["translation"][i]
        for a, b in pairs
        if "translation" in a and "translation" in b
        for i in (1, 2)
        if abs(a["translation"][i]) > 0.1
    ]
    unit = median(ratios) if ratios else 1
    if abs(unit - 1) < 0.0001:
        unit = 1
    elif abs(unit - 0.0085) < 0.00001:
        unit = 0.0085
    else:
        raise ValueError(f"Unknown skeleton units {unit}")
    # Packed GLBs retain named joints even for portions of a trimmed mesh.
    for a, b in pairs:
        a["name"] = b["name"]
    allowed = {b["name"] for _, b in pairs}
    converted = set()
    for anim in model.doc["animations"]:
        channels = [
            c for c in anim["channels"] if nodes[c["target"]["node"]]["name"] in allowed
        ]
        if not channels:
            raise ValueError("No matching bones: " + anim["name"])
        anim["channels"] = channels
        for ch in channels:
            path = ch["target"]["path"]
            acc_id = anim["samplers"][ch["sampler"]]["output"]
            if unit == 1 or path == "scale" or acc_id in converted:
                continue
            converted.add(acc_id)
            acc = model.doc["accessors"][acc_id]
            view = model.doc["bufferViews"][acc["bufferView"]]
            factors = (-unit, unit, unit) if path == "translation" else (1, -1, -1, 1)
            fmt = "<" + "f" * len(factors)
            assert acc["componentType"] == 5126
            offset = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
            for i in range(acc["count"]):
                start = offset + i * view.get("byteStride", struct.calcsize(fmt))
                values = struct.unpack_from(fmt, model.data, start)
                struct.pack_into(
                    fmt, model.data, start, *(v * f for v, f in zip(values, factors))
                )
            for tag in ("min", "max"):
                acc.pop(tag, None)


def build_asset(asset, packs, args, wads, tmp, dest):
    body = Model(BODIES / (asset + ".glb"))
    available = {a["name"] for a in body.doc["animations"]}
    packs = list(packs)
    if asset == "ashe":
        packs.append("ashe-review")
    for name in packs:
        available.update(
            a["name"] for a in Model(BODIES / (name + ".glb")).doc["animations"]
        )
    review = []
    aliases = {}

    def publish(model, chosen, label):
        if not chosen:
            return
        pack_tracks(model, chosen, label, tmp, WEB / "node_modules/.bin/gltfpack", dest)
        packed = dest / (label + ".glb")
        verify_pack(packed, chosen, body)
        data = gzip.compress(packed.read_bytes(), compresslevel=6, mtime=0)
        digest = hashlib.sha256(data).hexdigest()[:24]
        (dest / (digest + ".glb.gz")).write_bytes(data)
        review.append(digest)
        available.update(chosen)

    prepared = args.export / (asset + ".glb")
    if asset in SOURCES:
        prepared = args.assets / (SOURCES[asset] + ".glb")
    if asset not in {m[0] for m in MODELS} | {"pillar_of_ice"}:
        model = Model(prepared)
        publish(
            model, {a["name"] for a in model.doc["animations"]} - available, "prepared"
        )
    if asset != "pillar_of_ice":
        package, character, *skins = ORIGINS.get(asset, (asset, asset))
        wad = wads[package.lower()]
        files, skeleton = native_sources(wad, character, skins[0] if skins else 0, tmp)
        names = {key(n): n for n in sorted(available)}
        if asset.startswith("princess_tower-"):
            # These three ANMs bind to the independent debris rigs already
            # embedded in the tower as NativeBreak1/2/3.
            names.update({f"break{i}": f"NativeBreak{i}" for i in range(1, 4)})
        wanted = {}
        for path, slots in sorted(files.items()):
            stem = Path(path).stem
            existing = next(
                (names[key(n)] for n in [stem, *slots] if key(n) in names), None
            )
            if existing is None:
                existing = next((s for s in slots if not s.startswith("0x")), stem)
                wanted[path] = existing
            for name in slots:
                if (
                    name != existing
                    and name not in available
                    and not name.startswith("0x")
                ):
                    aliases[name] = existing
        if len(wanted) != len(set(wanted.values())):
            raise ValueError(f"Conflicting source animation names on {asset}")
        if wanted:
            model = convert_missing(wad, tmp, skeleton, wanted)
            bind_native(model, body)
            publish(model, set(wanted.values()), "native")
    return {"packs": sorted(packs), "review": review, "aliases": aliases}


def verify_pack(path, expected, body):
    doc = Model(path).doc
    nodes = {n["name"] for n in body.doc["nodes"] if "name" in n}
    clips = doc.get("animations", [])
    if {c["name"] for c in clips} != expected:
        raise ValueError(f"Packed clip list changed in {path.name}")
    for clip in clips:
        targets = {doc["nodes"][c["target"]["node"]]["name"] for c in clip["channels"]}
        if not targets or not targets <= nodes:
            raise ValueError(
                f"{clip['name']}: invalid animation targets {targets - nodes}"
            )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "source", type=Path, help="League installation containing Game/DATA/FINAL"
    )
    parser.add_argument(
        "assets", type=Path, help="Reference checkout's assets directory"
    )
    parser.add_argument(
        "export", type=Path, help="Full scenes from export_roster_visuals.gd"
    )
    args = parser.parse_args()
    root = args.source / "Game/DATA/FINAL"
    wads = {
        p.name.split(".")[0].lower(): p
        for folder in (root / "Champions", root / "Maps/Shipping")
        for p in folder.glob("*.wad.client")
        if p.name.count(".") == 2
    }
    bindings = json.loads(
        command("node", ROOT / "tools/model-resources.mjs", "--review-packs")
    )
    index = {}
    with tempfile.TemporaryDirectory() as stage:
        dest = Path(stage)
        for asset, packs in sorted(bindings.items()):
            with tempfile.TemporaryDirectory() as folder:
                print(asset, flush=True)
                index[asset] = build_asset(asset, packs, args, wads, Path(folder), dest)
        DEST.mkdir(parents=True, exist_ok=True)
        for pack in dest.glob("*.glb.gz"):
            shutil.copyfile(pack, DEST / pack.name)
        (WEB / "src/model-review.json").write_text(
            json.dumps(index, ensure_ascii=False, indent=2) + "\n"
        )


if __name__ == "__main__":
    main()
