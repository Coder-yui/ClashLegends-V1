// The track is indexed by display time. No simulation or random state lives on the client.
import * as T from "three";
import { pillarLayerAge, pillarLayerScale } from "./effect-calibration";
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
const arrivalGround: Record<string, Record<string, number>> = {
  comet: { Aura2: 1, Temp_GroundGlow4: 1 },
  slide: { MakerTrench1: 1, MakerTrench2: 1, MakerTrench3: 1, MakerTrench4: 1 },
  damage: {
    Temp_GroundGlow: 1,
    Temp_GroundGlow1: 2,
    "Dark ground wave'": 2,
    Temp_Trail9: 1,
    Temp_Trail10: 1,
  },
  landing: {
    Groundhole_LIGHT: 3,
    groundcrack: 3,
    dustRing3: 4,
    dustRing4: 4,
    dustRing5: 4,
    dustRing6: 4,
  },
  aftershock: { Temp_GroundGlow: 2, Temp_GroundGlow1: 2, Temp_GroundGlow2: 2 },
};
export interface Layer {
  name: string;
  quadType: number;
  rank: number;
  pass: number;
  groundLayer: boolean;
  phases: {
    colour: "under" | "over" | null;
    warpsEarly: boolean;
    warpsLate: boolean;
  };
  depthBias: [number, number];
  depthPushPull: number;
  soft: {
    beginIn: number;
    deltaIn: number;
    beginOut: number;
    deltaOut: number;
    target: number;
  } | null;
  projection: { yRange: number; fading: number } | null;
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
  lateScreen: { value: T.Texture | null };
  materials: T.ShaderMaterial[];
  shapes: T.BufferGeometry[];
}

const sceneDepthInput = 1,
  terrainInput = 2,
  lateColorInput = 4;
