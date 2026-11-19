"""Package the source GLBs and the two mesh-based building bodies for the web client.

Input is the adjacent material checkout's assets directory. Its converted source meshes
already have native skeletons, action names and embedded diffuse maps. No Godot scene,
particle player or resource loader is shipped to the browser.
"""
import argparse
import json
import math
from pathlib import Path
import struct
import subprocess
import tempfile

from import_battle_models import DEST
from source_glb import Model, pack_tracks

SOURCES = {
    "apex_turret": "units/apex_turret/source/apex_turret",
    "demacian_standard": "units/demacian_standard/source/standard",
    "evolution_turret": "units/evolution_turret/source/evolution_turret",
    "gold_ward": "units/gold_ward/source/ward",
    "jack_in_the_box": "units/jack_in_the_box/source/box",
    "powder_keg": "units/powder_keg/source/barrel",
    "queen_nest": "units/queen_nest/source/tunnel",
    "scarecrow": "units/fiddlesticks/source/fiddlesticks",
    "soul_tentacle": "units/soul_tentacle/tentacle",
    "thorn_spitter": "units/thorn_spitter/source/thorn_spitter",
    "tombstone": "units/tombstone/source/tombstone",
    "vine_lasher": "units/vine_lasher/source/vine_lasher",
    "void_gate": "units/void_gate/source/void_gate",
}
for team in ("blue", "red"):
    for key, stem in [
        ("inhibitor", "units/inhibitor/source/inhibitor_"),
        ("target_dummy", "units/target_dummy/source/"),
        ("princess_tower", "towers/princess/source/princess_tower_"),
        ("nexus", "towers/nexus/source/nexus_"),
    ]:
        SOURCES[f"{key}-{team}"] = stem + team
    SOURCES[f"sun_disc-{team}"] = "units/sun_disc/source/sun_disc"


def ice_body(assets):
    folder = assets/"effects/pillar_of_ice/pillar"
    source = next(folder.rglob("trundle_e_pillar_base.mesh.json"))
    geometry = json.loads(source.read_text())
    model = Model()
    xyz=geometry["vertices"]
    xyz[::3]=[-x for x in xyz[::3]]
    node=model.mesh("IcePillar",xyz,geometry["uv"],source.with_name("trundle_e_pillar_base.png"))
    samples=json.loads((folder/"sampled.json").read_text())
    fps=samples["fps"]
    for name,start,end in [("Rise",0,.36),("Idle",.36,.36),("Death",5.625,6.425)]:
        frames=range(round(start*fps),round(end*fps)+1)
        positions=[]
        for frame in frames:
            points=samples["frames"][frame][0]
            positions.append(points[0][1:4] if points else [0,-340,0])
        times=[i/fps for i in range(len(positions))]
        if len(times)==1: times.append(1);positions.append(positions[0])
        model.add("animations",{"name":name,"channels":[{"sampler":0,"target":{"node":node,"path":"translation"}}],
                                "samplers":[{"input":model.accessor(times,1),"output":model.accessor(sum(positions,[]),3)}]})
    return model


def add_banner(model, assets):
    # The native Standard SKN only contains the pole. Bake the cloth silhouette
    # from the settled E CameraTrail, with its own texture and attachment bone.
    folder=assets/"effects/demacian_standard/flag"
    sample=json.loads((folder/"sampled.json").read_text())
    particles=sorted(sample["frames"][sample["fps"]*2][0],key=lambda p:p[0],reverse=True)
    points=[]; uvs=[]; distance=0
    for i,p in enumerate(particles):
        pos=p[1:4] if i else [0,200,0]
        if i: distance+=math.dist(pos,previous)
        previous=pos
        width=p[4] if i else 20
        for sign in (1,-1):
            points.append([pos[0],pos[1]+width*sign,pos[2]])
            uvs.append([distance/100, .5-sign*.5*width/12])
    indices=[v for i in range(0,len(points)-2,2) for v in (i,i+1,i+2,i+2,i+1,i+3)]
    bone=next(i for i,n in enumerate(model.doc["nodes"]) if n.get("name")=="root")
    model.mesh("Banner",sum([points[i] for i in indices],[]),sum([uvs[i] for i in indices],[]),
               next(folder.rglob("jarvaniv_base_e_flag.png")),bone)


def add_ruin(model, source):
    # The extracted rubble is a single static node with an embedded diffuse.
    ruin=Model(source)
    other=ruin.doc
    prim=other["meshes"][0]["primitives"][0]
    def unpack(index):
        acc=other["accessors"][index]
        view=other["bufferViews"][acc["bufferView"]]
        code={5123:"H",5125:"I",5126:"f"}[acc["componentType"]]
        n={"SCALAR":1,"VEC2":2,"VEC3":3}[acc["type"]]
        start=view.get("byteOffset",0)+acc.get("byteOffset",0)
        stride=view.get("byteStride",struct.calcsize("<"+code*n))
        return [struct.unpack_from("<"+code*n,ruin.data,start+i*stride) for i in range(acc["count"])]
    indices=[i[0] for i in unpack(prim["indices"])]
    positions=unpack(prim["attributes"]["POSITION"])
    uvs=unpack(prim["attributes"]["TEXCOORD_0"])
    texture=source.with_name(source.stem+"_Rubble.png")
    # Extracted ruin's local X is reflected by its source node transform.
    xyz=[v*.01/.0172 for i in indices for v in (-positions[i][0],positions[i][1],positions[i][2])]
    model.mesh("RuinBase",xyz,[v for i in indices for v in uvs[i]],texture)



