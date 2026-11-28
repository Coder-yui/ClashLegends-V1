"""Low-water growth below the quay and salt-tolerant scrub outside the paved yard."""

import math
import random


def blade(m, mat, base, tip, width, azimuth, bend, pigment, label):
    """A folded leaf with a raised midrib; both sides catch the harbour light."""
    x, y, z = base
    dx, dy, dz = (b - a for a, b in zip(base, tip))
    across = (math.cos(azimuth) * width, math.sin(azimuth) * width)
    mid = (
        x + dx * 0.47 + bend * math.sin(azimuth),
        y + dy * 0.47,
        z + dz * 0.47 - bend * math.cos(azimuth),
    )
    left = (mid[0] - across[0], mid[1], mid[2] - across[1])
    right = (mid[0] + across[0], mid[1], mid[2] + across[1])
    ridge = (mid[0], mid[1] + width * 0.32, mid[2])
    mesh = m.groups[label, mat]
    for points, shade in [
        ([base, left, ridge], 0.72),
        ([base, ridge, right], 0.79),
        ([ridge, left, tip], 0.94),
        ([ridge, tip, right], 1.0),
    ]:
        mesh.face(
            points,
            [(0.0, 0.0), (0.5, 0.7), (1.0, 1.0)],
            [tuple(c * shade for c in pigment)] * 3,
            upward=True,
        )


def masonry_banks(m, rng):
    # The cap, dry ashlar and wet toe are separate bonded courses. In the
    # battle camera their broken light edges explain the drop to the water.
    course_materials = [
        m.material(
            "Sunlit quay limestone",
            m.lowtide_pavement.LIMESTONE,
            (1.0, 0.98, 0.92),
            0.80,
            scale=72,
        ),
        m.material(
            "Pitted salt masonry",
            m.lowtide_pavement.LIMESTONE,
            (0.72, 0.72, 0.59),
            0.86,
            scale=59,
        ),
        m.material(
            "Tidal masonry with algae",
            "seaworn_stone_tiles",
            (0.48, 0.50, 0.30),
            0.73,
            scale=47,
        ),
    ]
    for bank, inward in ((m.P, 1), (m.Q, -1)):
        gaps = [
            (b["left"] - m.HALF_WIDTH - 1, b["right"] - m.HALF_WIDTH + 1)
            for b in m.PLAN["bridges"]
        ]
        runs = zip([-990] + [b for _, b in gaps], [a for a, _ in gaps] + [558])
        for start, stop in runs:
            for course, mat in enumerate(course_materials):
                x = start
                while x < stop - 2:
                    length = rng.uniform(11, 20) if course == 0 else rng.uniform(14, 27)
                    end = min(x + length, stop)
                    a, b = x + 0.38, end - 0.38
                    bevel = min((b - a) * 0.17, rng.uniform(0.62, 1.30))
                    front = (2.1, 2.7, 3.2)[course] + rng.uniform(-0.45, 1.1)
                    back = (-6.0, -0.5, 0.10)[course] - rng.uniform(0, 1.4)
                    top = (1.0, -5.8, -14.8)[course] + rng.uniform(-0.28, 0.32)
                    base = (-5.55, -14.4, -22.6)[course]
                    if b - a < 2:
                        break
                    outline = [
                        (a + bevel, back),
                        (b - bevel, back),
                        (b, back + bevel),
                        (b - 0.2, front - bevel),
                        (b - bevel, front),
                        (a + bevel, front + rng.uniform(-0.4, 0.4)),
                        (a, front - bevel),
                        (a + 0.2, back + bevel),
                    ]

                    def at(u, v, h):
                        return u, h, m.sample(bank, u) + inward * v

                    centre_x, centre_z = (a + b) * 0.5, (back + front) * 0.5
                    shoulder = [at(u, v, top - bevel) for u, v in outline]
                    crown = [
                        at(
                            centre_x + (u - centre_x) * 0.93,
                            centre_z + (v - centre_z) * 0.76,
                            top,
                        )
                        for u, v in outline
                    ]
                    shade = rng.uniform((0.68, 0.56, 0.43)[course], 1.0)
                    m.surface(mat, crown, "Coping and wet ashlar", shade)
                    for k, edge in enumerate(shoulder):
                        n = (k + 1) % len(shoulder)
                        m.surface(
                            mat,
                            [edge, shoulder[n], crown[n], crown[k]],
                            "Coping and wet ashlar",
                            shade,
                        )
                        m.wall(
                            mat,
                            (edge[0], edge[2]),
                            (shoulder[n][0], shoulder[n][2]),
                            base,
                            edge[1],
                            "Coping and wet ashlar",
                            shade,
                        )
                    x = end