function inputMask(l: Layer) {
  return (
    (l.soft
      ? l.groundLayer || l.phases.warpsEarly
        ? terrainInput
        : sceneDepthInput
      : 0) |
    (l.phases.warpsEarly || l.projection ? terrainInput : 0) |
    (l.phases.warpsLate ? lateColorInput : 0)
  );
}
// Keep pass signed across systems. Rank breaks ties within the source definition.
function orderOf(l: Layer, early = l.phases.warpsEarly) {
  if (early) return -1_500_000_000;
  const priority =
    l.pass * 4096 + (l.groundLayer ? l.rank + 1_000_000 : l.rank);
  if (l.groundLayer) return -1_000_000_000 + priority;
  if (l.phases.warpsLate) return 400_000_000;
  return (l.phases.colour === "under" ? 200_000_000 : 650_000_000) + priority;
}
const vertex = /* glsl */ `
attribute vec4 p0,p1,p2,p3,p4,p5,p6,p7,p8,p9;
uniform vec4 flags, uvInfo, uv2Info;
uniform vec2 cells,cells2;
uniform float reach,pivot,beamLength,directed,channelMeshLength;
uniform vec2 beamMeshZ;
uniform vec3 beamStart,beamEnd,cableStart,cableEnd;uniform float cable;
#ifdef ARRIVAL_GROUND
uniform vec3 arrivalForward;
#endif
uniform float pushPull;
varying float nativeScale;
#ifdef DECAL
varying vec3 decalCenter;
varying vec4 decalAxes;
#endif
vec4 projectParticle(vec4 mv){
  vec3 ray=isOrthographic?vec3(0.,0.,-1.):normalize(mv.xyz);
  mv.xyz+=ray*pushPull*length(modelMatrix[0].xyz);
  return projectionMatrix*mv;
}
varying vec2 at,at2,lookup;
varying vec4 frameUV;
varying vec4 tint;
varying float erosion;
vec2 sampleUV(vec2 v,vec4 info,float angle,vec2 scale,vec2 scroll){
 vec2 a=(v-info.xy)*scale;
 float c=cos(angle),s=sin(angle);
 a=vec2(c*a.x-s*a.y,s*a.x+c*a.y)+info.xy+scroll;
 return mix(a,1.-a,info.zw);
}
void main(){
 vec3 center=p0.yzw,size=p1.xyz;
 mat3 axes=mat3(vec3(p3.x,p3.w,p4.z),vec3(p3.y,p4.x,p4.w),vec3(p3.z,p4.y,p5.x));
 vec2 coord=uv; vec3 local=center;
 if(flags.w>0.5){local=position;}
 else if(flags.x==6.){
   vec3 start=cable>.5?cableStart:beamStart;vec3 end=cable>.5?cableEnd:beamEnd+vec3(0.,0.,beamLength), delta=end-start;
   vec3 eye=(inverse(modelMatrix)*vec4(cameraPosition,1.)).xyz;
   vec3 side=normalize(cross(eye-start,delta));float t=position.y+0.5;
   if(flags.z>.5){
     float along=(beamMeshZ.y-position.z)/max(beamMeshZ.y-beamMeshZ.x,.00001);
     vec3 vertical=normalize(cross(delta,side));
     local=mix(start,end,along)+side*position.x*size.x*.5+vertical*position.y*size.y;
   }else{
     local=mix(end-delta*size.z,start+delta*size.y,t)+side*position.x*size.x;
     coord=vec2(t,position.x+.5);
   }
 }else if(flags.z>.5){local+=axes*(position*size); if(channelMeshLength>0.)local.z*=beamLength/channelMeshLength;}
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
   gl_Position=projectParticle(mv);
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
 if(flags.y<.5 || flags.z>.5 || flags.w>.5 || flags.x==6.)gl_Position=projectParticle(modelViewMatrix*vec4(local,1.));
 nativeScale=length(modelMatrix[0].xyz);
#ifdef ARRIVAL_GROUND
 vec3 worldCenter=(modelMatrix*vec4(center,1.)).xyz;
 vec3 f=normalize(mat3(modelMatrix)*arrivalForward), Y=vec3(0.,1.,0.);
 f=normalize(vec3(f.x,0.,f.z));
 vec3 across=normalize(cross(f,Y));
 vec3 world;
 #if ARRIVAL_GROUND == 4
   world=worldCenter+mat3(f,Y,across)*(position*size)*nativeScale;
 #else
   worldCenter.y=1.8;
   if(flags.w>.5){ world=(modelMatrix*vec4(position,1.)).xyz;world.y=1.8; }
   else{
     // Ground-facing adaptations use the old actor's QuadMesh UVs. The
     // source plane's transposed UVs would turn the wavefront along its side.
     if(flags.z<.5)coord=vec2(position.x+.5,.5-position.y);
     vec3 horizontal=mat3(modelMatrix)*axes[0];horizontal.y=0.;
     if(length(horizontal)>.0001 && ARRIVAL_GROUND==1)across=normalize(horizontal);
     if(ARRIVAL_GROUND==3)across=-across;
     world=worldCenter+(across*position.x*size.x+cross(Y,across)*(position.y+pivot)*size.y)*reach*nativeScale;
   }
 #endif
 gl_Position=projectParticle(viewMatrix*vec4(world,1.));
#endif
#ifdef DECAL
 decalCenter=(modelMatrix*vec4(center,1.)).xyz;
 float ca=cos(p2.w),sa=sin(p2.w);
 decalAxes=vec4((mat3(modelMatrix)*vec3(-ca,0.,sa)).xz*size.x,
               (mat3(modelMatrix)*vec3(sa,0.,ca)).xz*size.z);
 gl_Position=vec4(position.xy*2.,0.,1.);
#endif
 frameUV=vec4(p6.zw,p8.yz);
 at=sampleUV(coord,uvInfo,p5.y,p5.zw,p6.xy);
 at2=sampleUV(coord,uv2Info,p7.x,p7.yz,vec2(p7.w,p8.x));

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
 nativeScale=length(modelMatrix[0].xyz);
 gl_Position=projectParticle(modelViewMatrix*vec4(transformed,1.));
 frameUV=vec4(p6.zw,p8.yz);
 at=sampleUV(uv,uvInfo,p5.y,p5.zw,p6.xy);
 at2=sampleUV(uv,uv2Info,p7.x,p7.yz,vec2(p7.w,p8.x));
 tint=vec4(p1.w,p2.xyz);lookup=vec2(p8.w,p9.x);erosion=p9.y;
}`;
const fragment = /* glsl */ `
#include <packing>
uniform sampler2D image,map2,ramp,mask,normalMap,backdrop;
varying float nativeScale;
#ifdef SOFT_DEPTH
uniform sampler2D sceneDepth;
uniform vec2 cameraRange;
uniform vec4 softRange;
uniform vec2 softChannels;
float viewZ(float depth){return isOrthographic ? orthographicDepthToViewZ(depth,cameraRange.x,cameraRange.y) : perspectiveDepthToViewZ(depth,cameraRange.x,cameraRange.y);}
#endif
#ifdef DECAL
uniform sampler2D terrainDepth;
uniform mat4 unproject;
uniform vec2 heightFade;
varying vec3 decalCenter;
varying vec4 decalAxes;
#endif
uniform vec4 has,erosionMixer;
uniform vec3 band;
uniform vec2 address,screenSize,cells,cells2;
uniform vec4 flags;
uniform float alphaRef,warp,hasBackdrop,blendMode;
varying vec2 at,at2,lookup;
varying vec4 frameUV;
varying vec4 tint; varying float erosion;
// Keep the continuous derivatives. Differentiating fract(uv) across a tile
// boundary selects the smallest mip there and outlines otherwise clear quads.
vec4 sampleCell(sampler2D tex,vec2 uv,vec2 cell,vec2 origin,float mode,bool transposeUV){
 vec2 dx=dFdx(uv)*cell,dy=dFdy(uv)*cell;
 if(mode==3. && (any(lessThan(uv,vec2(0.))) || any(greaterThan(uv,vec2(1.)))))return vec4(0.);
 vec2 local=mode>=2.?clamp(uv,0.,1.):mode==1.?1.-abs(mod(uv,2.)-1.):fract(uv);
 vec2 inset=min(.5*cell,.5/vec2(textureSize(tex,0)));
 vec2 offset=local*cell;
 // Full wrap textures should filter across the seam. Clamp and atlas
 // cells use only their own edge texels, even with a repeat sampler.
 if(mode!=0. || cell.x<1.)offset.x=clamp(offset.x,inset.x,cell.x-inset.x);
 if(mode!=0. || cell.y<1.)offset.y=clamp(offset.y,inset.y,cell.y-inset.y);
 vec2 pos=origin+offset;
 return transposeUV?textureGrad(tex,pos.yx,dx.yx,dy.yx):textureGrad(tex,pos,dx,dy);
}
void main(){
 vec4 c=tint;
 if(warp==0.&&(blendMode==0.||blendMode==2.)){c.rgb*=c.a;c.a=1.;}
 vec2 uv=at;
#ifdef DECAL
 vec2 screen=gl_FragCoord.xy/screenSize;
 float surface=texture2D(terrainDepth,screen).r;
 if(surface>=1.)discard;
 vec4 point=unproject*vec4(vec3(screen,surface)*2.-1.,1.);
 vec3 ground=point.xyz/point.w;
 vec2 dx=ground.xz-decalCenter.xz;
 mat2 axes=mat2(decalAxes.xy,decalAxes.zw);
 if(abs(determinant(axes))<.0001)discard;
 uv=(inverse(axes)*dx)*vec2(.5,-.5)+.5;
 if(any(lessThan(uv,vec2(0.)))||any(greaterThan(uv,vec2(1.))))discard;
 c.a*=1.-clamp((abs(ground.y-decalCenter.y)/max(nativeScale,.00001)-heightFade.x)/max(heightFade.y,.00001),0.,1.);
 gl_FragDepth=surface;
#endif
 bool beam=flags.x==6. && flags.z<.5;
 vec4 v=sampleCell(image,uv,cells,frameUV.xy,address.x,beam)*c;
 if(has.y>.5)v*=texture2D(ramp,clamp(has.x>.5?frameUV.zw+at2*cells2:lookup,0.,1.));
 if(has.x>.5)v*=sampleCell(map2,at2,cells2,frameUV.zw,address.y,beam);
 if(has.z>.5){float m=dot(sampleCell(mask,frameUV.xy+at*cells,vec2(1.),vec2(0.),address.x,beam),erosionMixer);v.a*=clamp((erosion-m+band.x)*band.y,0.,1.)-clamp((erosion-m)*band.z,0.,1.);}
#ifdef SOFT_DEPTH
 float previous=texture2D(sceneDepth,gl_FragCoord.xy/screenSize).r;
 float gap=(viewZ(gl_FragCoord.z)-viewZ(previous))/max(nativeScale,.00001);
 vec2 eased=smoothstep(vec2(0.),vec2(1.),(gap-softRange.xy)*softRange.zw);
 float fade=eased.x-eased.y;
 v*=vec4(vec3(mix(1.,fade,softChannels.x)),mix(1.,fade,softChannels.y));
#endif
 if(v.a<=alphaRef)discard;
 if(blendMode==3.)v.a=1.;
#ifdef WARP
 {
   if(hasBackdrop<.5)discard;
   vec4 normal=sampleCell(normalMap,at,cells,frameUV.xy,address.x,beam);
   float coverage=v.a*normal.a;
   if(coverage<=0.)discard;
   vec2 delta=(normal.rg*2.-1.)*warp*coverage*vec2(screenSize.y/screenSize.x,1.);
   vec4 ground=texture2D(backdrop,clamp(gl_FragCoord.xy/screenSize+delta,0.,1.));
   if(ground.a<=0.)discard;
   v=linearToOutputTexel(vec4(ground.rgb/ground.a,coverage*ground.a));
 }
#else
 v=linearToOutputTexel(vec4(sRGBTransferEOTF(v).rgb,v.a));
#endif

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
  readonly earlyScreen = { value: null as T.Texture | null };
  readonly sceneDepth = { value: null as T.DepthTexture | null };
  readonly terrainDepth = { value: null as T.DepthTexture | null };
  readonly unproject = { value: new T.Matrix4() };
  readonly cameraRange = { value: new T.Vector2() };
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
    const soft = l.soft;
    const warps = l.phases.warpsEarly || l.phases.warpsLate;
    const bias = l.depthBias.some(Boolean)
      ? l.depthBias
      : l.projection || l.quadType === 11
        ? [-1, -1]
        : [0, 0];
    const m = new T.ShaderMaterial({
      defines: {
        ...(warps ? { WARP: 1 } : {}),
        ...(soft ? { SOFT_DEPTH: 1 } : {}),
        ...(l.projection ? { DECAL: 1 } : {}),
      },
      polygonOffset: bias.some(Boolean),
      polygonOffsetFactor: bias[0],
      polygonOffsetUnits: bias[1],
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
        cable: { value: 0 },
        cableStart: { value: new T.Vector3() },
        cableEnd: { value: new T.Vector3() },
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
        beamMeshZ: { value: new T.Vector2(-10, 10) },
        channelMeshLength: { value: 0 },
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
        warp: { value: warps ? (l.distortion?.strength ?? 0) : 0 },
        pushPull: { value: l.depthPushPull },
        sceneDepth:
          l.groundLayer || l.phases.warpsEarly
            ? this.terrainDepth
            : this.sceneDepth,
        terrainDepth: this.terrainDepth,
        unproject: this.unproject,
        cameraRange: this.cameraRange,
        heightFade: {
          value: new T.Vector2(l.projection?.yRange, l.projection?.fading),
        },
        softRange: {
          value: soft
            ? new T.Vector4(
                soft.beginIn,
                soft.beginOut > 0 ? soft.beginOut : 1e8,
                1 / Math.max(soft.deltaIn, 1e-8),
                1 / Math.max(soft.deltaOut, 1e-8),
              )
            : new T.Vector4(),
        },
        softChannels: {
          value: new T.Vector2(
            Number(soft?.target !== 2),
            Number(soft?.target !== 1),
          ),
        },
        blendMode: { value: l.blendMode },
        backdrop: l.phases.warpsEarly ? this.earlyScreen : this.screen,
        screenSize: this.size,
        hasBackdrop: this.hasScreen,
      },
    });
    if (!warps) {
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
      // Light and modulation change destination RGB without covering the terrain.
      const keepCoverage = [0, 2, 4].includes(l.blendMode);
      m.blendSrcAlpha = keepCoverage ? T.ZeroFactor : T.OneFactor;
      m.blendDstAlpha =
        keepCoverage || l.blendMode === 8
          ? T.OneFactor
          : T.OneMinusSrcAlphaFactor;
      m.blendEquationAlpha = T.AddEquation;
      if (l.blendMode === 3) {
        m.blending = T.NoBlending;
        m.transparent = false;
        m.depthWrite = true;
      }
    }
    if (l.groundLayer) m.transparent = false;
    if (l.phases.warpsEarly) {
      m.transparent = false;
      m.blending = T.CustomBlending;
      m.blendSrc = T.SrcAlphaFactor;
      m.blendDst = T.OneMinusSrcAlphaFactor;
      m.blendSrcAlpha = T.OneFactor;
      m.blendDstAlpha = T.OneMinusSrcAlphaFactor;
    }
    m.userData.beforeLate =
      l.groundLayer ||
      l.phases.warpsEarly ||
      l.phases.colour === "under" ||
      l.blendMode === 3;
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
    // Static hosts serve either a gzip file or an HTTP gzip response which
    // fetch has already decoded. Inspect the payload before unpacking it.
    const file = await res.blob();
    const signature = new Uint8Array(await file.slice(0, 2).arrayBuffer());
    const buf =
      signature[0] === 0x1f && signature[1] === 0x8b
        ? await new Response(
            file.stream().pipeThrough(new DecompressionStream("gzip")),
          ).arrayBuffer()
        : await file.arrayBuffer();
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
    if (name.startsWith("pantheon/")) {
      const part = name.slice(9);
      for (const [i, l] of h.layers.entries()) {
        const mat = materials[i];
        const projection = arrivalGround[part]?.[l.name];
        if (projection) {
          mat.defines.ARRIVAL_GROUND = projection;
          mat.uniforms.arrivalForward = {
            value:
              part === "landing"
                ? new T.Vector3(0, 0, 1)
                : part === "aftershock"
                  ? new T.Vector3(1, 0, 0)
                  : new T.Vector3(0, 1, 0),
          };
        }
        if (
          part === "damage" &&
          (l.name === "Air Streak 1" || l.name === "Air Streak 2")
        ) {
          const geom = shapes[i];
          geom.computeBoundingBox();
          const centerZ = geom.boundingBox!.getCenter(new T.Vector3()).z;
          for (let frame = 0; frame < h.frames; frame++) {
            const slot = frame * h.layers.length + i;
            for (let j = offsets[slot]; j < offsets[slot + 1]; j++) {
              const r = j * h.width;
              // WAD +X is mirrored in web space. Center the pair at +/-125 source units.
              rows[r + 1] += 125 - rows[r + 14] * rows[r + 6] * centerZ;
              rows[r + 2] -= rows[r + 17] * rows[r + 6] * centerZ;
              rows[r + 3] -= rows[r + 20] * rows[r + 6] * centerZ;
            }
          }
        }
      }
    }
    return { ...h, lateScreen: this.screen, offsets, rows, shapes, materials };
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
  secondWarp?: T.ShaderMaterial;
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
  onlyLayers?: ReadonlySet<string>;
  fieldRadius?: number;
  deathAge?: number;
  overlayTime?: number;
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
  inputs = 0;
  cableStart?: T.Vector3;
  cableEnd?: T.Vector3;
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
      old.secondWarp?.dispose();
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
    mesh.renderOrder = orderOf(layer);
    // The gate draws both BirthSpit layers above the idle ball (native pass 999).
    if (this.name === "void_gate/spit") mesh.renderOrder += 1000 * 4096;
    let secondWarp: T.ShaderMaterial | undefined;
    if (layer.phases.warpsEarly && layer.phases.warpsLate) {
      secondWarp = this.track.materials[i].clone();
      secondWarp.uniforms = {
        ...this.track.materials[i].uniforms,
        backdrop: this.track.lateScreen,
      };
      secondWarp.transparent = true;
      secondWarp.userData.beforeLate = false;
      const late = new T.Mesh(geo, secondWarp);
      late.frustumCulled = false;
      late.renderOrder = orderOf(layer, false);
      mesh.add(late);
    }
    const boundMesh = this.name === "aurelionsol_q" && !!layer.meshFile;
    if (layer.quadType === 6 && layer.meshFile) {
      const shape = this.track.shapes[i];
      shape.computeBoundingBox();
      this.track.materials[i].uniforms.beamMeshZ.value.set(
        shape.boundingBox!.min.z,
        shape.boundingBox!.max.z,
      );
    }
    if (boundMesh || layer.quadType === 6)
      mesh.onBeforeRender = () => {
        const m = this.track.materials[i];
        m.uniforms.cable.value = this.cableStart ? 1 : 0;
        if (this.cableStart && this.cableEnd) {
          m.uniforms.cableStart.value.copy(this.cableStart);
          m.uniforms.cableEnd.value.copy(this.cableEnd);
        }
        m.uniforms.beamLength.value = this.beamLength;
        m.uniforms.channelMeshLength.value = boundMesh ? 350 : 0;
        m.uniformsNeedUpdate = true;
      };
    this.root.add(mesh);
    const batch = { mesh, data, capacity, secondWarp };
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
        mesh.renderOrder = orderOf(this.track.layers[layer]);
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
    if (
      this.overlayTime !== undefined &&
      this.track.layers[layer].name === "Additive_Tent_Lines"
    )
      group.material.uniforms.p8.value.x +=
        0.1 * Math.max(0, this.overlayTime - 1);
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
    if (group.meshes.some((mesh) => mesh.visible))
      this.inputs |= inputMask(this.track.layers[layer]);
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
    this.inputs = 0;
    const point = new T.Vector3(),
      prev = new T.Vector3(),
      side = new T.Vector3(),
      previousSide = new T.Vector3();
    for (const group of this.overlays.values())
      for (const mesh of group.meshes) mesh.visible = false;
    for (let i = 0; i < t.layers.length; i++) {
      const layer = t.layers[i],
        trail = [4, 5].includes(layer.quadType);
      const pillar =
        this.fieldRadius !== undefined && this.name === "pillar_of_ice/pillar";
      const layerFrame = pillar
        ? Math.min(
            t.frames - 1,
            Math.floor(pillarLayerAge(layer.name, age, this.deathAge) * t.fps),
          )
        : fi;
      const at = layerFrame * t.layers.length + i,
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
        (this.onlyLayers && !this.onlyLayers.has(layer.name)) ||
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
      if (pillar)
        batch.mesh.scale.setScalar(
          pillarLayerScale(layer.name, this.fieldRadius!),
        );
      const particleSize =
        this.name === "jax/cas"
          ? 2
          : layer.name === "CenterRange" &&
              this.name.startsWith("mega_inferno_bomb/warning")
            ? (0.5 * 16.8) / 8
            : 1;
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
        this.localPoint(
          row,
          trail ? 0 : this.name === "sivir/shield" ? 1 : layer.bind,
          moving,
          point,
        );
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
          if (particleSize !== 1) {
            for (let axis = 4; axis < 7; axis++)
              batch.data.array[offset + axis] *= particleSize;
          }
          if (this.deathAge !== undefined)
            batch.data.array[offset + 10] *= Math.max(
              0,
              1 - this.deathAge / 0.8,
            );
        }
      }
      if (trail) {
        geo.setDrawRange(0, Math.max(0, (count / 2 - 1) * 6));
        geo.attributes.position.needsUpdate = true;
        geo.attributes.uv.needsUpdate = true;
      } else (geo as T.InstancedBufferGeometry).instanceCount = count;
      batch.mesh.visible = trail ? count >= 4 : count > 0;
      if (batch.mesh.visible) {
        this.inputs |= inputMask(layer);
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
    for (const batch of this.batches.values()) {
      batch.mesh.geometry.dispose();
      batch.secondWarp?.dispose();
    }
    this.batches.clear();
    this.path = [];
  }
}

// Snapshot terrain alone for projectors and early distortion, opaque scene depth
// for soft particles, and the scene with its under-layers for late distortion.
export class ParticleBackdrop {
  private targets = new Map<number, T.WebGLRenderTarget>();
  constructor(private library: ParticleLibrary) {}
  capture(
    renderer: T.WebGLRenderer,
    scene: T.Scene,
    camera: T.Camera,
    effects: T.Object3D,
    needs: number,
    characters: readonly T.Object3D[] = [],
  ) {
    const lib = this.library;
    lib.hasScreen.value = 0;
    if (!needs) return;
    const size = renderer.getDrawingBufferSize(lib.size.value);
    const view = camera as T.OrthographicCamera | T.PerspectiveCamera;
    lib.cameraRange.value.set(view.near, view.far);
    camera.updateMatrixWorld();
    lib.unproject.value.multiplyMatrices(
      camera.matrixWorld,
      camera.projectionMatrixInverse,
    );
    const previous = renderer.getRenderTarget();
    const hidden: T.Object3D[] = [];
    const hide = (o: T.Object3D) => {
      if (o.visible) {
        hidden.push(o);
        o.visible = false;
      }
    };
    const restore = () => {
      for (const o of hidden) o.visible = true;
      hidden.length = 0;
    };
    const capture = (key: number) => {
      let target = this.targets.get(key);
      if (!target) {
        target = new T.WebGLRenderTarget(size.x, size.y, {
          colorSpace: T.SRGBColorSpace,
        });
        if (key !== lateColorInput)
          target.depthTexture = new T.DepthTexture(
            size.x,
            size.y,
            T.UnsignedIntType,
          );
        this.targets.set(key, target);
      }
      target.setSize(size.x, size.y);
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      return target;
    };
    try {
      if (needs & terrainInput) {
        hide(effects);
        characters.forEach(hide);
        const terrain = capture(terrainInput);
        lib.terrainDepth.value = terrain.depthTexture;
        lib.earlyScreen.value = terrain.texture;
        restore();
      }
      if (needs & sceneDepthInput) {
        effects.traverse((o) => {
          if (
            o instanceof T.Mesh &&
            (!o.material.depthWrite || o.material.defines?.SOFT_DEPTH)
          )
            hide(o);
        });
        lib.sceneDepth.value = capture(sceneDepthInput).depthTexture;
        restore();
      }
      lib.hasScreen.value = 1;
      if (needs & lateColorInput) {
        effects.traverse((o) => {
          if (o instanceof T.Mesh && !o.material.userData.beforeLate) hide(o);
        });
        lib.screen.value = capture(lateColorInput).texture;
      }
    } finally {
      restore();
      renderer.setRenderTarget(previous);
    }
  }
  dispose() {
    for (const target of this.targets.values()) target.dispose();
    this.targets.clear();
  }
}
