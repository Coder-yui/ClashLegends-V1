"""Build the dock's terrain and three distinct working crossings. Units are game-world units."""

import argparse
from bisect import bisect_right
from collections import defaultdict
from io import BytesIO
import json
import math
from pathlib import Path
import random
import shutil
import struct
import sys
import subprocess
import tempfile

import lowtide_bridges
import lowtide_lane_shoulders
import lowtide_pavement
from lowtide_foundations import make_foundations
from lowtide_quay import make_outer_harbour
from lowtide_shoreline import make_shoreline
from lowtide_weathering import make_weathering

from PIL import Image, ImageEnhance

ROOT = Path(__file__).resolve().parents[1]
PLAN = json.loads((ROOT / "content/lowtide-layout.json").read_text())
OUT = ROOT / "web/public/media/battle/lowtide-dock"
R = random.Random(16118)
SEA_LEVEL = -27
P = [(x - PLAN["width"] / 2, y - PLAN["height"] / 2) for x, y in PLAN["river"]["north"]]
Q = [(x - PLAN["width"] / 2, y - PLAN["height"] / 2) for x, y in PLAN["river"]["south"]]
HALF_WIDTH, HALF_DEPTH = PLAN["width"] / 2, PLAN["height"] / 2


def sample(bank, x):
    if x <= bank[0][0]:
        return bank[0][1]
    if x >= bank[-1][0]:
        return bank[-1][1]
    i = bisect_right(bank, (x, float("inf")))
    (a, b), (c, d) = bank[i - 1], bank[i]
    return b + (x - a) * (d - b) / (c - a)


def unit(v):
    n = math.sqrt(sum(i * i for i in v)) or 1.0
    return tuple(i / n for i in v)


def cross(a, b):
    x, y, z = a
    u, v, w = b
    return y * w - z * v, z * u - x * w, x * v - y * u


def normal(a, b, c):
    return unit(cross([y - x for x, y in zip(a, b)], [y - x for x, y in zip(a, c)]))


def tone(x, z):
    # Broad damp and lichen patches, separate from the fine photographic grain.
    return (
        0.94
        + 0.067 * math.sin(0.013 * x + 0.005 * z)
        + 0.053 * math.cos(0.024 * z - 0.008 * x)
        + 0.035 * math.sin(0.038 * x + 0.027 * z)
    )


class Mesh:
    def __init__(self):
        self.pos = []
        self.nor = []
        self.uv = []
        self.color = []
        self.indices = []

    def face(self, points, coords, colors=None, upward=False):
        n = normal(*points[:3])
        if upward and n[1] < 0:
            points = points[::-1]
            coords = coords[::-1]
            if colors:
                colors = colors[::-1]
            n = tuple(-x for x in n)
        offset = len(self.pos) // 3
        for i, (p, uv) in enumerate(zip(points, coords)):
            self.pos.extend(p)
            self.nor.extend(n)
            self.uv.extend(uv)
            self.color.extend(colors[i] if colors else (1, 1, 1))
        for i in range(1, len(points) - 1):
            self.indices.extend([offset, offset + i, offset + i + 1])


groups = defaultdict(Mesh)
materials = {}


def material(
    name,
    asset=None,
    tint=(1, 1, 1),
    rough=0.88,
    metal=0,
    normal_strength=0.8,
    scale=96,
    rotate=False,
):
    materials[name] = (asset, tint, rough, metal, normal_strength, scale, rotate)
    return name


