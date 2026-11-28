"""The three tidal crossings, in the terrain builder's centred world coordinates."""

import math
import random


def make_crossings(m):
    for opening, build in zip(m.PLAN["bridges"], (cart_bridge, haul_bridge, trestle)):
        left = opening["left"] - m.HALF_WIDTH
        right = opening["right"] - m.HALF_WIDTH
        xs = range(math.floor(left), math.ceil(right) + 1)
        north = min(m.sample(m.P, x) for x in xs) - 3
        south = max(m.sample(m.Q, x) for x in xs) + 3
        for z in (north, south):
            m.box(m.brick, (left + right) / 2, z, right - left + 4, 10,
                  -39, -2, "Bridge abutments")
        build(m, left, right, north, south)


def face_swatch(ring, left, right, north, south, swatch):
    """Sample the interior of one dressed stone, leaving joints to the geometry."""
    return [((swatch % 4 + .08 + .84 * (x-left)/(right-left))/4,
             (swatch // 4 + .08 + .84 * (z-north)/(south-north))/4) for x,z in ring]


def cart_bridge(m, left, right, north, south):
    rng = random.Random(1856)
    span = south - north
    middle = (north + south) / 2
    # The opening and the vault soffit continue all the way between the two faces.
    def vault(angle, ring=0):
        return middle - (span / 2 + ring) * math.cos(angle), -35 + (27 + ring) * math.sin(angle)

    count = 23
    for i in range(count):
        a, b = i * math.pi / count, (i + 1) * math.pi / count
        z, y = vault(a)
        v, h = vault(b)
        m.groups["Cart bridge barrel", m.brick].face(
            [(left, y, z), (right, y, z), (right, h, v), (left, h, v)],
            [(left / 69, a / 1.2), (right / 69, a / 1.2),
             (right / 69, b / 1.2), (left / 69, b / 1.2)])
        for x, side in ((left, -1), (right, 1)):
            points = [(x, y, z), (x, h, v), (x, 0, v), (x, 0, z)]
            m.groups["Cart bridge barrel", m.brick].face(points, [(zz / 73, yy / 73) for _, yy, zz in points])
            # Each radial stone has its own worn arris. A deeper keystone anchors the crown.
            setback = rng.uniform(.65, 1.65) if i != count // 2 else 2.15
            depth = rng.uniform(4.4, 5.6) if i != count // 2 else 6.9
            stones = [vault(a + .006), vault(b - .006), vault(b - .006, depth), vault(a + .006, depth)]
            vertices = [(x + side * setback, yy, zz) for zz, yy in stones]
            shade = rng.uniform(.74, .97)
            m.groups["Limestone arch ring", m.edge].face(
                vertices, [(zz / 68, yy / 68) for _, yy, zz in vertices], [(shade,) * 3] * 4)
            for j in range(4):
                u, w = vertices[j], vertices[(j + 1) % 4]
                m.groups["Limestone arch ring", m.edge].face(
                    [u, w, (x, w[1], w[2]), (x, u[1], u[2])],
                    [(0, 0), (.09, 0), (.09, .025), (0, .025)], [(shade * .87,) * 3] * 4)

    # The sunken mortar bed is continuous under the stagger-bonded limestone flags.
    m.rect(m.slate, left, north, right, south, .08, "Cart bridge bed")
    z = north
    row = 0
    while z < south - .01:
        length = min(rng.uniform(6.8, 9.3), south - z)
        if south - z - length < 4:
            length = south - z
        x = left + 2
        while x < right - 2 - .01:
            width = rng.uniform(10, 19) if x > left + 2.01 or row % 2 == 0 else rng.uniform(6, 10)
            end = min(x + width, right - 2)
            if right - 2 - end < 5:
                end = right - 2
            chip = rng.uniform(.3, 1.5)
            h = rng.uniform(.40, .61)
            ring = [(x + .23, z + .26 + chip), (x + .23 + chip, z + .26),
                    (end - .22, z + .26), (end - .22, z + length - .27),
                    (x + .23, z + length - .27)]
            # The older, cooler setts from the cart street are mixed back into
            # the pale bridge flags by the masons at each landing.
            landing = max(0, 1 - min(z + length / 2 - north, south - z - length / 2) / 25)
            shade = rng.uniform(.67, .86)
            uv = face_swatch(ring, x, end, z, z+length, rng.randrange(16))
            base = (.93, .96, 1.) if row % 4 else (.98, .97, .96)
            tint = tuple(value * (1 + shift * landing) for value, shift in
                         zip(base, (-.08, -.02, .065)))
            m.surface(m.limestone, [(u, h, v) for u, v in ring], "Cart bridge flags", shade,
                      uv=uv, tint=tint)
            x = end
        z += length
        row += 1

    for x, side in ((left, -1), (right, 1)):
        z = north - 1
        while z < south + .99:
            end = min(z + rng.uniform(12, 21), south + 1)
            if south + 1 - end < 6:
                end = south + 1
            outer = x + side * rng.uniform(.9, 2.9)
            inner = x - side * rng.uniform(1.6, 2.9)
            ring = [(inner, z + .18), (outer - side, z + .18), (outer, z + 1.3),
                    (outer, end - 1.1), (outer - side * .9, end - .20), (inner, end - .20)]
            m.prism(m.limestone, ring, -.8, rng.uniform(1.2, 2), "Stone bridge coping", rng.uniform(.69, .85))
            z = end


def haul_bridge(m, left, right, north, south):
    cx, middle = (left + right) / 2, (north + south) / 2
    width, span = right - left, south - north
    bronze = m.material("Worn bronze bridge fasteners", None, (.48, .31, .135), .54, .46)
    m.box(m.iron, cx, middle, width, span, -3.6, -.42, "Haul bridge structure")
    for x in (left + 2, cx - 14, cx + 14, right - 2):
        m.box(m.iron, x, middle, 4.6, span, -15, -13, "Haul bridge structure")
        m.box(m.iron, x, middle, 1.5, span, -13, -3, "Haul bridge structure")
        m.box(m.iron, x, middle, 4.8, span, -4, -2, "Haul bridge structure")

    bays = 6
    for i in range(bays + 1):
        z = north + 2 + (span - 4) * i / bays
        m.box(m.iron, cx, z, width - 3, 2.1, -11, -3, "Haul bridge structure")
        for x in (left + .7, right - .7):
            m.box(m.iron, x, z, 2.6, 1.3, -13.2, -.4, "Haul bridge structure")
            if i != bays:
                m.shaft(m.iron, (x, -12.5, z + .6), (x, -3.5, z + (span - 4) / bays - .6),
                        .82, 7, "Haul bridge structure")

    # The same courses continue from the shore over the steel deck. Expansion
    # joints at the abutments and an inset access cover mark the change in support.
    for z0, z1 in ((north, 0), (0, south)):
        deck = [(left, z0), (left, z1), (right, z1), (right, z0)]
        m.surface(m.haulway, [(x, .44, z) for x, z in deck], "Floor haul bridge", .99,
                  uv=m.lowtide_pavement.haul_uv(m, deck))
    for z in (north + .7, south - .7):
        m.box(m.rail, cx, z, width - 3, 1.15, .43, .57, "Bridge expansion joints")

    for x in (left + 2, right - 2):
        m.box(m.iron, x, middle, 1.4, span - 1, -.9, .52, "Embedded haul rails")
        m.box(m.rail, x, middle, .78, span - 1, .52, .69, "Embedded haul rails")
    # A removable access plate covering a single repaired joint, riveted on four sides.
    x, z = left + 14, middle - span * .13
    cover = [(x - 7, z - 9), (x + 6, z - 9), (x + 8, z - 7),
             (x + 8, z + 8), (x - 7, z + 8)]
    m.prism(m.iron, cover, .46, .74, "Flush inspection covers", .88)
    for a, b in ((-5, -6.5), (5.5, -6.5), (5.5, 5.5), (-5, 5.5)):
        m.shaft(bronze, (x + a, .74, z + b), (x + a, .92, z + b), .70, 7, "Recessed fasteners")


def trestle(m, left, right, north, south):
    rng = random.Random(1933)
    cx, middle = (left + right) / 2, (north + south) / 2
    width, span = right - left, south - north
    # Short replacement lengths always butt on a real longitudinal bearer.
    bearers = (left + 6, cx - 22, cx, cx + 22, right - 6)
    for x in bearers:
        m.box(m.beam, x, middle, 5.4, span, -10.5, -2.2, "Trestle framework")

    tidal_wood = m.material("Tide-marked oak", "weathered_planks", (.42, .52, .42), .66,
                            0, .5, scale=76)
    for z in (north + 3, middle - 22, middle + 22, south - 3):
        m.box(m.beam, cx, z, width + 4, 5.5, -12, -7, "Trestle framework")
        for x in (left + 2, right - 2):
            tidemark = rng.uniform(-20, -16)
            m.shaft(tidal_wood, (x, -44, z), (x, tidemark, z), 3.2, 10, "Trestle piles")
            m.shaft(m.beam, (x, tidemark, z), (x, -.1, z), 3.2, 10, "Trestle piles")
            m.shaft(m.iron, (x, -10.2, z), (x, -8.4, z), 3.35, 10, "Trestle pile bands")
    for x in (left + 3, right - 3):
        for z in (middle - 22, middle + 22):
            m.shaft(m.beam, (x, -30, z - 19), (x, -9, z + 19), 1.7, 7, "Trestle braces")

    # Shallow dark bedding under the joints; the dry, 96-unit-wide route stays continuous.
    m.rect(m.beam, left, north, right, south, -.85, "Trestle bedding", .47)
    # Each hand-sawn board reaches across the travelling direction. Its two ends
    # weather independently. Both neighbouring rows share their slightly skew seam.
    seams = [(north, .0)]
    while seams[-1][0] < south:
        z = seams[-1][0]
        end = min(z + rng.uniform(5.7, 10.4), south)
        if south - end < 5.5:
            end = south
        fraction = (end - north) / span
        if .36 < fraction < .55:
            skew = 2.9   # an older batch was fixed to a skew edge beam
        elif .68 < fraction < .84:
            skew = -1.9
        else:
            skew = rng.uniform(-.6, .7)
        seams.append((end, 0 if end == south else skew))
    # Each address selects an uninterrupted, nail-free strip of the boarded atlas.
    old_boards = ((0,.849),(2,.594),(3,.432),(6,.161),(7,.802),
                  (8,.375),(10,.562),(11,.464),(14,.099),(15,.792))
    new_boards = ((4,.786),(5,.161),(9,.708),(13,.453))
    for i, ((z0, skew0), (z1, skew1)) in enumerate(zip(seams, seams[1:])):
        # Cut-to-length originals sit almost flush. One three-course replacement
        # is left long on the seaward side. A reused pair projects to port.
        batch = i - len(seams) // 2
        out_left, out_right = rng.uniform(.7, 2.4), rng.uniform(.8, 2.7)
        if batch in (-5, -4):
            out_left = 7.8 if batch == -5 else 5.6
        if batch in (-1, 0, 1):
            out_right = {-1: 6.2, 0: 8.0, 1: 7.2}[batch]
        if batch == 4:
            out_left = 6.9

        def front(x):
            return z0 + skew0 * (x - cx) / width + .17

        def back(x):
            return z1 + skew1 * (x - cx) / width - .17

        # A few joints have a patch cut to the next bearer. The sawn end and fresher
        # timber make these repairs visible at the normal orthographic camera size.
        splits = [left - out_left, right + out_right]
        if batch in (-1, 0, 1):
            splits.insert(1, cx - 22 if batch != 1 else cx)
        elif batch == -5:
            splits.insert(1, cx + 22)
        for part, (x0, x1) in enumerate(zip(splits, splits[1:])):
            x0 += .14 * (part > 0)
            x1 -= .14 * (part + 2 < len(splits))
            chip = rng.uniform(.3, 1.45)
            ring = [(x0, front(x0) + chip), (x0 + chip, front(x0 + chip)),
                    (x1 - chip * .65, front(x1 - chip * .65)), (x1, front(x1) + chip * .65),
                    (x1, back(x1)), (x0 + chip * .5, back(x0 + chip * .5)),
                    (x0, back(x0) - chip * .5)]
            h = rng.uniform(.46, .67)
            shade = rng.uniform(.96, 1.09)
            is_new = (batch in (-1, 0, 1) and part == 1) or (batch == -5 and part == 0)
            tint = (1., .96, .85) if is_new else (.93, .96, 1.)
            # Rain greys the top, while the sheltered board ends retain their tar.
            # Map each whole board onto a single strip, along the direction of its grain.
            swatch, offset = rng.choice(new_boards if is_new else old_boards)
            offset += rng.uniform(-.003, .003)
            uv = [((swatch % 4 + offset + (z-front(x))/(back(x)-front(x))*.052)/4,
                   (swatch // 4 + .065 + .87*(x-x0)/(x1-x0))/4) for x,z in ring]
            m.surface(m.oak, [(x, h, z) for x, z in ring], "Trestle wearing boards",
                      1.06 if is_new else shade, uv=uv, tint=tint)
            for a, b in zip(ring, ring[1:] + ring[:1]):
                m.wall(m.timber, a, b, -2.3, h, "Trestle wearing boards", .73)

            for x in (bearers[0], bearers[-1]):
                if x0 + 1.5 < x < x1 - 1.5:
                    z = (front(x) + back(x)) / 2
                    m.shaft(m.iron, (x, h, z), (x, h + .17, z), .61, 7, "Recessed fasteners")
            if len(splits) == 3:
                x = x1 - 1.4 if part == 0 else x0 + 1.4
                z = (front(x) + back(x)) / 2
                m.shaft(m.iron, (x, h, z), (x, h + .17, z), .61, 7, "Recessed fasteners")


    # Thresholds are let into the stone in short, staggered runs. The central
    # boards meet each bank flush instead of ending in a rail across the road.
    for side, z in ((-1, north), (1, south)):
        x = left + 2
        lengths = (7, 15, 9, 19, 8, 13) if side > 0 else (13, 8, 19, 9, 15, 7)
        for bay, runout in enumerate(lengths):
            end = right - 2 if bay == len(lengths) - 1 else x + rng.uniform(12, 18)
            depth = runout + rng.uniform(-.9, .9)
            far = z + side * depth
            ring = [(x + .15, z), (end - .2, z), (end - .2, far - side*.9),
                    (end - 1.30, far), (x + .15, far + side*.45)]
            uv = [((bay % 4 + .22 + .24*(u-x)/(end-x)) / 4,
                   ((bay+1) % 4 + .19 + .53*(v-z)/(side*depth)) / 4) for u, v in ring]
            m.surface(m.oak, [(u, .36, v) for u,v in ring], "Let-in oak thresholds",
                      .87 + .018*(bay%3), uv=uv)
            x = end
