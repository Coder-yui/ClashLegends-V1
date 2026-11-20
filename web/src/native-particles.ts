// The track is indexed by display time. No simulation or random state lives on the client.
import * as T from "three";
import index from "./battle-effect-assets.json";

const base = "/play/media/vfx/";
export const systems: Record<
  string,
  { file: string; frames: number; layers: number; fps: number }
> = index.systems;

type UV = {
  center?: number[];
  flipU?: boolean;
  flipV?: boolean;
  addressMode?: number;
};
export interface Layer {
  name: string;
  quadType: number;
  rank: number;
  blendMode: number;
  miscRenderFlags: number;
  bind: number;
  billboard: boolean;
  meshDraw: boolean;
  ray: boolean;
  reach: number;
  pivotUp: boolean;
  directionOriented: boolean;
  cell: number[];
  cellMult: number[];
  uv: UV;
  multUv: UV;
  alphaRef: number;
  textureFile?: string;
  meshFile?: string;
  multFile?: string;
  colorFile?: string;
  erosionFile?: string;
  normalFile?: string;
  beam?: { sourceOffset: number[]; targetOffset: number[] };
  trail?: {
    smoothing: number;
    mode: number;
    cutoff: number;
    tiling: { constant: number[] };
  };
  erosion?: {
    mixer: { constant: number[] };
    sliceWidth: number;
    featherIn: number;
    featherOut: number;
  };
  distortion?: { strength: number };
}
type Header = {
  version: number;
  width: number;
  duration: number;
  fps: number;
  frames: number;
  layers: Layer[];
};
export interface Track extends Header {
  offsets: Uint32Array;
  rows: Float32Array;
  materials: T.ShaderMaterial[];
  shapes: T.BufferGeometry[];
}