yard = material(
    "Old poured quay slabs",
    "concrete_pavement_02",
    (0.97, 0.955, 0.91),
    0.95,
    scale=169,
)
# The map's survey lattice drives geometry and swatch placement together.
limestone = material(
    "Sun-dried quay limestone", lowtide_pavement.LIMESTONE, (1.0, 0.995, 0.98), 0.88
)
haulway = material(
    "Lock haulway ashlar", lowtide_pavement.HAULWAY, (1, 1, 1), 0.83,
    normal_strength=0.85,
)
granite = material(
    "Hand-laid harbour setts", lowtide_pavement.GRANITE, (0.95, 0.98, 1.0), 0.86
)
oak = material(
    "Silvered oak repair bays", lowtide_pavement.OAK, (1.0, 0.995, 0.985), 0.83
)
apron = material(
    "Repair floor", "hangar_concrete_floor", (0.88, 0.85, 0.76), 0.88, scale=160
)
marine = material(
    "Seaworn masonry flags", "seaworn_stone_tiles", (1.0, 0.96, 0.86), 0.91, scale=108
)
damp = material(
    "Damp concrete", "concrete_floor_02", (0.49, 0.53, 0.49), 0.76, scale=122
)
stone = material(
    "Dressed paving", "seaworn_stone_tiles", (0.87, 0.91, 0.92), 0.90, scale=86
)
edge = material(
    "Worn pale coping", "concrete_floor_02", (1.17, 1.13, 0.98), 0.85, scale=72
)
slate = material("Basalt kerb", "stone_floor", (0.52, 0.52, 0.47), 0.81, scale=63)
timber = material(
    "Tarred timber decking",
    "weathered_planks",
    (1.22, 1.14, 1.01),
    0.82,
    scale=103,
    rotate=True,
)
beam = material(
    "Wet structural oak", "weathered_planks", (0.68, 0.65, 0.57), 0.82, scale=76
)
shoal = material(
    "Exposed tidal silt", "brown_mud_03", (0.70, 0.73, 0.58), 0.9, scale=89
)
brick = material(
    "Old dock masonry", "factory_brick", (0.72, 0.75, 0.70), 0.81, scale=95
)
iron = material(
    "Oxidised structural iron",
    "rusty_metal_02",
    (0.27, 0.32, 0.29),
    0.67,
    0.36,
    scale=100,
)
rail = material("Worn steel rail head", None, (0.23, 0.25, 0.245), 0.41, 0.72)
black = material("Expansion joint", None, (0.057, 0.063, 0.060), 0.9)
water = material("Water estuary", "wave", (0.080, 0.165, 0.16), 0.32, 0.20, 0.52, 245)
wash = material("Salt and wrack line", "brown_mud_03", (0.96, 1, 0.80), 0.86, scale=44)
paint = material(
    "Faded ochre dock paint", "concrete_floor_02", (0.95, 0.65, 0.26), 0.86, scale=90
)


def surface(mat, points, label="Floor", shade=1.0, uv=None, tint=None):
    scale = materials[mat][5]
    rotated = materials[mat][6]
    if uv is None:
        uv = [
            ((z if rotated else x) / scale, (x if rotated else z) / scale)
            for x, y, z in points
        ]
    colors = [
        tuple(max(0.05, min(1.0, tone(x, z) * shade * c)) for c in (tint or (1, 1, 1)))
        for x, y, z in points
    ]
    groups[label, mat].face(points, uv, colors, upward=True)


def rect(mat, x1, z1, x2, z2, h=0, label="Floor", shade=1.0, uv=None):
    surface(mat, [(x1, h, z1), (x1, h, z2), (x2, h, z2), (x2, h, z1)], label, shade, uv)


def wall(mat, a, b, low, high, label="Fabric", tint=1.0):
    x, z = a
    u, v = b
    s = materials[mat][5]
    L = math.hypot(u - x, v - z)
    base = (x * 0.73 + z * 0.57) / s
    p = [(x, low, z), (x, high, z), (u, high, v), (u, low, v)]
    # Double-sided masonry shading enables inspection from underneath a span.
    groups[label, mat].face(
        p,
        [
            (base, low / s),
            (base, high / s),
            (base + L / s, high / s),
            (base + L / s, low / s),
        ],
        [(tint,) * 3] * 4,
    )


def prism(mat, ring, low, high, label="Fabric", shade=1.0):
    surface(mat, [(x, high, z) for x, z in ring], label, shade)
    for a, b in zip(ring, ring[1:] + ring[:1]):
        wall(mat, a, b, low, high, label, shade)


def box(mat, x, z, w, d, low, high, label="Fabric", shade=1.0):
    ring = [
        (x - w / 2, z - d / 2),
        (x - w / 2, z + d / 2),
        (x + w / 2, z + d / 2),
        (x + w / 2, z - d / 2),
    ]
    prism(mat, ring, low, high, label, shade)


def strip(mat, a, b, width, h, label="Floor", shade=1.0):
    x, z = a
    u, v = b
    L = math.hypot(u - x, v - z)
    if L < 0.001:
        return
    dx = (v - z) / L * width / 2
    dz = (x - u) / L * width / 2
    surface(
        mat,
        [
            (x + dx, h, z + dz),
            (x - dx, h, z - dz),
            (u - dx, h, v - dz),
            (u + dx, h, v + dz),
        ],
        label,
        shade,
    )


def shaft(mat, a, b, r, sides=8, label="Fabric"):
    axis = unit(tuple(q - p for p, q in zip(a, b)))
    n = unit(cross(axis, (1, 0, 0) if abs(axis[0]) < 0.8 else (0, 0, 1)))
    t = cross(axis, n)
    off = [
        tuple(
            r
            * (
                math.cos(2 * math.pi * j / sides) * i
                + math.sin(2 * math.pi * j / sides) * k
            )
            for i, k in zip(n, t)
        )
        for j in range(sides)
    ]
    rings = [[tuple(i + k for i, k in zip(v, d)) for d in off] for v in (a, b)]
    s = materials[mat][5]
    for j in range(sides):
        k = (j + 1) % sides
        points = [rings[0][j], rings[0][k], rings[1][k], rings[1][j]]
        groups[label, mat].face(
            points,
            [
                (0, 0),
                (r / s, 0),
                (r / s, math.dist(a, b) / s),
                (0, math.dist(a, b) / s),
            ],
        )
    for ring in rings:
        groups[label, mat].face(ring, [(p[0] / s, p[2] / s) for p in ring])


