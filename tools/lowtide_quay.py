"""Outer harbour fabric, in centred terrain coordinates. All of it is scenery."""

import math
import random


def make_outer_harbour(m):
    """Add the east graving dock and its protective arms to the shared terrain mesh."""
    # The coasting ship lies at x~840, the nearest moorings at x~650.
    # The entrance at 1136 faces west, with an uninterrupted approach between the arms.
    sea = m.SEA_LEVEL
    rng = random.Random(1876)
    gate, head, centre = 1136, 1470, -585
    dock = "East graving dock"
    stonework = "Graving dock masonry"
    equipment = "Graving dock equipment"
    rocks = "Armour stone"
    breakwater = "Masonry breakwaters"

    # Shoreline extends beyond the panoramic crop. Its slight crown is above
    # the quay where the east end of the masonry basin meets the service yard.
    shore = [
        (1900, -1500),
        (1756, -1160),
        (1610, -963),
        (1582, -846),
        (1566, -709),
        (1579, -550),
        (1598, -424),
        (1690, -319),
        (1741, -212),
        (1784, -40),
        (1770, 170),
        (1711, 359),
        (1634, 555),
        (1584, 705),
        (1598, 816),
        (1716, 982),
        (1843, 1190),
        (1986, 1470),
    ]
    for (x, z), (u, v) in zip(shore, shore[1:]):
        m.surface(
            m.shoal,
            [(x - 27, sea - 5, z), (u - 27, sea - 5, v), (u, -12, v), (x, -12, z)],
            dock,
            0.84,
        )
        m.surface(
            m.slate,
            [(x, -12, z), (u, -12, v), (u + 12, 1.8, v), (x + 12, 1.8, z)],
            dock,
            0.8,
        )
        m.surface(
            m.yard,
            [(x + 12, 1.8, z), (u + 12, 1.8, v), (u + 83, 4, v), (x + 83, 4, z)],
            dock,
            0.91,
        )
        m.surface(
            m.shoal,
            [(x + 83, 4, z), (u + 83, 4, v), (2290, 11, v), (2290, 11, z)],
            dock,
            0.85,
        )

    # Looking west down the dry dock: two straight side walls turn around its
    # semicircular head. Each U-shaped contour stays open at the lock gates.
    def contour(radius):
        ring = [(gate, centre + radius)]
        for i in range(13):
            angle = math.pi / 2 - i * math.pi / 12
            ring.append(
                (head + radius * math.cos(angle), centre + radius * math.sin(angle))
            )
        return [*ring, (gate, centre - radius)]

    def bench(inner, outer, level, mat, label):
        for a, b, c, d in zip(inner, inner[1:], outer[1:], outer):
            m.surface(mat, [(x, level, z) for x, z in (a, b, c, d)], label)

    crown = contour(76)
    outer = contour(117)
    bench(crown, outer, 0, m.yard, dock)
    bench(crown, contour(81), 0.15, m.edge, stonework)
    for a, b in zip(outer, outer[1:]):
        m.wall(m.brick, a, b, sea - 15, 0, stonework, 0.8)
    for side in [-1, 1]:
        a = (gate, centre + side * 76)
        b = (gate, centre + side * 117)
        m.wall(m.brick, a, b, sea - 15, 0, stonework, 0.82)
        m.strip(m.edge, a, b, 3, 0.15, stonework)
    levels = [(76, 0), (68, -4), (61, -8), (54, -12), (47, -16), (39, -21)]
    for i, ((wide, top), (narrow, bottom)) in enumerate(zip(levels, levels[1:])):
        prev, nxt = contour(wide), contour(narrow)
        for a, b in zip(prev, prev[1:]):
            m.wall(m.brick, a, b, bottom, top, stonework, 0.73 + i * 0.025)
        bench(nxt, prev, bottom, m.stone, stonework)
        bench(nxt, contour(narrow + 1.5), bottom + 0.1, m.edge, stonework)
    floor = -21
    m.rect(m.yard, gate, centre - 39, head, centre + 39, floor, dock, 0.85)
    inner = contour(39)[1:-1]
    for a, b in zip(inner, inner[1:]):
        m.surface(
            m.yard,
            [(head, floor, centre), (a[0], floor, a[1]), (b[0], floor, b[1])],
            dock,
            0.85,
        )
    # The tidal plane is at -27. The pale bed sits six units clear of it.
    # Timber keel chairs and lateral drains show that the vessel has left.
    for j in range(13):
        x = gate + 32 + j * 23
        m.box(m.slate, x, centre, 10, 21, floor, floor + 2, equipment, 0.81)
        m.box(m.beam, x, centre, 8, 16, floor + 2, floor + 4.4, equipment)
    for side in (-1, 1):
        m.rect(
            m.black,
            gate + 4,
            centre + side * 32 - 1,
            head,
            centre + side * 32 + 1,
            floor + 0.12,
            equipment,
        )
        for x in (1190, 1260, 1340, 1420):
            m.box(m.beam, x, centre + side * 26, 5, 10, floor, floor + 2.6, equipment)
        # Winch drums, fender timber and bollards stand on the apron, outside the bed.
        for x in (1168, 1284, 1402, 1492):
            z = centre + side * 88
            m.shaft(m.iron, (x, -0.3, z), (x, 4.5, z), 2.9, 8, equipment)
            m.shaft(m.iron, (x, 4.5, z), (x, 5.7, z), 4.0, 8, equipment)
        x, z = gate + 7, centre + side * 99
        m.box(m.slate, x, z, 18, 15, 0, 2.3, equipment)
        m.shaft(m.iron, (x - 5, 5, z), (x + 5, 5, z), 3.8, 10, equipment)
        m.shaft(m.rail, (x - 5.4, 5, z), (x - 4.4, 5, z), 5.0, 10, equipment)
        m.shaft(m.rail, (x + 4.4, 5, z), (x + 5.4, 5, z), 5.0, 10, equipment)
    # A short, diagonal flight gives access to the side altars at every lift.
    for j in range(9):
        x = 1374 + j * 5
        z = centre + 72 - j * 4
        top = -1.1 - j * 2.25
        m.box(m.edge, x, z, 7, 12, floor - 0.25, top, stonework, 0.94)

    # The closed timber mitre gates brace against one another at the centre.
    # Their V and diagonal iron straps remain legible in the overhead view.
    for sign in (-1, 1):
        pivot = (gate - 1, centre + sign * 75)
        meet = (gate + 10, centre + sign * 0.7)
        dx, dz = meet[0] - pivot[0], meet[1] - pivot[1]
        length = math.hypot(dx, dz)
        vx, vz = -dz / length * 3.3, dx / length * 3.3
        leaf = [
            (pivot[0] + vx, pivot[1] + vz),
            (meet[0] + vx, meet[1] + vz),
            (meet[0] - vx, meet[1] - vz),
            (pivot[0] - vx, pivot[1] - vz),
        ]
        m.prism(m.beam, leaf, sea - 12, 1.7, equipment, 0.9)
        m.strip(m.iron, pivot, meet, 2.2, 2.05, equipment)
        for t in (0.12, 0.36, 0.6, 0.84):
            x, z = pivot[0] + t * dx, pivot[1] + t * dz
            m.strip(m.rail, (x - vx, z - vz), (x + vx, z + vz), 2.1, 2.15, equipment)
        m.shaft(
            m.iron, (pivot[0], -6, pivot[1]), (pivot[0], 4, pivot[1]), 3.8, 9, equipment
        )

    # A working pump house and low vent behind the closed head of the basin.
    px, pz = 1600, centre + 27
    m.box(m.slate, px, pz, 48, 74, 1.8, 5.2, equipment)
    m.box(m.brick, px, pz, 43, 68, 5.2, 22, equipment)
    for sign in (-1, 1):
        x = px + sign * 24
        m.surface(
            m.slate,
            [(x, 22, pz - 37), (x, 22, pz + 37), (px, 30, pz + 37), (px, 30, pz - 37)],
            equipment,
        )
    for z in (pz - 34, pz + 34):
        m.groups[equipment, m.brick].face(
            [(px - 21.5, 22, z), (px + 21.5, 22, z), (px, 30, z)],
            [(0, 0), (0.5, 0), (0.25, 0.12)],
        )
    for z in (pz - 20, pz, pz + 20):
        m.wall(m.black, (px - 21.6, z - 4), (px - 21.6, z + 4), 11, 18, equipment)
        m.box(m.edge, px - 21.9, z, 0.9, 9, 10.3, 11.2, equipment)
    m.shaft(m.brick, (px + 13, 3, pz - 30), (px + 13, 42, pz - 30), 4.5, 10, equipment)
    m.shaft(
        m.slate, (px + 13, 42, pz - 30), (px + 13, 43.7, pz - 30), 5.2, 10, equipment
    )

    def arm(points):
        """Continuous sloped rubble core, coping stones, and individual exposed toes."""
        frames = []
        for i, (x, z) in enumerate(points):
            a = points[max(0, i - 1)]
            b = points[min(i + 1, len(points) - 1)]
            dx, dz = b[0] - a[0], b[1] - a[1]
            length = math.hypot(dx, dz)
            frames.append((x, z, -dz / length, dx / length))
        profile = [
            (-31, sea - 5),
            (-23, sea + 4),
            (-13, -8),
            (-8, 1.2),
            (8, 1.2),
            (13, -9),
            (24, sea + 3),
            (31, sea - 5),
        ]
        for a, b in zip(frames, frames[1:]):
            x, z, nx, nz = a
            u, v, mx, mz = b
            for i, ((p, h), (q, k)) in enumerate(zip(profile, profile[1:])):
                mat = (m.shoal, m.slate, m.brick, m.stone, m.brick, m.slate, m.shoal)[i]
                m.surface(
                    mat,
                    [
                        (x + nx * p, h, z + nz * p),
                        (u + mx * p, h, v + mz * p),
                        (u + mx * q, k, v + mz * q),
                        (x + nx * q, k, z + nz * q),
                    ],
                    breakwater,
                    0.89,
                )
            dx, dz = u - x, v - z
            length = math.hypot(dx, dz)
            ux, uz = dx / length, dz / length
            count = math.ceil(length / 20)
            for i in range(count):
                t = (i + 0.5) / count
                cx, cz = x + t * dx, z + t * dz
                hx, hz = -uz, ux
                extent = length / count / 2 - 0.5
                slab = [
                    (cx + u0 * ux + v0 * hx, cz + u0 * uz + v0 * hz)
                    for u0, v0 in (
                        (-extent, -6),
                        (-extent, 6),
                        (extent, 6),
                        (extent, -6),
                    )
                ]
                m.prism(
                    m.edge,
                    slab,
                    1.12,
                    rng.uniform(1.5, 2.8),
                    breakwater,
                    rng.uniform(0.76, 1),
                )
                for side in (-1, 1):
                    # Each armour stone has its own ridgeline and tidal stain.
                    dist = rng.uniform(18, 31) * side
                    ax, az = cx + hx * dist, cz + hz * dist
                    height = rng.uniform(sea + 1, sea + 12)
                    self_angle = rng.uniform(0, math.tau)
                    base = []
                    top = []
                    for j in range(5):
                        phi = self_angle + j * math.tau / 5
                        radius = rng.uniform(7.5, 12.5)
                        sx, sz = math.cos(phi) * radius, math.sin(phi) * radius
                        base.append((ax + sx, sea - 6, az + sz))
                        top.append(
                            (
                                ax + sx * 0.63,
                                height + rng.uniform(-2, 1),
                                az + sz * 0.63,
                            )
                        )
                    for j in range(5):
                        k = (j + 1) % 5
                        m.surface(
                            m.slate,
                            [base[j], base[k], top[k], top[j]],
                            rocks,
                            rng.uniform(0.64, 0.9),
                        )
                    for j in range(1, 4):
                        m.surface(
                            m.wash,
                            [top[0], top[j], top[j + 1]],
                            rocks,
                            rng.uniform(0.63, 0.86),
                        )
        # Close both ends of the sloping core, including the visible entrance side.
        for x, z, nx, nz in (frames[0], frames[-1]):
            for (p, h), (q, k) in zip(profile[1:-2], profile[2:-1]):
                quad = [
                    (x + nx * p, sea - 5, z + nz * p),
                    (x + nx * p, h, z + nz * p),
                    (x + nx * q, k, z + nz * q),
                    (x + nx * q, sea - 5, z + nz * q),
                ]
                m.groups[breakwater, m.brick].face(
                    quad, [(0, 0), (0, 0.4), (0.3, 0.4), (0.3, 0)]
                )

    # Two offset arms shelter the entrance without enclosing the shipping lane.
    arm(
        [
            (1623, -959),
            (1524, -924),
            (1420, -910),
            (1301, -883),
            (1236, -837),
            (1198, -816),
        ]
    )
    arm([(1623, 697), (1546, 720), (1501, 762), (1388, 790), (1306, 780), (1248, 742)])
    # A low harbour daymark at the head of each arm, separate from gameplay towers.
    for x, z in ((1198, -816), (1248, 742)):
        m.shaft(m.edge, (x, 1, z), (x, 4.6, z), 6.9, 9, breakwater)
        m.shaft(m.iron, (x, 4.6, z), (x, 15, z), 2.6, 8, breakwater)
        m.shaft(m.paint, (x, 15, z), (x, 18.2, z), 3.1, 8, breakwater)
