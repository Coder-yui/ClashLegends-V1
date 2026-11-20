"""Make V1 particle assets directly from the LoL install. No reference game is required."""

import argparse
import fcntl
from collections import defaultdict
import gzip
import hashlib
import json
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "web/public/media/vfx"
REVISION = "712ddd1ecf725b6fc45aff7e629ee63e8137f13e"


def compact(data):
    return json.dumps(
        data, separators=(",", ":"), ensure_ascii=False, allow_nan=False
    ).encode()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def replace_file(path, data):
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as f:
        f.write(data)
        temporary = Path(f.name)
    temporary.chmod(0o644)
    temporary.replace(path)


def asset(data, extension):
    name = sha(data)[:24] + extension
    file = OUTPUT / name
    if not file.exists():
        replace_file(file, data)
    return name


def entry_hash(name):
    if name.startswith("0x"):
        return int(name, 16)
    h = 2166136261
    for c in name.lower().encode():
        h = ((h ^ c) * 16777619) & 0xFFFFFFFF
    return h


def command(*args):
    result = subprocess.run(list(map(str, args)), capture_output=True)
    if result.returncode:
        raise RuntimeError(
            result.stderr.decode()[-4000:] or result.stdout.decode()[-4000:]
        )
    return result.stdout


def mesh_json(glb):
    data = glb.read_bytes()
    size = struct.unpack_from("<I", data, 12)[0]
    doc = json.loads(data[20 : 20 + size])
    blob = memoryview(data)[28 + size :]

    def values(index):
        a = doc["accessors"][index]
        view = doc["bufferViews"][a["bufferView"]]
        offset = view.get("byteOffset", 0) + a.get("byteOffset", 0)
        fmt = (
            "<"
            + {5121: "B", 5123: "H", 5125: "I", 5126: "f"}[a["componentType"]]
            * {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[a["type"]]
        )
        stride = view.get("byteStride", struct.calcsize(fmt))
        return [
            struct.unpack_from(fmt, blob, offset + i * stride)
            for i in range(a["count"])
        ]

    positions, coords, colors = [], [], []
    for primitive in doc["meshes"][0]["primitives"]:
        attrs = primitive["attributes"]
        pts = values(attrs["POSITION"])
        uv = (
            values(attrs["TEXCOORD_0"])
            if "TEXCOORD_0" in attrs
            else [(0, 0)] * len(pts)
        )
        rgba = values(attrs["COLOR_0"]) if "COLOR_0" in attrs else None
        for (i,) in values(primitive["indices"]):
            positions.extend(pts[i])
            coords.extend(uv[i])
            color = rgba[i] if rgba else (1.0, 1.0, 1.0, 1.0)
            colors.extend(
                [round(v * 255) if isinstance(v, float) else v for v in color]
            )
            if len(color) == 3:
                colors.append(255)
    return compact(dict(vertices=positions, uv=coords, colors=colors))


class NativeAssets:
    def __init__(self, final, tools, scb, tmp):
        self.final, self.tools, self.scb, self.tmp = final, tools, scb, tmp
        self.indices, self.published = {}, {}

    def index(self, wad):
        if wad not in self.indices:
            output = command(
                self.tools / "wadtools", "list", "-i", self.final / wad, "-F", "json"
            )
            items = json.JSONDecoder().raw_decode(
                output[output.index(b"{") :].decode()
            )[0]["chunks"]
            self.indices[wad] = {
                i["path"].lower(): i["hash"] for i in items if i.get("path")
            }
        return self.indices[wad]

    def publish(self, wad, names):
        resolved = {}
        todo = defaultdict(dict)
        for original in names:
            path = original.lower().replace("\\", "/")
            if Path(path).suffix in (".dds", ".tga", ".png"):
                path = str(Path(path).with_suffix(".tex"))
            for src in dict.fromkeys(
                [wad, "Global.wad.client", "Maps/Shipping/Map11.wad.client"]
            ):
                found = self.index(src).get(path)
                if found:
                    resolved[original] = (src, path)
                    if (src, path) not in self.published:
                        todo[src][path] = found
                    break
            else:
                raise ValueError(f"{wad} missing native dependency {original}")
        for src, paths in todo.items():
            folder = self.tmp / "chunks" / Path(src).stem
            folder.mkdir(parents=True, exist_ok=True)
            command(
                self.tools / "wadtools",
                "extract",
                "-i",
                self.final / src,
                "-o",
                folder,
                "--hash",
                *paths.values(),
                "--stats=false",
            )
            models = [folder / p for p in paths if p.endswith(".scb")]
            if models:
                command("dotnet", self.scb, *models)
            for p, h in paths.items():
                source = folder / p
                record = dict(wad=src, path=p, chunk=h, sha256=sha(source.read_bytes()))
                if p.endswith(".tex"):
                    png = source.with_suffix(".png")
                    command(self.tools / "ltk-tex-utils", "decode", source, "-o", png)
                    record["file"] = asset(png.read_bytes(), ".png")
                elif p.endswith(".scb"):
                    record["file"] = asset(
                        mesh_json(source.with_suffix(".glb")), ".mesh.json"
                    )
                else:
                    raise ValueError("Unsupported source format " + p)
                self.published[src, p] = record
        return {original: self.published[key] for original, key in resolved.items()}


def build(options, tmp):
    ltk = options.ltk.resolve()
    if command("git", "-C", ltk, "rev-parse", "HEAD").decode().strip() != REVISION:
        raise ValueError("Use LTK Manager revision " + REVISION)
    helper = ltk / "crates/ltk-manager-game/examples/clash_vfx.rs"
    if not options.reader:
        helper.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / "tools/vfx/read_systems.rs", helper)
        subprocess.run(
            [
                "cargo",
                "build",
                "--release",
                "--locked",
                "-p",
                "ltk-manager-game",
                "--example",
                "clash_vfx",
            ],
            cwd=ltk,
            check=True,
        )
    reader = options.reader or ltk / "target/release/examples/clash_vfx"
    sampler = tmp / "sample.mjs"
    command(
        ROOT / "web/node_modules/.bin/esbuild",
        ROOT / "tools/vfx/sample.ts",
        "--bundle",
        "--platform=node",
        "--format=esm",
        "--alias:@vfx=" + str(ltk / "src/modules/workshop/bin/vfx"),
        "--alias:@=" + str(ltk / "src"),
        "--alias:three=" + str(ROOT / "web/node_modules/three"),
        "--outfile=" + str(sampler),
    )
    version = json.loads((options.source / "Game/content-metadata.json").read_bytes())[
        "version"
    ]
    generator = sha(
        sampler.read_bytes()
        + Path(__file__).read_bytes()
        + (ROOT / "tools/vfx/read_systems.rs").read_bytes()
    )
    final = options.source / "Game/DATA/FINAL"
    native = NativeAssets(final, options.tools, options.scb, tmp)
    recipes = json.loads((ROOT / "content/effect_recipes.json").read_bytes())
    groups = defaultdict(dict)
    for key, r in recipes.items():
        groups[r["wad"]][key] = r
    systems, provenance = {}, {}
    errors = []
    reader_digest = sha(reader.read_bytes())

    def stamp(path):
        stat = path.stat()
        return [str(path.resolve()), stat.st_size, stat.st_mtime_ns]

    for wad, group in groups.items():
        folder = tmp / Path(wad).stem
        folder.mkdir(exist_ok=True)
        requests = folder / "requests.json"
        requests.write_bytes(compact([entry_hash(r["entry"]) for r in group.values()]))
        identity = dict(version=version, reader=reader_digest, wad=stamp(final / wad))
        tag = folder / "input.json"
        changed = not tag.exists() or json.loads(tag.read_bytes()) != identity
        if changed or not all(
            (folder / (f"{entry_hash(r['entry']):08x}.json")).exists()
            for r in group.values()
        ):
            if changed:
                for recipe in group.values():
                    (folder / (f"{entry_hash(recipe['entry']):08x}.json")).unlink(
                        missing_ok=True
                    )
            command(reader, final / wad, requests, folder)
            tag.write_bytes(compact(identity))
        for key, recipe in group.items():
            try:
                h = f"{entry_hash(recipe['entry']):08x}"
                tree = folder / (h + ".json")
                if not tree.exists():
                    raise ValueError(f"{key}: missing {recipe['entry']} in {wad}")
                marker = folder / (key.replace("/", "-") + ".built.json")
                if marker.exists():
                    saved = json.loads(marker.read_bytes())
                    deps = saved["source"]["dependencies"]
                    archives = {d["wad"] for d in deps}
                    valid_inputs = saved.get("inputs") == [
                        stamp(final / w) for w in sorted(archives)
                    ]
                    if (
                        not changed
                        and saved.get("generator") == generator
                        and valid_inputs
                        and saved["recipe"] == recipe
                        and (OUTPUT / saved["system"]["file"]).exists()
                        and all((OUTPUT / d["file"]).exists() for d in deps)
                    ):
                        systems[key] = saved["system"]
                        provenance[key] = saved["source"]
                        continue
                out = folder / "sample"
                command("node", sampler, tree, out, json.dumps(recipe))
                header = json.loads(out.with_suffix(".json").read_bytes())
                if not header["layers"]:
                    raise ValueError(f"{key} contains no drawable native emitters")
                paths = {
                    v
                    for layer in header["layers"]
                    for k, v in layer.items()
                    if k.endswith("Path") and v
                }
                refs = native.publish(wad, sorted(paths))
                for layer in header["layers"]:
                    for k in list(layer):
                        if k.endswith("Path"):
                            path = layer.pop(k)
                            if path:
                                layer[k[:-4] + "File"] = refs[path]["file"]
                    for uv in ("uv", "multUv"):
                        layer[uv] = {
                            k: v
                            for k, v in layer[uv].items()
                            if k in ("center", "flipU", "flipV", "addressMode")
                        }
                head = compact(header)
                data = (
                    struct.pack("<4sII", b"CVFX", 1, len(head))
                    + head
                    + bytes(-len(head) % 4)
                    + out.with_suffix(".bin").read_bytes()
                )
                file = asset(gzip.compress(data, compresslevel=5, mtime=0), ".vfx.gz")
                systems[key] = dict(
                    file=file,
                    frames=header["frames"],
                    fps=header["fps"],
                    layers=len(header["layers"]),
                )
                provenance[key] = dict(
                    wad=wad,
                    entry=recipe["entry"],
                    entryHash=h,
                    binChunk=(folder / (h + ".bin-hash")).read_text(),
                    resolvedTreeSHA256=sha(tree.read_bytes()),
                    dependencies=list(refs.values()),
                )
                marker.write_bytes(
                    compact(
                        dict(
                            recipe=recipe,
                            system=systems[key],
                            source=provenance[key],
                            generator=generator,
                            inputs=[
                                stamp(final / w)
                                for w in sorted({d["wad"] for d in refs.values()})
                            ],
                        )
                    )
                )
            except (ValueError, RuntimeError) as e:
                errors.append(key + ": " + str(e))
                print(errors[-1], flush=True)
        print(wad, len(group), flush=True)
    if errors:
        raise ValueError("\n".join(errors))
    index = dict(version=1, sourceVersion=version, systems=systems)
    replace_file(
        ROOT / "content/effect_provenance.json",
        compact(dict(toolRevision=REVISION, sourceVersion=version, systems=provenance))
        + b"\n",
    )
    replace_file(ROOT / "web/src/battle-effect-assets.json", compact(index) + b"\n")
    published = {s["file"] for s in systems.values()} | {
        d["file"] for origin in provenance.values() for d in origin["dependencies"]
    }
    for file in OUTPUT.iterdir():
        digest = file.name.split(".")[0]
        if (
            file.is_file()
            and file.name not in published
            and len(digest) == 24
            and sha(file.read_bytes()).startswith(digest)
        ):
            file.unlink()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ltk", type=Path, required=True)
    parser.add_argument("--reader", type=Path)
    parser.add_argument(
        "--source", type=Path, default=Path.home() / "Downloads/LOL_Asset_Source"
    )
    parser.add_argument(
        "--tools", type=Path, default=Path.home() / "Tools/lol-asset-tools/bin"
    )
    parser.add_argument(
        "--scb",
        type=Path,
        default=Path.home()
        / "Tools/lol-scb-export/bin/Debug/net10.0/lol-scb-export.dll",
    )
    parser.add_argument("--work", type=Path)
    options = parser.parse_args()
    OUTPUT.mkdir(exist_ok=True, parents=True)
    lock = Path(tempfile.gettempdir()) / (
        "clash-vfx-" + sha(str(ROOT).encode())[:16] + ".lock"
    )
    with lock.open("a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        if options.work:
            options.work.mkdir(exist_ok=True, parents=True)
            build(options, options.work)
        else:
            with tempfile.TemporaryDirectory() as directory:
                build(options, Path(directory))
