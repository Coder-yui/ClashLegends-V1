import {
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  PlaneGeometry,
  ShaderMaterial,
} from "three";
import type { Unit } from "./battle-field";
import { showsTeamRing, visualRadius } from "./health-bars";

export function deployProgress(u: Unit, tick: number) {
  const start = u.deployStart ?? u.since;
  const end = u.readyTick ?? 0;
  if (
    end <= tick ||
    end <= start ||
    tick < start ||
    u.bar?.recoveryTicks ||
    u.controls.includes("Stasis")
  )
    return -1;
  return Math.max(0, Math.min(1, (tick - start) / (end - start)));
}

// One ground pass for both affiliations and deployment arcs, depth-tested
// against the actual posed meshes. Grow only if the live actor count needs it.
export class GroundMarks {
  readonly mesh: InstancedMesh;
  private data: InstancedBufferAttribute;
  private transform = new Matrix4();
  constructor(readonly capacity: number) {
    const ground = new PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
    this.data = new InstancedBufferAttribute(
      new Float32Array(capacity * 4),
      4,
    ).setUsage(DynamicDrawUsage);
    ground.setAttribute("mark", this.data);
    const material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      toneMapped: false,
      vertexShader: `attribute vec4 mark;
        varying vec4 style;
        varying vec2 offset;
        void main() {
          style = mark;
          offset = position.xz * max(mark.x+8.,18.);
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position,1.);
        }`,
      fragmentShader: `varying vec4 style;
        varying vec2 offset;
        void main() {
          float d=length(offset);
          float aa=max(fwidth(d),0.05);
          float disk=style.w*(1.-smoothstep(max(style.x,16.8)-aa,max(style.x,16.8)+aa,d));
          float angle=mod(atan(offset.x,-offset.y)+6.2831853,6.2831853);
          float arc=(angle < style.y*6.2831853 ? 1. : 0.) *
            (1.-smoothstep(1.5-aa,1.5+aa,abs(d-style.x-6.)));
          float alpha=max(arc,disk*0.72);
          if(alpha<=0.) discard;
          vec3 tint=mix(vec3(1.,0.24,0.18),vec3(0.20,0.55,1.),style.z);
          gl_FragColor=vec4(mix(tint,vec3(1.),arc),alpha);
        }`,
    });
    this.mesh = new InstancedMesh(ground, material, capacity);
    this.mesh.renderOrder = -100;
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.count = 0;
  }
  update(
    units: Unit[],
    me: number,
    width: number,
    height: number,
    tick: number,
  ) {
    let count = 0;
    for (const u of units) {
      if (u.kind === "nexus" || u.kind === "princess_tower") continue;
      const radius = visualRadius(u),
        progress = deployProgress(u, tick),
        disk = showsTeamRing(u);
      if (!disk && progress < 0) continue;
      const sign = me ? -1 : 1,
        extent = Math.max(radius + 8, 18);
      this.transform
        .makeScale(extent, 1, extent)
        .setPosition(sign * (u.x - width / 2), 0.4, sign * (u.y - height / 2));
      this.mesh.setMatrixAt(count, this.transform);
      this.data.setXYZW(
        count++,
        radius,
        progress,
        Number(me === u.team),
        Number(disk),
      );
    }
    this.mesh.count = count;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.data.needsUpdate = true;
  }
  dispose() {
    this.mesh.removeFromParent();
    this.mesh.dispose();
    this.mesh.geometry.dispose();
    (this.mesh.material as ShaderMaterial).dispose();
  }
}