def prepare_native_tracks(model, name):
    doc = model.doc
    for clip in doc["animations"]:
        channels = clip["channels"]
        if name.startswith("sun_disc-") and clip["name"] in ("Attack1_BASE", "Attack2_BASE"):
            # Native Disk mask. Preserve the posed body while only the top fires.
            clip["channels"] = [c for c in channels if doc["nodes"][c["target"]["node"]]["name"]
                                in ("C_Buffbone_Glb_Chest_Loc", "Buffbone_Cstm_Obelisk_Tip")]
        elif name == "thorn_spitter" and clip["name"] == "Buffbones":
            # Skin0 applies a static secondary track to the attachment bones.
            clip["channels"] = [c for c in channels if "buffbone" in doc["nodes"][c["target"]["node"]]["name"].lower()]
            for c in clip["channels"]:
                target = c["target"]
                acc = doc["accessors"][clip["samplers"][c["sampler"]]["output"]]
                view = doc["bufferViews"][acc["bufferView"]]
                dims = 4 if target["path"] == "rotation" else 3
                assert acc["componentType"] == 5126
                value = struct.unpack_from("<" + "f"*dims, model.data, view.get("byteOffset",0) + acc.get("byteOffset",0))
                doc["nodes"][target["node"]][target["path"]] = list(value)
        elif name == "void_gate" and clip["name"] == "Spit":
            # Source scale deltas are identity for every bone. Three's additive
            # mixer adds vector tracks, so omit these multiplicative identities.
            clip["channels"] = [c for c in channels if c["target"]["path"] != "scale"]


def tower_clips(model):
    doc = model.doc
    keep = {"Base", "Stage1", "Stage2", "Rubble", "Broken1", "Broken2", "Broken3"}
    for mesh in doc["meshes"]:
        mesh["primitives"] = [p for p in mesh["primitives"] if doc["materials"][p["material"]]["name"] in keep]
    clips = []
    for action in doc["animations"]:
        name = action["name"]
        layer = name.removeprefix("Native") if name.startswith("NativeBreak") else None
        if not layer and name not in {"Idle1", "State2", "State3", "Destroyed"}:
            continue
        # Each independent fall animates only its own bones. The tower body
        # must never write these tracks while another layer is playing.
        channels = []
        for channel in action["channels"]:
            bone = doc["nodes"][channel["target"]["node"]]["name"]
            if (bone.startswith(layer) if layer else not bone.startswith("Break")):
                channels.append(channel)
        action["channels"] = channels
        clips.append(action)
    doc["animations"] = clips


def build(assets, dest, only=None):
    dest.mkdir(parents=True,exist_ok=True)
    pack=DEST.parents[2]/"node_modules/.bin/gltfpack"
    bindings = json.loads(subprocess.check_output(["node", Path(__file__).with_name("model-resources.mjs"), "--clips"]))
    with tempfile.TemporaryDirectory() as tmp:
        for name, path in {**SOURCES, "pillar_of_ice":None}.items():
            if only and name not in only: continue
            model=Model(assets/(path+".glb")) if path else ice_body(assets)
            prepare_native_tracks(model, name)
            if name=="demacian_standard": add_banner(model,assets)
            if name.startswith("sun_disc-"):
                team=name.split("-")[-1]
                add_ruin(model,assets/f"units/sun_disc/source/princess_tower_ruin_{team}.glb")
            if name.startswith("princess_tower-"):
                tower_clips(model)
            for m in model.doc["materials"]:
                m.setdefault("extensions",{})["KHR_materials_unlit"]={}
            extensions=model.doc.setdefault("extensionsUsed",[])
            if "KHR_materials_unlit" not in extensions: extensions.append("KHR_materials_unlit")
            bound = bindings[name]
            for package, clip in bound["casts"].items():
                pack_tracks(model, {clip}, package, Path(tmp), pack, dest)
            core = set(bound["clips"]) - set(bound["casts"].values())
            model.doc["animations"] = [a for a in model.doc["animations"] if a["name"] in core]
            file=Path(tmp)/(name+".glb")
            model.write(file)
            subprocess.run([pack,"-i",file,"-o",dest/file.name,"-kn","-km","-ac","-cc","-ce","ext","-ar","16"],check=True)

if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("assets",type=Path,help="Directory containing units/, towers/ and effects/")
    parser.add_argument("--only", nargs="+", choices=[*SOURCES, "pillar_of_ice"])
    args = parser.parse_args()
    build(args.assets, DEST, args.only)
