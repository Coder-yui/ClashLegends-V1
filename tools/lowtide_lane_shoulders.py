"""Survey the cart street and timber slip along the two outer marching routes."""

from bisect import bisect_right
from dataclasses import dataclass
from math import floor, hypot, sin
import random
from typing import Optional
from PIL import Image, ImageChops, ImageFilter

TURN_START = 154
TURN_END = 628
SAND_SETTS = "sand_lodged_cart_setts"
SILVER_OAK = "salt_bleached_oak"


def smooth(t):
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


def board_face(front, back, left, right, height, inset):
    return [
        (
            frame[0] + n * frame[2] - t * frame[3],
            height,
            frame[1] + n * frame[3] + t * frame[2],
        )
        for frame, n, t in (
            (front, left, inset),
            (front, right, inset),
            (back, right, -inset),
            (back, left, -inset),
        )
    ]


def patch_noise(x, z, seed):
    """Continuous areas of wear; the end of a repair affects its adjacent courses."""
    ix, iz = floor(x), floor(z)
    u, v = smooth(x - ix), smooth(z - iz)

    def draw(i, j):
        h = (i * 374761393 + j * 668265263 + seed) & 0xFFFFFFFF
        h = ((h ^ (h >> 13)) * 1274126177) & 0xFFFFFFFF
        return (h ^ (h >> 16)) / 4294967295

    a, b, c, d = draw(ix, iz), draw(ix + 1, iz), draw(ix, iz + 1), draw(ix + 1, iz + 1)
    return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v


def shoulder_finish(directory, wood, base):
    """Dust fills the setts; salt and sun lift the worn grain of exposed boards."""
    size = (512, 512)
    albedo, normal, packed = [
        image.resize(size, Image.Resampling.LANCZOS) for image in base
    ]
    scan = Image.open(directory / "concrete_floor_02-c.jpg").convert("L").resize(size)
    sand = ImageChops.subtract(
        scan, scan.filter(ImageFilter.GaussianBlur(11)), scale=1.35, offset=128
    )
    mineral = (196, 179, 153) if not wood else (198, 181, 155)
    deposit = Image.merge(
        "RGB", tuple(sand.point(lambda v, c=c: c + v - 128) for c in mineral)
    )
    # Preserve dark end grain and iron fastenings in oak. Sand accumulates first
    # in the deeper granite bed; its compacted surface softens the original relief.
    if wood:
        mask = albedo.convert("L").point(lambda v: max(52, min(182, (v - 72) * 1.65)))
    else:
        mask = albedo.convert("L").point(lambda v: max(132, min(213, 277 - v * 0.58)))
    colour = Image.composite(deposit, albedo, mask)
    grain = (
        Image.open(directory / "concrete_floor_02-n.jpg").convert("RGB").resize(size)
    )
    grain = Image.blend(Image.new("RGB", size, (128, 128, 255)), grain, 0.38)
    relief = Image.composite(grain, normal, mask)
    rough = Image.composite(
        sand.point(lambda v: 220 + (v - 128) * 0.33), packed.getchannel("G"), mask
    )
    white = Image.new("L", size, 255)
    return colour, relief, Image.merge("RGB", (white, rough, white))


@dataclass(frozen=True)
class RoadSample:
    material: Optional[str]
    shade: float
    edge: float
    crosswise: bool
    timber_turn: bool


