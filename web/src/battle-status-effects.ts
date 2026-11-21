import {
  AdditiveBlending,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshPhongMaterial,
  Object3D,
  ShaderMaterial,
  SkinnedMesh,
  SphereGeometry,
  PlaneGeometry,
  Vector3,
} from "three";
import type { Unit } from "./battle-field";

type Status = "pix" | "regeneration" | "ward";
const quad = new PlaneGeometry();
const shell = new SphereGeometry(1, 30, 22);
const billboard = `
varying vec2 tex;
void main(){
  tex=uv;
  vec4 p=modelViewMatrix*vec4(0.,0.,0.,1.);
  p.xy+=position.xy*vec2(length(modelMatrix[0].xyz),length(modelMatrix[1].xyz));
  gl_Position=projectionMatrix*p;
}`;
const wispShader = `
varying vec2 tex;
uniform vec3 tint;
uniform float opacity,phase,side;
void main(){
  float bend=sin(tex.y*5.+phase*5.)*.12*side;
  float width=pow(max(0.,1.-abs(tex.x-.5-bend)*2.5),2.);
  float ends=smoothstep(0.,.22,tex.y)*(1.-smoothstep(.55,1.,tex.y));
  gl_FragColor=vec4(tint,width*ends*opacity);
}`;
const sandShader = `
varying vec2 tex;
uniform float opacity;
void main(){
  vec2 p=(tex-.5)*2.;
  gl_FragColor=vec4(1.,.72,.26,pow(max(0.,1.-dot(p,p)),2.)*opacity);
}`;

