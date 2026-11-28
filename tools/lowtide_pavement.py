"""Lay the working yard in the same 32-unit modules used for troop deployment.

The high frequency grain comes from the dock's photographic material sources.
Changing a patch of paving changes its colour, joints, normal and roughness together.
"""

from bisect import bisect_right
from math import cos, sin
from pathlib import Path
import random
from statistics import median

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageOps, ImageStat

from lowtide_lane_shoulders import SAND_SETTS, SILVER_OAK, SideRoads

ATLAS_SIDE = 4
PATCH = 192
LIMESTONE = "quarry_limestone"
GRANITE = "quay_granite"
OAK = "slip_oak"
HAULWAY = "haulway_ashlar"
HAUL_HALF_WIDTH = 160
HAUL_LENGTH = 832


def haul_uv(m, polygon):
    """Continuous masonry through the centre bridge and both haul yards."""
    axis = m.PLAN["lanes"][1][0][0] - m.HALF_WIDTH
    side = -1 if sum(z for _, z in polygon) < 0 else 1
    return [
        (0.5 + (x - axis) / (2 * HAUL_HALF_WIDTH), side * z / HAUL_LENGTH)
        for x, z in polygon
    ]


def haulway_ashlar(directory):
    """Build a half-court of old limestone with abrasion registered across all PBR maps."""
    scale = 2
    size = (2 * HAUL_HALF_WIDTH * scale, HAUL_LENGTH * scale)
    rng = random.Random(741063)
    field = [Image.new("RGB", size) for _ in range(3)]
    flag_maps = stone_look(directory, LIMESTONE)
    tile = 32 * scale
    for y in range(0, size[1], tile):
        for x in range(0, size[0], tile):
            swatch = rng.randrange(ATLAS_SIDE**2)
            sx, sy = swatch % ATLAS_SIDE * PATCH, swatch // ATLAS_SIDE * PATCH
            for sheet, source in zip(field, flag_maps):
                patch = source.crop((sx, sy, sx + PATCH, sy + PATCH))
                sheet.paste(patch.resize((tile, tile), Image.Resampling.LANCZOS), (x, y))

    # Each bank has an unbroken route to its lock. Sheltered edges keep their
    # patina; rubbed patches spill out to different widths on the two sides.
    interval = 48
    count = HAUL_LENGTH // interval + 2
    tracks = [(rng.uniform(-11, 11), rng.uniform(19, 37), rng.uniform(15, 36),
               rng.uniform(88, 137), rng.uniform(81, 138)) for _ in range(count)]

    def wear_at(x, z):
        i = min(int(max(z, 0) / interval), count - 2)
        t = max(0, min(1, z / interval - i))
        t = t * t * (3 - 2 * t)
        centre, lcore, rcore, left, right = (
            a + (b - a) * t for a, b in zip(tracks[i], tracks[i + 1])
        )
        core, edge = (lcore, left) if x < centre else (rcore, right)
        u = max(0, min(1, (abs(x - centre) - core) / (edge - core)))
        lock = max(0, min(1, (806 - z) / 45))
        return (1 - u * u * (3 - 2 * u)) * lock

    wear = Image.new("L", (size[0] // 8 + 1, size[1] // 8 + 1))
    wear.putdata([
        round(255 * wear_at((x * 8 + 3) / scale - HAUL_HALF_WIDTH, (y * 8 + 3) / scale))
        for y in range(wear.height) for x in range(wear.width)
    ])
    wear = wear.resize(size, Image.Resampling.BICUBIC)

    def scan(channel, mode):
        original = Image.open(directory / f"concrete_floor_02-{channel}.jpg").convert(mode)
        # Keep the same scale for pores, normals and roughness.
        patch = original.resize((640, 640), Image.Resampling.LANCZOS)
        sheet = Image.new(mode, size)
        for y in range(0, size[1], patch.height):
            for x in range(0, size[0], patch.width):
                sheet.paste(patch, (x, y))
        return sheet

    # Salvaged flags of different lengths sit between the original paving.
    # A common, slightly broken bed joint lets neighbouring stone cuts meet
    # while keeping four other neighbouring ends from falling in a grid.
    dry = Image.new("RGB", size, (168, 151, 124))
    rubbed = dry.copy()
    height = Image.new("L", size)
    inlay = Image.new("L", size)
    contact = Image.new("L", size)
    remnants = Image.new("L", size)
    dry_ink, polished_ink, relief, cut, traffic, spot = map(
        ImageDraw.Draw, (dry, rubbed, height, inlay, contact, remnants)
    )
    stocks = [((204, 188, 160), (244, 225, 193)), ((196, 178, 153), (242, 222, 187)),
              ((207, 191, 167), (248, 230, 201)), ((204, 193, 173), (239, 224, 197)),
              ((203, 184, 153), (250, 226, 187)), ((192, 177, 156), (235, 215, 184))]
    knot = 24
    edge_nodes = range(0, 2 * HAUL_HALF_WIDTH + knot, knot)
    top = [(x, 0) for x in edge_nodes]
    z = 0
    while z < HAUL_LENGTH:
        end = min(HAUL_LENGTH, z + rng.uniform(22, 42))
        if HAUL_LENGTH - end < 13:
            end = HAUL_LENGTH
        bottom = [(x, end + (rng.uniform(-4, 4) if end < HAUL_LENGTH else 0))
                  for x in edge_nodes]

        def joint(edge, x):
            i = min(int(x / knot), len(edge) - 2)
            return edge[i][1] + (edge[i + 1][1] - edge[i][1]) * (x - i * knot) / knot

        seams = [(0, 0)]
        x = 0
        while x < 2 * HAUL_HALF_WIDTH:
            x = min(2 * HAUL_HALF_WIDTH, x + rng.uniform(20, 53))
            if 2 * HAUL_HALF_WIDTH - x < 11:
                x = 2 * HAUL_HALF_WIDTH
            slant = rng.uniform(-3.5, 3.5) if x < 2 * HAUL_HALF_WIDTH else 0
            seams.append((x, x + slant))
        for (a, b), (c, d) in zip(seams, seams[1:]):
            cx, cz = (a + b + c + d) / 4, (z + end) / 2
            pressure = wear_at(cx - HAUL_HALF_WIDTH, cz)
            if rng.random() > min(.96, max(0, (pressure - .025) * 1.48)):
                continue
            ring = ([(a, joint(top, a))] + [p for p in top if a < p[0] < c] +
                    [(c, joint(top, c)), (d, joint(bottom, d))] +
                    [p for p in reversed(bottom) if b < p[0] < d] + [(b, joint(bottom, b))])
            cut.polygon([(x * scale, y * scale) for x, y in ring], fill=255)
            # Chip the four corners independently while retaining the wobbled bed joint.
            face = []
            corners = {(a, joint(top, a)), (c, joint(top, c)),
                       (d, joint(bottom, d)), (b, joint(bottom, b))}
            for i, (x, y) in enumerate(ring):
                inset = rng.uniform(.28, .64)
                px = x + (cx - x) * inset / max(1, abs(cx - x))
                py = y + (cz - y) * inset / max(1, abs(cz - y))
                if (x, y) in corners:
                    chip = rng.uniform(.45, 2.1)
                    for nx, ny in (ring[i - 1], ring[(i + 1) % len(ring)]):
                        f = min(.32, chip / max(1, abs(nx - x), abs(ny - y)))
                        face.append(((px + f * (nx - x)) * scale, (py + f * (ny - y)) * scale))
                else:
                    face.append((px * scale, py * scale))
            old, bright = rng.choice(stocks)
            fines = max(0., .67 - pressure)
            dry_ink.polygon(face, fill=tuple(round(v * (1-fines) + q * fines)
                                             for v, q in zip(old, (212, 197, 171))))
            polished_ink.polygon(face, fill=bright)
            relief.polygon(face, fill=rng.randint(183, 230))
            # A few replacement slabs stay rough; adjacent original flags may
            # still bear a polished high face well outside the main run.
            strength = rng.uniform(.80, 1) if rng.random() < .81 else rng.uniform(.25, .73)
            traffic.polygon(face, fill=round(255 * strength))
            if .07 < pressure < .63 and rng.random() < .38:
                spot.polygon(face, fill=round(255 * rng.uniform(.30, .62)))
        z, top = end, bottom

    grain = scan("c", "L")
    broad = grain.filter(ImageFilter.GaussianBlur(15))
    mineral = ImageChops.subtract(grain, broad, scale=1.9, offset=128)
    smooth_mineral = ImageChops.subtract(grain.filter(ImageFilter.GaussianBlur(2.6)),
                                         broad, scale=2.8, offset=128)
    # Local high spots and hollows catch different amounts of traffic on one flag.
    mottling = grain.filter(ImageFilter.GaussianBlur(4))
    mean = ImageStat.Stat(mottling).mean[0]
    highs = mottling.point(lambda v: round(max(-20, min(20, (v - mean) * .65)) + 128))
    abrasion = ImageChops.lighter(ImageChops.multiply(wear, contact), remnants)
    abrasion = ImageChops.add(abrasion, highs, offset=-128)
    # Loads rub the high face first. The sunken arrises and mineral hollows can
    # keep a skin of grit even on an otherwise polished slab.
    face_mask = height.point(lambda v: 255 if v else 0)
    crowns = face_mask.filter(ImageFilter.MinFilter(9)).filter(ImageFilter.GaussianBlur(3))
    abrasion = ImageChops.multiply(abrasion, crowns.point(lambda v: 168 + v * 87 / 255))
    colour = Image.composite(rubbed, dry, abrasion)
    grain_finish = Image.composite(smooth_mineral, mineral, abrasion)
    # Retain the broad cloudy mineral variation after the microtexture wears flat.
    clouds = ImageChops.subtract(mottling, grain.filter(ImageFilter.GaussianBlur(42)),
                                 scale=3.2, offset=126)
    clouds = Image.composite(clouds, Image.new("L", size, 128), abrasion)
    grain_finish = ImageChops.add(grain_finish, clouds, offset=-128)
    colour = ImageChops.add(colour, Image.merge("RGB", (grain_finish,) * 3), offset=-128)

    relief_map = height.filter(ImageFilter.GaussianBlur(1.15))
    normal_x, normal_y, normal_z = scan("n", "RGB").split()
    for channel, (dx, dy) in ((normal_x, (1, 0)), (normal_y, (0, -1))):
        slope = ImageChops.subtract(ImageChops.offset(relief_map, dx, dy),
                                    ImageChops.offset(relief_map, -dx, -dy), scale=4.6, offset=128)
        smoother = channel.point(lambda v: 128 + round((v - 128) * .16))
        channel.paste(ImageChops.add(Image.composite(smoother, channel, abrasion), slope, offset=-128))
    normal = Image.merge("RGB", (normal_x, normal_y, normal_z.point(lambda v: 242 + round(v / 20))))
    measured = scan("r", "L")
    pores = ImageChops.subtract(measured, measured.filter(ImageFilter.GaussianBlur(9)),
                                scale=2.5, offset=128)
    rough = ImageChops.add(abrasion.point(lambda a: round(226 - a * .51)), pores, offset=-128)
    white = Image.new("L", size, 255)
    mask = inlay.filter(ImageFilter.GaussianBlur(.68))
    return tuple(Image.composite(finish, base, mask) for finish, base in
                 zip((colour, normal, Image.merge("RGB", (white, rough, white))), field))


def colour_study():
    path = Path(__file__).resolve().parents[1] / "docs/battle/退潮船坞-晴日低潮概念.png"
    return Image.open(path).convert("RGB")


def flag_pigments(m):
    """Recover one relative stone colour per exposed flag in the portrait study."""
    image = colour_study()
    tile = m.PLAN["tile"]
    ox, oz = m.PLAN["tileOrigin"]
    swatches = {}
    # Omit silhouettes, rail beds and the ground that receives their shadows.
    cover = []
    for team in m.PLAN["teams"].values():
        for x, z in [team["nexus"], *team["towers"]]:
            cover.append((x - 69, z - 159, x + 161, z + 124))
    for prop in m.PLAN["props"]:
        x, z = prop["center"]
        if prop["kind"] == "barge":
            cover.append(
                (x - 134, min(z - 68, m.HALF_DEPTH), x + 134, max(z + 82, m.HALF_DEPTH))
            )
        else:
            cover.append((x - 110, z - 110, x + 128, z + 83))
    for row in range(int((m.PLAN["height"] - 2 * oz) / tile)):
        for col in range(int((m.PLAN["width"] - 2 * ox) / tile)):
            x, z = ox + (col + 0.5) * tile, oz + (row + 0.5) * tile
            if abs(z - m.HALF_DEPTH) < 83 or any(
                left < x < right and top < z < bottom for left, top, right, bottom in cover
            ):
                continue
            # The approved portrait is orthographic, with 90 units beyond each base.
            u = round(image.width * (0.5 + (x - m.HALF_WIDTH) / 1330))
            v = round(
                image.height * (0.5 + (z - m.HALF_DEPTH) / (m.PLAN["height"] + 180))
            )
            rgb = ImageStat.Stat(image.crop((u - 6, v - 5, u + 7, v + 6))).median
            if 181 <= rgb[0] < 253 and 146 <= rgb[1] and 4 < rgb[0] - rgb[1] < 52:
                swatches[col, row] = rgb
    pigments = {}
    for (col, row), rgb in swatches.items():
        neighbours = [
            swatches[c, r]
            for c in range(col - 2, col + 3)
            for r in range(row - 2, row + 3)
            if (c, r) in swatches
        ]
        if len(neighbours) < 8:
            continue
        # Divide out broad illumination. Only mineral colour travels with the flag;
        # the sun and the objects in the current match cast the actual light and shade.
        pigments[col, row] = tuple(
            max(0.81, min(1.16, (sample / median(channel)) ** 1.85))
            for sample, channel in zip(rgb, zip(*neighbours))
        )
    return pigments


def stone_joint(old, new, margin):
    """Cut two registered swatches through their least dissimilar stone edges."""
    width, height = old.size
    delta = ImageOps.grayscale(ImageChops.difference(old, new)).load()
    costs = [0] * margin
    parent = []
    for y in range(height):
        next_costs, prev = [], []
        for x in range(margin):
            via = min(range(max(0, x - 1), min(margin, x + 2)), key=costs.__getitem__)
            next_costs.append(costs[via] + delta[x, y])
            prev.append(via)
        costs = next_costs
        parent.append(prev)
    x = min(range(margin), key=costs.__getitem__)
    mask = Image.new("L", old.size, 255)
    draw = ImageDraw.Draw(mask)
    for y in reversed(range(height)):
        draw.line((0, y, x, y), fill=0)
        x = parent[y][x]
    return mask.filter(ImageFilter.GaussianBlur(0.45))


def cart_setts(directory):
    """Reconstruct the old granite courses in the colour study as a relightable surface."""
    study = colour_study()
    # Flat, unoccupied street samples from both banks. Stay clear of cast shadows
    # and the limestone repairs; the latter are placed separately in world space.
    exposures = [
        (122, 425, 235, 517),
        (188, 520, 274, 593),
        (198, 862, 272, 947),
        (116, 1148, 184, 1217),
        (218, 217, 284, 285),
    ]
    planes = []
    for region in exposures:
        plane = study.crop(region)
        # Remove broad incident-light changes. Preserve individual granite colours
        # and the warm packed joints revealed by the workshop carts.
        light = ImageOps.grayscale(plane).filter(ImageFilter.GaussianBlur(15))
        grey = Image.new("L", plane.size, 151)
        correction = ImageChops.subtract(grey, light, offset=128)
        planes.append(
            ImageChops.add(plane, Image.merge("RGB", (correction,) * 3), offset=-128)
        )
    rng = random.Random(50897)
    size, step, lap = 240, 48, 16
    tile = step + lap
    atlas = Image.new("RGB", (size + lap, size + lap))
    for y in range(0, size, step):
        for x in range(0, size, step):
            old = atlas.crop((x, y, x + tile, y + tile))
            best, cost = None, float("inf")
            for _ in range(20):
                plane = rng.choice(planes)
                xx, yy = (
                    rng.randint(0, plane.width - tile),
                    rng.randint(0, plane.height - tile),
                )
                patch = plane.crop((xx, yy, xx + tile, yy + tile))
                d = ImageChops.difference(old, patch)
                err = (
                    sum(ImageStat.Stat(d.crop((0, 0, lap, tile))).mean) if x else 0
                ) + (sum(ImageStat.Stat(d.crop((0, 0, tile, lap))).mean) if y else 0)
                if err < cost:
                    best, cost = patch, err
            mask = Image.new("L", (tile, tile), 255)
            if x:
                mask = stone_joint(old, best, lap)
            if y:
                seam = stone_joint(
                    old.transpose(Image.Transpose.TRANSPOSE),
                    best.transpose(Image.Transpose.TRANSPOSE),
                    lap,
                )
                mask = ImageChops.darker(
                    mask, seam.transpose(Image.Transpose.TRANSPOSE)
                )
            atlas.paste(best, (x, y), mask)
    # The final overlap at each side meets its opposite side through the same
    # stone-following seam, so world-space UVs can repeat without a tile line.
    for _ in range(2):
        old = atlas.crop((size, 0, size + lap, atlas.height))
        new = atlas.crop((0, 0, lap, atlas.height))
        atlas.paste(Image.composite(new, old, stone_joint(old, new, lap)), (0, 0))
        atlas = atlas.crop((0, 0, size, atlas.height)).transpose(
            Image.Transpose.TRANSPOSE
        )
    luma = ImageOps.grayscale(atlas)
    fine = ImageChops.subtract(
        luma, luma.filter(ImageFilter.GaussianBlur(1.55)), offset=128
    )
    # Most of the lit edge response moves into the normal map. Low-frequency
    # mineral colour remains albedo, the real scanned stone supplies fine pores.
    colour_channels = []
    for ch, target in zip(atlas.split(), (183, 174, 161)):
        residual = ImageChops.subtract(
            ch, fine.point(lambda v: round((v - 128) * 0.25 + 128)), offset=128
        )
        mu = ImageStat.Stat(residual).mean[0]
        colour_channels.append(
            residual.point(
                lambda i: round(max(0, min(255, target + (i - mu) * 1.41)))
            ).filter(ImageFilter.UnsharpMask(radius=1.3, percent=130, threshold=2))
        )
    size_hi = (768, 768)
    colour = Image.merge("RGB", colour_channels).resize(
        size_hi, Image.Resampling.BICUBIC
    )
    scan = Image.open(directory / "stone_floor-c.jpg").convert("L").resize(size_hi)
    pores = ImageChops.subtract(
        scan, scan.filter(ImageFilter.GaussianBlur(3.8)), scale=1.35, offset=128
    )
    colour = ImageChops.add(colour, Image.merge("RGB", (pores,) * 3), offset=-128)
    bed = fine.filter(ImageFilter.GaussianBlur(0.7)).point(
        lambda i: round(max(0, min(255, 144 + (i - 128) * 4.1)))
    )
    nx = ImageChops.subtract(
        ImageChops.offset(bed, 1, 0),
        ImageChops.offset(bed, -1, 0),
        scale=1.9,
        offset=128,
    )
    ny = ImageChops.subtract(
        ImageChops.offset(bed, 0, -1),
        ImageChops.offset(bed, 0, 1),
        scale=1.9,
        offset=128,
    )
    n = Image.merge("RGB", (nx, ny, Image.new("L", bed.size, 249))).resize(
        size_hi, Image.Resampling.BICUBIC
    )
    scan_normal = (
        Image.open(directory / "stone_floor-n.jpg").convert("RGB").resize(size_hi)
    )
    n = Image.blend(n, scan_normal, 0.21)
    rough = bed.point(lambda i: 229 - round(i * 0.26)).resize(
        size_hi, Image.Resampling.BICUBIC
    )
    white = Image.new("L", size_hi, 255)
    return colour, n, Image.merge("RGB", (white, rough, white))


def stone_look(directory, asset):
    """Return registered albedo, tangent-space normal and packed roughness for the paving."""
    if asset == HAULWAY:
        return haulway_ashlar(directory)
    if asset == GRANITE:
        return cart_setts(directory)
    source_name, targets, window, contrast, strength = {
        LIMESTONE: (
            "concrete_floor_02",
            [(211, 197, 172), (216, 201, 177), (206, 192, 170), (210, 195, 167)],
            (230, 490),
            0.32,
            0.24,
        ),
        OAK: (
            "weathered_planks",
            [(165, 141, 118), (168, 143, 121), (158, 137, 118), (162, 139, 121)],
            (361, 592),
            1.12,
            0.78,
        ),
    }[asset]
    source = [
        Image.open(directory / f"{source_name}-{c}.jpg").convert(mode)
        for c, mode in (("c", "RGB"), ("n", "RGB"), ("r", "L"))
    ]
    side = ATLAS_SIDE * PATCH
    albedo, normal, rough = (
        Image.new(mode, (side, side)) for mode in ("RGB", "RGB", "L")
    )
    rng = random.Random(asset)
    if asset == LIMESTONE:
        study = colour_study().convert("L")
        # Object-free, sunlit faces in the approved colour study. Only a narrow
        # mid-frequency range of their limestone mottling is used: all surface
        # normals, fine pores, roughness and lighting remain those of the 3D scene.
        faces = (
            (0.41, 0.32),
            (0.37, 0.37),
            (0.405, 0.40),
            (0.46, 0.351),
            (0.352, 0.305),
            (0.43, 0.373),
            (0.46, 0.43),
            (0.395, 0.438),
            (0.395, 0.664),
            (0.447, 0.684),
            (0.382, 0.731),
            (0.379, 0.797),
            (0.405, 0.757),
            (0.44, 0.814),
            (0.42, 0.78),
            (0.467, 0.73),
        )
    inset = 2  # two texels of margin protect each swatch while mipmapping
    for k in range(ATLAS_SIDE**2):
        crop = rng.randint(*window)
        xx, yy = (
            rng.randrange(source[0].width - crop),
            rng.randrange(source[0].height - crop),
        )
        rect = xx, yy, xx + crop, yy + crop
        c, n, r = [
            im.crop(rect).resize((PATCH, PATCH), Image.Resampling.LANCZOS)
            for im in source
        ]
        luma = ImageOps.grayscale(c)
        grain_mean = ImageStat.Stat(luma).mean[0]
        anchor = targets[k % len(targets)]
        # Keep real pores/wood grain and remove the dark overcast colour of the source yard.
        shade = Image.merge(
            "RGB",
            tuple(
                luma.point(
                    [
                        round(max(0, min(255, v + (i - grain_mean) * contrast)))
                        for i in range(256)
                    ]
                )
                for v in anchor
            ),
        )
        if asset == LIMESTONE:
            fx, fy = faces[k]
            xx, yy = round(fx * study.width), round(fy * study.height)
            grain = study.crop((xx - 12, yy - 10, xx + 12, yy + 10)).resize(
                (PATCH, PATCH), Image.Resampling.BICUBIC
            )
            mean = ImageStat.Stat(grain).mean[0]
            mineral = grain.point(
                lambda i: round(128 + max(-13, min(14, i - mean)) * 0.79)
            )
            shade = ImageChops.add(
                shade, Image.merge("RGB", (mineral, mineral, mineral)), offset=-128
            )
        if asset == OAK:
            # Individual boards were sawn from different stock. Align differences in
            # shade and joint normals to actual plank bounds instead of drawing a checker.
            rebuilt = shade.copy()
            plank_width = rng.choice((22, 24, 26, 29, 31))
            boundaries = list(
                range(
                    -rng.randrange(plank_width // 2), PATCH + plank_width, plank_width
                )
            )
            for board, (start, end) in enumerate(zip(boundaries, boundaries[1:])):
                start, end = max(0, start), min(PATCH, end)
                if end <= start:
                    continue
                # Select the middle of an actual photographed plank; its grain runs along V.
                photo_width = 82
                source_x = rng.choice((64, 170, 292, 401, 521, 635, 743, 856))
                source_y = rng.randrange(0, 486)
                photo_rect = (
                    source_x,
                    source_y,
                    source_x + photo_width,
                    source_y + 525,
                )
                colour, board_normal, board_rough = (
                    im.crop(photo_rect).resize(
                        (end - start, PATCH), Image.Resampling.LANCZOS
                    )
                    for im in source
                )
                n.paste(board_normal, (start, 0))
                r.paste(board_rough, (start, 0))
                strip = ImageOps.grayscale(colour)
                mean = ImageStat.Stat(strip).mean[0]
                shift = rng.choice((-10, -6, -2, 1, 5, 9))
                channel = [
                    strip.point(
                        [
                            round(max(0, min(255, v + shift + (i - mean) * 1.32)))
                            for i in range(256)
                        ]
                    )
                    for v in anchor
                ]
                rebuilt.paste(Image.merge("RGB", tuple(channel)), (start, 0))
            shade = rebuilt
            ink = ImageDraw.Draw(shade)
            normals = ImageDraw.Draw(n)
            for edge in boundaries:
                if 0 < edge < PATCH:
                    ink.line(
                        (edge, 0, edge, PATCH),
                        fill=tuple(round(v * 0.48) for v in anchor),
                        width=2,
                    )
                    ink.line(
                        (edge + 2, 0, edge + 2, PATCH),
                        fill=tuple(v + 5 for v in anchor),
                        width=1,
                    )
                    normals.line((edge, 0, edge, PATCH), fill=(91, 129, 248), width=2)
                    normals.line(
                        (edge + 2, 0, edge + 2, PATCH), fill=(164, 128, 247), width=2
                    )
            # A pair of trenails pins each plank to its underlying transverse bearer.
            for a, b in zip(boundaries, boundaries[1:]):
                for x0 in (a + 5, b - 5):
                    for y0 in (rng.randint(6, 10), rng.randint(PATCH - 12, PATCH - 8)):
                        ink.ellipse(
                            (x0 - 1.8, y0 - 1.8, x0 + 1.8, y0 + 1.8), fill=(91, 76, 62)
                        )
                        ink.ellipse(
                            (x0 - 0.7, y0 - 0.7, x0 + 0.9, y0 + 0.9),
                            fill=(130, 105, 82),
                        )
        neutral = Image.new("RGB", n.size, (128, 128, 255))
        n = Image.blend(neutral, n, strength)
        # Worn stone corners and the end grain of a timber bay mark a deployment corner.
        # Joints occupy well under one world unit even on the closest camera.
        heights = bytearray(PATCH * PATCH)
        for y in range(PATCH):
            for x in range(PATCH):
                a, b = min(x, PATCH - 1 - x), min(y, PATCH - 1 - y)
                ripple = (
                    0.6
                    + 0.55 * sin(x * 0.071 + y * 0.023 + k)
                    + 0.50 * cos(y * 0.095 - x * 0.031)
                )
                chipped = (
                    max(0.0, (6.8 if asset == LIMESTONE else 4.6) - max(a, b)) * 0.48
                )
                distance = min(a, b) - inset - ripple - chipped
                heights[y * PATCH + x] = round(max(0, min(1, distance / 2.6)) * 255)
        bevel = Image.frombytes("L", (PATCH, PATCH), bytes(heights)).filter(
            ImageFilter.GaussianBlur(0.4)
        )
        # Sand packed into the old joints brings parts of each flag edge back up
        # to the face. A single joint can have a buried end and an exposed chip.
        if asset == LIMESTONE:
            joint_rng = random.Random(4801 + k)
            sediment = Image.new("L", (6, 5))
            sediment.putdata([joint_rng.randrange(10, 225) for _ in range(30)])
            sediment = sediment.resize((PATCH, PATCH), Image.Resampling.BICUBIC)
            bevel = ImageChops.lighter(bevel, sediment)
        bed = shade.point(lambda v: round(v * (0.81 if asset == LIMESTONE else 0.84)))
        shade = Image.composite(shade, bed, bevel)
        nx, ny, nz = n.split()
        for axis, channel in enumerate((nx, ny)):
            shift = (1, 0) if axis == 0 else (0, 1)
            delta = ImageChops.subtract(
                ImageChops.offset(bevel, *shift),
                ImageChops.offset(bevel, -shift[0], -shift[1]),
                scale=4.0,
                offset=128,
            )
            channel.paste(ImageChops.add(channel, delta, offset=-128))
        n = Image.merge("RGB", (nx, ny, nz))
        r = r.point(lambda i: 85 + round(i * 0.59))
        at = (k % ATLAS_SIDE * PATCH, k // ATLAS_SIDE * PATCH)
        albedo.paste(shade, at)
        normal.paste(n, at)
        rough.paste(r, at)
    white = Image.new("L", rough.size, 255)
    return albedo, normal, Image.merge("RGB", (white, rough, white))


def clipped_dry_patches(m, left, top, right, bottom):
    """Trim the few paving stones at the irregular tide wall to its surveyed corners."""
    for bank, sign in ((m.P, -1), (m.Q, 1)):
        i = bisect_right(bank, (left, float("inf")))
        k = bisect_right(bank, (right, float("-inf")))
        breaks = [
            (left, m.sample(bank, left)),
            *bank[i:k],
            (right, m.sample(bank, right)),
        ]
        shore = [v for _, v in breaks]
        if (sign < 0 and bottom <= min(shore)) or (sign > 0 and top >= max(shore)):
            yield [(left, top), (left, bottom), (right, bottom), (right, top)]
            return
        if (sign < 0 and top >= max(shore)) or (sign > 0 and bottom <= min(shore)):
            continue
        for (a, v), (b, w) in zip(breaks, breaks[1:]):
            if b <= a:
                continue
            polygon = [(a, top), (a, bottom), (b, bottom), (b, top)]
            result = []
            for prev, cur in zip(polygon[-1:] + polygon[:-1], polygon):
                px, pz = prev
                x, z = cur
                dp = sign * (pz - v - (w - v) * (px - a) / (b - a))
                dc = sign * (z - v - (w - v) * (x - a) / (b - a))
                if (dp >= 0) != (dc >= 0):
                    t = dp / (dp - dc)
                    result.append((px + t * (x - px), pz + t * (z - pz)))
                if dc >= 0:
                    result.append(cur)
            if len(result) >= 3:
                yield result


def make_pavement(m):
    tile = m.PLAN["tile"]
    centre_lane = m.PLAN["lanes"][1]
    road_axis = centre_lane[0][0] - m.HALF_WIDTH
    lock_approach = max(abs(z - m.HALF_DEPTH) for _, z in centre_lane) + tile
    origin_x = m.PLAN["tileOrigin"][0] - m.HALF_WIDTH
    origin_z = m.PLAN["tileOrigin"][1] - m.HALF_DEPTH
    rng = random.Random(220564)
    pigments = flag_pigments(m)
    height = 0.065
    side_roads = SideRoads(m.PLAN)
    sand_setts = m.material("Sand-filled street granite", SAND_SETTS, rough=.94)
    silver_oak = m.material("Salt-silvered plank ends", SILVER_OAK, rough=.92)
    road_materials = {"granite": m.granite, "oak": m.oak,
                      "sanded": sand_setts, "silver": silver_oak}

    def patch_id(a, b):
        return random.Random(a * 31907 + b * 1907 + 709).randrange(1 << 26)

    for row in range(-7, int(m.PLAN["height"]) // tile + 7):
        z0 = origin_z + tile * row
        for col in range(-6, int(m.PLAN["width"]) // tile + 1):
            x0 = origin_x + col * tile
            x, z = x0 + tile / 2, z0 + tile / 2
            timber_row = row // 3
            first_col = (col + (timber_row % 2)) // 2 * 2 - (timber_row % 2)
            bay = patch_id(first_col, timber_row)
            oak_swatch = bay % 16
            limestone_swatch, rotation = rng.randrange(16), rng.randrange(4)
            # Unpolished and sawn flags have subtly different relief. The gentle
            # colour change between flags is visible with a card picked up or put away.
            limestone_tint = rng.uniform(0.925, 1.0)
            oak_tint = 0.965 + (0.034 * (bay % 11) / 10)
            distance_out = max(-m.HALF_WIDTH - x, abs(z) - m.HALF_DEPTH, 0.0)
            fade = max(0.0, min(1.0, (distance_out - 55.0) / 135.0))
            old_yard = fade > 0 and rng.random() < fade**1.4
            cell_road = side_roads.sample(x, z)
            # Only the paving at a shoulder needs the finer brick/board-end cuts.
            if -55 < cell_road.edge < 92:
                divisions = (0, .25, .5, .75, 1)
            else:
                divisions = (0, 1)
            oak_turn = 0
            if x > 0 and cell_road.edge < 92:
                oak_turn = side_roads.sample(
                    origin_x + (first_col + 1) * tile,
                    origin_z + (timber_row * 3 + 1.5) * tile,
                ).crosswise
            for iz, jz in zip(divisions, divisions[1:]):
                for ix, jx in zip(divisions, divisions[1:]):
                    left, right = x0 + tile * ix, min(558, x0 + tile * jx)
                    if right <= left:
                        continue
                    top, bottom = z0 + tile * iz, z0 + tile * jz
                    xx, zz = (left + right) / 2, (top + bottom) / 2
                    road = side_roads.sample(xx, zz) if len(divisions) > 2 else cell_road
                    if old_yard:
                        mat = m.yard
                    elif road.material and not road.timber_turn:
                        mat = road_materials[road.material]
                    else:
                        mat = m.limestone

                    for polygon in clipped_dry_patches(m, left, top, right, bottom):
                        positions = [(px, height, pz) for px, pz in polygon]
                        if (
                            abs(xx - road_axis) < HAUL_HALF_WIDTH and abs(zz) < lock_approach
                            and (abs(xx - road_axis) < 44 or mat == m.limestone)
                        ):
                            # A subtle difference in each surveyed bay keeps the 32-unit
                            # deployment grid legible through the continuous road bond.
                            shoulder = max(0, min(1, (abs(x - road_axis) - 29) / 99))
                            worn = .5 + limestone_tint * .5
                            yard = limestone_tint * (1 - .065 * min(1, abs(x) / 450)
                                                    - .085 * max(0, min(1, (abs(z) - 625) / 220)))
                            tint = [1 + (c - 1) * shoulder for c in pigments.get((col, row), (1, 1, 1))]
                            m.surface(m.haulway, positions, shade=worn + (yard - worn) * shoulder,
                                      uv=haul_uv(m, polygon), tint=tint)
                            continue
                        if mat == m.yard:
                            m.surface(mat, positions, shade=0.9)
                            continue
                        if mat in (m.granite, sand_setts):
                            uv = [
                                (
                                    px / 277 + 0.014 * sin(pz / 135.0),
                                    pz / 334 + 0.018 * sin(px / 133.0 + pz / 206.0),
                                )
                                for px, pz in polygon
                            ]
                            shade = road.shade
                        else:
                            coords = []
                            for px, pz in polygon:
                                if mat in (m.oak, silver_oak):
                                    u = (px - origin_x - first_col * tile) / (2 * tile)
                                    v = (pz - origin_z - timber_row * 3 * tile) / (
                                        3 * tile
                                    )
                                    turns = int(oak_turn)
                                    swatch = oak_swatch
                                else:
                                    u, v = (px - x0) / tile, (pz - z0) / tile
                                    turns = rotation
                                    swatch = limestone_swatch
                                for _ in range(turns):
                                    u, v = 1 - v, u
                                pad = 2 / PATCH
                                coords.append(
                                    (
                                        (swatch % ATLAS_SIDE + pad + u * (1 - 2 * pad))
                                        / ATLAS_SIDE,
                                        (swatch // ATLAS_SIDE + pad + v * (1 - 2 * pad))
                                        / ATLAS_SIDE,
                                    )
                                )
                            uv = coords
                            is_board = mat in (m.oak, silver_oak)
                            shade = road.shade * (oak_tint if is_board else limestone_tint)
                            if not is_board:
                                lateral = min(1, abs(x) / 450)
                                edge = max(0.0, min(1.0, (abs(z) - 625) / 220.0))
                                shade *= 1.0 - 0.065 * lateral - 0.085 * edge
                        m.surface(
                            mat,
                            positions,
                            shade=shade * (1.0 - 0.18 * fade),
                            uv=uv,
                            tint=pigments.get((col, row))
                            if mat == m.limestone
                            else None,
                        )
    side_roads.lay_timber_turns(m, silver_oak)
