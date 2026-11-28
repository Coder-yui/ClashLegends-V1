"""Landward warehouse courts, cart paving and cargo beside the old siding."""

import math
import random


# Centres are beside loading faces of the actual sheds. Rotation follows each
# door, so the cart tracks and supplies leave clear routes between buildings.
LOTS = [
    (-1003, -718, 0.04, "timber"),
    (-1174, -656, 1.55, "stone"),
    (-1422, -429, 0.03, "aggregate"),
    (-1069, -199, -0.10, "timber"),
    (-1391, -244, 1.52, "stone"),
    (-866, 157, 1.53, "aggregate"),
    (-1254, 281, 0.08, "stone"),
    (-1087, 557, -0.17, "timber"),
    (-1373, 605, 1.47, "aggregate"),
    (-1118, 787, 1.53, "timber"),
]


def warehouse_bank(m, sign):
    rng = random.Random(6284 + sign)
    bank = m.P if sign < 0 else m.Q
    lots = [lot for lot in LOTS if lot[1] * sign > 0]
    clay = m.material(
        "Old brick goods court", "factory_brick", (0.80, 0.70, 0.60), 0.98, scale=112
    )
    stone = m.material(
        "Flint and sand ballast", "stone_floor", (0.82, 0.80, 0.69), 0.98, scale=88
    )
    flags = m.material(
        "Salt-worn blocks in the loading courts",
        "seaworn_stone_tiles",
        (1.0, 0.98, 0.96),
        0.98,
        normal_strength=0.48,
        scale=145,
    )
    lumber = m.material(
        "Sawn sleepers in store", "weathered_planks", (1, 0.84, 0.60), 0.91, scale=77
    )
    label = "West warehouse courts"

    # Slightly meandering wagon roads have their own coursing through the older
    # yards. Reversing the stone bond indicates a turn without painting outlines.
    def lane(x, z):
        a = -931 + 21 * math.sin(z / 247) + 11 * math.sin(z / 93)
        b = -1273 + 31 * math.sin(z / 285 + sign)
        c = -1632 + 31 * math.cos(z / 200 + sign)
        ver = min(abs(x - a) - 36, abs(x - b) - 43, abs(x - c) - 41)
        hor = min(
            abs(z - s - 0.038 * (x + 1050) - 9 * math.sin(x / 106)) - w
            for s, w in ((155, 24), (458, 24), (803, 27), (1100, 22))
        )
        return min(ver, hor), hor < ver

    def stone_colour(x, z):
        route, _ = lane(x, abs(z))
        traffic = max(0, min(1, (45 - route) / 70))
        coastal = max(0, 1 - (abs(z) - abs(m.sample(bank, x))) / 100)
        age = (
            0.94
            + 0.08 * math.sin(x / 89 + z / 133)
            + 0.045 * math.cos(z / 61 - x / 186)
        )
        far = min(1, max(0, (-x - 735) / 83))
        shade = age * (1 - 0.15 * coastal) * (0.96 - far * 0.29 + 0.091 * traffic)
        return tuple(
            min(1, shade * c) for c in (0.98, 0.94 - 0.066 * far, 0.91 - 0.09 * far)
        )

    def court_edge(x, z):
        # We only find traces of older paving under or directly beside stored
        # cargo. The broad public cart yard between sheds is one continuous stone bed.
        edge = -300
        for cx, cz, angle, _ in lots:
            dx, dz = x - cx, z - cz
            along = dx * math.cos(angle) + dz * math.sin(angle)
            across = dz * math.cos(angle) - dx * math.sin(angle)
            reach = math.hypot((along + 0.33 * across + 9) / 88, (across + 17) / 47)
            wear = 8 * math.sin(dx / 29 + dz / 37) + 4 * math.sin(dz / 14 - dx / 24)
            edge = max(edge, (1 - reach) * 54 + wear)
        return edge

    def clipped(points, landward):
        poly = []
        for a, b in zip(points, points[1:] + points[:1]):
            if (a[2] >= 0) == landward:
                poly.append(a[:2])
            if (a[2] >= 0) != (b[2] >= 0):
                t = a[2] / (a[2] - b[2])
                poly.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
        return poly

    # Tessellate the continuous street to represent damp coastal stone, the
    # lighter cart lanes and ochre grime near warehouse walls at a broad scale.
    xs = sorted({-2500, *range(-2475, -736, 38), -736})
    depths = [0, *range(32, 1880, 35), 1890]
    for x, u in zip(xs, xs[1:]):
        for near, far in zip(depths, depths[1:]):
            ring = [
                (xx, 0.11, sign * d + m.sample(bank, xx))
                for xx, d in ((x, near), (u, near), (u, far), (x, far))
            ]
            _, transverse = lane((x + u) / 2, abs((ring[0][2] + ring[2][2]) / 2))

            def uv(px, pz):
                if transverse:
                    return pz / 175, -px / 174
                return px / 174, pz / 175

            points = [(px, pz, court_edge(px, pz)) for px, _, pz in ring]
            for triangle in (
                [points[0], points[1], points[2]],
                [points[0], points[2], points[3]],
            ):
                for landward in (False, True):
                    patch = clipped(triangle, landward)
                    if len(patch) < 3:
                        continue
                    # Large salt-worn flags carry the load beside each goods door.
                    if landward:
                        m.surface(
                            flags,
                            [(px, 0.11, pz) for px, pz in patch],
                            label,
                            0.98,
                            uv=[
                                ((px + 0.12 * pz) / 154, (pz - 0.12 * px) / 154)
                                for px, pz in patch
                            ],
                        )
                    else:
                        m.groups[label, m.granite].face(
                            [(px, 0.11, pz) for px, pz in patch],
                            [uv(px, pz) for px, pz in patch],
                            [stone_colour(px, pz) for px, pz in patch],
                            upward=True,
                        )
    # Old sett courses outside each goods door are interleaved with the clay
    # paviours and patch stones, in the same joint directions as the shed face.
    for index, (cx, cz, angle, load) in enumerate(lots):
        cs, sn = math.cos(angle), math.sin(angle)

        def local(x, z):
            return cx + x * cs - z * sn, cz + x * sn + z * cs

        def board(mat, x, z, w, d, lo, hi, shade):
            corners = [
                local(x + a, z + b)
                for a, b in (
                    (-w / 2, -d / 2),
                    (-w / 2, d / 2),
                    (w / 2, d / 2),
                    (w / 2, -d / 2),
                )
            ]
            m.prism(mat, corners, lo, hi, "Stored port cargo", shade)

        half = 78 if load == "timber" else 69
        bw, bd = 15.5, 10.5
        for row in range(-5, 5):
            offset = (row % 2) * bw / 2
            for col in range(-6, 6):
                x, z = col * bw + offset, row * bd
                extent = (abs(x) / half) ** 3 + (abs(z + 6) / 48) ** 3
                if extent > rng.uniform(0.83, 1.36):
                    continue
                # The outer rows taper into the older granite, with intermittent
                # surviving bricks in both directions across the boundary.
                strength = min(1, max(0, (1.32 - extent) / 0.82))
                if rng.random() > 0.40 + 0.60 * strength:
                    continue
                mat = clay if index % 3 != 1 else stone
                blend = mat if rng.random() < (0.46 + 0.54 * strength) else m.granite
                coords = [(x, z), (x, z + bd), (x + bw, z + bd), (x + bw, z)]
                ring = [local(px, pz) for px, pz in coords]
                m.surface(
                    blend,
                    [(a, 0.17, b) for a, b in ring],
                    label,
                    rng.uniform(0.78, 0.97),
                    uv=[(a / 134, b / 116) for a, b in coords],
                )
        if load == "timber":
            for pos in (-15, 12):
                board(m.beam, pos, 0, 4.5, 38, 0.15, 3.4, 0.72)
            for layer in range(3):
                for part in range(5 - layer % 2):
                    z = (part - 2) * 6.3 + layer % 2 * 3.2
                    length = rng.uniform(39, 55)
                    x = rng.uniform(-2.3, 3.2) + 0.9 * layer
                    board(
                        lumber,
                        x,
                        z,
                        length,
                        rng.uniform(4.8, 5.8),
                        3.4 + 4.5 * layer,
                        7.7 + 4.5 * layer,
                        rng.uniform(0.70, 1.0),
                    )
        elif load == "stone":
            for layer in range(3):
                for col in range(4 - layer):
                    for row in range(2):
                        board(
                            stone,
                            (col - 1.5 + 0.5 * layer) * 10,
                            (row - 0.5) * 10,
                            rng.uniform(9.2, 9.8),
                            rng.uniform(8.9, 9.8),
                            0.17 + 4.8 * layer,
                            rng.uniform(4.45, 4.78) + 4.8 * layer,
                            rng.uniform(0.82, 1.0),
                        )
        else:
            edge = [
                local(
                    math.cos(k * math.tau / 11) * rng.uniform(19, 28),
                    math.sin(k * math.tau / 11) * rng.uniform(12, 20),
                )
                for k in range(11)
            ]
            x, z = local(-4, -2)
            top = (x, rng.uniform(9.5, 14), z)
            for a, b in zip(edge, edge[1:] + edge[:1]):
                m.surface(
                    stone,
                    [(a[0], 0.18, a[1]), (b[0], 0.18, b[1]), top],
                    "Loose limestone aggregate",
                    rng.uniform(0.79, 1),
                )
            board(lumber, -1, 18, 53, 3.5, 0.2, 6, 0.71)
    # Short iron grilles collect drain water along the outer goods quay.
    for x in (-822, -994, -1142, -1355, -1524, -1702):
        z = m.sample(bank, x) + sign * rng.uniform(12, 18)
        m.rect(
            m.iron, x - 5.8, z - 2.7, x + 5.8, z + 2.7, 0.21, "Warehouse drains", 0.78
        )
        for offset in (-3, 0, 3):
            m.rect(
                m.black,
                x + offset - 0.45,
                z - 2.3,
                x + offset + 0.45,
                z + 2.3,
                0.24,
                "Warehouse drains",
            )