class StatusModel {
  readonly root = new Group();
  private sprites: Mesh<PlaneGeometry, ShaderMaterial>[] = [];
  private overlays: Mesh[] = [];
  private surface?: MeshPhongMaterial;
  private barrier?: Mesh<SphereGeometry, ShaderMaterial>;
  constructor(
    readonly kind: Status,
    readonly owner: Object3D,
    sources: readonly Mesh[],
  ) {
    const ward = kind === "ward",
      pix = kind === "pix";
    if (ward) {
      this.barrier = new Mesh(
        shell,
        new ShaderMaterial({
          uniforms: { age: { value: 0 } },
          transparent: true,
          depthWrite: false,
          blending: AdditiveBlending,
          vertexShader: `varying vec3 n,v;varying vec2 tex;void main(){vec4 p=modelViewMatrix*vec4(position,1.);n=normalMatrix*normal;v=-p.xyz;tex=uv;gl_Position=projectionMatrix*p;}`,
          fragmentShader: `varying vec3 n,v;varying vec2 tex;uniform float age;void main(){float rim=pow(1.-abs(dot(normalize(n),normalize(v))),3.);float band=pow(.5+.5*sin(tex.y*65.-age*7.+sin(tex.x*40.)),8.);float gain=1.-smoothstep(.12,.4,age);gl_FragColor=vec4(1.,.64,.12,rim*(.23+.1*band+.2*gain)+band*.012);}`,
        }),
      );
      this.root.add(this.barrier);
    } else {
      const surface = (this.surface = new MeshPhongMaterial({
        color: 0,
        emissive: pix ? 0xff1308 : 0x982aff,
        transparent: true,
        opacity: 0.28,
        side: DoubleSide,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      }));
      surface.onBeforeCompile = (s) => {
        s.fragmentShader = s.fragmentShader.replace(
          "#include <opaque_fragment>",
          "diffuseColor.a *= 1. + .65*pow(1.-abs(dot(normalize(normal),normalize(vViewPosition))),1.6);\n#include <opaque_fragment>",
        );
      };
      // Reuse the imported body geometry and the live skeleton, including wing motion.
      for (const body of sources) {
        const overlay = body.clone(false);
        overlay.material = surface;
        overlay.position.set(0, 0, 0);
        overlay.quaternion.identity();
        overlay.scale.setScalar(1);
        if (body instanceof SkinnedMesh && overlay instanceof SkinnedMesh)
          overlay.skeleton = body.skeleton;
        overlay.renderOrder = 8;
        body.add(overlay);
        this.overlays.push(overlay);
      }
    }
    for (let i = 0; i < (ward ? 24 : pix ? 5 : 9); i++) {
      const mat = new ShaderMaterial({
        vertexShader: billboard,
        fragmentShader: ward ? sandShader : wispShader,
        uniforms: {
          tint: { value: new Color(pix ? 0xff2010 : 0xac4dff) },
          opacity: { value: 0 },
          phase: { value: 0 },
          side: { value: 0 },
        },
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
      });
      const part = new Mesh(quad, mat);
      part.scale.set(
        ward ? 2.4 : pix ? 6.4 : 9.6,
        ward ? 3.6 : pix ? 22 : 30,
        1,
      );
      part.renderOrder = 9;
      this.sprites.push(part);
      this.root.add(part);
    }
  }
  sample(age: number, point: Vector3) {
    this.root.position.copy(point);
    const ward = this.kind === "ward",
      pix = this.kind === "pix";
    const t = Math.max(0, Math.min(1, age / 0.38)),
      gather = 1 - t * t * (3 - 2 * t);
    if (this.barrier) {
      this.barrier.scale.set(28, 50, 28).multiplyScalar(1 + 0.15 * gather);
      this.barrier.material.uniforms.age.value = age;
    }
    if (this.surface)
      this.surface.opacity = 0.28 * (0.8 + 0.2 * Math.sin(age * 7));
    this.sprites.forEach((s, i) => {
      const uniforms = s.material.uniforms;
      if (ward) {
        const angle = i * 2.39996 + age * 0.7,
          h = -0.95 + ((i * 0.173 + age * 0.24) % 1.9);
        const r =
          0.66 * Math.sqrt(Math.max(0.1, 1 - (h / 1.3) ** 2)) + gather * 0.65;
        s.position
          .set(Math.cos(angle) * r, h, Math.sin(angle) * r)
          .multiplyScalar(40);
        uniforms.opacity.value = 0.5 + gather * 0.4;
      } else {
        const pair = Math.max(0, Math.floor((i - 1) / 2)),
          p = (age - (pair % 3) * 0.075) / 0.65;
        s.visible = p >= 0 && p < 1;
        if (!s.visible) return;
        const side = i === 0 ? 0 : i % 2 === 1 ? 1 : -1,
          ang = (Math.PI * pair) / ((this.sprites.length - 1) / 2);
        s.position
          .set(
            side * Math.cos(ang) * (pix ? 0.22 : 0.38),
            (pix ? -0.25 : -0.6) + (pix ? 1.05 : 1.65) * p,
            side * Math.sin(ang) * (pix ? 0.22 : 0.38),
          )
          .multiplyScalar(40);
        uniforms.phase.value = p + pair * 0.7;
        uniforms.side.value = side;
        uniforms.opacity.value = Math.sin(Math.PI * p) * 0.9;
      }
    });
  }
  dispose() {
    for (const o of this.overlays) o.removeFromParent();
    this.surface?.dispose();
    this.barrier?.material.dispose();
    for (const s of this.sprites) s.material.dispose();
    this.root.removeFromParent();
  }
}
export class StatusModels {
  readonly root = new Group();
  private entries = new Map<number, StatusModel>();
  sample(
    u: Unit,
    tick: number,
    model: Object3D | undefined,
    skin: () => readonly Mesh[],
    socket: (name: string) => Object3D | undefined,
  ) {
    const v = u.visual;
    const kind =
      v?.lifestealStart != null
        ? "pix"
        : v?.regenerationUntil
          ? "regeneration"
          : v?.sandWardUntil
            ? "ward"
            : undefined;
    if (!kind || !model) return false;
    const start =
      kind === "pix"
        ? v!.lifestealStart!
        : kind === "ward"
          ? v!.sandWardUntil! - 40
          : v!.regenerationUntil! - 60;
    let entry = this.entries.get(u.id);
    if (!entry || entry.owner !== model || entry.kind !== kind) {
      entry?.dispose();
      entry = new StatusModel(kind, model, skin());
      this.entries.set(u.id, entry);
      this.root.add(entry.root);
    }
    const point = (
      socket(kind === "pix" ? "spine" : "Root") ?? model
    ).getWorldPosition(new Vector3());
    entry.sample(Math.max(0, tick - start) / 20, point);
    return true;
  }
  retain(ids: Set<number>) {
    for (const [id, e] of this.entries)
      if (!ids.has(id)) {
        e.dispose();
        this.entries.delete(id);
      }
  }
}

