"""Compile the dock survey into the rectangular geometry used by the battle core."""
import argparse
from itertools import pairwise
import json
from pathlib import Path

CONTENT = Path(__file__).resolve().parents[1] / "content"
RASTER = 8  # A quarter deployment tile; navigation runs continuously against the rectangles.


def horizontal_runs(polygon, y):
    xs = sorted(
        x0 + (x1 - x0) * (y - y0) / (y1 - y0)
        for (x0, y0), (x1, y1) in pairwise([*polygon, polygon[0]])
        if min(y0, y1) <= y < max(y0, y1)
    )
    return list(zip(xs[::2], xs[1::2]))


def bands(rows):
    """Merge equal cross sections on successive rows into maximal rectangles."""
    result = []
    prior = {}
    for y, height, runs in rows:
        current = {}
        for left, right in runs:
            if left >= right:
                continue
            key = (left, right)
            rect = prior.get(key)
            if rect is None:
                rect = [left, y, right, y]
                result.append(rect)
            rect[3] = y + height
            current[key] = rect
        prior = current
    return result


def terrain(layout):
    width, height = layout["width"], layout["height"]
    land_rows = []
    for y in range(0, height, RASTER):
        mid = y + RASTER / 2
        (west, east), = horizontal_runs(layout["outline"], mid)
        ranges = [(0, west), (east, width)]
        for prop in layout["props"]:
            ranges.extend(horizontal_runs(prop["polygon"], mid))
        # Keep the ship and crane outlines within a couple units of their survey.
        runs = [(round(a / 4) * 4, round(b / 4) * 4) for a, b in ranges]
        land_rows.append((y, RASTER, runs))

    def bank_at(points, x):
        for (a, b), (c, d) in pairwise(points):
            if a <= x <= c and a != c:
                return b + (x - a) * (d - b) / (c - a)
        raise ValueError(f"Bank does not cover x={x}")

    bridges = layout["bridges"]
    xs = sorted({*range(0, width, RASTER), width, *(v for bridge in bridges for v in bridge.values())})
    wet, channel = [], []
    for left, right in pairwise(xs):
        x = (left + right) / 2
        lo, hi = [round(bank_at(layout["river"][bank], x) / 4) * 4 for bank in ("north", "south")]
        runs = [(lo, hi)]
        channel.append((left, right - left, runs))
        is_bridge = any(b["left"] < x < b["right"] for b in bridges)
        wet.append((left, right - left, [] if is_bridge else runs))
    # The river was swept along X. Transpose its rectangles back to world XY.
    def transpose(rows):
        return [[x, y, r, b] for y, x, b, r in bands(rows)]
    return bands(land_rows), transpose(wet), transpose(channel)


def tile_zones(cells):
    rows = []
    for y in range(max((y for _, y in cells), default=-1) + 1):
        xs = sorted(x for x, row in cells if row == y)
        runs = []
        for x in xs:
            if runs and runs[-1][1] == x:
                runs[-1][1] = x + 1
            else:
                runs.append([x, x + 1])
        rows.append((y, 1, runs))
    return [[x, y, r-x, b-y] for x, y, r, b in bands(rows)]


def compile_map(layout):
    width, height, tile = (layout[k] for k in ("width", "height", "tile"))
    ox, oy = layout["tileOrigin"]
    land, water, channel = terrain(layout)
    banks = {"blue": set(), "red": set()}
    pockets = {"blue": [set() for _ in layout["lanes"]], "red": [set() for _ in layout["lanes"]]}
    bridges = [(b["left"] + b["right"]) / 2 for b in layout["bridges"]]
    for y in range((height - 2 * oy) // tile):
        for x in range((width - 2 * ox) // tile):
            left, top = ox + tile*x, oy + tile*y
            if any(left + tile > a and left < c and top + tile > b and top < d
                   for a, b, c, d in [*land, *channel]):
                continue
            cx, cy = left + tile/2, top + tile/2
            bank = "blue" if cy > height / 2 else "red"
            banks[bank].add((x, y))
            enemy = "red" if bank == "blue" else "blue"
            lane = min(range(len(bridges)), key=lambda i: abs(bridges[i] - cx))
            # Capturing the opposing outer tower unlocks this lane's forward bank.
            tower_y = layout["teams"][bank]["towers"][lane][1]
            if abs(cy-height/2) < abs(tower_y-height/2)-2*tile:
                pockets[enemy][lane].add((x,y))

    landmarks = []
    for team in ("blue", "red"):
        side = layout["teams"][team]
        sign = 1 if team == "blue" else -1
        landmarks.append({
            **side, "towerRadius": 46, "nexusRadius": 44,
            "front": [[x, height/2 + sign*5*tile] for x in bridges],
            "buildingFront": [[x, height/2 + sign*7*tile] for x in bridges],
        })
    media = "/play/media/battle/lowtide-dock"
    return {
        "id": "lowtide-dock", "name": "退潮船坞", "width": width, "height": height,
        "tile": tile, "tileOrigin": [ox, oy], "obstacles": water, "landObstacles": land,
        "landmarks": landmarks, "lanes": layout["lanes"],
        "home": tile_zones(banks["blue"]), "redHome": tile_zones(banks["red"]),
        "pockets": [tile_zones(cells) for cells in pockets["blue"]],
        "redPockets": [tile_zones(cells) for cells in pockets["red"]],
        "terrain": f"{media}/overview.webp", "terrainRed": f"{media}/overview-red.webp",
        "backdropWidth": 3680, "backMargin": 90, "projection": 0.8090169943749475,
        "image": f"{media}/preview.webp", "desktopRecommended": True,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    path = CONTENT / "maps.json"
    maps = json.loads(path.read_text())
    result = compile_map(json.loads((CONTENT / "lowtide-layout.json").read_text()))
    if args.check:
        if next((m for m in maps if m["id"] == result["id"]), None) != result:
            raise SystemExit("Dock map differs from the shared survey; run tools/build_lowtide_map.py.")
    else:
        encode = lambda v: json.dumps(v, ensure_ascii=False, separators=(",", ":"))
        previous = ["  " + encode(m) for m in maps if m["id"] != result["id"]]
        entry = "  {\n" + ",\n".join("    " + encode(k) + ":" + encode(v) for k,v in result.items()) + "\n  }"
        path.write_text("[\n" + ",\n".join([*previous, entry]) + "\n]\n")
