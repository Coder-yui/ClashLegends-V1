"""Build the Rift's render geometry from the same scene used by export_battlefield.gd."""
import argparse
import io
import json
from pathlib import Path
import struct
import subprocess
import tempfile

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]


def export(source, destination):
    data = (source / "rift_arena.glb").read_bytes()
    size = struct.unpack_from("<I", data, 12)[0]
    doc = json.loads(data[20:20 + size])
    binary_start = 28 + size
    binary = bytearray(data[binary_start:])
    # Preserve the actual silhouette masks, including the runtime pine material
    # override in rift_arena.gd. Terrain colour comes from the matching camera bake.
    def append_mask(image):
        alpha = image.convert("RGBA").getchannel("A")
        mask = Image.new("LA", image.size, (255, 255))
        mask.putalpha(alpha)
        encoded = io.BytesIO()
        mask.save(encoded, format="PNG", optimize=True)
        binary.extend(bytes(-len(binary) % 4))
        view = {"buffer": 0, "byteOffset": len(binary), "byteLength": encoded.tell()}
        doc["bufferViews"].append(view)
        binary.extend(encoded.getvalue())
        return {"bufferView": len(doc["bufferViews"]) - 1, "mimeType": "image/png"}

    for i, record in enumerate(doc["images"]):
        view = doc["bufferViews"][record["bufferView"]]
        start = binary_start + view.get("byteOffset", 0)
        encoded = io.BytesIO(data[start:start + view["byteLength"]])
        with Image.open(encoded) as image:
            doc["images"][i] = append_mask(image)
    pine = len(doc["textures"])
    doc["textures"].append({"source": len(doc["images"])})
    with Image.open(source / "textures/canopy_foliage.png") as canopy:
        doc["images"].append(append_mask(canopy))
    for i, material in enumerate(doc["materials"]):
        name = material["name"]
        tex = material.get("pbrMetallicRoughness", {}).get("baseColorTexture")
        threshold = material.get("alphaCutoff", 0.5)
        if name.startswith("RiftPine"):
            tex = {"index": pine}
            threshold = 0.5
        doc["materials"][i] = {"doubleSided": True}
        if tex and (name.startswith("RiftPine") or material.get("alphaMode") == "MASK"):
            doc["materials"][i].update(
                alphaMode="MASK",
                alphaCutoff=threshold,
                pbrMetallicRoughness={"baseColorTexture": tex},
            )
    for mesh in doc["meshes"]:
        for primitive in mesh["primitives"]:
            attrs = primitive["attributes"]
            kept = {"POSITION": attrs["POSITION"]}
            if "alphaMode" in doc["materials"][primitive["material"]]:
                kept["TEXCOORD_0"] = attrs["TEXCOORD_0"]
            primitive["attributes"] = kept
    doc["buffers"][0]["byteLength"] = len(binary)
    header = json.dumps(doc, separators=(",", ":")).encode()
    header += b" " * (-len(header) % 4)
    binary.extend(bytes(-len(binary) % 4))
    with tempfile.TemporaryDirectory() as temporary:
        path = Path(temporary) / "terrain.glb"
        path.write_bytes(struct.pack("<4sIIII", b"glTF", 2, 28 + len(header) + len(binary),
                                     len(header), 0x4e4f534a) + header
                         + struct.pack("<II", len(binary), 0x004e4942) + binary)
        subprocess.run([ROOT / "web/node_modules/.bin/gltfpack", "-i", path, "-o", destination,
                        "-cc", "-vp", "16"], check=True)


if __name__ == "__main__":
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("source", type=Path, help="reference assets/arena/rift_arena directory")
    args = cli.parse_args()
    export(args.source, ROOT / "web/public/media/battle/rift-terrain.glb")
