"""Build the phase-one GLBs from a League installation with lol-asset-tools on PATH."""
import argparse
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile


DEST = Path(__file__).resolve().parents[1] / "web/public/media/models"
MINIONS = "Maps/Shipping/Map11.wad.client"
# Character, WAD, mesh stem, texture stem, SKN material slot.
MODELS = [
    ("ashe", "ashe", "Champions/Ashe.wad.client", "ashe", "ashe_base_2011_tx_cm", "ashe_base_2011_MD_lambert2SG1"),
    ("melee-order", "sru_orderminionmelee", MINIONS, "order_minion_melee", "orderminion_melee_tx_cm", "lambert1"),
    ("melee-chaos", "sru_chaosminionmelee", MINIONS, "chaos_minion_melee", "chaosminion_melee_tx_cm", "RedMinion_Caster_MD_Default3"),
]


# Order/Chaos have separate meshes, including two material slots on the Order cannon.
for role, order_mesh, chaos_mesh, order_tex, chaos_tex, order_mat, chaos_mat in [
    ("ranged", "order_minion_caster", "chaos_minion_caster", "orderminion_caster_tx_cm", "red_caster_tx_cm", "lambert1", "RedMinion_Caster_MD_Default3"),
    ("siege", "order_minion_siege", "chaos_minion_siege", "order_minion_siege_tx_cm", "chaos_minion_siege_tx_cm", "Cannon_Order_Mat Minion_Order_Mat", "Cannon_Chaos_Mat"),
    ("super", "blue_minion_superminion", "red_minion_superminion", "blue_superminion_tx_cm", "red_superminion_tx_cm", "Order_Mat", "Chaos_Mat"),
]:
    for side, mesh, tex, material in [("order",order_mesh,order_tex,order_mat),("chaos",chaos_mesh,chaos_tex,chaos_mat)]:
        MODELS.append((role+"-"+side, "sru_"+side+"minion"+role, MINIONS, mesh, tex, material))


def run(*args):
    return subprocess.check_output(args, text=True)


def build(root, tmp, name, character, package, mesh, texture, material):
    wad = root / package
    base = f"assets/characters/{character}/skins/base"
    graph = f"data/characters/{character}/animations/skin0.bin"
    paths = [f"{base}/{mesh}.skn", f"{base}/{mesh}.skl", f"{base}/{texture}.tex", graph]
    listing = run("wadtools", "list", "-i", wad, "-F", "json")
    chunks = json.JSONDecoder().raw_decode(listing[listing.index("{"):])[0]["chunks"]
    by_path = {chunk["path"]: chunk["hash"] for chunk in chunks if chunk.get("path")}
    by_hash = {v: k for k, v in by_path.items()}

    def extract(hashes):
        run("wadtools", "extract", "-i", wad, "-o", tmp, "--no-bin-paths", "--hash", *hashes)

    extract([by_path[path] for path in paths])
    graph_text = tmp / "graph.ritobin"
    run("ritobin-tools", "convert", tmp / graph, "-o", graph_text)
    table = graph_text.read_text()
    clips = ["Idle1", "Run", "Attack1", "Attack2", "Death"]
    if name.startswith("siege-"):
        clips = ["Idle1", "Run", "Attack1_BASE", "Attack2_BASE", "Death"]
    if name.startswith("super-"):
        clips = ["Idle1", "Run", "Attack1", "Attack2", "Death_Base"]
    core = set(clips)
    # Skin0 has named actions and two hashed aliases. Keep graph slots even
    # when the source intentionally points several slots at the same ANM.
    graph_clips = {}
    for label, hashed, key in re.findall(r'^            (?:"([^"]+)"|(0x[0-9a-f]+)) = AtomicClipData \{(?:(?!^            \}).)*?mAnimationFilePath: file = 0x([a-f0-9]+)', table, re.M | re.S):
        graph_clips[label or hashed] = key.zfill(16)
    if character == "ashe":
        clips = list(graph_clips)
        for path, key in by_path.items():
            if path.startswith(base + "/animations/") and path.endswith(".anm") and key not in graph_clips.values():
                label = Path(path).stem
                graph_clips[label] = key
                clips.append(label)

    animations = tmp / "clips"
    animations.mkdir()
    for clip in clips:
        key = graph_clips[clip]
        extract([key])
        shutil.copyfile(tmp / by_hash[key], animations / (clip + ".anm"))
    result = tmp / (name + ".glb")
    run("lol2gltf", "skn2gltf", "-m", tmp / paths[0], "-s", tmp / paths[1],
        "-a", animations, "--materials", *material.split(), "--textures", *([tmp / paths[2]] * len(material.split())), "-g", result)
    DEST.mkdir(parents=True, exist_ok=True)
    pack = DEST.parents[2] / "node_modules/.bin/gltfpack"
    if character == "ashe":
        from source_glb import Model, pack_tracks
        model = Model(result)
        all_clips = model.doc["animations"]
        for suffix, chosen in [("volley", {"Spell2"}), ("review", set(clips) - core - {"Spell2"})]:
            pack_tracks(model, chosen, "ashe-" + suffix, tmp, pack, DEST)
        model.doc["animations"] = [a for a in all_clips if a["name"] in core]
        model.write(result)
    run(pack, "-i", result, "-o", DEST / result.name, "-kn", "-cc", "-ce", "ext", "-ar", "16")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="League install root containing Game/DATA/FINAL")
    parser.add_argument("--only", nargs="+", choices=[m[0] for m in MODELS])
    args = parser.parse_args()
    for model in MODELS:
        if args.only and model[0] not in args.only:
            continue
        with tempfile.TemporaryDirectory() as stage:
            build(args.source / "Game/DATA/FINAL", Path(stage), *model)
