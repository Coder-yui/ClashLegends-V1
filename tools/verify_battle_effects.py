"""Check published particle tracks, dependency hashes and optional original WAD contents."""

import argparse
from collections import defaultdict
import gzip
import hashlib
import json
from pathlib import Path
import struct
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
MEDIA = ROOT / "web/public/media/vfx"


def check(condition, message):
    if not condition:
        raise ValueError(message)


def read_json(path):
    return json.loads(path.read_bytes())


def verify(source, wadtools):
    index = read_json(ROOT / "web/src/battle-effect-assets.json")
    recipes = read_json(ROOT / "content/effect_recipes.json")
    history = read_json(ROOT / "content/effect_provenance.json")
    systems = index["systems"]
    check(
        systems.keys() == recipes.keys() == history["systems"].keys(),
        "Different system lists",
    )
    files = set()
    inputs = defaultdict(dict)
    layers = 0
    for key, system in systems.items():
        origin = history["systems"][key]
        check(
            origin["wad"] == recipes[key]["wad"]
            and origin["entry"] == recipes[key]["entry"],
            key,
        )
        dependencies = {d["file"] for d in origin["dependencies"]}
        for record in origin["dependencies"]:
            inputs[record["wad"]][record["chunk"]] = record
        files.add(system["file"])
        files.update(dependencies)
        with gzip.open(MEDIA / system["file"], "rb") as stream:
            magic, version, size = struct.unpack("<4sII", stream.read(12))
            check(magic == b"CVFX" and version == 1, key)
            header = json.loads(stream.read(size))
            stream.read(-size % 4)
            count = header["frames"] * len(header["layers"]) + 1
            offsets = struct.unpack(f"<{count}I", stream.read(count * 4))
            check(
                offsets[0] == 0
                and offsets[-1] > 0
                and list(offsets) == sorted(offsets),
                key + " empty/invalid offsets",
            )
            check(
                len(stream.read()) == offsets[-1] * header["width"] * 4,
                key + " invalid rows",
            )
        check(header["width"] == 40 and len(header["layers"]) == system["layers"], key)
        for layer in header["layers"]:
            for field, value in layer.items():
                if field.endswith("File"):
                    check(value in dependencies, key + " untraced " + value)
        layers += len(header["layers"])
    for file in files:
        check(
            hashlib.sha256((MEDIA / file).read_bytes()).hexdigest()[:24]
            == file.split(".")[0],
            file,
        )
    check(
        files == {f.name for f in MEDIA.iterdir() if f.is_file()},
        "Unreferenced published files",
    )
    if source:
        version = read_json(source / "Game/content-metadata.json")["version"]
        check(
            version == index["sourceVersion"] == history["sourceVersion"],
            "Source version differs",
        )
        with tempfile.TemporaryDirectory() as folder:
            for wad, records in inputs.items():
                output = Path(folder) / Path(wad).stem
                output.mkdir(exist_ok=True)
                subprocess.run(
                    [
                        wadtools,
                        "extract",
                        "-i",
                        source / "Game/DATA/FINAL" / wad,
                        "-o",
                        output,
                        "--hash",
                        *records.keys(),
                        "--stats=false",
                    ],
                    check=True,
                    stdout=subprocess.DEVNULL,
                )
                for record in records.values():
                    raw = output / record["path"]
                    check(
                        hashlib.sha256(raw.read_bytes()).hexdigest()
                        == record["sha256"],
                        str(raw),
                    )
    print(
        f"{len(systems)} systems, {layers} emitters, {len(files)} published files verified"
    )
    if source:
        print(
            f"{sum(map(len, inputs.values()))} original WAD dependency chunks verified"
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path)
    parser.add_argument(
        "--wadtools",
        type=Path,
        default=Path.home() / "Tools/lol-asset-tools/bin/wadtools",
    )
    args = parser.parse_args()
    verify(args.source, args.wadtools)
