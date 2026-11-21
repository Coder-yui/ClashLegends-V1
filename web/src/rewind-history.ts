import { Bone, Mesh, Object3D, Quaternion, SkinnedMesh, Vector3 } from "three";
import { clone } from "three/addons/utils/SkeletonUtils.js";

interface Pose {
  tick: number;
  position: Vector3;
  rotation: Quaternion;
  joints: Float32Array;
}

// One detached skeleton per visible Ekko. Only the native overlay draws it.
export class RewindHistory {
  private samples: Pose[] = [];
  private original: Bone[] = [];
  private copy: Bone[] = [];
  private ghost: Object3D;
  readonly skin: Mesh[] = [];
  constructor(readonly model: Object3D) {
    this.ghost = clone(model);
    model.traverse((o) => {
      if (o instanceof Bone) this.original.push(o);
    });
    this.ghost.traverse((o) => {
      if (o instanceof Bone) this.copy.push(o);
      if (o instanceof Mesh && o.geometry.hasAttribute("uv")) this.skin.push(o);
    });
  }
  capture(tick: number) {
    const last = this.samples.at(-1);
    if (last?.tick === tick) return;
    if (last && (tick < last.tick || tick - last.tick > 5))
      this.samples.length = 0;
    const outdated =
      this.samples[0]?.tick < tick - 104 ? this.samples.shift() : undefined;
    const joints =
      outdated?.joints ?? new Float32Array(this.original.length * 10);
    this.original.forEach((bone, i) => {
      bone.position.toArray(joints, i * 10);
      bone.quaternion.toArray(joints, i * 10 + 3);
      bone.scale.toArray(joints, i * 10 + 7);
    });
    this.samples.push({
      tick,
      position: this.model.getWorldPosition(new Vector3()),
      rotation: this.model.getWorldQuaternion(new Quaternion()),
      joints,
    });
  }
  at(tick: number) {
    for (let i = this.samples.length - 1; i >= 0; i--)
      if (this.samples[i].tick <= tick) return this.samples[i];
    return this.samples[0];
  }
  pose(tick: number) {
    const p = this.at(tick);
    if (!p) return;
    this.ghost.position.copy(p.position);
    this.ghost.quaternion.copy(p.rotation);
    this.model.getWorldScale(this.ghost.scale);
    this.copy.forEach((bone, i) => {
      bone.position.fromArray(p.joints, i * 10);
      bone.quaternion.fromArray(p.joints, i * 10 + 3);
      bone.scale.fromArray(p.joints, i * 10 + 7);
    });
    this.ghost.updateMatrixWorld(true);
    return p;
  }
  anchor(point: Vector3) {
    this.ghost.position.copy(point);
    this.ghost.updateMatrixWorld(true);
  }
  dispose() {
    const skeletons = new Set(
      this.skin.flatMap((m) => (m instanceof SkinnedMesh ? [m.skeleton] : [])),
    );
    for (const s of skeletons) s.dispose();
  }
}