def bank_strip(x):
    return sample(P, x), sample(Q, x)


def quad_section(mat, x, u, z1, z2, v1, v2, h1, h2, label="Floor", shade=1):
    surface(mat, [(x, h1, z1), (u, h1, v1), (u, h2, v2), (x, h2, z2)], label, shade)


def make_estuary():
    # A single tidal height, with darker water out in the basin and pale shoals under the bank.
    for x in range(558, 3100, 80):
        for z in range(-2080, 2080, 80):
            p = [
                (x, SEA_LEVEL, z),
                (x, SEA_LEVEL, z + 80),
                (x + 80, SEA_LEVEL, z + 80),
                (x + 80, SEA_LEVEL, z),
            ]
            colors = []
            for xx, _, zz in p:
                distance = max(xx - 552, 0)
                f = math.exp(-distance / 175) * (0.82 + 0.14 * math.cos(zz * 0.022))
                patch = 0.03 * math.sin(xx * 0.012 + zz * 0.016) + 0.024 * math.cos(
                    xx * 0.026 - zz * 0.021
                )
                colors.append(
                    (
                        0.55 + 0.39 * f + patch,
                        0.68 + 0.24 * f + patch,
                        0.73 + 0.12 * f + patch,
                    )
                )
            groups["Estuary", water].face(
                p, [(i / 245, k / 245) for i, _, k in p], colors, upward=True
            )
    east = 558
    xs = sorted(
        set(
            [
                -2500,
                *range(-2450, -750, 50),
                *[round(x, 3) for x, z in P if -750 < x < east],
                *[round(x, 3) for x, z in Q if -750 < x < east],
                east,
            ]
        )
    )
    for i, (x, u) in enumerate(zip(xs, xs[1:])):
        n, s = bank_strip(x)
        m, t = bank_strip(u)
        # In the shaded channel the brown bed shows through at the shore.
        for j in range(5):
            f = j / 5
            g = (j + 1) / 5
            points = [
                (x, SEA_LEVEL, n + (s - n) * f),
                (u, SEA_LEVEL, m + (t - m) * f),
                (u, SEA_LEVEL, m + (t - m) * g),
                (x, SEA_LEVEL, n + (s - n) * g),
            ]
            cs = [
                (
                    0.61 + 0.16 * math.sin(math.pi * t),
                    0.57 + 0.18 * math.sin(math.pi * t),
                    0.45 + 0.22 * math.sin(math.pi * t),
                )
                for t in (f, f, g, g)
            ]
            groups["Estuary", water].face(
                points, [(xx / 245, zz / 245) for xx, _, zz in points], cs, upward=True
            )
        for sign, far, a, b in ((-1, -1860, n, m), (1, 1860, s, t)):
            # Tessellated apron gives broad changes in the damp stone visible even at full-map zoom.
            for j in range(16):
                f = j / 16.0
                g = (j + 1) / 16.0
                quad_section(
                    yard,
                    x,
                    u,
                    a + (far - a) * f,
                    a + (far - a) * g,
                    b + (far - b) * f,
                    b + (far - b) * g,
                    0,
                    0,
                )
            wall(brick, (x, a), (u, b), -24, 0, "Quay wall", 0.85)
            quad_section(edge, x, u, a, a + sign * 6, b, b + sign * 6, 0.14, 0.14)

            # Two exposed ledges run into the low-tide mud, with irregular outer waterlines.
            def shelf(xx):
                return (
                    8
                    + 3.5 * math.sin(xx * 0.032 + sign)
                    + 1.5 * math.cos(xx * 0.074)
                    + 3 * (1 + math.sin(xx * 0.012 + sign))
                )

            wa, wb = shelf(x), shelf(u)
            quad_section(
                shoal,
                x,
                u,
                a,
                a - sign * wa,
                b,
                b - sign * wb,
                -18,
                -24,
                "Tidal shelf",
                0.83,
            )
            quad_section(
                shoal,
                x,
                u,
                a - sign * wa,
                a - sign * (wa + 10),
                b - sign * wb,
                b - sign * (wb + 10),
                -24,
                -32,
                "Tidal shelf",
                0.91,
            )
            if x < -740 and u - x > 20:
                continue
            if i % 4 == 0 and u - x > 1.5:
                wall(
                    wash,
                    (x, a - sign * 1.0),
                    (u, b - sign * 1.0),
                    -17,
                    -15,
                    "Tide stain",
                    0.7,
                )
    # Armoured face along the estuary. Aprons branch out as individual pile-supported piers.
    for za, zb in [(-1860, P[-1][1]), (sample(Q, east), 1860)]:
        for z in range(math.ceil(za), math.ceil(zb), 38):
            end = min(z + 38, zb)
            wall(brick, (east, z), (east, end), -48, 0, "Quay wall")
            box(edge, east - 2.4, (z + end) / 2, 6, end - z - 0.6, -2, 0.8, "Coping")
            if z % 3 == 0:
                shaft(beam, (east + 3, -37, z + 4), (east + 5, 2, z + 4), 3.3, 9)
                wall(
                    black, (east + 0.1, z + 5), (east + 0.1, z + 12), -21, -4, "Fender"
                )
    # Raised cargo landing outside the fighting limit on the east side.
    for z, end, width in [
        (-642, 678, 26),
        (-458, 704, 32),
        (-314, 627, 42),
        (-195, 655, 26),
        (101, 617, 26),
        (242, 626, 33),
        (315, 635, 29),
        (479, 684, 33),
        (667, 620, 31),
    ]:
        make_pier(east - 2, end, z, width)
    # Boat crew's alongside berth, under the two mooring bollards at paper x695..697.
    make_pier(east - 2, 607, 251, 19)
    box(beam, 593, 249, 34, 166, -6, -1, "Pier")
    rect(timber, 576, 165, 610, 333, -0.6, "Pier")
    for z in (168, 201, 264, 327):
        for x in (578, 607):
            shaft(beam, (x, -45, z), (x, 1.4, z), 2.75)
    # Quayside ladders and rusty tide-gauge marks, outside the arena.
    for z in (-634, -248, 307, 595):
        for d in (-4, 4):
            shaft(iron, (east + 2, -29, z + d), (east + 2, 2, z + d), 0.75)
        for y in range(-27, 3, 4):
            shaft(iron, (east + 3, y, z - 4), (east + 3, y, z + 4), 0.52)