const vertex = /* glsl */ `
attribute vec4 p0,p1,p2,p3,p4,p5,p6,p7,p8,p9;
uniform vec4 flags, uvInfo, uv2Info;
uniform vec2 cells,cells2;
uniform float reach,pivot,beamLength,directed;
uniform vec3 beamStart,beamEnd;
varying vec2 at,at2,lookup;
varying vec4 tint;
varying float erosion;
vec2 sampleUV(vec2 v,vec4 info,vec2 cell,float angle,vec2 scale,vec2 scroll,vec2 frame){
 vec2 a=(v-info.xy)*scale;
 float c=cos(angle),s=sin(angle);
 a=vec2(c*a.x-s*a.y,s*a.x+c*a.y)+info.xy+scroll;
 return frame+mix(a,1.-a,info.zw)*cell;
}
void main(){
 vec3 center=p0.yzw,size=p1.xyz;
 mat3 axes=mat3(vec3(p3.x,p3.w,p4.z),vec3(p3.y,p4.x,p4.w),vec3(p3.z,p4.y,p5.x));
 vec2 coord=uv; vec3 local=center;
 if(flags.w>0.5){local=position;}
 else if(flags.x==6.){
   vec3 end=beamEnd+vec3(0.,0.,beamLength), delta=end-beamStart;
   vec3 eye=(inverse(modelMatrix)*vec4(cameraPosition,1.)).xyz;
   vec3 side=normalize(cross(eye-beamStart,delta));float t=position.y+0.5;
   local=mix(end-delta*size.z,beamStart+delta*size.y,t)+side*position.x*size.x;
   coord=vec2(t,position.x+.5);
 }else if(flags.z>.5){local+=axes*(position*size);}
 else if(flags.y>.5){
   vec2 corner=(position.xy+vec2(0.,pivot))*reach;
   float c=cos(p2.w),s=sin(p2.w);
   vec2 off=vec2(c*corner.x-s*corner.y,s*corner.x+c*corner.y)*size.xy;
   if(directed>.5){
     vec2 v=(mat3(modelViewMatrix)*axes[1]).xy;
     vec2 up=length(v)>.0001?normalize(v):vec2(0.,1.);
     off=vec2(up.y,-up.x)*corner.x*size.x+up*corner.y*size.y;
   }
   vec4 mv=modelViewMatrix*vec4(center,1.);
   mv.xy+=off*length(modelMatrix[0].xyz);
   gl_Position=projectionMatrix*mv;
   coord=vec2(position.x+.5,.5-position.y);
 }else if(flags.x==7.){
   local.xz+=vec2(position.x*size.x,position.y*size.z)*reach;
   coord=vec2(position.x+.5,.5-position.y);
 }else if(flags.x==2.){
   vec3 forward=axes[2],eye=(inverse(modelMatrix)*vec4(cameraPosition,1.)).xyz;
   vec3 side=-normalize(cross(forward,eye-center));
   local+=forward*(size.z+(position.y+.5)*size.y)+side*position.x*size.x;
   coord=vec2(position.x+.5,.5-position.y);
 }else{
   local+=(axes[0]*position.x*size.x+axes[1]*(position.y+pivot)*size.y)*reach;
   coord=position.yx+.5;
 }
 if(flags.y<.5 || flags.z>.5 || flags.w>.5 || flags.x==6.)gl_Position=projectionMatrix*modelViewMatrix*vec4(local,1.);
 at=sampleUV(coord,uvInfo,cells,p5.y,p5.zw,p6.xy,p6.zw);
 at2=sampleUV(coord,uv2Info,cells2,p7.x,p7.yz,vec2(p7.w,p8.x),p8.yz);
 if(flags.x==6.){at=at.yx;at2=at2.yx;}
 tint=vec4(p1.w,p2.xyz)*color;
 lookup=vec2(p8.w,p9.x); erosion=p9.y;
}
`;
const skinVertex =
  vertex
    .slice(0, vertex.indexOf("void main()"))
    .replace("attribute vec4 p0", "uniform vec4 p0") +
  `
#include <common>
#include <skinning_pars_vertex>
void main(){
 #include <skinbase_vertex>
 #include <begin_vertex>
 #include <skinning_vertex>
 gl_Position=projectionMatrix*modelViewMatrix*vec4(transformed,1.);
 at=sampleUV(uv,uvInfo,cells,p5.y,p5.zw,p6.xy,p6.zw);
 at2=sampleUV(uv,uv2Info,cells2,p7.x,p7.yz,vec2(p7.w,p8.x),p8.yz);
 tint=vec4(p1.w,p2.xyz);lookup=vec2(p8.w,p9.x);erosion=p9.y;
}`;
const fragment = /* glsl */ `
uniform sampler2D image,map2,ramp,mask,normalMap,backdrop;
uniform vec4 has,erosionMixer;
uniform vec3 band;
uniform vec2 address,screenSize;
uniform float alphaRef,warp,hasBackdrop,blendMode;
varying vec2 at,at2,lookup;
varying vec4 tint; varying float erosion;
vec2 addr(vec2 uv,float mode){if(mode>=2.)return clamp(uv,0.,1.);if(mode==1.)return 1.-abs(mod(uv,2.)-1.);return fract(uv);}
void main(){
 vec4 c=tint;
 if(warp==0.&&(blendMode==0.||blendMode==2.)){c.rgb*=c.a;c.a=1.;}
 vec4 v=texture2D(image,addr(at,address.x))*c;
 if(has.y>.5)v*=texture2D(ramp,clamp(has.x>.5?at2:lookup,0.,1.));
 if(has.x>.5)v*=texture2D(map2,addr(at2,address.y));
 if(has.z>.5){float m=dot(texture2D(mask,addr(at,address.x)),erosionMixer);v.a*=clamp((erosion-m+band.x)*band.y,0.,1.)-clamp((erosion-m)*band.z,0.,1.);}
 if(v.a<=alphaRef)discard;
 if(warp!=0.){
   if(hasBackdrop<.5)discard;
   vec2 delta=(texture2D(normalMap,addr(at,address.x)).rg*2.-1.)*warp*v.a;
   v=vec4(texture2D(backdrop,clamp(gl_FragCoord.xy/screenSize+delta,0.,1.)).rgb,v.a);
 }

 gl_FragColor=v;
}
`;
function uvInfo(uv: UV) {
  return new T.Vector4(
    ...([
      ...(uv.center ?? [0.5, 0.5]),
      Number(!!uv.flipU),
      Number(!!uv.flipV),
    ] as [number, number, number, number]),
  );
}
function quad() {
  const g = new T.PlaneGeometry(1, 1);
  const color = new Uint8Array(g.attributes.position.count * 4).fill(255);
  g.setAttribute("color", new T.Uint8BufferAttribute(color, 4, true));
  return g;
}
export class ParticleLibrary {
  private readonly plane = quad();
  private readonly white = new T.DataTexture(
    new Uint8Array([255, 255, 255, 255]),
    1,
    1,
  );
  private readonly textures = new Map<string, Promise<T.Texture>>();
  private readonly shapes = new Map<string, Promise<T.BufferGeometry>>();
  private readonly tracks = new Map<string, Promise<Track>>();
  private controller = new AbortController();
  private alive = true;
  readonly screen = { value: null as T.Texture | null };
  readonly size = { value: new T.Vector2(1, 1) };
  readonly hasScreen = { value: 0 };
  constructor() {
    this.white.needsUpdate = true;
  }
  private texture(file?: string) {
    if (!file) return Promise.resolve(this.white);
    let promise = this.textures.get(file);
    if (!promise) {
      promise = new T.TextureLoader()
        .loadAsync(base + file)
        .then((tex) => {
          tex.flipY = false;
          tex.wrapS = tex.wrapT = T.RepeatWrapping;
          if (!this.alive) tex.dispose();
          return tex;
        })
        .catch((e) => {
          this.textures.delete(file);
          throw e;
        });
      this.textures.set(file, promise);
    }
    return promise;
  }
  private async read(file: string) {
    const response = await fetch(base + file, {
      signal: this.controller.signal,
    });
    if (!response.ok)
      throw Error("VFX resource " + file + " HTTP " + response.status);
    return response;
  }
  private shape(file?: string) {
    if (!file) return Promise.resolve(this.plane);
    let promise = this.shapes.get(file);
    if (!promise) {
      promise = this.read(file)
        .then((r) => r.json())
        .then((d) => {
          const g = new T.BufferGeometry();
          const xyz = new Float32Array(d.vertices);
          for (let j = 0; j < xyz.length; j += 3) xyz[j] *= -1;
          g.setAttribute("position", new T.BufferAttribute(xyz, 3));
          g.setAttribute("uv", new T.Float32BufferAttribute(d.uv, 2));
          g.setAttribute(
            "color",
            new T.Uint8BufferAttribute(
              d.colors ?? new Uint8Array((xyz.length / 3) * 4).fill(255),
              4,
              true,
            ),
          );
          if (!this.alive) g.dispose();
          return g;
        })
        .catch((e) => {
          this.shapes.delete(file);
          throw e;
        });
      this.shapes.set(file, promise);
    }
    return promise;
  }
  private async material(l: Layer) {
    const [image, map2, ramp, mask, normal] = await Promise.all(
      [l.textureFile, l.multFile, l.colorFile, l.erosionFile, l.normalFile].map(
        (f) => this.texture(f),
      ),
    );
    const erosion = l.erosion,
      beam = l.beam;
    const m = new T.ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: fragment,
      vertexColors: true,
      transparent: true,
      side: T.DoubleSide,
      forceSinglePass: true,
      depthWrite: false,
      depthTest: !(l.miscRenderFlags & 1),
      uniforms: {
        flags: {
          value: new T.Vector4(
            l.quadType,
            Number(!!l.billboard),
            Number(!!l.meshFile),
            Number([4, 5].includes(l.quadType)),
          ),
        },
        uvInfo: { value: uvInfo(l.uv) },
        uv2Info: { value: uvInfo(l.multUv) },
        cells: { value: new T.Vector2().fromArray(l.cell ?? [1, 1]) },
        cells2: { value: new T.Vector2().fromArray(l.cellMult ?? [1, 1]) },
        reach: { value: l.reach ?? 2 },
        pivot: { value: l.pivotUp ? 0.5 : 0 },
        beamStart: {
          value: new T.Vector3()
            .fromArray(beam?.sourceOffset ?? [0, 0, 0])
            .multiply(new T.Vector3(-1, 1, 1)),
        },
        beamEnd: {
          value: new T.Vector3()
            .fromArray(beam?.targetOffset ?? [0, 0, 0])
            .multiply(new T.Vector3(-1, 1, 1)),
        },
        beamLength: { value: 3410 },
        directed: { value: Number(!!l.directionOriented) },
        image: { value: image },
        map2: { value: map2 },
        ramp: { value: ramp },
        mask: { value: mask },
        normalMap: { value: normal },
        has: {
          value: new T.Vector4(
            Number(!!l.multFile),
            Number(!!l.colorFile && !erosion),
            Number(!!erosion),
            0,
          ),
        },
        erosionMixer: {
          value: new T.Vector4().fromArray(
            erosion?.mixer.constant ?? [0, 0, 0, 1],
          ),
        },
        band: {
          value: new T.Vector3(
            erosion?.sliceWidth ?? 0,
            1 / Math.max(1e-8, erosion?.featherIn ?? 1),
            1 / Math.max(1e-8, erosion?.featherOut ?? 1),
          ),
        },
        address: {
          value: new T.Vector2(
            l.uv.addressMode ?? 0,
            l.multUv.addressMode ?? 0,
          ),
        },
        alphaRef: { value: l.alphaRef ?? 0 },
        warp: { value: l.distortion?.strength ?? 0 },
        blendMode: { value: l.blendMode },
        backdrop: this.screen,
        screenSize: this.size,
        hasBackdrop: this.hasScreen,
      },
    });
    if (!l.distortion) {
      m.blending = T.CustomBlending;
      m.blendSrc =
        l.blendMode === 2
          ? T.ZeroFactor
          : l.blendMode === 8
            ? T.OneMinusDstAlphaFactor
            : [1, 4].includes(l.blendMode)
              ? T.SrcAlphaFactor
              : T.OneFactor;
      m.blendDst =
        l.blendMode === 2
          ? T.OneMinusSrcColorFactor
          : l.blendMode === 8
            ? T.DstAlphaFactor
            : [1, 5].includes(l.blendMode)
              ? T.OneMinusSrcAlphaFactor
              : T.OneFactor;
      m.blendEquation =
        l.blendMode === 6
          ? T.MinEquation
          : l.blendMode === 7
            ? T.MaxEquation
            : T.AddEquation;
      m.blendSrcAlpha = l.blendMode === 2 ? T.ZeroFactor : T.OneFactor;
      m.blendDstAlpha =
        l.blendMode === 8 ? T.OneFactor : T.OneMinusSrcAlphaFactor;
      m.blendEquationAlpha = T.AddEquation;
      if (l.blendMode === 3) {
        m.blending = T.NoBlending;
        m.transparent = false;
        m.depthWrite = true;
      }
    }
    if (!this.alive) m.dispose();
    return m;
  }
  load(name: string) {
    let promise = this.tracks.get(name);
    if (!promise) {
      promise = this.decode(name).catch((e) => {
        this.tracks.delete(name);
        throw e;
      });
      this.tracks.set(name, promise);
    }
    return promise;
  }
  release(name: string) {
    const track = this.tracks.get(name);
    this.tracks.delete(name);
    if (track)
      void track.then(
        (t) => t.materials.forEach((m) => m.dispose()),
        () => {},
      );
  }
  private async decode(name: string): Promise<Track> {
    const res = await this.read(systems[name].file);
    const buf = await new Response(
      res.body!.pipeThrough(new DecompressionStream("gzip")),
    ).arrayBuffer();
    const view = new DataView(buf),
      n = view.getUint32(8, true);
    if (view.getUint32(0) !== 0x43564658 || view.getUint32(4, true) !== 1)
      throw Error("Unknown particle format");
    const h: Header = JSON.parse(
      new TextDecoder().decode(new Uint8Array(buf, 12, n)),
    );
    const offsets = new Uint32Array(
      buf,
      12 + Math.ceil(n / 4) * 4,
      h.frames * h.layers.length + 1,
    );
    const rows = new Float32Array(buf, offsets.byteOffset + offsets.byteLength);
    if (rows.length !== offsets[offsets.length - 1] * h.width)
      throw Error("Incomplete particle track");
    const shapes = await Promise.all(
      h.layers.map((l) => this.shape(l.meshFile)),
    );
    const materials = await Promise.all(h.layers.map((l) => this.material(l)));
    return { ...h, offsets, rows, shapes, materials };
  }
  dispose() {
    this.alive = false;
    this.controller.abort();
    for (const p of this.tracks.values())
      void p.then(
        (t) => t.materials.forEach((m) => m.dispose()),
        () => {},
      );
    for (const p of this.shapes.values())
      void p.then(
        (g) => g.dispose(),
        () => {},
      );
    for (const p of this.textures.values())
      void p.then(
        (t) => t.dispose(),
        () => {},
      );
    this.white.dispose();
    this.plane.dispose();
    this.tracks.clear();
    this.shapes.clear();
    this.textures.clear();
  }
}

