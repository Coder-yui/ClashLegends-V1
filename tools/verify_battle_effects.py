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


def compare_reference(reference, recipes, headers):
    """Compare calibration metadata only; the import never reads legacy media."""
    root = reference / "assets/effects"
    paths = sorted(root.rglob("sampled.json"))
    check(paths, f"No legacy particle samples in {root}")
    compared = 0
    for path in paths:
        key = path.parent.relative_to(root).as_posix()
        check(key in recipes, f"{key}: legacy system missing from battle recipes")
        # Stop before the frame arrays, which can be tens of megabytes.
        with path.open() as stream:
            prefix = ""
            while ',"frames":[' not in prefix:
                chunk = stream.read(65536)
                check(chunk, f"{key}: missing legacy frame array")
                prefix += chunk
        legacy = json.loads(prefix.split(',"frames":[', 1)[0] + "}")
        duration = legacy["duration"]
        # Crescendo emits for half a second then plays a 1.5-second tail.
        check(abs(headers[key]["duration"] - (2 if key == "sona/wave" else duration)) < 0.0001,
              f"{key}: sample window differs from reference")
        wanted = {e["name"].split(":")[-1] for e in legacy["emitters"]
                  if not (e.get("disabled") or e.get("culled"))}
        if key == "gwen_tristana/missile":
            wanted = {"bullet1"}
        if key == "malzahar/spawn":
            wanted.discard("LightFlashes1")
        if key.startswith("stasis/native/"):
            wanted.discard("RimLighting")
        if key == "soul_tentacle/avatar":
            wanted -= {"fireLine", "MatOverride"}  # legacy actor uses the three skin overlays
        if key == "reksai/emerge":
            # The old emerge stage is published as knockup + animated rock meshes.
            actual = {e["name"] for e in headers["reksai/knockup"]["layers"]}
            rocks = read_json(ROOT / "web/src/reksai-rock-assets.json")
            check(rocks["entry"] == recipes["reksai/knockup"]["entry"], "RekSai rock parent")
            actual.add(rocks["layer"])
        else:
            actual = {e["name"] for e in headers[key]["layers"]}
        check(actual == wanted, f"{key}: reference layers differ: {sorted(actual ^ wanted)}")
        compared += 1
    print(f"{compared} legacy sample windows and emitter selections compared")


def verify(source, wadtools, reader=None, reference=None):
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
    headers = {}
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
            if reference:
                headers[key] = header
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
            bias = layer["depthBias"]
            check(len(bias) == 2 and all(isinstance(x, (int, float)) for x in bias),
                  key + " invalid polygon offset")
            check(isinstance(layer["pass"], int) and isinstance(layer["depthPushPull"], (int, float)),
                  key + " invalid depth priority or push")
            check(layer["groundLayer"] == (layer["rank"] < 0), key + " wrong ground phase")
            phases = layer["phases"]
            check(phases["colour"] in (None, "under", "over") and
                  (phases["colour"] is not None or phases["warpsEarly"] or phases["warpsLate"]),
                  key + " missing render phase")
            if layer["soft"]:
                check(set(layer["soft"]) == {"beginIn", "deltaIn", "beginOut", "deltaOut", "target"},
                      key + " incomplete soft depth")
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
    if reference:
        compare_reference(reference, recipes, headers)
    if reader and not source:
        raise ValueError("--reader requires --source")
    if reader:
        # Re-resolve the named system inside the original BIN, including its
        # local links. Matching TEX bytes alone cannot detect a wrong emitter.
        groups = defaultdict(list)
        for origin in history["systems"].values():
            groups[origin["wad"]].append(origin)
        with tempfile.TemporaryDirectory() as tmp:
            for wad, group in groups.items():
                folder = Path(tmp) / Path(wad).stem
                folder.mkdir()
                request = folder / "requests.json"
                request.write_text(json.dumps([s["entry"] for s in group]))
                subprocess.run([reader, source / "Game/DATA/FINAL" / wad, request, folder], check=True)
                for origin in group:
                    key = origin["entryHash"]
                    check((folder / (key + ".bin-hash")).read_text() == origin["binChunk"], origin["entry"])
                    tree = (folder / (key + ".json")).read_bytes()
                    check(hashlib.sha256(tree).hexdigest() == origin["resolvedTreeSHA256"], origin["entry"])
        print(f"{len(systems)} original WAD system definitions verified")
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
    parser.add_argument("--reference", type=Path, help="Compare old battle sample windows and layer selections")
    parser.add_argument(
        "--wadtools",
        type=Path,
        default=Path.home() / "Tools/lol-asset-tools/bin/wadtools",
    )
    parser.add_argument("--reader", type=Path, help="Re-resolve every BIN system with the import reader")
    args = parser.parse_args()
    verify(args.source, args.wadtools, args.reader, args.reference)