def make_pier(x, end, z, width):
    box(beam, (x + end) / 2, z, end - x, width, -6, -1, "Pier")
    rect(timber, x, z - width / 2, end, z + width / 2, -0.65, "Pier")
    for xx in range(int(x + 9), int(end + 1), 29):
        for zz in (z - width / 2 + 1, z + width / 2 - 1):
            shaft(beam, (xx, -45, zz), (xx, 1, zz), 2.6)
    box(edge, end, z, 2, width + 0.8, -4, 0.2, "Pier")


def outside_channel(x, z, buffer=0):
    a, b = bank_strip(x)
    return z < a - buffer or z > b + buffer


def make_roads():
    lowtide_pavement.make_pavement(sys.modules[__name__])
    for side in [-1, 1]:
        # Paired drains catch wash water at the launching ways and crane workshop.
        for cx, cz in ((side * 249, side * 220), (side * -367, side * 380)):
            rect(iron, cx - 2.65, cz - 7, cx + 2.65, cz + 7, 0.15)
            for offset in range(-5, 6, 3):
                rect(black, cx - 2.3, cz + offset, cx + 2.3, cz + offset + 0.82, 0.20)
        # West siding extends beyond the map as a continuation of the dock workshop.
        for x in (-780, -761):
            strip(rail, (x, side * 87), (x, side * 1300), 2.3, 0.62)
        for z in range(92, 1300, 16):
            rect(beam, -785, side * z, -756, side * (z + 3), 0.2)
    # Safety paint at lifting berths uses short worn markings on the actual ground.
    for prop in PLAN["props"]:
        x, z = prop["center"]
        x -= HALF_WIDTH
        z -= HALF_DEPTH
        a = math.radians(prop["angle"])
        cs = math.cos(a)
        sn = math.sin(a)

        def pt(u, v):
            return x + cs * u - sn * v, z + sn * u + cs * v

        for sign in (-1, 1):
            for j in (-28, -14, 0, 14, 28):
                strip(paint, pt(sign * 29, j), pt(sign * 29, j + 6), 1.45, 0.42)