def tidal_outcrops(m, rng):
    """Scattered exposed stones and ochre wrack attached to joints in the tide wall."""
    rock = m.material(
        "Intertidal dolerite", "stone_floor", (0.46, 0.43, 0.29), 0.76, scale=26
    )
    frond = m.material("Golden rockweed at low tide", None, (0.29, 0.26, 0.054), 0.64)
    for bank, inward in ((m.P, 1), (m.Q, -1)):
        abutments = [
            (b["left"] - m.HALF_WIDTH - 7, b["right"] - m.HALF_WIDTH + 7)
            for b in m.PLAN["bridges"]
        ]
        x = -740
        while x < 556:
            x += rng.uniform(13, 36)
            if any(a < x < b for a, b in abutments):
                continue
            crest = rng.uniform(-11.7, -8.5)
            length = rng.uniform(7, 17)
            for _ in range(rng.randrange(7, 17)):
                xx = x + rng.uniform(-length, length)
                if any(a < xx < b for a, b in abutments):
                    continue
                z0 = m.sample(bank, xx) + inward * 2.0
                y0 = crest + rng.uniform(-3, 1.4)
                reach = rng.uniform(2.6, 8.2)
                shade = rng.uniform(0.37, 0.98)
                blade(
                    m,
                    frond,
                    (xx, y0, z0),
                    (
                        xx + rng.uniform(-2, 2),
                        y0 - reach,
                        z0 + inward * rng.uniform(0.8, 2.8),
                    ),
                    rng.uniform(1.1, 2.3),
                    0,
                    0.42,
                    (shade, shade * 0.97, rng.uniform(0.45, 0.85)),
                    "Wrack",
                )
            if rng.random() > 0.27:
                continue
            distance = rng.uniform(9, 18)
            cz = m.sample(bank, x) + inward * distance
            shoulder = -18 - distance * 0.45 + rng.uniform(0.8, 3.1)
            rx, rz = rng.uniform(3.3, 7), rng.uniform(2.7, 4.5)
            rough = [rng.uniform(0.71, 1.18) for _ in range(7)]
            ring = [
                (
                    x + rx * math.cos(j * math.tau / 7) * r,
                    shoulder + rng.uniform(-0.7, 0.7),
                    cz + rz * math.sin(j * math.tau / 7) * r,
                )
                for j, r in enumerate(rough)
            ]
            summit = (x - rx * 0.22, shoulder + rz * 0.68, cz - inward * 0.21 * rz)
            for a, b in zip(ring, ring[1:] + ring[:1]):
                m.surface(
                    rock, [a, b, summit], "Intertidal outcrops", rng.uniform(0.65, 0.92)
                )
                m.wall(
                    rock,
                    (a[0], a[2]),
                    (b[0], b[2]),
                    -30.5,
                    min(a[1], b[1]),
                    "Intertidal outcrops",
                    0.61,
                )


