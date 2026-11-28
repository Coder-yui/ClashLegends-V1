"""Bake damp, iron stains, salt and distance to the low-water ledge in world space."""

from math import cos, sin, radians
from pathlib import Path
import random

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageOps

EXTENT = 2048
SIZE = 1024


def make_weathering(plan, output):
    rng = random.Random(77304)

    def point(x, z):
        return ((x + EXTENT / 2) * SIZE / EXTENT, (z + EXTENT / 2) * SIZE / EXTENT)

    def source(x, z):
        return point(x - plan["width"] / 2, z - plan["height"] / 2)

    def noise(w, h):
        im = Image.new("L", (w, h))
        im.putdata([rng.randrange(256) for _ in range(w * h)])
        return im.resize((SIZE, SIZE), Image.Resampling.BICUBIC)

    def ink_point(layer, x, z, rx, rz, strength):
        a, b = point(x - rx, z - rz)
        c, d = point(x + rx, z + rz)
        ImageDraw.Draw(layer).ellipse((a, b, c, d), fill=strength)

    grain = Image.blend(noise(94, 111), noise(263, 277), 0.38)
    mottling = Image.blend(noise(8, 13), noise(43, 57), 0.41)
    banks = Image.new("L", (SIZE, SIZE))
    for line in plan["river"].values():
        pts = [source(*p) for p in line]
        d = ImageDraw.Draw(banks)
        for w, c in [(76, 112), (28, 180), (12, 235)]:
            d.line(pts, fill=c, width=w, joint="curve")
    dock_edge = ImageDraw.Draw(banks)
    a = point(558, -1120)
    b = point(558, 1120)
    dock_edge.line((a, b), fill=155, width=28)
    banks = banks.filter(ImageFilter.GaussianBlur(11))
    # Tide stains catch on the exposed quay shoulders. At the openings there is
    # no wall underfoot: traffic carries sand and moisture a few stones inland.
    # Work in ground coordinates so one deposit can cross two different pavements.
    swept = Image.new("L", banks.size)
    deposits = Image.new("L", banks.size)
    drift = random.Random(1952)
    for opening in plan["bridges"]:
        left, right = opening["left"], opening["right"]
        cx = (left + right) / 2
        for name, inland in (("north", -1), ("south", 1)):
            bank = plan["river"][name]
            bank_z = min(bank, key=lambda corner: abs(corner[0] - cx))[1]
            sx, sz = cx - plan["width"] / 2, bank_z - plan["height"] / 2
            ink_point(swept, sx, sz, (right - left) * .43, 49, 213)
            for edge_x in (left, right):
                x = edge_x - plan["width"] / 2
                reach = drift.uniform(30, 78)
                for _ in range(8):
                    ink_point(deposits, x + drift.uniform(-18, 21),
                              sz + inland * drift.uniform(0, reach),
                              drift.uniform(7, 22), drift.uniform(5, 17),
                              drift.randrange(72, 170))
    banks = ImageChops.subtract(banks, swept.filter(ImageFilter.GaussianBlur(6)))
    damp = Image.blend(banks, ImageChops.multiply(mottling, grain), 0.32)
    rust = Image.new("L", (SIZE, SIZE))
    puddles = Image.new("L", (SIZE, SIZE))
    for team in plan["teams"].values():
        for px, pz in [team["nexus"], *team["towers"]]:
            x = px - plan["width"] / 2
            z = pz - plan["height"] / 2
            ink_point(puddles, x, z, 58, 46, 197)
    for prop in plan["props"]:
        px, pz = prop["center"]
        x = px - plan["width"] / 2
        z = pz - plan["height"] / 2
        theta = radians(prop["angle"])

        def loc(u, v):
            return x + u * cos(theta) - v * sin(theta), z + u * sin(theta) + v * cos(
                theta
            )

        if prop["kind"] == "barge":
            for u in range(-78, 79, 13):
                xx, zz = loc(u, rng.uniform(-20, 20))
                ink_point(puddles, xx, zz, 18, 21, 239)
                a, b = loc(u, 20)
                c, d = loc(u, 105)
                ImageDraw.Draw(rust).line(
                    [point(a, b), point(c, d)],
                    fill=rng.randint(110, 202),
                    width=rng.randint(4, 8),
                )
        else:
            ink_point(puddles, x, z, 51, 51, 220)
            ink_point(rust, x + 4, z - 5, 37, 32, 174)
    for _ in range(105):
        x = rng.uniform(-800, 565)
        z = rng.uniform(-944, 944)
        ink_point(
            puddles,
            x,
            z,
            rng.uniform(12, 63),
            rng.uniform(2.5, 10.5),
            rng.randint(70, 200),
        )
    # Narrow wet edges remain toothed across paver joints; broad patches fade into the stone.
    pools = puddles.filter(ImageFilter.GaussianBlur(4))
    pools = ImageChops.subtract(
        pools, ImageOps.invert(grain).point(lambda v: round(v * 0.43))
    )
    damp = ImageChops.lighter(damp, pools)
    damp = ImageChops.multiply(
        damp, Image.blend(grain, Image.new("L", grain.size, 255), 0.65)
    )
    rust = ImageChops.multiply(rust.filter(ImageFilter.GaussianBlur(2.7)), grain)
    salts = ImageChops.multiply(
        banks,
        ImageOps.autocontrast(noise(120, 120)).point(lambda v: max(0, 2 * (v - 128))),
    )
    grit = ImageOps.autocontrast(Image.blend(grain, mottling, .30))
    deposits = ImageChops.multiply(deposits.filter(ImageFilter.GaussianBlur(2.5)), grit)
    salts = ImageChops.lighter(salts, deposits)
    # The fourth channel follows the surveyed shore, including its bend into the
    # estuary. A nonzero minimum keeps WebP encoders from clearing the RGB wear.
    shoal = Image.new("L", (SIZE, SIZE), 32)
    shore = ImageDraw.Draw(shoal)
    banks_and_quay = [[source(*p) for p in line] for line in plan["river"].values()]
    banks_and_quay.append([point(558, -1100), point(558, 1100)])
    for width, strength in ((56, 65), (34, 124), (20, 198), (9, 255)):
        for line in banks_and_quay:
            shore.line(line, fill=strength, width=width, joint="curve")
    shoal = shoal.filter(ImageFilter.GaussianBlur(3))
    Image.merge("RGBA", (damp, rust, salts, shoal)).save(
        Path(output) / "weathering.webp", quality=90, method=6
    )