def make_yard_details():
    # Thin border in the pavement gives players a physical reference at the limit of a cast.
    outline = [(x - HALF_WIDTH, z - HALF_DEPTH) for x, z in PLAN["outline"]]
    for a, b in zip(outline, outline[1:] + outline[:1]):
        length = math.dist(a, b)
        n = math.ceil(length / 21)
        for j in range(n):
            p = [a[i] + (b[i] - a[i]) * j / n for i in (0, 1)]
            q = [a[i] + (b[i] - a[i]) * (j + 0.985) / n for i in (0, 1)]
            if outside_channel(*p, 2) and outside_channel(*q, 2):
                if j % 5 == 0:
                    strip(
                        iron,
                        p,
                        [p[i] + (q[i] - p[i]) * 0.16 for i in (0, 1)],
                        3.4,
                        0.21,
                    )
    # Weathered masonry, two marine outfalls and exposed coarse riprap.
    for x in (-285, 281):
        a = sample(P, x)
        z = a + 1
        for j in range(12):
            t = math.pi * j / 12
            u = math.pi * (j + 1) / 12
            pts = [
                (x + r * math.cos(w), -17 + r * math.sin(w), z + 0.8)
                for r, w in [(6, t), (8.4, t), (8.4, u), (6, u)]
            ]
            groups["Drain mouths", edge].face(
                pts, [(xx / 45, yy / 45) for xx, yy, zz in pts]
            )
        pts = [
            (
                x + 5.8 * math.cos(math.tau * j / 16),
                -17 + 5.8 * math.sin(math.tau * j / 16),
                z + 0.5,
            )
            for j in range(16)
        ]
        groups["Drain mouths", black].face(pts, [(0, 0)] * len(pts))
    for _ in range(460):
        x = R.uniform(-750, 550)
        sign = R.choice((-1, 1))
        a = sample(P if sign < 0 else Q, x)
        z = a - sign * R.uniform(5, 20)
        y = R.uniform(-28, -23)
        r = R.uniform(0.65, 2.4)
        pts = [
            (
                x + r * R.uniform(0.65, 1.2) * math.cos(math.tau * j / 6),
                z + r * R.uniform(0.45, 1) * math.sin(math.tau * j / 6),
            )
            for j in range(6)
        ]
        prism(shoal, pts, y - r, y + r * 0.36, "Riprap", R.uniform(0.53, 1))