interface Batch {
  mesh: T.Mesh;
  data: T.InterleavedBuffer;
  capacity: number;
}
type Pose = { age: number; position: T.Vector3; orientation: T.Quaternion };
export const missileOrientation = new T.Quaternion(
  0,
  Math.SQRT1_2,
  Math.SQRT1_2,
  0,
);
const beamFilter = new Set(["Left_outline", "Left_outline1", "Right_outline1"]);
export type ParticleQuality = "high" | "low" | "off";
export class ParticleActor {
  readonly root = new T.Group();
  private overlays = new Map<
    string,
    { material: T.ShaderMaterial; meshes: T.Mesh[]; sources: readonly T.Mesh[] }
  >();
  sources?: readonly T.Mesh[];
  private batches = new Map<number, Batch>();
  private path: Pose[] = [];
  private lastAge = -1;
  private birthPosition = new T.Vector3();
  private birthRotation = new T.Quaternion();
  private rotationInverse = new T.Quaternion();
  private relativeRotation = new T.Quaternion();
  private blendedRotation = new T.Quaternion();
  private axis = new T.Vector3();
  readonly viewDirection = new T.Vector3(0, -0.809, -0.588);
  private cameraLocal = new T.Vector3();
  private oldest = 0;
  distortion = false;
  beamLength = 3410;
  drawn = 0;
  constructor(
    readonly name: string,
    readonly track: Track,
  ) {}
  previewMotion(age: number) {
    this.root.quaternion.copy(missileOrientation);
    this.root.position.set(0, 0, 1280 * Math.min(0.5, age) - 320);
    this.oldest = 0;
    this.lastAge = age;
    this.path = [0, Math.min(age, 0.5), age].map((t) => ({
      age: t,
      position: new T.Vector3(0, 0, 1280 * Math.min(0.5, t) - 320),
      orientation: missileOrientation,
    }));
  }
  private batch(i: number, size: number, trail: boolean) {
    const old = this.batches.get(i);
    if (old && old.capacity >= size) return old;
    if (old) {
      old.mesh.removeFromParent();
      old.mesh.geometry.dispose();
    }
    const capacity = 2 ** Math.ceil(Math.log2(Math.max(size, 1)));
    const geo = trail
      ? new T.BufferGeometry()
      : new T.InstancedBufferGeometry();
    if (trail) {
      geo.setAttribute(
        "position",
        new T.Float32BufferAttribute(
          new Float32Array(capacity * 3),
          3,
        ).setUsage(T.DynamicDrawUsage),
      );
      geo.setAttribute(
        "uv",
        new T.Float32BufferAttribute(
          new Float32Array(capacity * 2),
          2,
        ).setUsage(T.DynamicDrawUsage),
      );
      geo.setAttribute(
        "color",
        new T.Uint8BufferAttribute(
          new Uint8Array(capacity * 4).fill(255),
          4,
          true,
        ),
      );
      const triangles = [];
      for (let k = 2; k < capacity; k += 2)
        triangles.push(k - 2, k - 1, k, k, k - 1, k + 1);
      geo.setIndex(triangles);
    } else {
      const source = this.track.shapes[i];
      geo.setIndex(source.index);
      for (const attr of ["position", "color", "uv"])
        geo.setAttribute(attr, source.getAttribute(attr));
    }
    const data = trail
      ? new T.InterleavedBuffer(new Float32Array(capacity * 40), 40)
      : new T.InstancedInterleavedBuffer(new Float32Array(capacity * 40), 40);
    data.setUsage(T.DynamicDrawUsage);
    for (let j = 0; j < 10; j++)
      geo.setAttribute(
        "p" + j,
        new T.InterleavedBufferAttribute(data, 4, j * 4),
      );
    const layer = this.track.layers[i];
    const mesh = new T.Mesh(geo, this.track.materials[i]);
    mesh.frustumCulled = false;
    mesh.renderOrder =
      100 +
      (layer.distortion
        ? -99
        : layer.rank < 0
          ? layer.rank + 999900
          : layer.rank);
    if (layer.quadType === 6)
      mesh.onBeforeRender = () => {
        const m = this.track.materials[i];
        m.uniforms.beamLength.value = this.beamLength;
        m.uniformsNeedUpdate = true;
      };
    this.root.add(mesh);
    const batch = { mesh, data, capacity };
    this.batches.set(i, batch);
    return batch;
  }
  private overlay(layer: number, particle: number, row: number) {
    const sources = this.sources;
    if (!sources?.length) return;
    const key = layer + "/" + particle;
    let group = this.overlays.get(key);
    if (group && group.sources !== sources) {
      group.meshes.forEach((m) => m.removeFromParent());
      group.material.dispose();
      this.overlays.delete(key);
      group = undefined;
    }
    if (!group) {
      const original = this.track.materials[layer],
        material = original.clone();
      material.uniforms = { ...original.uniforms };
      material.vertexColors = false;
      material.vertexShader = skinVertex;
      material.polygonOffset = true;
      material.polygonOffsetFactor = -1;
      material.polygonOffsetUnits = -1;
      for (let j = 0; j < 10; j++)
        material.uniforms["p" + j] = { value: new T.Vector4() };
      const meshes = sources.map((source) => {
        const mesh =
          source instanceof T.SkinnedMesh
            ? new T.SkinnedMesh(source.geometry, material)
            : new T.Mesh(source.geometry, material);
        if (mesh instanceof T.SkinnedMesh) {
          const skinned = source as T.SkinnedMesh;
          mesh.bind(skinned.skeleton, skinned.bindMatrix);
          mesh.bindMode = T.DetachedBindMode;
        }
        mesh.matrixAutoUpdate = false;
        mesh.matrixWorldAutoUpdate = false;
        mesh.frustumCulled = false;
        mesh.renderOrder = 100 + this.track.layers[layer].rank;
        this.root.add(mesh);
        return mesh;
      });
      group = { material, meshes, sources };
      this.overlays.set(key, group);
    }
    for (let j = 0; j < 10; j++)
      group.material.uniforms["p" + j].value.fromArray(
        this.track.rows,
        row + j * 4,
      );
    group.meshes.forEach((mesh, j) => {
      const source = sources[j];
      source.updateWorldMatrix(true, false);
      mesh.matrixWorld.copy(source.matrixWorld);
      mesh.visible = source.visible;
      if (mesh instanceof T.SkinnedMesh)
        mesh.bindMatrixInverse.copy(
          (source as T.SkinnedMesh).bindMatrixInverse,
        );
    });
    this.drawn++;
  }
  private birthPose(age: number) {
    let hi = this.path.length - 1,
      lo = 0;
    while (lo < hi) {
      const mid = (hi + lo) >> 1;
      if (this.path[mid].age < age) lo = mid + 1;
      else hi = mid;
    }
    const b = this.path[lo],
      a = this.path[Math.max(0, lo - 1)];
    const t =
      b.age > a.age
        ? T.MathUtils.clamp((age - a.age) / (b.age - a.age), 0, 1)
        : 1;
    this.birthPosition.lerpVectors(a.position, b.position, t);
    this.birthRotation.slerpQuaternions(a.orientation, b.orientation, t);
  }
  private localPoint(
    row: number,
    bind: number,
    moving: boolean,
    out: T.Vector3,
  ) {
    const a = this.track.rows;
    out.set(a[row + 1], a[row + 2], a[row + 3]);
    if (moving && bind < 1) {
      this.birthPose(a[row + 38]);
      this.birthPosition
        .sub(this.root.position)
        .applyQuaternion(this.rotationInverse)
        .divideScalar(this.root.scale.x);
      this.relativeRotation.multiplyQuaternions(
        this.rotationInverse,
        this.birthRotation,
      );
      this.blendedRotation.identity().slerp(this.relativeRotation, 1 - bind);
      out
        .applyQuaternion(this.blendedRotation)
        .addScaledVector(this.birthPosition, 1 - bind);
    }
    return out;
  }
  sample(
    age: number,
    quality: ParticleQuality,
    muted: ReadonlySet<string>,
    moving: boolean,
    cutoff = Infinity,
    preview = false,
  ) {
    const t = this.track,
      fi = Math.min(t.frames - 1, Math.max(0, Math.floor(age * t.fps)));
    if (age < this.lastAge) {
      this.path = [];
      this.oldest = age;
    }
    if (moving && (!this.path.length || this.path.at(-1)!.age !== age)) {
      this.path.push({
        age,
        position: this.root.position.clone(),
        orientation: this.root.quaternion.clone(),
      });
      while (this.path.length > 2 && this.path[1].age < age - 4)
        this.path.shift();
      if (this.lastAge < 0) this.oldest = age;
    }
    this.lastAge = age;
    this.rotationInverse.copy(this.root.quaternion).invert();
    this.cameraLocal
      .copy(this.viewDirection)
      .applyQuaternion(this.rotationInverse);
    this.drawn = 0;
    this.distortion = false;
    const point = new T.Vector3(),
      prev = new T.Vector3(),
      side = new T.Vector3(),
      previousSide = new T.Vector3();
    for (const group of this.overlays.values())
      for (const mesh of group.meshes) mesh.visible = false;
    for (let i = 0; i < t.layers.length; i++) {
      const layer = t.layers[i],
        trail = [4, 5].includes(layer.quadType);
      const at = fi * t.layers.length + i,
        start = t.offsets[at],
        end = t.offsets[at + 1];
      const hide =
        quality === "off" ||
        age > t.duration ||
        muted.has(layer.name) ||
        (!preview && this.name === "sona/wave" && beamFilter.has(layer.name)) ||
        (quality === "low" && !!layer.distortion);
      const old = this.batches.get(i);
      if (old) old.mesh.visible = false;
      if (
        hide ||
        end === start ||
        (Number.isFinite(cutoff) && layer.bind >= 1 && !trail)
      )
        continue;
      if (layer.quadType === 11) {
        for (let p = start; p < end; p++)
          if (t.rows[p * t.width + 38] <= cutoff)
            this.overlay(i, p - start, p * t.width);
        continue;
      }
      const batch = this.batch(i, (end - start) * (trail ? 2 : 1), trail),
        geo = batch.mesh.geometry;
      let count = 0,
        distance = 0;
      const stride = quality === "low" && end - start > 8 ? 2 : 1;
      const reverse = trail && layer.trail?.smoothing !== 2;
      for (let j = 0; j < end - start; j += stride) {
        const row = (reverse ? end - 1 - j : start + j) * t.width,
          born = t.rows[row + 38];
        if (
          born > cutoff ||
          (trail && moving && this.oldest > 0.09 && born < this.oldest)
        )
          continue;
        this.localPoint(row, trail ? 0 : layer.bind, moving, point);
        if (trail) {
          const smoothing = layer.trail?.smoothing ?? 0;
          if (smoothing && count && j + 1 < end - start) {
            const center = reverse ? end - 1 - j : start + j;
            point.set(0, 0, 0);
            const first = Math.max(start, center - 3),
              last = Math.min(end - 1, center + 3);
            for (let k = first; k <= last; k++)
              point.add(this.localPoint(k * t.width, 0, moving, this.axis));
            point.divideScalar(last - first + 1);
          }
          if (count) distance += prev.distanceTo(point);
          if (layer.trail?.cutoff && distance >= layer.trail.cutoff) break;
          side.set(-t.rows[row + 12], -t.rows[row + 15], -t.rows[row + 18]);
          if (moving) {
            this.birthPose(born);
            side
              .applyQuaternion(this.birthRotation)
              .applyQuaternion(this.rotationInverse);
          }
          if (layer.quadType === 4) {
            const other =
              j + stride < end - start
                ? reverse
                  ? end - 1 - j - stride
                  : start + j + stride
                : Math.max(
                    start,
                    Math.min(
                      end - 1,
                      reverse ? end - 1 - j + stride : start + j - stride,
                    ),
                  );
            this.localPoint(other * t.width, 0, moving, this.axis).sub(point);
            if (this.axis.lengthSq() > 0.000001) {
              side.crossVectors(this.axis, this.cameraLocal).normalize();
              if (count && side.dot(previousSide) < 0) side.negate();
            }
          }
          this.axis.copy(side);
          if (smoothing && count) side.add(previousSide).normalize();
          previousSide.copy(this.axis);
          prev.copy(point);
          const tile = layer.trail?.tiling.constant ?? [1, 0],
            width = t.rows[row + 4];
          const odometer = t.rows[row + 39];
          const u =
            (layer.trail?.mode === 1 && odometer >= 0 ? odometer : distance) /
            (tile[0] || 1);
          const v = tile[1] > 0 ? width / tile[1] : Math.abs(tile[1]) || 1;
          for (let edge = 0; edge < 2; edge++) {
            const sign = edge ? -1 : 1;
            geo.attributes.position.setXYZ(
              count,
              point.x + side.x * width * sign,
              point.y + side.y * width * sign,
              point.z + side.z * width * sign,
            );
            geo.attributes.uv.setXY(count, u, 0.5 - (sign * v) / 2);
            batch.data.array.set(t.rows.subarray(row, row + 38), count++ * 40);
          }
        } else {
          batch.data.array.set(t.rows.subarray(row, row + 38), count * 40);
          const offset = count++ * 40;
          batch.data.array[offset + 1] = point.x;
          batch.data.array[offset + 2] = point.y;
          batch.data.array[offset + 3] = point.z;
        }
      }
      if (trail) {
        geo.setDrawRange(0, Math.max(0, (count / 2 - 1) * 6));
        geo.attributes.position.needsUpdate = true;
        geo.attributes.uv.needsUpdate = true;
      } else (geo as T.InstancedBufferGeometry).instanceCount = count;
      batch.mesh.visible = trail ? count >= 4 : count > 0;
      if (batch.mesh.visible) {
        if (layer.distortion) this.distortion = true;
        batch.data.clearUpdateRanges();
        batch.data.addUpdateRange(0, count * 40);
        batch.data.needsUpdate = true;
        this.drawn += trail ? count / 2 : count;
      }
    }
  }
  dispose() {
    this.root.removeFromParent();
    for (const group of this.overlays.values()) group.material.dispose();
    this.overlays.clear();
    for (const batch of this.batches.values()) batch.mesh.geometry.dispose();
    this.batches.clear();
    this.path = [];
  }
}