const surfaceVertex = `varying vec2 tex;void main(){tex=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`;
const zoneShader = `varying vec2 tex;uniform float elapsed,strength;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
float noise(vec2 p) {
 vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
 return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);
}
float mist(vec2 p) { return noise(p)*0.58 + noise(p*2.1+3.7)*0.28 + noise(p*4.3)*0.14; }
void main() {
 vec2 p=tex*2.0-1.0;
 float r=length(p), a=atan(p.y,p.x);
 float clip=1.0-smoothstep(0.985,1.0,r);
 float t=elapsed;
 float rot=t*0.24-r*2.4;
 vec2 q=mat2(vec2(cos(rot),sin(rot)),vec2(-sin(rot),cos(rot)))*p;
 float clouds=mist(q*5.0+vec2(t*0.13,-t*0.10));
 float veins=pow(1.0-abs(sin(a*5.0+r*10.0-t*1.5+clouds*3.0)),12.0);
 float spiral=pow(0.5+0.5*sin(a*3.0+r*15.0+t*2.0+clouds*2.0),8.0);
 float corona=exp(-pow((r-(0.88+0.018*sin(a*9.0-t*2.0)))*36.0,2.0));
 float boundary=exp(-pow((r-0.975)*100.0,2.0))*(0.45+0.30*sin(a*12.0+t*2.2));
 float fragments=pow(max(0.0,sin(a*19.0-t*1.2)),18.0)*exp(-pow((r-0.77)*28.0,2.0));
 float pulse=0.80+0.20*cos(t*12.56637);
 float energy=(0.30*veins+0.26*spiral)*smoothstep(0.08,0.40,r)+corona*0.65*pulse+fragments*0.7+boundary;
 vec3 deep=mix(vec3(0.045,0.008,0.09),vec3(0.22,0.025,0.37),clouds);
 vec3 rgb=deep+vec3(0.52,0.12,0.85)*energy;
 gl_FragColor=vec4(rgb,strength*clip*(0.55+0.16*clouds+0.22*clamp(energy,0.0,1.0)));
}
`;
const smokeShader = `varying vec2 tex;uniform float fade;uniform vec3 tint;uniform float progress;
void main() {
 vec2 p = (tex - vec2(0.5)) * 2.0;
 float ripple = sin(p.x * 12.0 + progress * 6.0) * sin(p.y * 9.0 - progress * 4.0);
 float cloud = pow(max(1.0 - length(p) + ripple * 0.10, 0.0), 1.5);
 vec3 rgb=tint;
 gl_FragColor=vec4(rgb,cloud * fade * 0.48);
}
`;
const streakShader = `varying vec2 tex;uniform float fade;uniform bool inward;
void main() {
 float across = pow(max(1.0 - abs(tex.x * 2.0 - 1.0), 0.0), 1.8);
 float head = inward ? 1.0 - tex.y : tex.y;
 float taper = smoothstep(0.0, 0.2, head) * (1.0 - smoothstep(0.75, 1.0, head));
 vec3 rgb=mix(vec3(0.16, 0.68, 0.26), vec3(0.40, 0.78, 0.30), head);
 gl_FragColor=vec4(rgb,across * taper * fade * 0.46);
}
`;
const waveShader = `varying vec2 tex;uniform float fade;
void main() {
 vec2 p = (tex - vec2(0.5)) * 2.0;
 float r = length(p);
 float rim = exp(-pow((r - 0.82) * 19.0, 2.0));
 float wisps = 0.65 + 0.35 * sin(atan(p.y, p.x) * 9.0 + r * 16.0);
 vec3 rgb=vec3(0.25, 0.72, 0.28);
 gl_FragColor=vec4(rgb,rim * wisps * fade * 0.22);
}
`;