def make_working_aprons():
    """Flush repair beds, lifting tracks, loading wharfs and painted pier numbers."""
    for team in ("red", "blue"):
        sign = -1 if team == "red" else 1
        for role in ("barge", "crane"):
            prop = next(
                p
                for p in PLAN["props"]
                if p["kind"] == role and (p["center"][1] - HALF_DEPTH) * sign > 0
            )
            x, z = prop["center"]
            x -= HALF_WIDTH
            z -= HALF_DEPTH
            angle = math.radians(prop["angle"])

            def local(u, v):
                return (
                    x + u * math.cos(angle) - v * math.sin(angle),
                    z + u * math.sin(angle) + v * math.cos(angle),
                )

            if role == "barge":

                def cut_block(u, v, half_length, half_width, chamfer):
                    return [
                        local(u + du, v + dv)
                        for du, dv in (
                            (-half_length + chamfer, -half_width),
                            (-half_length, -half_width + chamfer),
                            (-half_length, half_width - chamfer),
                            (-half_length + chamfer, half_width),
                            (half_length, half_width),
                            (half_length, -half_width + chamfer),
                            (half_length - chamfer, -half_width),
                        )
                    ]

                # Sit the four modeled stocks on individual shallow bearing stones.
                # The long beds are under the splayed shores of the two outer stocks.
                for u, spread in ((-48, 25), (-14, 7), (31.2, 23), (58, 6)):
                    for side in (-1, 1):
                        v = side * spread
                        stone_bed = cut_block(u, v, 4.7, 4.4, 1.0)
                        prism(edge, stone_bed, 0.068, 0.84, "Keel stock bearings")
                        for offset in (-3, 3):
                            bx, bz = local(u + offset, v + side * 2.6)
                            shaft(
                                iron,
                                (bx, 0.78, bz),
                                (bx, 1.12, bz),
                                0.58,
                                6,
                                "Keel stock bolts",
                            )
                    sleeper = cut_block(u, 0, 3.05, spread + 1, 0.44)
                    prism(beam, sleeper, 0.1, 1.07, "Keel stock sleepers")

                # The embedded launching rails run broadside from the hull to the
                # actual stone quay. Only their short heel shoes sit on rock pockets.
                bank = P if sign < 0 else Q
                for u, heel in (
                    (-84, -10),
                    (-56, -17),
                    (-27, -17),
                    (4, -17),
                    (35, -16),
                    (66, -10),
                    (83, -3),
                ):
                    prism(
                        stone,
                        cut_block(u, heel, 2.45, 3.2, 0.65),
                        0.067,
                        0.30,
                        "Launch rail shoes",
                    )
                    bx, bz = local(u, heel - 2.1)
                    shaft(
                        rail,
                        (bx, 0.29, bz),
                        (bx, 0.44, bz),
                        0.52,
                        6,
                        "Launch rail heel pins",
                    )
                    inland, offshore = 45, 420
                    for _ in range(14):
                        v = (inland + offshore) / 2
                        px, pz = local(u, v)
                        if (pz - sample(bank, px)) * sign > 0:
                            inland = v
                        else:
                            offshore = v
                    rail_start, rail_end = local(u, heel), local(u, inland - 0.3)
                    for mat, width, height in (
                        (damp, 4.8, 0.16),
                        (beam, 2.7, 0.22),
                        (rail, 1.35, 0.40),
                    ):
                        strip(
                            mat,
                            rail_start,
                            rail_end,
                            width,
                            height,
                            "Embedded launch rails",
                        )
            else:
                # A circular, flush slew rail explains the crane's turning radius.
                for rr, ww, mat, h in [
                    (53, 34, marine, 0.15),
                    (57, 3, damp, 0.23),
                    (55.5, 1.2, rail, 0.26),
                ]:
                    for i in range(60):
                        a, b = i * math.tau / 60, (i + 1) * math.tau / 60
                        surface(
                            mat,
                            [
                                (x + r * math.cos(t), h, z + r * math.sin(t))
                                for r, t in [
                                    (rr - ww, a),
                                    (rr, a),
                                    (rr, b),
                                    (rr - ww, b),
                                ]
                            ],
                        )
        # West warehouse street and the quay-facing ends of the loading aprons.
        from lowtide_goods_yard import warehouse_bank

        warehouse_bank(sys.modules[__name__], sign)
        for z in (985, 1325):
            rect(apron, -736, sign * (z - 65), -113, sign * (z + 65), 0.17, shade=0.88)
    # Service steps descend to the low-water landing; a diagonal return gives the quay its characteristic edge.
    for z, length, depth in [
        (-485, 135, 51),
        (397, 131, 49),
        (-788, 172, 77),
        (713, 160, 64),
    ]:
        side = 1 if z > 0 else -1
        ring = [
            (554, z - length / 2),
            (558 + depth * 0.61, z - length / 2),
            (558 + depth, z - length / 2 + 26),
            (558 + depth, z + length / 2 - 12),
            (558 + depth - 13, z + length / 2),
            (554, z + length / 2),
        ]
        prism(brick, ring, -46, -3, "Tidal landing")
        surface(marine, [(xx, -2.7, zz) for xx, zz in ring], "Tidal landing")
        for i in range(6):
            x = 558 + depth + 3 + i * 4
            box(
                edge,
                x,
                z + side * 9,
                4,
                49,
                -37,
                -4 - i * 3.1,
                "Landing steps",
                0.93 - i * 0.043,
            )

    # Hand-cut, salt-worn wharf numerals. Each stencil marks the physical bridge opening.
    # Seven rectilinear strokes match the narrow stamped numerals on quay castings.
    berth_ink = material("Weathered berth stencil", lowtide_pavement.LIMESTONE,
                          (0.75, 0.67, 0.48), 0.93)
    stencil = {1: "bc", 2: "abdeg", 3: "abcdg", 0: "abcdef"}
    seg = {
        "a": ((1, 0), (8, 0)),
        "g": ((1, 8), (8, 8)),
        "d": ((1, 16), (8, 16)),
        "b": ((9, 1), (9, 7)),
        "c": ((9, 9), (9, 15)),
        "e": ((0, 9), (0, 15)),
        "f": ((0, 1), (0, 7)),
    }
    for index, bridge in enumerate(PLAN["bridges"]):
        cx = bridge["left"] - HALF_WIDTH
        for sign in (-1, 1):
            z = sample(P if sign < 0 else Q, cx) + sign * 26
            x = cx - 29
            for k, num in enumerate((0, index + 1)):
                for stroke in stencil[num]:
                    a, b = seg[stroke]

                    def pp(p):
                        return x + sign * .68 * (12 * k + p[0]), z + sign * .68 * p[1]

                    strip(berth_ink, pp(a), pp(b), 1.05, 0.51, shade=0.85)