// Capture the opaque scene only on frames that draw native refraction.
export class ParticleBackdrop {
  private target?: T.WebGLRenderTarget;
  private texture?: T.Texture;
  private url?: string;
  private size = new T.Vector2();
  private alive = true;
  constructor(private library: ParticleLibrary) {}
  capture(
    renderer: T.WebGLRenderer,
    scene: T.Scene,
    camera: T.Camera,
    effects: T.Object3D,
    needed: boolean,
    map?: {
      terrain: string | null;
      width: number;
      height: number;
      projection: number;
      backdropWidth: number;
    },
  ) {
    this.library.hasScreen.value = 0;
    if (!needed) return;
    if (map?.terrain && this.url !== map.terrain) {
      this.url = map.terrain;
      this.texture?.dispose();
      this.texture = new T.TextureLoader().load(map.terrain, (t) => {
        if (!this.alive) t.dispose();
      });
      this.texture.colorSpace = T.SRGBColorSpace;
    }
    renderer.getDrawingBufferSize(this.size);
    const { x, y } = this.size;
    if (!this.target) this.target = new T.WebGLRenderTarget(x, y);
    this.target.setSize(x, y);
    const oldTarget = renderer.getRenderTarget(),
      oldBackground = scene.background;
    const image = this.texture?.image as HTMLImageElement | undefined;
    if (map && image?.width && this.texture) {
      const h = (map.backdropWidth * image.height) / image.width;
      this.texture.repeat.set(
        map.width / map.backdropWidth,
        (map.height * map.projection) / h,
      );
      this.texture.offset.set(
        (1 - this.texture.repeat.x) / 2,
        (1 - this.texture.repeat.y) / 2,
      );
      scene.background = this.texture;
    }
    effects.visible = false;
    try {
      renderer.setRenderTarget(this.target);
      renderer.render(scene, camera);
    } finally {
      effects.visible = true;
      scene.background = oldBackground;
      renderer.setRenderTarget(oldTarget);
    }
    this.library.screen.value = this.target.texture;
    this.library.size.value.copy(this.size);
    this.library.hasScreen.value = 1;
  }
  dispose() {
    this.alive = false;
    this.target?.dispose();
    this.texture?.dispose();
  }
}
