import {
  AnimationMixer,
  Color,
  DoubleSide,
  Euler,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  LoopOnce,
  RepeatWrapping,
  Quaternion,
  SkinnedMesh,
  SRGBColorSpace,
  TextureLoader,
  Vector3,
} from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone } from "three/addons/utils/SkeletonUtils.js";
import assets from "./pantheon-arrival-assets.json";
import type { EffectPath, Frame } from "./battle-field";

const scale = (40 * 0.0075 * 1.05) / 1.3;
export const arrivalScale = scale;
const up = new Vector3(0, 1, 0);
const saturate = (value: number) => Math.min(1, Math.max(0, value));
export function arrivalPose(
  path: EffectPath,
  tick: number,
  frame: Frame,
  seat: number,
) {
  const age = (tick - path.start) / 20;
  const sign = seat ? -1 : 1,
    dir = (path.team === "Blue" ? -1 : 1) * sign;
  const p = path.path[0],
    end = new Vector3(
      (p.x - frame.map.width / 2) * sign,
      0,
      (p.y - frame.map.height / 2) * sign,
    );
  const landing = end.clone();
  landing.z -= dir * 120;
  const fly = age < 0.65,
    progress = fly
      ? saturate((age - 0.2) / 0.45)
      : saturate((age - 0.65) / 0.65);
  const comet = landing.clone();
  if (fly) {
    comet.z -= 160 * dir * (1 - progress);
    comet.y = 80 * (1 - progress) + (44 * 1.05) / 1.3;
  } else comet.lerp(end, 1 - (1 - progress) ** 2);
  // Combat publishes a linear sweep. Keep its hit marker on the authoritative front.
  const damage = landing.clone().lerp(end, fly ? 0 : progress);
  const forward = new Vector3(0, 0, dir),
    side = forward.clone().cross(up);
  const yAxis = fly
    ? forward.clone().addScaledVector(up, -0.5).normalize()
    : forward;
  const orientation = new Quaternion().setFromRotationMatrix(
    new Matrix4().makeBasis(side, yAxis, side.clone().cross(yAxis)),
  );
  return { age, dir, end, landing, comet, damage, orientation, fly };
}

async function loadAssets() {
  const gltf = new GLTFLoader(),
    tex = new TextureLoader(),
    url = (k: keyof typeof assets.files) =>
      "/play/media/" + assets.files[k];
  const [spear, proxy, color, stars] = await Promise.all([
    gltf.loadAsync(url("spear")),
    gltf.loadAsync(url("proxy")),
    tex.loadAsync(url("color")),
    tex.loadAsync(url("stars")),
  ]);
  for (const t of [color, stars]) {
    t.flipY = false;
    t.colorSpace = SRGBColorSpace;
  }
  stars.wrapT = RepeatWrapping;
  stars.offset.y = -0.2;
  return { spear, proxy, color, stars };
}
let shared: ReturnType<typeof loadAssets> | undefined;
export class ArrivalModels {
  readonly root = new Group();
  private data?: Awaited<ReturnType<typeof loadAssets>>;
  private retry = 0;
  loading = false;
  private entries = new Map<
    number,
    {
      spear: Group;
      proxy: Object3D;
      mixer: AnimationMixer;
      material: MeshBasicMaterial;
      clip: string;
    }
  >();
  prepare() {
    if (this.data || this.loading || performance.now() < this.retry) return;
    this.loading = true;
    (shared ??= loadAssets())
      .then((v) => (this.data = v))
      .catch((error) => {
        shared = undefined;
        this.retry = performance.now() + 10000;
        console.warn("潘森入场资源载入失败", error);
      })
      .finally(() => (this.loading = false));
  }
  show(path: EffectPath, tick: number, frame: Frame, seat: number) {
    this.prepare();
    if (!this.data) return;
    const { age, dir, end, comet, orientation, fly } = arrivalPose(
      path,
      tick,
      frame,
      seat,
    );
    let entry = this.entries.get(path.owner);
    if (!entry) {
      const spear = this.data.spear.scene.clone(),
        proxy = clone(this.data.proxy.scene);
      const material = new MeshBasicMaterial({
        map: this.data.stars,
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
      });
      const shaft = new MeshBasicMaterial({
        map: this.data.color,
        side: DoubleSide,
      });
      spear.traverse((o) => {
        if (o instanceof Mesh) o.material = shaft;
      });
      proxy.traverse((o) => {
        if (o instanceof Mesh) o.material = material;
      });
      this.root.add(spear, proxy);
      entry = {
        spear,
        proxy,
        material,
        mixer: new AnimationMixer(proxy),
        clip: "",
      };
      this.entries.set(path.owner, entry);
    }
    const { spear, proxy, material, mixer } = entry;
    spear.visible = age >= 0 && age < 1.3;
    spear.position.copy(end);
    const f = 1 - saturate(age / 0.2);
    spear.position.y += 120 * f;
    spear.position.z -= dir * 240 * f;
    spear.quaternion
      .setFromAxisAngle(up, dir === 1 ? 0 : Math.PI)
      .multiply(
        new Quaternion().setFromEuler(new Euler(-Math.atan2(1, 0.5), 0, 0)),
      )
      .multiply(new Quaternion().setFromAxisAngle(up, Math.PI / 2))
      .multiply(
        new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI),
      );
    spear.scale.setScalar((40 * 0.009 * 1.05) / 1.3);
    proxy.visible = age >= 0.2 && age < 1.3;
    if (proxy.visible) {
      const offset = fly
        ? new Vector3(0, -50, -250)
        : new Vector3(0, -100, -70);
      proxy.position
        .copy(comet)
        .add(offset.multiplyScalar(scale).applyQuaternion(orientation));
      proxy.quaternion
        .copy(orientation)
        .multiply(
          new Quaternion().setFromEuler(
            new Euler(-Math.PI / 2, Math.PI / 2, Math.PI / 2, "YXZ"),
          ),
        );
      proxy.scale.setScalar(scale * (fly ? 0.8 : 1));
      const t = age - (fly ? 0.2 : 0.65);
      const name = fly ? "pantheon_spell4_fly" : "pantheon_spell4_slide";
      if (entry.clip !== name) {
        mixer.stopAllAction();
        const action = mixer.clipAction(
          this.data.proxy.animations.find((a) => a.name === name)!,
        );
        action.reset().setLoop(LoopOnce, 1);
        action.clampWhenFinished = true;
        action.play();
        entry.clip = name;
      }
      proxy.traverse((o) => {
        if (o instanceof Mesh)
          o.renderOrder = 650_000_000 + (fly ? 40 : 0) * 4096;
      });
      mixer.setTime(t);
      material.color.copy(
        fly ? new Color(1, 0.0745, 0.0118) : new Color(0.6824, 0.0392, 0.0392),
      );
      material.opacity = saturate(t / 0.1);
    }
  }
  retain(ids: Set<number>) {
    for (const [id, e] of this.entries)
      if (!ids.has(id)) {
        e.mixer.stopAllAction();
        e.mixer.uncacheRoot(e.proxy);
        e.material.dispose();
        const mats = new Set<MeshBasicMaterial>();
        e.spear.traverse((o) => {
          if (o instanceof Mesh) mats.add(o.material);
        });
        for (const m of mats) m.dispose();
        const rigs = new Set<SkinnedMesh["skeleton"]>();
        e.proxy.traverse((o) => {
          if (o instanceof SkinnedMesh) rigs.add(o.skeleton);
        });
        for (const r of rigs) r.dispose();
        e.proxy.removeFromParent();
        e.spear.removeFromParent();
        this.entries.delete(id);
      }
  }
}