def wave_images():
    # Periodic, directional swell using image-space derivatives to generate a seamless normal field.
    size = 384
    fields = []
    for a, b, weight in [
        (6, 11, 0.55),
        (12, 28, 0.34),
        (23, 62, 0.25),
        (54, 112, 0.17),
        (100, 221, 0.11),
    ]:
        data = Image.new("L", (a, b))
        data.putdata([R.randrange(256) for _ in range(a * b)])
        tile = Image.new("L", (a * 3, b * 3))
        for i in range(3):
            for j in range(3):
                tile.paste(data, (a * i, b * j))
        fields.append(
            (
                tile.resize((size * 3, size * 3), Image.Resampling.BICUBIC)
                .crop((size, size, size * 2, size * 2))
                .tobytes(),
                weight,
            )
        )
    heights = [sum(d[i] * w for d, w in fields) for i in range(size * size)]
    rgb = bytearray()
    base = bytearray()
    for z in range(size):
        for x in range(size):
            dx = heights[z * size + (x + 1) % size] - heights[z * size + (x - 1) % size]
            dz = (
                heights[((z + 1) % size) * size + x]
                - heights[((z - 1) % size) * size + x]
            )
            n = unit((-0.025 * dx, -0.033 * dz, 1))
            rgb.extend(round((v * 0.5 + 0.5) * 255) for v in n)
            c = round(max(0, min(255, 165 + 0.22 * heights[z * size + x])))
            base.extend((c, c, c))
    return Image.frombytes("RGB", (size, size), bytes(base)), Image.frombytes(
        "RGB", (size, size), bytes(rgb)
    )


