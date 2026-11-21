"""Rebuild Rek'Sai's skinned rock shard and its emitter poses after importing native tracks."""
import argparse
import gzip
import json
from pathlib import Path
import struct
import tempfile

from import_battle_effects import ROOT, NativeAssets, command, entry_hash, sha

ENTRY = "Characters/RekSai/Skins/Skin0/Particles/RekSai_Base_Burrowed_W_cas_knockup"


def build(source, tools, work, tmp):
    wad = "Champions/RekSai.wad.client"
    final = source / "Game/DATA/FINAL"
    folder = work / "RekSai.wad"
    tree = folder / f"{entry_hash(ENTRY):08x}.json"
    sample = tmp / "poses"
    command("node", work / "sample.mjs", tree, sample, json.dumps({
        "only": ["rockShard_Spike"], "seconds": 3, "fps": 60
    }))
    track = json.loads(sample.with_suffix(".json").read_bytes())
    layer, = track["layers"]
    base = Path(layer["meshPath"].lower())
    names = {"mesh": str(base), "rig": str(base.with_suffix(".skl")),
             "clip": str(base.with_suffix(".anm")), "texture": layer["texturePath"].lower()}
    index = NativeAssets(final, tools, None, tmp).index(wad)
    command(tools / "wadtools", "extract", "-i", final / wad, "-o", tmp,
            "--hash", *(index[name] for name in names.values()), "--stats=false")
    command(tools / "lol2gltf", "skn2gltf", "-m", tmp / names["mesh"], "-s", tmp / names["rig"],
            "-a", (tmp / names["clip"]).parent, "-g", tmp / "rock.glb")
    command(tools / "ltk-tex-utils", "decode", tmp / names["texture"], "-o", tmp / "stone.png")
    # Frames retain the native emitter's birth time, XYZ, scale, RGBA and 3x3 basis.
    data = sample.with_suffix(".bin").read_bytes()
    count = track["frames"] + 1
    offsets = struct.unpack_from(f"<{count}I", data)
    frames = []
    for begin, end in zip(offsets, offsets[1:]):
        frame = []
        for j in range(begin, end):
            row = struct.unpack_from("<40f", data, count * 4 + j * 160)
            frame.append([round(x, 6) for x in (*row[:11], *row[12:21], row[38])])
        frames.append(frame)
    dest = ROOT / "web/public/media/arrival"
    dest.mkdir(parents=True, exist_ok=True)
    sources = {"mesh": ("glb", (tmp / "rock.glb").read_bytes()),
               "texture": ("png", (tmp / "stone.png").read_bytes()),
               "poses": ("json.gz", gzip.compress(json.dumps(frames,separators=(",",":")).encode(),mtime=0))}
    files = {}
    for key,(extension, data) in sources.items():
        files[key] = sha(data)[:24]+"."+extension
        (dest / files[key]).write_bytes(data)
    archive = {"wad": wad, "entry": ENTRY, "layer": layer["name"], "treeSHA256": sha(tree.read_bytes()),
               "fps": track["fps"], "inputs": {k: {"path": v, "chunk":index[v],"sha256":sha((tmp/v).read_bytes())}
                    for k,v in names.items()}, "files":files}
    (ROOT/"web/src/reksai-rock-assets.json").write_text(json.dumps(archive,indent=2)+"\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source",type=Path,default=Path.home()/"Downloads/LOL_Asset_Source")
    parser.add_argument("--tools",type=Path,default=Path.home()/"Tools/lol-asset-tools/bin")
    parser.add_argument("--work",type=Path,required=True)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory() as tmp:
        build(args.source,args.tools,args.work,Path(tmp))
