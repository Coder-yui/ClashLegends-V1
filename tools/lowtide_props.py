"""Model the Low Tide Dock buildings, boats, lifting gear and quay fittings.

Run Blender in background mode with --python tools/lowtide_props.py.
The optional arguments after -- are --output FILE and --proof DIRECTORY.
Lengths in model construction are in the drawing's units. Placement converts
the authoritative map coordinates to the existing Three.js world convention.

The embedded, locally bundled photographic surfaces are derived from CC0
Poly Haven materials: weathered_planks (Dario Barresi and Dimitrios Savva),
weathered_peeling_timber (Dimitrios Savva), factory_brick (Rob Tuytel),
worn_corrugated_iron and rusty_metal_02. Original scan pages:
https://polyhaven.com/a/weathered_planks
https://polyhaven.com/a/weathered_peeling_timber
https://polyhaven.com/a/concrete_floor_02
https://polyhaven.com/a/factory_brick
https://polyhaven.com/a/worn_corrugated_iron
https://polyhaven.com/a/rusty_metal_02
"""
import argparse
import json
import math
from pathlib import Path
import random
import sys
import tempfile
from zipfile import ZipFile

import bpy
import numpy as np
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[1]
TAU = 2 * math.pi
rng = random.Random(568)
MATERIALS = {}


def material(key, color, roughness=.78, metal=0., scan=None, normal=.62, normal_scan=None):
    mat = bpy.data.materials.new(key)
    mat.use_nodes = True
    tree = mat.node_tree
    shader = tree.nodes.get('Principled BSDF')
    shader.inputs['Base Color'].default_value = (*color, 1.)
    shader.inputs['Metallic'].default_value = metal
    shader.inputs['Roughness'].default_value = roughness
    if scan:
        def texture(suffix, colour_space):
            image = bpy.data.images.load(str(TEMP / f'{normal_scan if suffix == "n" and normal_scan else scan}-{suffix}.jpg'), check_existing=True)
            image.colorspace_settings.name = colour_space
            node = tree.nodes.new('ShaderNodeTexImage')
            node.image = image
            return node
        tree.links.new(texture('c','sRGB').outputs['Color'], shader.inputs['Base Color'])
        bump = tree.nodes.new('ShaderNodeNormalMap')
        bump.inputs['Strength'].default_value = normal
        tree.links.new(texture('n','Non-Color').outputs['Color'], bump.inputs['Color'])
        tree.links.new(bump.outputs['Normal'], shader.inputs['Normal'])
    MATERIALS[key] = mat
    return key


def palette():
    # A planed face on a repair hull exposes honey oak beneath the greyed outer skin.
    # Keep the photographed grain and its knots in both finishes.
    scan = bpy.data.images.load(str(TEMP / 'timber-c.jpg'))
    pixels = np.empty(len(scan.pixels), dtype=np.float32)
    scan.pixels.foreach_get(pixels)
    rgb = pixels.reshape((-1, 4))[:, :3]
    rgb[:] = np.minimum(np.power(rgb, .95) * (1.49, 1.39, 1.32), 1.)
    scan.pixels.foreach_set(pixels)
    scan.filepath_raw = str(TEMP / 'planed-oak-c.jpg')
    scan.save()
    bpy.data.images.remove(scan)
    material('Oak',(.23,.16,.1),scan='timber')
    material('Planed repair oak',(.49,.33,.20),scan='planed-oak',normal=.54,normal_scan='timber')
    material('Old marine paint',(.2,.23,.19),scan='painted-wood',normal=.36)
    material('Salt-stained brick',(.32,.22,.16),scan='brick')
    material('Rolled zinc',(.30,.33,.31),.70,.30,'roof',.42)
    material('Dock green iron',(.15,.24,.2),.72,.27,'green-iron',.40,'roof')
    material('Oxide iron',(.37,.15,.08),.78,.22,'oxide-iron',.44,'roof')
    material('Warm glazed clerestory',(.20,.27,.25),.26,.32)
    material('Hull oil red',(.20,.053,.035),.74,.22)
    material('Wheelhouse enamel',(.50,.48,.35),.62,.22)
    material('Patinated steel',(.16,.22,.19),.68,.42,'painted-steel',.28)
    material('Tar',(.048,.058,.053),.76)
    material('Heartwood',(.29,.168,.085),.83)
    material('Weathered end grain',(.21,.175,.126),.77)
    material('Galvanized edges',(.39,.43,.41),.55,.61)
    material('Rust',(.236,.108,.052),.88,.18)
    material('Cast iron',(.098,.123,.111),.64,.65)
    material('Working cable',(.102,.119,.109),.43,.68)
    material('Dry hemp',(.38,.29,.166),.92)
    material('Quay concrete',(.33,.32,.266),.91,scan='concrete',normal=.35)
    material('Dirty glass',(.113,.177,.192),.25,.32)
    material('Putty',(.506,.46,.346),.87)


class Builder:
    def __init__(self):
        self.vertices, self.lookup, self.faces, self.options = [], {}, [], []

    def face(self, points, mat, uv=None, smooth=False):
        points=list(map(Vector,points))
        normal=(points[1]-points[0]).cross(points[2]-points[0])
        if normal.length < .000001:
            return
        if uv is None:
            axis=max(range(3),key=lambda a:abs(normal[a]))
            if axis==2:
                coord=[(v.x,v.y) for v in points]
            elif axis==0:
                coord=[(v.y,v.z) for v in points]
            else:
                coord=[(v.x,v.z) for v in points]
            size={'Salt-stained brick':16.5,'Rolled zinc':13.,'Patinated steel':19.}.get(mat,23.)
            uv=[(x/size,y/size) for x,y in coord]
        ids=[]
        for v in points:
            key=(round(v.x,5),round(-v.y,5),round(v.z,5))
            ix=self.lookup.get(key)
            if ix is None:
                ix=len(self.vertices);self.lookup[key]=ix;self.vertices.append(key)
            ids.append(ix)
        if len(set(ids))<3:
            return
        self.faces.append(list(reversed(ids)))
        self.options.append((mat,list(reversed(uv)),smooth))

    def prism(self, lower, upper, mat, cap=None):
        n=len(lower)
        self.face(reversed(lower),cap or mat)
        self.face(upper,cap or mat)
        for i in range(n):
            j=(i+1)%n
            self.face([lower[i],lower[j],upper[j],upper[i]],mat)

    def box(self, center, dims, mat, angle=0, cap=None):
        x,y,z=center;w,l,h=(a/2 for a in dims)
        a=math.radians(angle);c=math.cos(a);s=math.sin(a)
        lower=[(x+c*u-s*v,y+s*u+c*v,z-h) for u,v in [(-w,-l),(w,-l),(w,l),(-w,l)]]
        self.prism(lower,[(u,v,z+h) for u,v,_ in lower],mat,cap)

    def bar(self, start, end, width, depth, mat):
        a,b=map(Vector,(start,end));delta=b-a
        if delta.length<.0001:return
        axis=delta.normalized()
        side=axis.cross(Vector((0,0,1)))
        if side.length<.001:side=Vector((1,0,0))
        side.normalize()
        up=axis.cross(side).normalized()
        ring=[side*(s*width/2)+up*(h*depth/2) for s,h in ((-1,-1),(1,-1),(1,1),(-1,1))]
        p=[a+v for v in ring];q=[b+v for v in ring]
        self.face(p[::-1],mat);self.face(q,mat)
        for i in range(4):
            j=(i+1)%4
            offset=(.373 if i%2 else .138)+(start[0]*.011)%1.
            across=(p[i]-p[j]).length/17.
            along=delta.length/17.
            self.face([p[i],p[j],q[j],q[i]],mat,[(offset,0),(offset+across,0),(offset+across,along),(offset,along)])

    def rod(self, start, end, r, mat, n=10, r2=None, smooth=True):
        a,b=map(Vector,(start,end))
        axis=(b-a).normalized()
        side=axis.cross(Vector((0,0,1)))
        if side.length<.001:side=Vector((1,0,0))
        side.normalize()
        up=axis.cross(side).normalized()
        ring=[side*math.cos(i*TAU/n)+up*math.sin(i*TAU/n) for i in range(n)]
        low=[a+r*v for v in ring];high=[b+(r if r2 is None else r2)*v for v in ring]
        self.face(low[::-1],mat);self.face(high,mat)
        for i in range(n):
            j=(i+1)%n
            self.face([low[i],low[j],high[j],high[i]],mat,smooth=smooth)

    def cable(self, pts, radius, mat='Working cable', n=7):
        for a,b in zip(pts,pts[1:]):self.rod(a,b,radius,mat,n)

    def mesh(self,name):
        mesh=bpy.data.meshes.new(name)
        mesh.from_pydata(self.vertices,[],self.faces)
        matnames=list(dict.fromkeys(o[0] for o in self.options))
        for k in matnames:mesh.materials.append(MATERIALS[k])
        layer=mesh.uv_layers.new(name='Surface mapping')
        for poly,(mat,uv,smooth) in zip(mesh.polygons,self.options):
            poly.material_index=matnames.index(mat);poly.use_smooth=smooth
            for i,uvpair in zip(poly.loop_indices,uv):layer.data[i].uv=uvpair
        mesh.validate(clean_customdata=False)
        mesh.update()
        return mesh