class Glb:
    def __init__(self):
        self.data = bytearray()
        self.doc = {
            "asset": {"version": "2.0", "generator": "ClashLegends low tide dock"},
            "scene": 0,
            "scenes": [{"nodes": []}],
            **{
                k: []
                for k in [
                    "nodes",
                    "meshes",
                    "materials",
                    "images",
                    "textures",
                    "accessors",
                    "bufferViews",
                ]
            },
            "samplers": [
                {"wrapS": 10497, "wrapT": 10497, "magFilter": 9729, "minFilter": 9987}
            ],
        }

    def view(self, data, target=None):
        while len(self.data) % 4:
            self.data.append(0)
        index = len(self.doc["bufferViews"])
        entry = {"buffer": 0, "byteOffset": len(self.data), "byteLength": len(data)}
        if target:
            entry["target"] = target
        self.doc["bufferViews"].append(entry)
        self.data.extend(data)
        return index

    def texture(self, image, name, quality):
        b = BytesIO()
        image.save(b, "JPEG", quality=quality, subsampling=0, optimize=True)
        i = len(self.doc["images"])
        self.doc["images"].append(
            {
                "name": name,
                "mimeType": "image/jpeg",
                "bufferView": self.view(b.getvalue()),
            }
        )
        self.doc["textures"].append({"sampler": 0, "source": i})
        return i

    def acc(self, values, n, indices=False, bounds=False):
        kind = "I" if indices else "f"
        typ = 5125 if indices else 5126
        v = self.view(
            struct.pack("<" + str(len(values)) + kind, *values),
            34963 if indices else 34962,
        )
        a = {
            "bufferView": v,
            "componentType": typ,
            "count": len(values) // n,
            "type": {1: "SCALAR", 2: "VEC2", 3: "VEC3"}[n],
        }
        if bounds:
            a["min"] = [min(values[i::n]) for i in range(n)]
            a["max"] = [max(values[i::n]) for i in range(n)]
        ix = len(self.doc["accessors"])
        self.doc["accessors"].append(a)
        return ix

    def export(self, directory):
        tile_cache = {}
        mat_index = {}
        for name, (asset, tint, rough, metal, ns, s, rotate) in materials.items():
            pbr = {
                "baseColorFactor": [min(1, t) for t in tint] + [1],
                "metallicFactor": metal,
                "roughnessFactor": rough,
            }
            mat = {"name": name, "doubleSided": True, "pbrMetallicRoughness": pbr}
            if asset:
                if asset not in tile_cache:
                    if asset in (
                        lowtide_pavement.LIMESTONE,
                        lowtide_pavement.HAULWAY,
                        lowtide_pavement.GRANITE,
                        lowtide_pavement.OAK,
                    ):
                        color, nor, packed = lowtide_pavement.stone_look(
                            directory, asset
                        )
                    elif asset in (lowtide_lane_shoulders.SAND_SETTS, lowtide_lane_shoulders.SILVER_OAK):
                        wood = asset == lowtide_lane_shoulders.SILVER_OAK
                        source = lowtide_pavement.OAK if wood else lowtide_pavement.GRANITE
                        maps = lowtide_pavement.stone_look(directory, source)
                        color, nor, packed = lowtide_lane_shoulders.shoulder_finish(directory, wood, maps)
                    elif asset == "wave":
                        color, nor = wave_images()
                        packed = None
                    else:
                        color = Image.open(directory / (asset + "-c.jpg")).convert(
                            "RGB"
                        )
                        nor = Image.open(directory / (asset + "-n.jpg")).convert("RGB")
                        color = ImageEnhance.Color(color).enhance(
                            0.58 if "concrete" in asset else 0.77
                        )
                        if asset in ("concrete_pavement_02", "hangar_concrete_floor"):
                            color = ImageEnhance.Contrast(color).enhance(0.84)
                        if asset == "hangar_concrete_floor":
                            color = color.point(
                                lambda v: min(255, round(68 + v * 1.17))
                            )
                        if asset == "seaworn_stone_tiles":
                            color = ImageEnhance.Color(color).enhance(0.52)
                        gamma = {
                            "weathered_planks": 0.72,
                            "stone_floor": 0.78,
                            "seaworn_stone_tiles": 0.78,
                            "concrete_pavement_02": 0.81,
                            "brown_mud_03": 0.84,
                            "rusty_metal_02": 1.08,
                        }.get(asset, 0.91)
                        color = color.point(
                            [round(255 * (i / 255) ** gamma) for i in range(256)] * 3
                        )
                        roughmap = (
                            Image.open(directory / (asset + "-r.jpg"))
                            .convert("L")
                            .resize((384, 384), Image.Resampling.LANCZOS)
                            .point(lambda v: 68 + round(0.73 * v))
                        )
                        packed = Image.merge(
                            "RGB",
                            (
                                Image.new("L", roughmap.size, 255),
                                roughmap,
                                Image.new("L", roughmap.size, 255),
                            ),
                        )
                    # The haulway sheet covers the entire half-map, including its
                    # shoulders. Keep enough texels across even the narrowest course.
                    if asset != lowtide_pavement.HAULWAY:
                        color.thumbnail((768, 768), Image.Resampling.LANCZOS)
                        nor.thumbnail((512, 512), Image.Resampling.LANCZOS)
                    tile_cache[asset] = (
                        self.texture(color, asset + " albedo", 86),
                        self.texture(nor, asset + " normal", 85),
                        self.texture(packed, asset + " roughness", 81)
                        if packed
                        else None,
                    )
                col, n, m = tile_cache[asset]
                pbr["baseColorTexture"] = {"index": col}
                mat["normalTexture"] = {"index": n, "scale": ns}
                if m is not None:
                    pbr["metallicRoughnessTexture"] = {"index": m}
            mat_index[name] = len(self.doc["materials"])
            self.doc["materials"].append(mat)
        for (label, mat), m in groups.items():
            if not m.pos:
                continue
            prim = {
                "attributes": {
                    "POSITION": self.acc(m.pos, 3, bounds=True),
                    "NORMAL": self.acc(m.nor, 3),
                    "TEXCOORD_0": self.acc(m.uv, 2),
                    "COLOR_0": self.acc(m.color, 3),
                },
                "indices": self.acc(m.indices, 1, True),
                "material": mat_index[mat],
            }
            i = len(self.doc["meshes"])
            name = label + " - " + mat
            self.doc["meshes"].append({"name": name, "primitives": [prim]})
            self.doc["nodes"].append({"name": name, "mesh": i})
            self.doc["scenes"][0]["nodes"].append(i)
        while len(self.data) % 4:
            self.data.append(0)
        self.doc["buffers"] = [{"byteLength": len(self.data)}]
        meta = json.dumps(self.doc, separators=(",", ":")).encode()
        meta += b" " * ((-len(meta)) % 4)
        packed_bytes = (
            struct.pack("<4sII", b"glTF", 2, 28 + len(meta) + len(self.data))
            + struct.pack("<I4s", len(meta), b"JSON")
            + meta
            + struct.pack("<I4s", len(self.data), b"BIN\0")
            + self.data
        )
        file = OUT / "harbor.glb"
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "dock.glb"
            packed = Path(tmp) / "harbor.glb"
            source.write_bytes(packed_bytes)
            # Full precision keeps flush rails and adjoining beds from z-fighting.
            subprocess.run(
                [
                    str(ROOT / "web/node_modules/.bin/gltfpack"),
                    "-i",
                    str(source),
                    "-o",
                    str(packed),
                    "-cc",
                    "-noq",
                    "-kn",
                    "-km",
                ],
                check=True,
            )
            shutil.copyfile(packed, file)
        print(
            f"{file.name}: {file.stat().st_size:,} bytes, {sum(len(m.indices) // 3 for m in groups.values()):,} triangles"
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--materials", type=Path, default=ROOT / ".local/lowtide-materials"
    )
    args = parser.parse_args()
    OUT.mkdir(exist_ok=True, parents=True)
    make_estuary()
    make_roads()
    lowtide_bridges.make_crossings(sys.modules[__name__])
    make_yard_details()
    make_working_aprons()
    make_outer_harbour(sys.modules[__name__])
    make_shoreline(sys.modules[__name__])
    make_foundations(sys.modules[__name__])
    Glb().export(args.materials)
    make_weathering(PLAN, OUT)
    shutil.copyfile(
        args.materials / "kloofendal_48d_partly_cloudy_puresky.hdr", OUT / "sky.hdr"
    )
