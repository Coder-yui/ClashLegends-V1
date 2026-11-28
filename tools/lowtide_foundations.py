"""Permanent dock masonry around the native tower wells and the two lock-drive cradles."""

import math
import random


def make_foundations(m):
    limestone = m.material(
        "Dressed dock footing",
        m.materials[m.limestone][0],
        (1.0, 0.96, 0.82),
        0.91,
        normal_strength=0.48,
        scale=164,
    )
    granite = m.material(
        "Tidal granite sill",
        m.materials[m.limestone][0],
        (0.75, 0.81, 0.77),
        0.88,
        normal_strength=0.55,
        scale=127,
    )
    bronze = m.material("Salted bronze brackets", None, (0.30, 0.37, 0.27), 0.65, 0.32)
    brass = m.material("Burnished bolt lands", None, (0.57, 0.40, 0.18), 0.49, 0.37)

    # The outermost stonework lies almost flush. High solid corners sit in the
    # mesh-covered footprint; visually open approaches to a tower remain traversable.
    def fitted_block(ring, height, material, label, shade=0.98, bevel=0.60):
        cx = sum(x for x, _ in ring) / len(ring)
        cz = sum(z for _, z in ring) / len(ring)
        inner = []
        for x, z in ring:
            radius = math.hypot(x - cx, z - cz)
            scale = max(0.78, 1 - bevel / max(radius, 0.01))
            inner.append((cx + (x - cx) * scale, cz + (z - cz) * scale))
        shoulder = max(0.075, height - min(bevel, 0.55))
        for i, a in enumerate(ring):
            j = (i + 1) % len(ring)
            b = ring[j]
            m.wall(material, a, b, -0.2, shoulder, label, shade * 0.94)
            m.surface(
                material,
                [
                    (a[0], shoulder, a[1]),
                    (b[0], shoulder, b[1]),
                    (inner[j][0], height, inner[j][1]),
                    (inner[i][0], height, inner[i][1]),
                ],
                label,
                shade,
            )
        m.surface(material, [(x, height, z) for x, z in inner], label, shade)

    def oriented(cx, cz, theta, ring):
        co, si = math.cos(theta), math.sin(theta)
        return [(cx + u * co - v * si, cz + u * si + v * co) for u, v in ring]

    def polar(cx, cz, radius, theta):
        return cx + radius * math.cos(theta), cz + radius * math.sin(theta)

    def anchor_shoe(x, z, theta):
        # Short flanged iron knees are set into stone at the foot of each buttress.
        shoe = oriented(
            x, z, theta, [(44, -5), (61, -5), (64, -3.6), (64, 3.6), (61, 5), (44, 5)]
        )
        fitted_block(shoe, 3.0, bronze, "Tower anchor shoes", bevel=0.45)
        for tangent in (-3.0, 3.0):
            bx, bz = oriented(x, z, theta, [(60, tangent)])[0]
            m.shaft(brass, (bx, 3.0, bz), (bx, 4.2, bz), 1.15, 6, "Anchor bolts")

    def tower(x, z, team, index):
        # Twelve separately bedded wedge-shaped foot stones. Longer backing
        # pieces on the outer towers head toward the edge of the quay.
        to_back = (math.pi, team * math.pi / 2, 0)[index]
        stones = 12
        offset = 0.11 * team
        for i in range(stones):
            a = (i - 0.5) * math.tau / stones + offset
            b = a + math.tau / stones
            centre = (a + b) / 2
            back = max(0.0, math.cos(centre - to_back))
            outer = 62.2 + 5.0 * back
            # Native tower extends through the slightly raised inner sill.
            ring = [
                polar(x, z, r, k)
                for r, k in [
                    (39, a + 0.013),
                    (outer, a + 0.011),
                    (outer, b - 0.011),
                    (39, b - 0.013),
                ]
            ]
            fitted_block(
                ring,
                2.4 + 0.8 * back,
                limestone,
                "Tower cut stone",
                0.90 + 0.018 * ((i * 3) % 6),
            )
        for i in range(4):
            anchor_shoe(x, z, offset + i * math.pi / 2)
        # A compact rectangular inspection hatch is built into an apron of
        # staggered flagstones at the back, where the service crew approaches.
        # Leave a clear joint around the access plate rather than a painted ring.
        for u, v, du, dv in [
            (61, 0, 22, 20),
            (60, -16, 20, 10),
            (59, 16, 18, 10),
            (77, -4, 8, 21),
        ]:
            ring = oriented(
                x,
                z,
                to_back,
                [
                    (u - du / 2, v - dv / 2),
                    (u + du / 2, v - dv / 2),
                    (u + du / 2, v + dv / 2),
                    (u - du / 2, v + dv / 2),
                ],
            )
            fitted_block(ring, 0.65, granite, "Service apron", 0.91, bevel=0.35)
        hatch = oriented(x, z, to_back, [(55, -6), (68, -6), (68, 6), (55, 6)])
        fitted_block(hatch, 0.94, bronze, "Inspection covers", bevel=0.24)
        for d in (-2.5, 2.5):
            a, b = oriented(x, z, to_back, [(57, d), (66, d)])
            m.strip(m.black, a, b, 0.48, 1.01, "Recessed cover handles")

    def nexus(x, z, team):
        # Twelve low stone shoes follow the octagonal pattern of the native clutch.
        # The two forward bays are level with the surrounding muster court.
        back_angle = team * math.pi / 2
        for i in range(12):
            angle = math.tau * i / 12
            rear = max(0.0, math.cos(angle - back_angle))
            tangent = 13.5 if i % 3 else 15.0
            ring = oriented(
                x,
                z,
                angle,
                [
                    (48, -tangent + 1),
                    (61, -tangent),
                    (69.5 + rear * 4, -tangent + 2),
                    (71 + rear * 4, tangent - 2),
                    (61, tangent),
                    (48, tangent - 1),
                ],
            )
            fitted_block(
                ring, 1.2 + 2.1 * rear, limestone, "Drive holding stones", 0.96
            )
        # Two fixed spindle bearings and their removable bronze caps connect the
        # crystal's drive cradle to the old gate shaft. Broken cores leave these beds.
        for s in (-1, 1):
            bx, bz = x + s * 68, z + team * 9
            m.box(granite, bx, bz, 18, 21, 0.15, 3.25, "Gate bearing sleepers")
            m.box(bronze, bx, bz, 13.5, 13.5, 3.25, 5.4, "Gate bearing housing")
            m.shaft(
                bronze,
                (bx - 5, 5.1, bz),
                (bx + 5, 5.1, bz),
                4.0,
                12,
                "Gate bearing cap",
            )
            m.shaft(
                brass,
                (bx + s * 5, 5.1, bz),
                (bx + s * 6.4, 5.1, bz),
                3.15,
                12,
                "Gate shaft ends",
            )
            for dz in (-5.1, 5.1):
                for dx in (-4.8, 4.8):
                    m.shaft(
                        brass,
                        (bx + dx, 5.2, bz + dz),
                        (bx + dx, 6.15, bz + dz),
                        0.82,
                        6,
                        "Anchor bolts",
                    )
            m.box(
                granite,
                x + s * 78,
                z + team * 19,
                9.5,
                23,
                0.075,
                0.67,
                "Service apron",
                0.91,
            )
        # The footpath fans gently out behind each cradle. Preserve the flat apron
        # directly in front of the crystal where minions muster.
        for side in (-1, 1):
            theta = back_angle + side * 0.53
            for u, v, du, dv in [(66, 0, 16, 20), (81, -4, 14, 12), (82, 10, 15, 13)]:
                ring = oriented(
                    x,
                    z,
                    theta,
                    [
                        (u - du / 2, v - dv / 2),
                        (u + du / 2, v - dv / 2),
                        (u + du / 2, v + dv / 2),
                        (u - du / 2, v + dv / 2),
                    ],
                )
                fitted_block(ring, 0.64, granite, "Service apron", 0.95)

    def muster_apron(nx, nz, sx, sz):
        # Salvaged blocks in front of the lock spread from its stone shoes into
        # the three streets. Vary their lengths so the courses have no ring seam.
        rng = random.Random(1827)
        reach = math.hypot(sx - nx, sz - nz)
        dx, dz = (sx - nx) / reach, (sz - nz) / reach
        bearings = [-69, -55, -42, -30, -18, -6, 6, 18, 30, 42, 55, 69]

        def point(radius, angle):
            cross, along = radius * math.sin(angle), radius * math.cos(angle)
            return nx + dx * along - dz * cross, nz + dz * along + dx * cross

        for a, b in zip(bearings, bearings[1:]):
            left, right = math.radians(a + .15), math.radians(b - .15)
            end = reach + rng.uniform(37, 51) - 9 * abs(math.sin((left + right) / 2))
            r = reach - 22
            while r < end:
                next_r = min(r + rng.uniform(17, 29), end)
                if end - next_r < 9:
                    next_r = end
                ring = [point(r + .24, left), point(next_r - .24, left),
                        point(next_r - .24, right), point(r + .24, right)]
                swatch = rng.randrange(16)
                u, v = swatch % 4, swatch // 4
                uv = [((u + i) / 4, (v + j) / 4) for i, j in
                      ((.12, .12), (.12, .89), (.86, .89), (.86, .12))]
                m.surface(m.limestone, [(x, .23, z) for x, z in ring],
                          "Floor lock apron", rng.uniform(.65, .82), uv=uv,
                          tint=(.95, .98, 1.))
                r = next_r

    for side, team in [("red", -1), ("blue", 1)]:
        survey = m.PLAN["teams"][side]
        for i, (px, pz) in enumerate(survey["towers"]):
            tower(px - m.HALF_WIDTH, pz - m.HALF_DEPTH, team, i)
        px, pz = survey["nexus"]
        nexus(px - m.HALF_WIDTH, pz - m.HALF_DEPTH, team)
        sx, sz = survey["spawn"]
        muster_apron(px - m.HALF_WIDTH, pz - m.HALF_DEPTH,
                     sx - m.HALF_WIDTH, sz - m.HALF_DEPTH)
