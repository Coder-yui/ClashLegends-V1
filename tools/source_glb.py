"""Offline editing of source (uncompressed) mesh and animation GLBs."""
from array import array
import json
import struct
import subprocess


class Model:
    def __init__(self, source=None):
        if source:
            raw = source.read_bytes()
            n = struct.unpack_from("<I", raw, 12)[0]
            self.doc = json.loads(raw[20:20+n])
            self.data = bytearray(raw[28+n:][:self.doc["buffers"][0]["byteLength"]])
        else:
            self.doc = {"asset":{"version":"2.0"}, "scene":0, "scenes":[{"nodes":[]}], "buffers":[{}]}
            self.data = bytearray()

    def add(self, table, value):
        entries = self.doc.setdefault(table, [])
        entries.append(value)
        return len(entries)-1

    def view(self, content):
        self.data.extend(bytes(-len(self.data) % 4))
        offset = len(self.data)
        self.data.extend(content)
        return self.add("bufferViews", {"buffer":0,"byteOffset":offset,"byteLength":len(content)})

    def accessor(self, values, size):
        desc = {"bufferView":self.view(array("f", values).tobytes()), "count":len(values)//size,
                "componentType":5126, "type":{1:"SCALAR",2:"VEC2",3:"VEC3"}[size],
                "min":[min(values[i::size]) for i in range(size)],"max":[max(values[i::size]) for i in range(size)]}
        return self.add("accessors", desc)

    def mesh(self, name, xyz, uv, png=None, parent=None):
        color = {"baseColorFactor":[.13,.15,.16,1]}
        if png:
            image = self.add("images", {"bufferView":self.view(png.read_bytes()),"mimeType":"image/png"})
            color = {"baseColorTexture":{"index":self.add("textures", {"source":image})}}
        material = self.add("materials", {"name":name,"doubleSided":True,"pbrMetallicRoughness":color})
        if name == "Banner":
            self.doc["materials"][material].update(alphaMode="MASK",alphaCutoff=.08)
        attrs = {"POSITION":self.accessor(xyz,3)}
        if uv:
            attrs["TEXCOORD_0"] = self.accessor(uv,2)
        mesh = self.add("meshes", {"name":name,"primitives":[{"material":material,"attributes":attrs}]})
        node = self.add("nodes", {"name":name,"mesh":mesh})
        if parent is None:
            self.doc["scenes"][0]["nodes"].append(node)
        else:
            self.doc["nodes"][parent].setdefault("children",[]).append(node)
        return node

    def write(self, dest):
        self.doc["buffers"][0]["byteLength"] = len(self.data)
        self.data.extend(bytes(-len(self.data)%4))
        header=json.dumps(self.doc,separators=(",",":")).encode()
        header+=b" "*(-len(header)%4)
        dest.write_bytes(struct.pack("<4sIII4s",b"glTF",2,28+len(header)+len(self.data),len(header),b"JSON")+header+struct.pack("<I4s",len(self.data),b"BIN\0")+self.data)


def pack_tracks(model, chosen, name, tmp, pack, dest):
    # Animation-only GLB. Copy exactly the referenced tracks, retaining
    # native joint names so Three binds them to the shared body.
    strip = Model()
    nodes, views, accessors = {}, {}, {}
    def copy_accessor(index):
        if index not in accessors:
            acc = model.doc["accessors"][index].copy()
            view_id = acc["bufferView"]
            if view_id not in views:
                view = model.doc["bufferViews"][view_id]
                start = view.get("byteOffset", 0)
                views[view_id] = strip.view(model.data[start:start + view["byteLength"]])
                if "byteStride" in view:
                    strip.doc["bufferViews"][-1]["byteStride"] = view["byteStride"]
            acc["bufferView"] = views[view_id]
            accessors[index] = strip.add("accessors", acc)
        return accessors[index]
    for anim in model.doc["animations"]:
        if anim["name"] not in chosen: continue
        tracks = []
        for channel in anim["channels"]:
            target = channel["target"].copy()
            node = target["node"]
            if node not in nodes:
                nodes[node] = strip.add("nodes", {"name": model.doc["nodes"][node]["name"]})
                strip.doc["scenes"][0]["nodes"].append(nodes[node])
            target["node"] = nodes[node]
            tracks.append({**channel, "target":target})
        samplers = [{**s, "input":copy_accessor(s["input"]), "output":copy_accessor(s["output"])} for s in anim["samplers"]]
        strip.add("animations", {**anim, "channels":tracks, "samplers":samplers})
    selected = tmp / (name + ".glb")
    strip.write(selected)
    subprocess.run([pack, "-i", selected, "-o", dest / selected.name, "-kn", "-ac", "-cc", "-ce", "ext", "-ar", "16"],check=True)