def place(mesh,name,x,y,angle=0,h=0,scale=1):
    obj=bpy.data.objects.new(name,mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.location=(2*(x-400),-2*(y-568),2*h)
    obj.rotation_euler.z=-math.radians(angle)
    obj.scale=(2*scale,)*3
    return obj


def lerp(stations,x,column):
    for a,b in zip(stations,stations[1:]):
        if x<=b[0]:
            t=max(0,(x-a[0])/(b[0]-a[0]))
            return a[column]*(1-t)+b[column]*t
    return stations[-1][column]


def boat(repair=True):
    g=Builder()
    upper_wood = 'Planed repair oak' if repair else 'Oak'
    stations=[(-46,.75,3.8),(-44.5,5.5,2.8),(-41.8,9.1,1.9),(-37.4,11.8,1.1),
              (-30,13.6,.55),(-21,14.5,.18),(-9,15.0,0),(3,15.0,0),(13,14.4,.12),
              (23,12.6,.55),(31,10.1,1.0),(38.5,6.9,1.8),(44,3.35,2.8),(47,.17,4.)]
    def shell(x,t,side,inner=False):
        w=lerp(stations,x,1);sheer=lerp(stations,x,2)
        k=.12+ .88*math.sin(t*math.pi*.5)**.78
        width=max(.04,w*k-(.65 if inner else 0))
        return Vector((x,side*width,5.3+sheer*.33+(8.5+sheer*.67)*t+(.45 if inner else 0)))
    # Each bent strake has a modeled lap and an interior face; bow and stern
    # sections gain freeboard while the center carries the broad, shallow hold.
    xs=[r[0] for r in stations]
    for side in (-1,1):
        for k in range(7):
            lo,hi=k/7,(k+1)/7
            for i,(x,u) in enumerate(zip(xs,xs[1:])):
                q=[shell(x,lo,side),shell(u,lo,side),shell(u,hi,side),shell(x,hi,side)]
                mat='Tar' if k<=1 else ('Old marine paint' if k>=5 or not repair and k>=3 else 'Oak')
                uv=[((k*.127+v)*.86,x0/23+.11) for x0,v in [(x,0),(u,0),(u,.113),(x,.113)]]
                iq=[shell(x,lo,side,True),shell(u,lo,side,True),shell(u,hi,side,True),shell(x,hi,side,True)]
                g.face(q if side==-1 else q[::-1],mat,uv if side==-1 else uv[::-1],True)
                g.face(iq[::-1] if side==-1 else iq,upper_wood,uv[::-1] if side==-1 else uv,True)
                if k in (1,4,6):
                    p0,p1=q[3],q[2]
                    g.bar(p0,p1,.45 if k!=6 else 1.15,.33 if k!=6 else .60,'Tar' if k!=6 else 'Weathered end grain')
    # Keel, bilge ceiling and stern/bowpost.
    for a,b in zip(xs,xs[1:]):
        q=[shell(a,0,-1),shell(a,0,1),shell(b,0,1),shell(b,0,-1)]
        g.face(q,'Tar')
        g.bar((a,0,5.5+lerp(stations,a,2)*.34),(b,0,5.5+lerp(stations,b,2)*.34),2.5,1.6,'Oak')
        for sign in (-1,1):
            g.bar(shell(a,.43,sign,True),shell(b,.43,sign,True),.54,.58,'Oak')
    g.bar((-46,0,6.2),(-45.85,0,17.8),1.4,1.6,'Old marine paint')
    g.bar((44.2,0,5.9),(47.1,0,18.25),1.35,1.7,'Oak')
    for j,x in enumerate(range(-36,40,4)):
        for sign in (-1,1):
            heights=(.04,.17,.36,.61,.83,1.) if not (repair and j in (7,12) and sign==1) else (.04,.17,.36,.49)
            pts=[shell(x+.55*(1-t),t,sign,True) for t in heights]
            for a,b in zip(pts,pts[1:]):
                g.bar(a,b,.88,1.02,'Heartwood' if j%3 else 'Oak')
            if len(heights)==6:
                p=pts[-1];g.rod(p,p+Vector((0,0,.32)),.40,'Cast iron',8)
    def planking(x1,x2):
        for k in range(9):
            v0=-1+2*k/9;v1=-1+2*(k+1)/9-.009
            for a,b in zip(xs,xs[1:]):
                a=max(a,x1);b=min(b,x2)
                if a>=b:continue
                def deck(x,v):
                    return (x,v*max(.1,lerp(stations,x,1)-.82),13.85+lerp(stations,x,2)+.37*(1-v*v))
                g.face([deck(a,v0),deck(b,v0),deck(b,v1),deck(a,v1)],upper_wood,
                       [(k*.082,a/23), (k*.082,b/23),(k*.082+.075,b/23),(k*.082+.075,a/23)])
    planking(-45.5,-23.5)
    planking(28.5,46.8)
    if not repair:planking(-23.5,28.5)
    # Small raised hatch, barred cover and mooring horns on both end decks.
    g.box((-33,0,15.1),(8.4,6.5,.9),'Tar')
    g.box((-33,0,15.64),(7.9,5.9,.25),'Weathered end grain')
    for x in (-35.8,-34.5,-33.2,-31.9,-30.6):
        g.bar((x,-2.55,15.83),(x,2.55,15.83),.51,.35,'Cast iron')
    for x,z in ((-40,16.4),(36,15.3)):
        for y in (-3.5,3.5):
            g.rod((x,y,z),(x,y,z+1.3),.55,'Cast iron')
            g.bar((x-1.25,y,z+1.38),(x+1.25,y,z+1.38),.55,.52,'Cast iron')
    if repair:
        # Loose limber boards sit down inside the hold. Gaps expose the keelson
        # and leave the darker curved frames readable from the battle camera.
        for i, offset in enumerate((-4.7, -2.35, 0., 2.35, 4.7)):
            a = -25 + (i % 3) * 1.25
            b = 28 - ((i + 1) % 3) * 1.1
            g.bar((a,offset,8.18),(b,offset,8.23),2.12,.36,upper_wood)
        # The shoring follows the four spur tips of the authoritative footprint.
        for x,slope in ((-24,-.14),(15.6,.14)):
            g.bar((x,-18,1.8),(x,18,1.8),3.6,3.2,'Oak')
            for sign in (-1,1):
                g.bar((x,sign*15.3,2.8),(x+slope,sign*10.5,10.25),2.05,2.18,'Oak')
                g.bar((x,sign*12.4,3.0),(x,sign*1.8,6.0),1.0,1.3,'Weathered end grain')
            g.box((x,0,4.1),(4.6,5.8,2.0),'Oak')
        for x in (-7,29):
            g.box((x,0,1.45),(4.6,9.,2.9),'Oak')
            g.box((x,0,3.7),(7.,4.1,1.7),'Oak')
        # A replaced thwart and a pair of loose planks across two surviving frames.
        g.bar((-14,-12.,13.1),(-14,12.,13.1),2.7,.78,'Oak')
        g.bar((6.6,-6.2,11.95),(24.5,-5.45,12.50),1.8,.38,'Weathered end grain')
    return g


def hoist():
    g=Builder()
    # Elliptical beveled stone plinth and separately bolted after bed.
    foot=[(-22.4,-2),(-14,-5),(-10.7,-8.1),(-7.5,-12.4),(-2.3,-15.1),(3.5,-15.8),
          (9.7,-14.7),(15.2,-11.3),(18.7,-6.3),(20,0),(18.7,6.2),(15.4,11.5),
          (9.8,14.9),(3.9,15.8),(-2.8,15.1),(-7.2,13.),(-17.2,14.9),(-19.5,12.2),(-22.9,2)]
    perimeter=[(x,y,1.99) for x,y in foot]
    g.prism([(x,y,.10) for x,y in foot],perimeter,'Quay concrete')
    # The pale broken arris is modeled, so the cap catches light on each side.
    inset=[(x*.986,y*.984,2.19) for x,y in foot]
    for i in range(len(foot)):
        j=(i+1)%len(foot)
        g.face([perimeter[i],perimeter[j],inset[j],inset[i]],'Quay concrete')
    g.face(inset,'Quay concrete')
    g.box((-15.9,3,2.6),(7.0,9.2,.73),'Cast iron')
    for x in (-18.5,-13.4):
        for y in (-.35,6.35):
            g.rod((x,y,2.92),(x,y,3.52),.53,'Rust',6,smooth=False)
    for z1,z2,r1,r2,mat in ((2.15,3.05,13.9,13.4,'Cast iron'),
                            (3.05,5.6,12.7,11.9,'Patinated steel'),
                            (5.6,6.2,12.8,12.8,'Cast iron'),(6.2,7.3,12.1,12.,'Rust'),
                            (7.3,8.5,12.5,12.3,'Patinated steel')):
        g.rod((3,0,z1),(3,0,z2),r1,mat,44,r2)
    for i in range(24):
        t=TAU*i/24;x=3+12.63*math.cos(t);y=12.63*math.sin(t)
        g.rod((x,y,2.7),(x,y,3.35),.41,'Galvanized edges',6,smooth=False)
        if i%2==0:
            x=3+12.1*math.cos(t);y=12.1*math.sin(t)
            g.rod((x,y,6.23),(x,y,7.1),.65,'Cast iron',10)
    # Open machinery deck, timber floorboards, tapered counterweight and cab.
    g.box((-2.4,0,8.9),(28.5,19.6,1.03),'Patinated steel')
    g.box((-6.1,0,9.69),(18.3,18.7,.54),'Oak')
    g.box((-13.9,-4.8,12.7),(6.7,7.3,5.8),'Cast iron')
    for z in (10.8,12.25,13.7,15.0):
        g.box((-13.95,-4.8,z),(6.95,7.6,.48),'Patinated steel')
    g.box((-5.4,-6.8,13.8),(8.5,5.8,8.1),'Patinated steel')
    g.box((-5.4,-6.8,18.),(9.05,6.5,.65),'Rolled zinc')
    for x in (-7.6,-3.2):
        g.box((x,-9.76,14.9),(3.5,.14,3.35),'Dirty glass')
        g.bar((x,-9.87,13.25),(x,-9.87,16.55),.18,.20,'Galvanized edges')
    for y in (-8.,-5.4):
        g.box((-1.09,y,15.0),(.14,2.,3.4),'Dirty glass')
    g.box((-5.55,-3.83,13.8),(3.5,.15,6.8),'Old marine paint')
    # Drum, outboard gear and helix of cable. All are visible from above.
    for y in (1.2,9):
        g.box((-8.3,y,12.15),(6.7,1.0,4.4),'Patinated steel')
    g.rod((-8.1,.05,13.7),(-8.1,10.0,13.7),.76,'Cast iron',12)
    g.rod((-8.1,1.55,13.7),(-8.1,8.45,13.7),2.43,'Cast iron',20)
    for y in (1.75,8.15,9.1):
        g.rod((-8.1,y,13.7),(-8.1,y+.38,13.7),3.18,'Patinated steel',24)
    turns=9
    pts=[]
    for i in range(turns*11+1):
        t=i/(turns*11);theta=t*turns*TAU
        pts.append((-8.1+2.46*math.cos(theta),2.23+5.9*t,13.7+2.46*math.sin(theta)))
    g.cable(pts,.20)
    # Four chords and alternating diagonal lacing make an open tapered box jib.
    def section(t):
        x=3+60*t;y=3.13*(1-t)+.72*t
        z=15.0+22.3*t
        return [(x,-y,z),(x,y,z),(x,y,z+4.7-2.85*t),(x,-y,z+4.7-2.85*t)]
    rings=[section(i/9) for i in range(10)]
    for k in range(4):
        g.bar(rings[0][k],rings[-1][k],.72,.67,'Patinated steel')
    for idx,points in enumerate(rings):
        for k in range(4):g.bar(points[k],points[(k+1)%4],.40,.48,'Patinated steel')
        if idx+1<len(rings):
            nxt=rings[idx+1]
            for k in range(4):
                a,b=(points[k],nxt[(k+1)%4]) if idx%2==0 else (nxt[k],points[(k+1)%4])
                g.bar(a,b,.42,.49,'Patinated steel')
    for y in (-4.3,4.3):
        g.bar((-7.6,y,10.4),(0.3,y*.67,32.2),1.05,.95,'Patinated steel')
        g.bar((6,y,10.2),(.3,y*.67,32.2),1.15,.98,'Patinated steel')
        g.bar((-4.2,y*.89,19.6),(3.8,y*.82,20.1),.59,.55,'Patinated steel')
        g.cable([(.3,y*.67,31.7),(30,y*.47,34.9),(62.9,y*.16,38.9)],.265)
    g.bar((.2,-3.,32.15),(.2,3.,32.15),1.1,1.1,'Patinated steel')
    for x,y,z,r in ((.1,0,32.2,1.7),(62.6,0,38.25,1.1),(63.35,0,22.7,1.)):
        g.rod((x,y-.65,z),(x,y+.65,z),r,'Cast iron',16)
        g.rod((x,y-.71,z),(x,y-.48,z),r*1.1,'Rust',16)
    g.cable([(-8.1,5.2,16.2),(.2,1.0,33.8),(31,.7,36),(62.9,.5,39.35),(64.1,.5,22.4)],.20)
    g.cable([(62.,-.48,38.),(62.1,-.5,22.6)],.21)
    g.rod((63.1,0,21.6),(63.1,0,20),.59,'Cast iron')
    g.cable([(63.1,0,20.3),(63.8,0,19.5),(64.1,0,18.5),(63.55,0,17.8),
             (62.7,0,17.7),(61.9,0,18.5),(61.85,0,19.25)],.36,'Cast iron',9)
    # A ladder to service the drum remains inside the base footprint.
    for y in (3.3,5.9):g.bar((-15.3,y,2.4),(-13.6,y,10.7),.28,.28,'Galvanized edges')
    for k in range(5):
        t=k/5;g.rod((-15.15+1.52*t,3.3,3.1+7.2*t),(-15.15+1.52*t,5.9,3.1+7.2*t),.18,'Cast iron')
    return g


def warehouse(w,l,eave,variation=0,detail=True):
    g=Builder();brick='Salt-stained brick'
    g.box((0,0,1.25),(w+1.2,l+1.3,2.5),'Quay concrete')
    g.box((0,0,(eave+2.4)/2),(w,l,eave-2.4),brick)
    ridge=eave+w*(.26 if variation%3==0 else .32)
    for y,sgn in ((-l/2,-1),(l/2,1)):
        pts=[(-w/2,y,eave),(w/2,y,eave),(0,y,ridge)]
        g.face(pts if sgn<0 else pts[::-1],brick,[(0,eave/16.5),(w/16.5,eave/16.5),(w/33,ridge/16.5)] if sgn<0 else [(w/33,ridge/16.5),(w/16.5,eave/16.5),(0,eave/16.5)])
    # Overhanging folded zinc sheets. Thick fascia and ridge cap give the
    # corrugations a real silhouette at the eaves and protect the masonry.
    for s in (-1,1):
        xe=s*(w/2+1.5);zlow=eave-.45
        low=[(xe,-l/2-1.5,zlow),(xe,l/2+1.5,zlow)]
        high=[(0,-l/2-1.5,ridge),(0,l/2+1.5,ridge)]
        q=[low[0],high[0],high[1],low[1]]
        u=[(0,0),(0,w*.56/14),((l+3)/14,w*.56/14),((l+3)/14,0)]
        g.face(q if s<0 else q[::-1],'Rolled zinc',u if s<0 else u[::-1])
        g.bar(low[0],low[1],.7,1.33,'Weathered end grain')
        for end in (0,1):
            g.bar(low[end],high[end],.9,1.0,'Galvanized edges')
        for qy in range(-int(l/2),int(l/2)+1,10):
            g.bar((xe,qy,zlow+.1),(0,qy,ridge+.12),.24,.18,'Galvanized edges')
            g.rod((xe-s*.25,qy,zlow-1.),(xe+s*.85,qy,zlow-.6),.27,'Rust',7)
        # Rain gutter and a downpipe with a double elbow and wall straps.
        g.rod((xe+s*.4,-l/2-1.3,zlow-.64),(xe+s*.4,l/2+1.3,zlow-.64),.48,'Patinated steel',10)
        for end in (-1,1):
            yy=end*(l/2-2.4);xc=s*(w/2+.45)
            g.cable([(xe+s*.4,yy,zlow-.5),(xe+s*.4,yy,zlow-2.1),(xc,yy,zlow-3.5),(xc,yy,2.5),
                     (xc+s*.85,yy,1.5)],.36,'Patinated steel')
    g.rod((0,-l/2-1.7,ridge+.1),(0,l/2+1.7,ridge+.1),.59,'Galvanized edges',12)
    for x in (-w/2,w/2):
        for yy in (-l/2+.8,l/2-.8):
            g.box((x,yy,eave*.5),(1.55,1.9,eave-.70),brick)
    # The doors and tall multi-light windows face the loading street.
    def bay(sign,y,wide,door):
        x=sign*(w/2+.13);bottom=2.65 if door else eave*.41
        top=eave-(1.8 if door else 3.5)
        z=(bottom+top)/2
        g.box((x,y,z),(.39,wide+1.6,top-bottom+1.2),'Tar')
        g.box((x+sign*.25,y,z),(.14,wide,top-bottom),'Old marine paint' if door else 'Dirty glass')
        for dx in (-1,1):
            g.box((x+sign*.46,y+dx*(wide/2+.45),z),(.75,.82,top-bottom+1.6),'Weathered end grain' if door else 'Putty')
        g.box((x+sign*.43,y,top+.5),(.95,wide+2.5,.94),'Quay concrete')
        g.box((x+sign*.50,y,bottom-.35),(1.25,wide+1.4,.67),'Quay concrete')
        if door:
            g.bar((x+sign*.49,y,bottom),(x+sign*.49,y,top),.46,.47,'Tar')
            g.bar((x+sign*.60,y-wide*.47,bottom+.9),(x+sign*.60,y-.28,top-1.),.49,.52,'Oak')
            g.bar((x+sign*.60,y+wide*.47,bottom+.9),(x+sign*.60,y+.28,top-1.),.49,.52,'Oak')
            for yy in (-wide*.43,wide*.43):
                for zz in (bottom+2,top-2):
                    g.box((x+sign*.62,y+yy,zz),(.18,2.3,.38),'Cast iron')
        else:
            for yy in (-wide*.24,0,wide*.24):
                g.bar((x+sign*.40,y+yy,bottom),(x+sign*.4,y+yy,top),.24,.31,'Patinated steel')
            for zz in (bottom+(top-bottom)*.42,bottom+(top-bottom)*.77):
                g.bar((x+sign*.4,y-wide/2,zz),(x+sign*.40,y+wide/2,zz),.28,.3,'Patinated steel')
    bay(1,0,min(l*.27,14),True)
    if detail:
        for yy in (-l*.32,l*.32):bay(1,yy,min(l*.15,9),False)
        for yy in (-l*.27,l*.27):bay(-1,yy,min(l*.21,12),variation%2==1)
    if detail and variation in (1,2):
        # The loading canopy has two wall brackets and clear space beneath
        # its outer edge. The projecting roof remains outside the battle area.
        x=w/2;out=x+5.35;top=eave-.92;half=min(l*.185,10.)
        canopy=[(x,-half,top),(out,-half,top-1.15),(out,half,top-1.15),(x,half,top)]
        g.face(canopy,'Rolled zinc',[(0,0),(0,.44),(1.7,.44),(1.7,0)])
        g.bar((out,-half,top-1.32),(out,half,top-1.32),.56,.56,'Patinated steel')
        for y in (-half+.8,half-.8):
            g.bar((x+.19,y,top-4.2),(out-.65,y,top-1.4),.41,.42,'Patinated steel')
    if variation%3!=1:
        # Low north-light on one roof pitch, seated on a flashed curb.
        x=w*.20;y=-l*.17;half=l*.14
        def roof_z(xx):
            return ridge - (ridge-eave+.45)*xx/(w/2+1.5)
        def window_points(delta):
            return [(xx,yy,roof_z(xx)+delta) for xx,yy in ((x-2.8,y-half),(x+2.8,y-half),(x+2.8,y+half),(x-2.8,y+half))]
        g.prism(window_points(-.18),window_points(.96),'Patinated steel')
        g.face(window_points(1.01),'Dirty glass')
        for f in (-.98,-.50,0,.5,.98):
            yy=y+half*f
            g.bar((x-2.8,yy,roof_z(x-2.8)+1.13),(x+2.8,yy,roof_z(x+2.8)+1.13),.22,.27,'Galvanized edges')
        for xx in (x-2.8,x+2.8):
            g.bar((xx,y-half,roof_z(xx)+1.1),(xx,y+half,roof_z(xx)+1.1),.30,.30,'Galvanized edges')
    if variation%2==0:
        x=-w*.25;y=l*.29;z=(eave+ridge)*.5
        g.box((x,y,z+2.0),(4.2,4.9,6.8),brick)
        g.box((x,y,z+5.0),(4.8,5.4,.78),'Quay concrete')
        for off in (-1.1,1.0):
            g.rod((x,y+off,z+5.2),(x,y+off,z+7.4),.74,'Rust',10)
    return g


def moored_boat():
    g=boat(False)
    # White-painted wheelhouse with a curved wooden visor, inset lights and
    # a pitched wheelhouse roof. It is a working harbour vessel under mooring.
    g.box((-23,0,17.5),(14,13.5,7.4),'Old marine paint')
    g.box((-22.8,0,22.65),(13.8,12.7,3.6),'Old marine paint')
    for s in (-1,1):
        for x in (-27.2,-23.1,-19.0):
            g.box((x,6.42*s,22.85),(3.2,.22,2.65),'Dirty glass')
        for y in (-4.45,0,4.45):
            g.box((-15.87,y,22.85),(.18,3.7,2.65),'Dirty glass')
        g.bar((-29.8,6.55*s,20.98),(-15.7,6.55*s,20.98),.4,.4,'Heartwood')
        g.bar((-30.7,7.55*s,24.75),(-14.8,7.55*s,24.75),.55,.58,'Weathered end grain')
    g.box((-22.85,0,24.74),(15.9,15.1,.80),'Rolled zinc')
    g.rod((-26,0,25.1),(-26,0,29.4),1.0,'Tar',18)
    g.rod((-26,0,28.7),(-26,0,29.7),1.15,'Rust',18)
    g.box((3.0,0,15.40),(20.8,14.1,2.0),'Old marine paint')
    g.box((3.0,0,16.7),(21.7,14.7,.66),'Oak')
    for x in (-5.5,0,6,11.5):g.bar((x,-7.5,16.1),(x,7.5,16.1),.38,.32,'Cast iron')
    g.rod((19,0,15),(19,0,33.4),.74,'Oak',12,.49)
    g.bar((19.15,.2,17.6),(32.1,0,26.4),.68,.83,'Oak')
    for y in (-8,8):g.cable([(19,0,32.5),(22.,y,14.85)],.16,'Dry hemp')
    g.cable([(19,0,32.15),(32.2,0,26.7),(32.3,0,21.15)],.15,'Working cable')
    for x in (-37,-10,16,34):
        for sign in (-1,1):
            w=lerp([(-37,11.8),(-10,15.),(16,14.),(34,8.6)],x,1)
            g.rod((x,sign*w,14.6),(x,sign*(w-.4),17.0),.25,'Cast iron',8)
    return g


def bollard(g,x,y,z=0):
    g.rod((x,y,z+.16),(x,y,z+.62),1.45,'Cast iron',12)
    g.rod((x,y,z+.55),(x,y,z+2.62),.82,'Cast iron',12,.72)
    g.rod((x,y,z+2.62),(x,y,z+3.1),1.13,'Rust',12)


def crate(g,x,y,w,l,h,z=0):
    g.box((x,y,z+h/2),(w,l,h),'Oak')
    for s in (-1,1):
        for sign in (-1,1):
            g.bar((x+s*(w/2-.26),y+sign*(l/2-.24),z),(x+s*(w/2-.26),y+sign*(l/2-.24),z+h+.15),.69,.72,'Heartwood')
        for v in (0.45,h-.45):
            g.bar((x+s*(w/2+.12),y-l/2,z+v),(x+s*(w/2+.12),y+l/2,z+v),.54,.82,'Heartwood')
        g.bar((x-w*.46,y+s*(l*.5+.13),z+.66),(x+w*.46,y+s*(l*.5+.13),z+h-.7),.75,.75,'Weathered end grain')
    for off in (-w*.27,w*.27):
        g.bar((x+off,y-l*.5,z+h+.23),(x+off,y+l*.5,z+h+.23),.46,.33,'Cast iron')


def barrel(g,x,y,z=0):
    rows=[(0,1.87),(.54,1.96),(2.9,2.27),(4.7,2.23),(6.5,1.94),(6.86,1.84)]
    for (z0,r0),(z1,r1) in zip(rows,rows[1:]):
        g.rod((x,y,z+z0),(x,y,z+z1),r0,'Oak',14,r1)
    for dz,r in ((.76,2.025),(2.15,2.24),(4.9,2.24),(6.15,2.025)):
        g.rod((x,y,z+dz),(x,y,z+dz+.29),r,'Cast iron',14)


def assembly_shop(w,l,green):
    """North-light boiler assembly or a warm curved-roof hull shop."""
    g=Builder();eave=26.0 if green else 22.5
    roof='Dock green iron' if green else 'Oxide iron'
    half=w/2;end=l/2
    g.box((0,0,.57),(w+2.8,l+2.8,1.14),'Quay concrete')
    # The overhead hall has real open doors on two faces and a recessed floor.
    g.box((0,0,1.1),(w-1,l-1,.20),'Tar')
    for sx in (-1,1):
        xx=sx*half
        for lo,hi in ((-end,-18),(19,end)) if sx==1 else ((-end,end),):
            g.box((xx,(lo+hi)/2,eave/2+1.0),(1.8,hi-lo,eave-2.0),'Salt-stained brick')
        if sx==1:
            g.box((xx,.5,eave-2.5),(2.1,37,5.0),'Salt-stained brick')
            g.bar((xx+.75,-20,eave-5.2),(xx+.75,21,eave-5.2),1.08,.94,'Cast iron')
            for yy,sgn in ((-17,-1),(18,1)):
                g.box((xx+1.15,yy+sgn*5.4,10.9),(1.1,11.0,19.9),roof)
                g.bar((xx+1.76,yy,1.15),(xx+1.76,yy+sgn*10.6,20.6),.65,.70,'Patinated steel')
        # A full-height brick pier and a bank of narrow metal sash lights
        # articulate the bays as a single building across a wide frontage.
        for i in range(7):
            yy=-end+(i+.5)*l/7
            if sx>0 and abs(yy)<26:continue
            top=eave-2.;bot=eave-11.0;wid=l/7-3.7
            g.box((xx+sx*.96,yy,(top+bot)/2),(.48,wid,top-bot),'Tar')
            g.box((xx+sx*1.24,yy,(top+bot)/2),(.08,wid-.65,top-bot-.7),'Warm glazed clerestory')
            for f in (-.3,-.10,.1,.3):
                g.bar((xx+sx*1.37,yy+wid*f,bot),(xx+sx*1.37,yy+wid*f,top),.26,.36,'Cast iron')
            g.bar((xx+sx*1.37,yy-wid/2,bot+4.),(xx+sx*1.37,yy+wid/2,bot+4.),.34,.34,'Cast iron')
            g.box((xx+sx*.40,yy+wid/2+1.5,eave/2),(2.15,2.27,eave),'Salt-stained brick')
        g.rod((xx+sx*1.1,-end,eave+.28),(xx+sx*1.1,end,eave+.28),.49,'Patinated steel')
        for yy in (-end+2,end-2):
            g.cable([(xx+sx*1.15,yy,eave+.3),(xx+sx*1.15,yy,eave-2.5),
                     (xx+sx*.92,yy,eave-3.2),(xx+sx*.92,yy,1.2)],.39,'Patinated steel')
    # North wall is solid. South wall is a broad, partly open ship door with
    # two sliding leaves, a dark interior and a steel lintel across the span.
    g.box((0,-end,eave*.5),(w,1.9,eave),'Salt-stained brick')
    gap=w*.53
    for side in (-1,1):
        g.box((side*(half+gap/2)/2,end,eave*.5),((w-gap)/2,1.9,eave),'Salt-stained brick')
        g.box((side*gap*.43,end+.95,eave*.44),(gap*.26,.95,eave*.88),roof)
        g.bar((side*gap*.32,end+1.53,1),(side*gap*.53,end+1.53,eave*.85),.78,.72,'Cast iron')
    g.bar((-half-.7,end+.82,eave-.9),(half+.7,end+.82,eave-.9),1.5,1.65,'Patinated steel')
    for xx in (-half+1.3,half-1.3):
        g.bar((xx,end,0.9),(xx,end,eave+1),1.8,1.8,'Patinated steel')
    if green:
        # The vertical glass bank faces north. From either overhead orientation
        # the alternating glass and corrugated slope remain visible.
        count=4;rise=13.4
        for i in range(count):
            y0=-end+i*l/count;y1=y0+l/count;crest=y0+4.7
            for xx in (-half-.9,half+.9):
                tri=[(xx,y0,eave),(xx,crest,eave+rise),(xx,y1,eave)]
                g.face(tri if xx>0 else tri[::-1],roof)
            g.face([(-half-1.0,crest,eave+rise),(half+1.0,crest,eave+rise),(half+1.0,y1,eave),(-half-1.0,y1,eave)],
                   roof,[(0,0),(w/19,0),(w/19,l/count/17),(0,l/count/17)])
            g.face([(-half,y0,eave),(half,y0,eave),(half,crest,eave+rise),(-half,crest,eave+rise)],'Warm glazed clerestory')
            for k in range(11):
                x=-half+w*k/10
                g.bar((x,y0,eave+.2),(x,crest,eave+rise+.1),.52,.6,'Cast iron')
                if k%2==0:g.bar((x,crest,eave+rise+.07),(x,y1,eave+.1),.34,.30,'Patinated steel')
            for f in (.14,.51,.94):
                g.bar((-half,y0+(crest-y0)*f,eave+rise*f),(half,y0+(crest-y0)*f,eave+rise*f),.73,.50,'Patinated steel')
            g.rod((-half-1.25,crest,eave+rise+.12),(half+1.25,crest,eave+rise+.12),.61,'Galvanized edges',10)
        # Exhaust cowls and axial ventilators on the workshop pitches.
        for x,y in ((-half*.40,-end+l*.16),(-half*.40,-end+l*.66)):
            t=((y+end)%(l/4)-4.7)/(l/4-4.7);z=eave+rise*(1-t)
            g.rod((x,y,z-.3),(x,y,z+3),2.,'Patinated steel',14)
            g.rod((x,y,z+2.9),(x,y,z+4.6),3.0,'Dock green iron',14,.5)
    else:
        # Pressed-steel barrel roof over a timber and riveted-steel span.
        def profile(t):return (-half-1.1+(w+2.2)*t,eave+17.8*math.sin(math.pi*t)**.83)
        arcs=[profile(i/16) for i in range(17)]
        for (x,z),(u,h) in zip(arcs,arcs[1:]):
            g.face([(x,-end-1,z),(u,-end-1,h),(u,end+1,h),(x,end+1,z)],roof,
                   [(0,x/17),(0,u/17),(l/16,u/17),(l/16,x/17)])
            for yy in (-end-1,end+1):
                g.bar((x,yy,z-.30),(u,yy,h-.30),.98,.98,'Galvanized edges')
        for yy in (-end,-end/2,0,end/2,end):
            for (x,z),(u,h) in zip(arcs,arcs[1:]):
                g.bar((x,yy,z+.05),(u,yy,h+.05),.42,.46,'Rust')
        for yy in (-end,end):
            n=10
            for i in range(n):
                a=i/n;b=(i+1)/n;x,z=profile(a);u,h=profile(b)
                if i in (0,n-1):
                    g.face([(x,yy,eave-.1),(u,yy,eave-.1),(u,yy,h),(x,yy,z)],'Oxide iron')
                else:
                    g.face([(x,yy,eave+.15),(u,yy,eave+.15),(u,yy,h-.42),(x,yy,z-.42)],'Warm glazed clerestory')
                    g.bar((x,yy,eave+.1),(x,yy,z-.40),.73,.64,'Cast iron')
            g.bar((-half,yy,eave+1.2),(half,yy,eave+1.2),.95,.98,'Cast iron')
        # Duct, saddles and bolted curved cowls, set longitudinally on roof.
        for yy in (-end*.68,-end*.35,end*.32,end*.66):
            g.rod((0,yy,eave+17.2),(0,yy,eave+19.1),2.35,'Cast iron',14)
            g.rod((0,yy,eave+18.9),(0,yy,eave+20.25),2.93,'Oxide iron',14,.70)
    # Visible internal truss, stacks and dark carriage frame behind the doors.
    for yy in (-end*.60,0,end*.61):
        g.bar((-half+1,yy,eave-1),(half-1,yy,eave-1),1.,1.,'Cast iron')
        for xx in (-half*.68,-half*.18,half*.34):
            g.bar((xx,yy,eave-1),(xx+w*.15,yy,eave+5),.75,.80,'Patinated steel')
    for xx in (-6.3,6.3):
        g.bar((xx,-end*.85,.9),(xx,end+7.4,.9),.57,.36,'Cast iron')
    for yy in (end*.30,end*.52):
        g.bar((-11,yy,1.65),(11,yy,1.65),2.35,1.65,'Oak')
        for s in (-1,1):g.bar((s*3.4,yy,2.3),(s*11,yy,11.3),.91,1.15,'Oak')
    return g


def brick_stack():
    g=Builder()
    g.box((0,0,3.0),(14.5,15,6),'Quay concrete')
    g.box((0,0,8.4),(13.0,13.7,7.4),'Salt-stained brick')
    g.box((0,0,12.5),(14.15,14.4,1.05),'Quay concrete')
    # Hollow, slightly battered stack. Bands and a ladder break the silhouette.
    stations=[(12.9,6.0),(15.0,6.1),(56.5,4.6),(69.5,4.1),(70.1,4.55),(72.5,4.6),(73.,4.32),(74.,4.32)]
    for (z,r),(h,R) in zip(stations,stations[1:]):
        for k in range(30):
            t=k/30;u=(k+1)/30;a=TAU*t;b=TAU*u
            pts=[(r*math.cos(a),r*math.sin(a),z),(r*math.cos(b),r*math.sin(b),z),
                 (R*math.cos(b),R*math.sin(b),h),(R*math.cos(a),R*math.sin(a),h)]
            g.face(pts,'Salt-stained brick',[(t*2.35,z/17),(u*2.35,z/17),(u*2.35,h/17),(t*2.35,h/17)],True)
    for zz in (22,35,48,60,67.2):
        r=6.1-(zz-15)*2.0/54.5
        g.rod((0,0,zz),(0,0,zz+.40),r+.10,'Cast iron',30)
    g.rod((0,0,73.05),(0,0,73.5),3.9,'Tar',28)
    for s in (-1,1):
        g.bar((5.97,s*.79,13.),(4.47,s*.79,73.5),.23,.23,'Cast iron')
    for zz in range(15,73,3):
        x=5.98-(zz-13.)*.025
        g.bar((x,-.82,zz),(x,.82,zz),.22,.22,'Cast iron')
    return g


def lumber_stacks():
    g=Builder()
    for cx,cy,h,length in ((-6,0,7,25),(15,3,5,19),(-9,29,4,26)):
        for y in (-length*.37,length*.37):
            g.box((cx,cy+y,.63),(11.,1.5,1.26),'Tar')
        for layer in range(h):
            zz=1.43+layer*.94
            if layer%2==0:
                for y in (-length*.34,length*.34):g.box((cx,cy+y,zz-.15),(9.7,1.0,.28),'Weathered end grain')
            for i in range(5):
                x=cx+(i-2)*1.9;dy=rng.uniform(-.7,.7);dy2=rng.uniform(-.5,.5)
                g.bar((x,cy-length/2+dy,zz+.18),(x,cy+length/2+dy2,zz+.18),1.77,.74,'Oak' if (i+layer)%4 else 'Heartwood')
    return g


def rigging_store():
    g=Builder()
    # A roofed but open-sided spar store, with timber racks exposed to the slip.
    for xx in (-30,-10,10,30):
        for yy in (-9,9):
            g.box((xx,yy,7.4),(1.24,1.24,14.8),'Oak')
            g.bar((xx,yy,10.1),(xx+(-2.75 if xx>0 else 2.75),yy,14.4),.78,.78,'Weathered end grain')
        g.bar((xx,-9,14.5),(xx,9,14.5),1.2,1.0,'Oak')
    for sign in (-1,1):
        g.face([(-32,sign*10.5,14.25),(32,sign*10.5,14.25),(32,0,18.8),(-32,0,18.8)],
               'Oxide iron',[(0,0),(4.8,0),(4.8,1.1),(0,1.1)])
        g.bar((-32,sign*10.5,14.25),(32,sign*10.5,14.25),.72,.8,'Oak')
    g.rod((-32,0,18.8),(32,0,18.8),.48,'Galvanized edges',9)
    for y in (-5.2,0,5.2):
        for zz in (2.2,3.8,5.3):
            g.rod((-28,y,zz),(28.5,y,zz+.13),.82,'Oak',8,.66)
    return g


def coaster():
    """A small coastal steel freighter with aft bridge and two cargo hatches."""
    g=Builder()
    stations=[(-74,1.4,4.8),(-72,6.8,4.2),(-66,12.3,3.5),(-58,15,2.5),(-42,17,1),
              (-13,17.7,.3),(19,17.6,0),(42,16.5,1.2),(55,13,2.4),(65,8.4,4.2),(73,2.3,5.8),(75,.22,6.4)]
    # World water level in these local coordinates is z=0.
    def plate(x,y,t):
        w=lerp(stations,x,1);rise=lerp(stations,x,2)
        return (x,y*w*(.48+.52*math.sin(t*math.pi/2)**.55),-6.2+12.0*t+rise*(.18+.82*t))
    xs=[p[0] for p in stations]
    for a,b in zip(xs,xs[1:]):
        for side in (-1,1):
            for lo,hi,mat in ((0,.43,'Hull oil red'),(.43,.59,'Tar'),(.59,.93,'Patinated steel'),(.93,1,'Tar')):
                pts=[plate(a,side,lo),plate(b,side,lo),plate(b,side,hi),plate(a,side,hi)]
                uv=[(a/30,lo*.95),(b/30,lo*.95),(b/30,hi*.95),(a/30,hi*.95)]
                g.face(pts if side<0 else pts[::-1],mat,uv if side<0 else uv[::-1],True)
            g.bar(plate(a,side,1),plate(b,side,1),.60,.70,'Rust')
        q=[plate(a,-1,1),plate(b,-1,1),plate(b,1,1),plate(a,1,1)]
        g.face(q,'Patinated steel')
    for e in (xs[0],xs[-1]):
        p0=plate(e,-1,0);p1=plate(e,1,0);p2=plate(e,1,1);p3=plate(e,-1,1)
        g.face([p0,p1,p2,p3],'Tar')
    # Raised quarterdeck, bridge face, window strip, wing railings and funnel.
    for z,w,l,h,mat in ((7.3,27,27,2.8,'Patinated steel'),(11,21.2,25,5.6,'Wheelhouse enamel'),
                          (15.3,17.5,21.5,3.5,'Wheelhouse enamel'),(18.5,16.5,18.7,3.1,'Wheelhouse enamel')):
        g.box((-49,0,z),(l,w,h),mat)
    g.box((-48.2,0,20.55),(20.7,23,.65),'Tar')
    for x in (-54.4,-50.4,-46.4,-42.4):
        for side in (-1,1):
            g.box((x,8.29*side,18.85),(2.9,.25,2.0),'Dirty glass')
            g.rod((x,10.73*side,10.1),(x,10.82*side,10.1),.60,'Cast iron',10)
    for y in (-6.3,-3.2,0,3.2,6.3):g.box((-39.56,y,18.94),(.22,2.57,1.9),'Dirty glass')
    g.rod((-56,0,20.87),(-56.8,0,28.8),2.9,'Oxide iron',18,2.4)
    g.rod((-56.8,0,28.1),(-57.05,0,30.1),2.42,'Tar',18,2.49)
    for y in (-7.4,7.4):
        g.bar((-59,y,20.9),(-39,y,20.9),.36,.36,'Cast iron')
    for x,ln in ((-17,20),(17.6,28.8)):
        g.box((x,0,7.3),(ln,22,2.4),'Rust')
        g.box((x,0,8.8),(ln-.35,21.6,.68),'Oxide iron')
        for i in range(5):
            px=x-ln*.45+i*ln*.225
            g.bar((px,-11,9.1),(px,11,9.1),.55,.59,'Cast iron')
        for sy in (-1,1):
            for k in (-.46,-.20,.09,.36):
                g.box((x+ln*k,sy*11.1,8.2),(1.2,.65,.66),'Tar')
    # Paired cargo derricks served both hatches before quay cranes.
    for x,sgn in ((.35,-1),(47,1)):
        g.rod((x,0,6.75),(x,0,36),.88,'Weathered end grain',12,.5)
        g.bar((x,0,33.8),(x,sgn*5.4,33.8),.48,.43,'Cast iron')
        for side in (-1,1):
            g.cable([(x,0,34.8),(x+sgn*6.3,side*13.5,8.)],.17)
        end=(x+sgn*17.7,4*sgn,23.3)
        g.bar((x,0,10),end,.76,.90,'Weathered end grain')
        g.cable([(x,0,35.15),end,(end[0],end[1],12.4)],.19)
    for xx in (-67,-31,-4,31,58,67):
        for s in (-1,1):
            point=Vector(plate(xx,s,1))
            g.rod(point,point+Vector((0,0,1.9)),.18,'Cast iron',7)
    return g


def mooring_buoys():
    g=Builder()
    def convert(x,y,z):return (x-400,y-568,z)
    for x,y in ((776,398),(867,235)):
        p,q,_=convert(x,y,0)
        g.rod((p,q,-14.9),(p,q,-13.25),2.65,'Hull oil red',16,2.75)
        g.rod((p,q,-13.25),(p,q,-11.8),2.75,'Oxide iron',16,1.10)
        g.rod((p,q,-11.8),(p,q,-11.15),.62,'Cast iron',12)
    # From both working moorings the hawser disappears into the steel fairlead.
    for a,b in (((776,398,-11.6),(785,381,-4.0)),((867,235,-11.6),(850,254,-1.9))):
        start,end=Vector(convert(*a)),Vector(convert(*b));points=[]
        for i in range(11):
            f=i/10;v=start.lerp(end,f);v.z-=1.70*math.sin(math.pi*f);points.append(v)
        g.cable(points,.35,'Dry hemp')
    return g


def scene_props():
    layout=json.loads((ROOT/'content/lowtide-layout.json').read_text())
    models={'barge':boat().mesh('Oak lighter on stocks'),'crane':hoist().mesh('Lattice quay crane')}
    for prop in layout['props']:
        px=126+prop['center'][0]/2
        py=132+prop['center'][1]/2
        place(models[prop['kind']],('North ' if py<568 else 'South ')+prop['kind'],px,py,prop['angle'])
    # Projecting cornices and loading gear of all buildings remain landward of x123.
    # GLTFLoader can draw the repeated structures with one call per surface.
    # Keep facility roots separate so north/south placements remain inspectable.
    district=bpy.data.objects.new('Quayside warehouses',None)
    bpy.context.scene.collection.objects.link(district)
    sheds=[warehouse(37,76,18.5,0).mesh('Bond warehouse'),
           warehouse(33,49,15.,1).mesh('Short shipwright shed'),
           warehouse(42,67,20.,2).mesh('Loading shed with lantern'),
           warehouse(38,86,20,3).mesh('Transit warehouse')]
    # Irregular service yards, with separate repair and construction specialisms.
    # The nearest walls end west of paper x123. The canal leaves a clear service strip.
    for i,(x,y,style,angle) in enumerate(((74,206,0,-5),(63,289,1,88),(84,484,1,88),
                                         (71,654,1,-6),(78,944,0,86))):
        place(sheds[style],f'West quay shed {i+1}',x,y,angle).parent=district
    distant=[warehouse(43,84,18.8,4,False).mesh('Low background store'),
             warehouse(47,92,22.,5,False).mesh('Long brick store')]
    addresses=[(-98,170,1,90),(-226,216,0,5),(-320,318,1,88),
               (-137,433,0,84),(-262,448,1,5),(-75,641,0,4),(-230,673,1,90),
               (-146,811,0,79),(-322,863,1,-6),(-124,957,0,2)]
    for i,(x,y,j,a) in enumerate(addresses):
        place(distant[j],f'Warehouse district {i+1}',x,y,a,scale=(.92,1.,1.06)[i%3]).parent=district
    place(assembly_shop(100,132,True).mesh('Sawtooth assembly works'),'Rail and boiler assembly',44,392,-2)
    place(assembly_shop(91,141,False).mesh('Arched steel hull loft'),'Hull framing hall',39,802,4)
    place(brick_stack().mesh('Banded brick boiler stack'),'Boilerhouse chimney',6,281)
    woodpile=lumber_stacks().mesh('Seasoning timber and stickers')
    place(woodpile,'Seasoning yard',-66,346,12)
    place(woodpile,'Long timber by hull loft',64,704,87)
    rig=rigging_store().mesh('Spar shed and racks')
    place(rig,'North rigging workshop',234,110,-5,scale=1.18)
    place(sheds[1],'North gatehouse and shore dispatch',545,105,89,scale=.88).parent=district
    place(rig,'South spar seasoning store',557,1033,-4,scale=1.32)
    place(sheds[3],'South repair receiving office',254,1037,86,scale=1.03).parent=district
    place(woodpile,'South repair timbers',318,1030,74,scale=.74)
    place(coaster().mesh('Steel coastal freighter'),'Steel coaster at the moorings',819,318,-64,h=-13.5)
    place(mooring_buoys().mesh('Coaster moorings'),'Freighter swinging buoys',400,568)
    place(moored_boat().mesh('Harbour lighter afloat'),'Moored harbour boat',727,692,-83,h=-22.8)
    # The following static objects are all outside the gameplay polygon.
    quay=Builder()
    def local(x,y,z):return (x-400,y-568,z)
    # A narrow clutch of tide-stained buffers hangs below the outer coping.
    for y in (183,263,352,444,489,632,756,832,917,960):
        x,yy,_=local(676.2,y,0)
        quay.box((x,yy,-4.7),(1.4,3.4,11.2),'Oak')
        for zz in (-.8,-7.4):
            quay.box((x+.55,yy,zz),(.65,3.63,.55),'Rust')
        if y in (263,444,756,917):bollard(quay,x+1.4,yy)
    for x,y in ((695,655),(697,723)):
        xx,yy,_=local(x,y,0);bollard(quay,xx,yy)
    # Mooring lines bow under their own weight between the shore bollards and deck cleats.
    for start,end in (((695,655,2.5),(728.4,655.9,-6.1)),((697,723,2.5),(719.5,731.0,-5.7))):
        a=Vector(local(*start));b=Vector(local(*end))
        points=[]
        for i in range(11):
            t=i/10;p=a.lerp(b,t);p.z-=2.15*math.sin(math.pi*t);points.append(p)
        quay.cable(points,.255,'Dry hemp')
    for x,y,w,l,h in ((696,409,9.7,8.3,7.7),(704,414,5.5,4.7,5.3),
                        (102,714,12.,8.2,7.),(113,710,5.7,5.2,4.4)):
        xx,yy,_=local(x,y,0);crate(quay,xx,yy,w,l,h)
    for x,y in ((96.5,721),(101.5,723.5),(98,727.5),(699.5,416.5)):
        xx,yy,_=local(x,y,0);barrel(quay,xx,yy)
    place(quay.mesh('Quay fittings and cargo'),'Shore fittings and cargo',400,568)


def proof(directory):
    scene=bpy.context.scene
    scene.render.engine='CYCLES';scene.cycles.samples=18
    scene.cycles.use_denoising=True;scene.cycles.device='CPU'
    scene.world.use_nodes=True
    scene.world.node_tree.nodes['Background'].inputs[0].default_value=(.71,.81,.90,1)
    scene.world.node_tree.nodes['Background'].inputs[1].default_value=.55
    bpy.ops.object.light_add(type='SUN',location=(-200,-600,850))
    sun=bpy.context.object;sun.rotation_euler=Vector((.40,.5,-.83)).to_track_quat('-Z','Y').to_euler()
    sun.data.energy=3.3;sun.data.angle=math.radians(13)
    bpy.ops.mesh.primitive_plane_add(size=5200)
    floor=bpy.context.object;floor.location.z=-.32
    mat=bpy.data.materials.new('Proof ground');mat.diffuse_color=(.31,.315,.275,1);floor.data.materials.append(mat)
    bpy.ops.object.camera_add();cam=bpy.context.object;scene.camera=cam;cam.data.type='ORTHO';cam.data.clip_end=6500
    scene.view_settings.view_transform='AgX'
    scene.render.resolution_percentage=100
    testviews=[('repair-boats',(507,427,7),200,(.23,-.94,.89)),
               ('quay-crane',(660,447,13),225,(.42,-.91,.75)),
               ('warehouse',(46,389,20),340,(.69,-.91,.65)),
               ('hull-hall',(45,796,15),350,(.66,-.93,.60)),
               ('steel-coaster',(819,318,5),342,(.93,-.28,.62)),
               ('dock-district',(71,382,18),1130,(.68,-.88,.57))]
    directory.mkdir(parents=True,exist_ok=True)
    for name,(x,y,h),span,view in testviews:
        floor.location.z=-27.05 if name=='steel-coaster' else -.32
        target=Vector((2*(x-400),-2*(y-568),2*h))
        cam.location=target+Vector(view)*650
        cam.rotation_euler=(target-cam.location).to_track_quat('-Z','Y').to_euler()
        cam.data.ortho_scale=span;scene.render.resolution_x=760;scene.render.resolution_y=510
        scene.render.filepath=str(directory/(name+'.jpg'));scene.render.image_settings.file_format='JPEG'
        bpy.ops.render.render(write_still=True)


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--output',type=Path,default=ROOT/'web/public/media/battle/lowtide-dock/props.glb')
    parser.add_argument('--proof',type=Path)
    argv=sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else []
    args=parser.parse_args(argv)
    bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
    with tempfile.TemporaryDirectory() as temp:
        TEMP=Path(temp)
        with ZipFile(ROOT/'tools/lowtide-prop-surfaces.zip') as surfaces:surfaces.extractall(TEMP)
        palette();scene_props()
        args.output.parent.mkdir(parents=True,exist_ok=True)
        bpy.ops.export_scene.gltf(filepath=str(args.output),export_format='GLB',export_yup=True,
                                  export_texcoords=True,export_normals=True,export_materials='EXPORT',
                                  export_animations=False,export_cameras=False,export_lights=False,export_gpu_instances=True)
        print('Wrote',args.output,args.output.stat().st_size,flush=True)
        if args.proof:proof(args.proof)
