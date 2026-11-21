import {
  AnimationMixer,
  DoubleSide,
  Group,
  LoopOnce,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  SkinnedMesh,
  SRGBColorSpace,
  TextureLoader,
} from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone } from "three/addons/utils/SkeletonUtils.js";
import assets from "./reksai-rock-assets.json";
import type { EffectPath, Frame } from "./battle-field";

const dir = "/play/media/arrival/";
async function load() {
  const [body, texture, res] = await Promise.all([
    new GLTFLoader().loadAsync(dir + assets.files.mesh),
    new TextureLoader().loadAsync(dir + assets.files.texture),
    fetch(dir + assets.files.poses),
  ]);
  if (!res.ok) throw Error("RekSai " + res.status);
  const buffer = await res.arrayBuffer(),
    bytes = new Uint8Array(buffer);
  const stream =
    bytes[0] === 31 && bytes[1] === 139
      ? new Response(
          new Blob([buffer])
            .stream()
            .pipeThrough(new DecompressionStream("gzip")),
        )
      : new Response(buffer);
  const frames: number[][][] = await stream.json();
  texture.flipY = false;
  texture.colorSpace = SRGBColorSpace;
  return { body, texture, frames };
}
let shared: ReturnType<typeof load> | undefined;
type Shard = {
  body: Object3D;
  mixer: AnimationMixer;
  material: MeshBasicMaterial;
};
export class BurrowRocks {
  readonly root = new Group();
  loading = false;
  private data?: Awaited<ReturnType<typeof load>>;
  private retry = 0;
  private owners = new Map<
    number,
    { root: Group; shards: Map<number, Shard> }
  >();
  prepare() {
    if (this.loading || this.data || performance.now() < this.retry) return;
    this.loading = true;
    (shared ??= load())
      .then((data) => (this.data = data))
      .catch((error) => {
        shared = undefined;
        this.retry = performance.now() + 10000;
        console.warn("雷克塞出土资源载入失败", error);
      })
      .finally(() => (this.loading = false));
  }
  show(p: EffectPath, tick: number, f: Frame, seat: number) {
    this.prepare();
    if (!this.data || tick < p.impact) return;
    const age = (tick - p.impact) / 20,
      rows = this.data.frames[Math.floor(age * assets.fps)] ?? [];
    let owner = this.owners.get(p.owner);
    if (!owner) {
      owner = { root: new Group(), shards: new Map() };
      this.owners.set(p.owner, owner);
      this.root.add(owner.root);
    }
    const pos = p.path[p.path.length - 1],
      sign = seat ? -1 : 1;
    owner.root.position.set(
      sign * (pos.x - f.map.width / 2),
      0,
      sign * (pos.y - f.map.height / 2),
    );
    owner.root.rotation.y = (p.team === "Blue") === (seat === 0) ? Math.PI : 0;
    owner.root.scale.setScalar(0.32);
    for (const s of owner.shards.values()) s.body.visible = false;
    for (const r of rows) {
      let shard = owner.shards.get(r[0]);
      if (!shard) {
        const body = clone(this.data.body.scene),
          material = new MeshBasicMaterial({
            map: this.data.texture,
            side: DoubleSide,
            transparent: true,
            depthWrite: false,
          });
        body.traverse((o) => {
          if (o instanceof Mesh) {
            o.material = material;
            o.frustumCulled = false;
          }
        });
        const mixer = new AnimationMixer(body),
          action = mixer.clipAction(this.data.body.animations[0]);
        action.clampWhenFinished = true;
        action.setLoop(LoopOnce, 1).play();
        shard = { body, mixer, material };
        owner.root.add(body);
        owner.shards.set(r[0], shard);
      }
      const { body, material, mixer } = shard;
      body.visible = true;
      body.position.set(r[1], r[2], r[3]);
      body.scale.set(r[4], r[5], r[6]);
      body.quaternion.setFromRotationMatrix(
        new Matrix4().set(
          r[11],
          r[12],
          r[13],
          0,
          r[14],
          r[15],
          r[16],
          0,
          r[17],
          r[18],
          r[19],
          0,
          0,
          0,
          0,
          1,
        ),
      );
      material.color.setRGB(r[7], r[8], r[9]);
      material.opacity = r[10];
      mixer.setTime(Math.max(0, age - r[20]));
    }
  }
  retain(live: Set<number>) {
    for (const [id, o] of this.owners)
      if (!live.has(id)) {
        for (const s of o.shards.values()) {
          s.mixer.stopAllAction();
          s.mixer.uncacheRoot(s.body);
          s.material.dispose();
          const rigs = new Set<SkinnedMesh["skeleton"]>();
          s.body.traverse((obj) => {
            if (obj instanceof SkinnedMesh) rigs.add(obj.skeleton);
          });
          for (const rig of rigs) rig.dispose();
        }
        o.root.removeFromParent();
        this.owners.delete(id);
      }
  }
}