class SideRoads:
    def __init__(self, plan):
        self.routes = []
        self.bridge_widths = []
        self.loading = []
        self.cranes = []
        for lane, opening in zip(plan["lanes"][::2], plan["bridges"][::2]):
            segments = []
            length = 0
            for (x, z), (u, v) in zip(lane, lane[1:]):
                dx, dz = u - x, v - z
                size = hypot(dx, dz)
                segments.append(
                    (
                        x - plan["width"] / 2,
                        z - plan["height"] / 2,
                        dx / size,
                        dz / size,
                        size,
                        length,
                    )
                )
                length += size
            self.routes.append((segments, length))
            self.bridge_widths.append((opening["right"] - opening["left"]) / 2)

            def on_bank(x):
                return (x < plan["width"] / 2) == (opening["left"] < plan["width"] / 2)

            service = [
                (z - plan["height"] / 2, 19, 83)
                for team in plan["teams"].values()
                for x, z in team["towers"][::2]
                if on_bank(x)
            ]
            cranes = [
                p["center"][1] - plan["height"] / 2
                for p in plan["props"]
                if p["kind"] == "crane" and on_bank(p["center"][0])
            ]
            service.extend((z, 31, 75) for z in cranes)
            self.loading.append(service)
            self.cranes.append(cranes)
        self.stations = [part[-1] for part in self.routes[1][0]]

    def sample(self, x, z):
        east = x > 0
        segments, length = self.routes[east]
        nearest = float("inf")
        for cx, cz, dx, dz, size, start in segments:
            u, v = x - cx, z - cz
            step = max(0, min(size, u * dx + v * dz))
            gap = (u - dx * step) ** 2 + (v - dz * step) ** 2
            if gap < nearest:
                nearest = gap
                along = start + step
                road_x = cx + dx * step
                side = 1 if u * dz - v * dx > 0 else -1
                crosswise = abs(dz) > abs(dx)

        # Both streets leave the common muster apron at a narrower gauge. They
        # broaden into the bend beside each tower, then fit their own abutment.
        journey = min(along, length - along)
        normal_width = 34 + (27 if east else 32) * smooth(journey / 355)
        quay = smooth((abs(z) - 62) / 120)
        width = (
            self.bridge_widths[east] + (normal_width - self.bridge_widths[east]) * quay
        )
        width += quay * (4 * sin(along / 51 + side) + 3 * sin(along / 105 - side))
        if abs(x) > abs(road_x):
            width += self.apron_width(east, z)
        # Each course ends at a different board end or staggered granite sett.
        course = floor((z if crosswise else x) / (8 if east else 12))
        tooth = 6 * sin(48.3 * course + side) + 4 * sin(14.9 * (course // 3) + side)
        # A couple of reclaimed courses tie each crane's landing into its street.
        if abs(x) > abs(road_x) and any(
            42 < abs(z - cz) < 66 for cz in self.cranes[east]
        ):
            tooth += 14
        edge = nearest**0.5 - width
        # Between the swept lane and clean flag yard lie rows from earlier
        # repairs: tongues of bleached oak or sandy granite interleave with
        # islands of original foundation. Vary width and depth by repair area.
        spread = smooth((abs(z) - 34) / 109) * (0.35 + 0.65 * smooth(journey / 136))
        local = patch_noise(x / 57 + 0.14, z / 89, 5567)
        pieces = patch_noise(x / 25 - 0.79 * (course % 2), z / 29, 19433)
        gutter = patch_noise(along / 113, side * 3.7, 9959)
        bite = spread * (45 * (local - 0.45) + 23 * (pieces - 0.5) + tooth)
        fringe = edge - bite
        scatter = ((20 if east else 31) + 38 * gutter) * spread
        grit = smooth((edge + 27) / (43 + scatter))
        repaired = local > 0.73 and pieces > 0.45 and fringe > -44 * spread
        faded = fringe > -(13 + 8 * gutter) * spread or repaired
        if fringe < 0 or (fringe < scatter and 0.69 * local + 0.31 * pieces > 0.34):
            if east:
                material = "silver" if faded else "oak"
                # Traffic wears through the dry salt crust to darker, oiled oak.
                # Old groups of sleepers share their patina across several boards.
                shade = 0.95 + 0.05 * local if faded else 0.73 + 0.15 * local
            else:
                material = "sanded" if faded else "granite"
                shade = 0.71 + 0.21 * grit + 0.05 * local
        else:
            material = None
            shade = 0.78 + 0.22 * smooth((fringe + 12) / (54 + scatter))
        timber_turn = east and TURN_START + 12 < journey < TURN_END - 12
        return RoadSample(material, shade, edge, crosswise, timber_turn)

    def apron_width(self, east, z):
        return sum(
            extra * (1 - smooth(abs(z - centre) / run))
            for centre, extra, run in self.loading[east]
        )

    def timber_frame(self, station):
        """A cross-section normal to the timber lane, with a splayed outer shoulder."""
        segments = self.routes[1][0]
        i = max(0, bisect_right(self.stations, station) - 1)
        cx, cz, dx, dz, size, start = segments[i]
        t = (station - start) / size
        x, z = cx + t * size * dx, cz + t * size * dz
        prev, nxt = segments[max(0, i - 1)], segments[min(i + 1, len(segments) - 1)]
        tx = dx + prev[2] * (1 - t) + nxt[2] * t
        tz = dz + prev[3] * (1 - t) + nxt[3] * t
        length = hypot(tx, tz)
        tx, tz = tx / length, tz / length
        journey = min(station, self.routes[1][1] - station)
        width = 34 + 27 * smooth(journey / 355)
        # The tight inner corner receives short tapered boards. Full lengths
        # wrap around the outside of the same turn without crossing one another.
        inner = width * (1 - 0.37 * abs(2 * tx * tz))
        outer = width + self.apron_width(True, z)
        return x, z, tz, -tx, inner, outer

    def lay_timber_turns(self, m, silver_oak):
        rng = random.Random(22917)
        # Positions inside uninterrupted photographed oak strips in the swatch atlas.
        stock = (
            (0, 0.849),
            (2, 0.594),
            (3, 0.432),
            (6, 0.161),
            (7, 0.802),
            (8, 0.375),
            (10, 0.562),
            (11, 0.464),
            (14, 0.099),
            (15, 0.792),
        )
        length = self.routes[1][1]
        for start, end in [
            (TURN_START, TURN_END),
            (length - TURN_END, length - TURN_START),
        ]:
            s = start
            while s < end:
                following = min(end, s + rng.uniform(6.8, 9.1))
                if end - following < 5:
                    following = end
                front, back = self.timber_frame(s), self.timber_frame(following)
                inner_wear = patch_noise(s / 64, 0.2, 4417)
                outer_wear = patch_noise(s / 89, 4.0, 853)
                inner = (
                    (front[4] + back[4]) / 2
                    + 24 * (inner_wear - 0.57)
                    + rng.uniform(-6, 7)
                )
                outer = (
                    (front[5] + back[5]) / 2
                    + 29 * (outer_wear - 0.48)
                    + rng.uniform(-8, 9)
                )

                m.surface(
                    m.beam,
                    board_face(front, back, -inner, outer, 0.09, 0),
                    "Floor turn bedding",
                    0.65,
                )
                # Butt joints fall on offset supporting sleepers. Some courses
                # carry a longer original plank past the centre of the lane.
                join = max(
                    -inner + 8, min(outer - 8, rng.choice((-31, -29, -11, 18, 21, 37)))
                )
                repairs = [
                    (-inner, join - 0.19, inner_wear, True),
                    (join + 0.19, outer, outer_wear, False),
                ]
                for a, b, wear, inner_end in repairs:
                    # Replaced ends stop on an old bearer: the new plank has a
                    # clear butt joint; nearby salt-weathered ends persist in groups.
                    split = min(b - 7, max(a + 7, (a + b) / 2 + rng.uniform(-8, 8)))
                    if wear > 0.48 and b - a > 26:
                        boards = (
                            (a, split - 0.2, inner_end),
                            (split + 0.2, b, not inner_end),
                        )
                    else:
                        boards = ((a, b, wear > 0.78),)
                    for begin, end_board, bleached in boards:
                        self.wearing_board(
                            m,
                            silver_oak if bleached else m.oak,
                            front,
                            back,
                            begin,
                            end_board,
                            rng,
                            stock,
                        )
                    if wear > 0.55:
                        # A few old lengths reach one bearer beyond the replacement.
                        extra = 6 + 28 * (wear - 0.42) + rng.uniform(-3, 6)
                        old_a, old_b = (
                            (a - extra, a - 0.35)
                            if inner_end
                            else (b + 0.35, b + extra)
                        )
                        self.wearing_board(
                            m, silver_oak, front, back, old_a, old_b, rng, stock
                        )
                s = following

        # On the straight wharf the repairs stop at individual bearing joists
        # instead of repeating the rectangular bays of the original carpentry.
        for offset, count, side in ((686, 7, 1), (816, 13, -1), (951, 6, 1)):
            for start in (offset, length - offset - count * 7.8):
                station = start
                for i in range(count):
                    end = station + rng.uniform(6.2, 9.1)
                    front, back = self.timber_frame(station), self.timber_frame(end)
                    inner = rng.choice((-27, -12, -12, 4))
                    outer = min(58, 36 + min(i, count - 1 - i) * 4) + rng.uniform(-4, 3)
                    a, b = sorted((side * inner, side * outer))
                    mat = (
                        silver_oak
                        if 2 <= i < count - 2 and (i + offset) % 7 < 3
                        else m.oak
                    )
                    self.wearing_board(m, mat, front, back, a, b, rng, stock)
                    station = end

    @staticmethod
    def wearing_board(m, material, front, back, a, b, rng, stock):
        swatch, u = rng.choice(stock)
        uv = [
            ((swatch % 4 + u + du) / 4, (swatch // 4 + v) / 4)
            for du, v in ((0, 0.08), (0, 0.92), (0.052, 0.92), (0.052, 0.08))
        ]
        shaded = (
            rng.uniform(0.72, 0.87) if material == m.oak else rng.uniform(0.83, 0.94)
        )
        m.surface(
            material,
            board_face(front, back, a, b, 0.21, 0.17),
            "Floor road planking",
            shaded,
            uv=uv,
            tint=(1, 0.96, 0.90) if material == m.oak else None,
        )
