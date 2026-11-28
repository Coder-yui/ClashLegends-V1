"""Fetch the CC0 photographic sources used by the dock terrain; the game uses the baked GLB."""

from concurrent.futures import ThreadPoolExecutor
from hashlib import md5
from pathlib import Path
import json
import sys
import urllib.request

CACHE = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(".local/lowtide-materials")
SOURCES = [
    "stone_floor",
    "weathered_planks",
    "brown_mud_03",
    "factory_brick",
    "rusty_metal_02",
    "concrete_floor_02",
    "seaworn_stone_tiles",
    "concrete_pavement_02",
    "hangar_concrete_floor",
]
SKY = "kloofendal_48d_partly_cloudy_puresky"


def read(url):
    request = urllib.request.Request(
        url, headers={"User-Agent": "ClashLegends low tide dock asset builder"}
    )
    return urllib.request.urlopen(request, timeout=45).read()


def fetch(asset):
    entry = json.loads(read("https://api.polyhaven.com/files/" + asset))
    channels = {
        "c": ("diffuse", "diff", "color"),
        "n": ("nor_gl",),
        "r": ("rough", "roughness"),
    }
    if asset == SKY:
        channels = {"hdr": ("hdri",)}
    for suffix, keys in channels.items():
        keys_lower = {k.lower(): v for k, v in entry.items()}
        spec = next((keys_lower[k] for k in keys if k in keys_lower), None)
        if spec is None:
            raise ValueError(f"{asset}: {keys_lower.keys()}")
        extension = "hdr" if suffix == "hdr" else "jpg"
        file = spec["1k"][extension]
        target = CACHE / (
            asset + ("-" + suffix if suffix != "hdr" else "") + "." + extension
        )
        if target.exists() and md5(target.read_bytes()).hexdigest() == file["md5"]:
            continue
        data = read(file["url"])
        if md5(data).hexdigest() != file["md5"]:
            raise ValueError("Truncated download: " + asset)
        target.write_bytes(data)
    print(asset, flush=True)


if __name__ == "__main__":
    CACHE.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(7) as pool:
        list(pool.map(fetch, SOURCES + [SKY]))