def warehouse_scrub(m, rng):
    """Windswept saltbushes and small trees in the cracks outside the working yard."""
    wood = m.material("Salt-weathered branches", None, (0.115, 0.076, 0.032), 0.90)
    leaves = m.material("Coastal scrub leaves", None, (1, 1, 1), 0.85)
    # World-space stems. Clumps at the gatehouses bookend the port. The western
    # plants are rooted beside the shed walls and between the loading yards.
    sites = [
        (-627, -914, 51, 48),
        (-573, -898, 40, 48),
        (-507, -915, 35, 35),
        (-467, -934, 20, 22),
        (503, -921, 37, 36),
        (539, -929, 23, 31),
        (-592, -702, 29, 49),
        (-584, -662, 18, 32),
        (-586, -124, 34, 43),
        (-597, -99, 23, 29),
        (-589, 402, 28, 38),
        (-583, 435, 17, 25),
        (-634, 910, 41, 40),
        (-594, 928, 37, 36),
        (-559, 933, 24, 24),
        (490, 919, 34, 38),
        (526, 902, 26, 35),
        (-978, 726, 29, 36),
        (-1010, -739, 24, 29),
    ]
    uv = [(0.5, 0), (0, 0.49), (0.5, 1)]
    spray_mesh = m.groups["Warehouse foliage", leaves]

    def leaf(base, heading, length, width, lift, pigment):
        # Two folded laminae give each leaf thickness in silhouette and varied
        # light as the viewer rotates. The lower edge of the fold stays darker.
        x, y, z = base
        dx, dz = math.cos(heading), math.sin(heading)
        tip = (x + dx * length, y + lift, z + dz * length)
        half = (x + dx * length * 0.46, y + lift * 0.53, z + dz * length * 0.46)
        tilt = rng.uniform(-0.83, 0.83) * width
        left = (
            half[0] - dz * width,
            half[1] + tilt - 0.21 * width,
            half[2] + dx * width,
        )
        right = (
            half[0] + dz * width,
            half[1] - tilt - 0.21 * width,
            half[2] - dx * width,
        )
        for edge, value in ((left, 0.84), (right, 1.0)):
            root_color = tuple(c * value * 0.75 for c in pigment)
            end_color = tuple(c * value for c in pigment)
            spray_mesh.face(
                [base, edge, tip], uv, [root_color, end_color, end_color], upward=True
            )

    def lerp(a, b, t):
        return tuple(v + (w - v) * t for v, w in zip(a, b))

    for cx, cz, radius, height in sites:
        spin = rng.random() * math.tau
        crown = rng.uniform(0.81, 1.03)
        wind = rng.uniform(0.09, 0.19)
        flush = rng.uniform(-0.15, 0.15)
        root = (cx, 0.1, cz)
        joints = []
        for k in range(7):
            angle = spin + k * math.tau / 7 + rng.uniform(-0.24, 0.24)
            knee = (
                cx + radius * (0.23 * math.cos(angle) + 0.035),
                height * rng.uniform(0.27, 0.43),
                cz + radius * 0.22 * math.sin(angle),
            )
            m.shaft(wood, root, knee, max(0.49, radius * 0.032), 5, "Quayside boughs")
            joints.append(knee)
        # Overlapping low and high sprays build a layered crown with small holes
        # between branches. Interior foliage has its own richer, shaded albedo.
        for layer, n in enumerate((8, 10, 12)):
            for j in range(n):
                angle = (
                    spin + math.tau * (j + layer * 0.39) / n + rng.uniform(-0.23, 0.23)
                )
                r = radius * rng.uniform(0.56, 1.0) * (0.86, 0.81, 0.57)[layer]
                # Upright leaders cross the crown. Leeward branches extend at
                # different heights and close the hollow directly above the trunk.
                if layer == 2 and j % 3 == 0:
                    r *= -0.30
                peak = height * ((0.44, 0.68, 0.84)[layer] + rng.uniform(-0.10, 0.10))
                outer = (
                    cx + r * math.cos(angle) + radius * wind * math.cos(spin),
                    peak,
                    cz + crown * r * math.sin(angle) + radius * wind * math.sin(spin),
                )
                knee = joints[round((angle - spin) * 7 / math.tau) % 7]
                crotch = lerp(knee, outer, rng.uniform(0.40, 0.51))
                m.shaft(wood, knee, crotch, radius * 0.015, 3, "Quayside boughs")
                for split in (-1, 1):
                    az = angle + split * rng.uniform(0.33, 0.82)
                    spread = radius * rng.uniform(-0.10, 0.14)
                    end = (
                        outer[0] + spread * math.cos(az),
                        outer[1] + height * rng.uniform(0.01, 0.08),
                        outer[2] + spread * math.sin(az),
                    )
                    m.shaft(wood, crotch, end, radius * 0.0085, 3, "Quayside boughs")
                    golden = rng.uniform(0, 0.65) + 0.14 * layer + flush
                    sunlight = (
                        0.22
                        + 0.55 * layer / 2
                        + rng.uniform(-0.18, 0.28)
                        + 0.33 * max(0, -math.cos(angle + 0.5))
                    )
                    for h in range(8):
                        p = lerp(crotch, end, (h + rng.uniform(-0.1, 0.32)) / 8)
                        heading = az + (-1 if h % 2 else 1) * rng.uniform(0.55, 1.14)
                        size = radius * rng.uniform(0.17, 0.29)
                        tone = max(0.0, min(1.15, sunlight + rng.uniform(-0.27, 0.25)))
                        light = tone**1.72
                        pigment = (
                            0.008 + (0.19 + 0.30 * golden) * light,
                            0.030 + (0.26 + 0.059 * golden) * light,
                            0.002 + (0.018 - 0.012 * golden) * light,
                        )
                        leaf(
                            p,
                            heading,
                            size,
                            size * rng.uniform(0.20, 0.31),
                            size * rng.uniform(-0.43, 0.38),
                            pigment,
                        )
                    if layer == 2 and sunlight > 0.85 and rng.random() < 0.48:
                        # Small pale flower heads punctuate the sunward sprays.
                        for q in range(8):
                            azimuth = q * math.tau / 8 + rng.uniform(-0.5, 0.5)
                            stalk = radius * rng.uniform(0.028, 0.095)
                            p = (
                                end[0] + stalk * math.cos(azimuth),
                                end[1] + stalk * rng.uniform(0.1, 0.5),
                                end[2] + stalk * math.sin(azimuth),
                            )
                            leaf(
                                p,
                                azimuth,
                                radius * 0.062,
                                radius * 0.023,
                                0.26,
                                (0.73, rng.uniform(0.54, 0.69), 0.27),
                            )