export class BattleGroundEffects {
  readonly root = new Group();
  private zones = new Map<number, Mesh<PlaneGeometry, ShaderMaterial>>();
  private transitions = new Map<
    number,
    { start: number; enter: boolean; root: Group; materials: ShaderMaterial[] }
  >();
  zone(id: number, position: Vector3, radius: number, age: number) {
    let mesh = this.zones.get(id);
    if (!mesh) {
      const mat = new ShaderMaterial({
        vertexShader: surfaceVertex,
        fragmentShader: zoneShader,
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
        uniforms: { elapsed: { value: 0 }, strength: { value: 0 } },
      });
      mesh = new Mesh(quad, mat);
      mesh.rotation.x = -Math.PI / 2;
      this.root.add(mesh);
      this.zones.set(id, mesh);
    }
    mesh.position.copy(position);
    mesh.scale.setScalar(radius * 2);
    mesh.material.uniforms.elapsed.value = age;
    mesh.material.uniforms.strength.value = Math.min(
      1,
      age / 0.1,
      Math.max(0, 5 - age) / 0.2,
    );
  }
  stealth(id: number, start: number, enter: boolean, point: Vector3) {
    this.dropTransition(id);
    const root = new Group();
    root.position.copy(point);
    const materials = [smokeShader, streakShader, waveShader].map(
      (fragmentShader, i) =>
        new ShaderMaterial({
          vertexShader: i === 0 ? billboard : surfaceVertex,
          fragmentShader,
          transparent: true,
          depthWrite: false,
          side: DoubleSide,
          ...(i ? { blending: AdditiveBlending } : {}),
          uniforms: {
            fade: { value: 0 },
            progress: { value: 0 },
            tint: {
              value: enter
                ? new Color(0.2, 0.72, 0.4)
                : new Color(0.56, 0.82, 0.16),
            },
            inward: { value: enter },
          },
        }),
    );
    for (let i = 0; i < 22; i++) {
      const m = new Mesh(quad, materials[i < 12 ? 0 : i < 21 ? 1 : 2]);
      if (i >= 12) {
        m.rotation.order = "YXZ";
        m.rotation.x = -Math.PI / 2;
        m.rotation.y = (-2 * Math.PI * (i - 12)) / 9;
      }
      root.add(m);
    }
    this.root.add(root);
    this.transitions.set(id, { start, enter, root, materials });
  }
  private dropTransition(id: number) {
    const e = this.transitions.get(id);
    if (e) {
      e.root.removeFromParent();
      for (const m of e.materials) m.dispose();
      this.transitions.delete(id);
    }
  }
  sample(tick: number, zones: Set<number>) {
    for (const [id, m] of this.zones)
      if (!zones.has(id)) {
        m.removeFromParent();
        m.material.dispose();
        this.zones.delete(id);
      }
    for (const [id, e] of this.transitions) {
      const t = (tick - e.start) / (e.enter ? 13 : 9);
      if (t >= 1 || t < 0) {
        this.dropTransition(id);
        continue;
      }
      const a = e.enter ? t * t : 1 - (1 - t) ** 2,
        lerp = (from: number, to: number) => from + (to - from) * a;
      const smooth = (t: number) => {
        const f = Math.min(1, Math.max(0, t));
        return f * f * (3 - 2 * f);
      };
      e.materials.forEach((m) => {
        m.uniforms.fade.value =
          smooth(t / 0.1) * (1 - smooth((t - 0.58) / 0.42));
        m.uniforms.progress.value = t;
      });
      e.root.children.forEach((m, i) => {
        if (i === 21) {
          m.scale.setScalar(
            80 * (e.enter ? lerp(1.35, 0.12) : lerp(0.22, 1.45)),
          );
          m.position.y = 3.2;
          return;
        }
        const puff = i < 12,
          n = puff ? i : i - 12,
          angle =
            (Math.PI * 2 * n) / (puff ? 12 : 9) +
            (puff ? (e.enter ? 0.2 : 0.06) * a : 0),
          spread = 1 + 0.14 * Math.sin(n * 2.4);
        const radius = puff
          ? e.enter
            ? lerp(1.05 * spread, 0.1)
            : lerp(0.16, 1.2 * spread)
          : e.enter
            ? lerp(1.05, 0.12)
            : lerp(0.25, 1.25);
        const h = puff
          ? e.enter
            ? lerp(0.25 + (n % 4) * 0.27, 0.65)
            : 0.35 + (n % 4) * 0.22 + a * 0.25
          : 0.3 + (n % 3) * 0.25;
        m.position
          .set(Math.cos(angle) * radius, h, Math.sin(angle) * radius)
          .multiplyScalar(40);
        if (puff)
          m.scale.setScalar(40 * (e.enter ? lerp(0.65, 0.3) : lerp(0.4, 0.75)));
        else
          m.scale.set(
            4.4,
            22 * (e.enter ? lerp(1.2, 0.25) : lerp(0.45, 1.25)),
            1,
          );
      });
    }
  }
  reset() {
    for (const id of this.transitions.keys()) this.dropTransition(id);
    this.sample(0, new Set());
  }
}