def make_shoreline(m):
    rng = random.Random(21817)
    masonry_banks(m, random.Random(31921))
    weed = m.material("Low water bladderwrack", None, (0.125, 0.158, 0.043), 0.53, 0.04)
    salt = m.material("Pale barnacle shells", None, (0.62, 0.63, 0.50), 0.89)
    # Patchy wrack caught on the actual silt ledge. The two upper banks remain open.
    for bank, inward in [(m.P, 1), (m.Q, -1)]:
        for _ in range(95):
            cx = rng.uniform(-810, 555)
            if any(
                b["left"] - m.HALF_WIDTH - 4 < cx < b["right"] - m.HALF_WIDTH + 4
                for b in m.PLAN["bridges"]
            ):
                continue
            curb = m.sample(bank, cx)
            for _ in range(rng.randrange(3, 8)):
                x = cx + rng.uniform(-13, 13)
                distance = rng.uniform(3, 12)
                z = m.sample(bank, x) + inward * distance
                y = -17.2 - distance * 0.38
                for _ in range(rng.randrange(4, 8)):
                    angle = rng.uniform(0, math.tau)
                    length = rng.uniform(3, 9)
                    tip = (
                        x + length * math.cos(angle),
                        y + rng.uniform(-3, 1.4),
                        z + length * math.sin(angle),
                    )
                    blade(
                        m,
                        weed,
                        (x, y, z),
                        tip,
                        rng.uniform(0.66, 1.22),
                        angle + math.pi / 2,
                        rng.uniform(-1, 1),
                        (rng.uniform(0.53, 0.89), rng.uniform(0.57, 0.91), 0.72),
                        "Wrack",
                    )
            # Discontinuous chalky barnacles at the old high-water mark.
            for j in range(rng.randrange(4, 10)):
                x = cx + rng.uniform(-8, 8)
                z = m.sample(bank, x) + inward * 0.35
                y = -9.8 + rng.uniform(-2.3, 1.7) + 0.7 * math.sin(curb * 0.3 + x * 0.2)
                radius = rng.uniform(0.42, 0.97)
                shell = [
                    (
                        x + radius * math.cos(k * math.tau / 5),
                        y + radius * math.sin(k * math.tau / 5),
                        z,
                    )
                    for k in range(5)
                ]
                tip = (x + 0.15, y + 0.12, z + inward * 0.54)
                for k in range(5):
                    m.groups["Old tide line", salt].face(
                        [shell[k], shell[(k + 1) % 5], tip],
                        [(0, 0), (1, 0), (0.4, 1)],
                        [(0.73, 0.76, 0.70)] * 3,
                    )

    tidal_outcrops(m, rng)
    warehouse_scrub(m, random.Random(34863))
