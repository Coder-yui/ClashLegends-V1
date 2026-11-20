import {
  AnimationMixer,
  Box3,
  Color,
  DirectionalLight,
  DoubleSide,
  Group,
  HemisphereLight,
  LoadingManager,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  Vector3,
  WebGLRenderer,
  MathUtils,
  LoopOnce,
} from "three";
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import {
  loadModel,
  modelSurfaces,
  releaseAsset,
  reviewMesh,
} from "./battle-models";
import { profileFor, type ModelProfile } from "./battle-motion";
import groups from "./photo-groups.json";

export const width = 308,
  height = 560;
export interface Member {
  kind: string;
  team: number;
  alternate: boolean;
  clip: string;
  time: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
}
export interface Shot {
  version: 1;
  card: string;
  members: Member[];
  azimuth: number;
  elevation: number;
  distance: number;
  targetX: number;
  targetY: number;
  targetZ: number;
  light: number;
  background: string;
  transparent: boolean;
  floor: boolean;
}
export function newMember(
  kind: string,
  team: number,
  alternate = false,
): Member {
  return {
    kind,
    team,
    alternate,
    clip: "",
    time: 0,
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    scale: 1,
  };
}
const formations: Record<string, string[]> = groups;
export function defaultShot(
  card: string,
  team: number,
  alternate: string,
): Shot {
  const kinds = formations[card] ?? [card];
  const members = kinds
    .filter((kind) => profileFor({ kind, team }))
    .map((kind, i, all) => ({
      ...newMember(kind, team, alternate === kind),
      x: ((i % 2) - (Math.min(all.length, 2) - 1) / 2) * 0.85,
      z: -Math.floor(i / 2) * 0.7,
    }));
  return {
    version: 1,
    card,
    members,
    azimuth: 12,
    elevation: 12,
    distance: members.length > 1 ? 5 : 3.25,
    targetX: 0,
    targetY: 0.58,
    targetZ: 0,
    light: 1,
    background: "#263842",
    transparent: false,
    floor: false,
  };
}
const finite = (x: unknown) => typeof x === "number" && Number.isFinite(x);
export function readShot(raw: string, card: string): Shot {
  const s = JSON.parse(raw);
  if (s && typeof s === "object") s.targetZ ??= 0;
  if (
    !s ||
    s.version !== 1 ||
    s.card !== card ||
    !Array.isArray(s.members) ||
    s.members.length > 64 ||
    ![
      s.azimuth,
      s.elevation,
      s.distance,
      s.targetX,
      s.targetY,
      s.targetZ,
      s.light,
    ].every(finite) ||
    s.distance <= 0 ||
    s.light < 0 ||
    !/^#[a-f\d]{6}$/i.test(s.background) ||
    typeof s.transparent !== "boolean" ||
    typeof s.floor !== "boolean" ||
    !s.members.every(
      (m: Member) =>
        m &&
        typeof m.kind === "string" &&
        (m.kind.startsWith("local:") || profileFor(m)) &&
        [0, 1].includes(m.team) &&
        typeof m.alternate === "boolean" &&
        typeof m.clip === "string" &&
        [m.x, m.y, m.z, m.yaw, m.scale, m.time].every(finite) &&
        m.scale > 0 &&
        m.time >= 0,
    )
  )
    throw Error("方案格式有误，或方案属于其他卡牌");
  return s;
}
export class PhotoScene {
  scene = new Scene();
  camera = new PerspectiveCamera(36, width / height, 0.01, 150);
  renderer: WebGLRenderer;
  ambient = new HemisphereLight(0xffffff, 0x9faeb6, 1.6);
  key = new DirectionalLight(0xfff3de, 1.45);
  floor = new Mesh(
    new PlaneGeometry(100, 100),
    new MeshStandardMaterial({ color: 0x495057, side: DoubleSide }),
  );
  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true });
    this.renderer.setSize(width * 2, height * 2, false);
    this.renderer.localClippingEnabled = true;
    this.key.position.set(-3, 5, 4);
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.position.y = -0.01;
    this.scene.add(this.key, this.ambient, this.floor);
  }
  configure(s: Shot) {
    this.renderer.setClearColor(s.background, s.transparent ? 0 : 1);
    this.floor.visible = s.floor;
    this.ambient.intensity = 1.6 * s.light;
    this.key.intensity = 1.45 * s.light;
    const theta = MathUtils.degToRad(s.azimuth),
      phi = MathUtils.degToRad(s.elevation);
    const target = new Vector3(s.targetX, s.targetY, s.targetZ);
    this.camera.position
      .set(
        Math.sin(theta) * Math.cos(phi),
        Math.sin(phi),
        Math.cos(theta) * Math.cos(phi),
      )
      .multiplyScalar(s.distance)
      .add(target);
    this.camera.lookAt(target);
    this.draw();
  }
  fit(roots: Group[]) {
    // Measure the posed, visible vertices in camera coordinates. A rotated
    // world-axis bounding box would waste much of a narrow portrait frame.
    this.camera.updateMatrixWorld();
    const box = new Box3(),
      v = new Vector3();
    for (const root of roots) {
      root.updateMatrixWorld(true);
      root.traverseVisible((mesh) => {
        if (!(mesh instanceof Mesh) || !reviewMesh(mesh, root.userData.asset))
          return;
        for (let i = 0; i < mesh.geometry.attributes.position.count; i++) {
          mesh.getVertexPosition(i, v).applyMatrix4(mesh.matrixWorld);
          if (root.userData.clipGround && v.y < root.position.y) continue;
          box.expandByPoint(v.applyMatrix4(this.camera.matrixWorldInverse));
        }
      });
    }
    if (box.isEmpty()) return {};
    const center = box
      .getCenter(new Vector3())
      .applyMatrix4(this.camera.matrixWorld);
    const size = box.getSize(v),
      tangent = Math.tan(MathUtils.degToRad(this.camera.fov / 2));
    const distance =
      size.z / 2 +
      (0.6 * Math.max(size.x / this.camera.aspect, size.y)) / tangent;
    return {
      targetX: center.x,
      targetY: center.y,
      targetZ: center.z,
      distance: Math.max(0.8, distance),
    };
  }
  draw() {
    this.renderer.render(this.scene, this.camera);
  }
  async capture(): Promise<Blob> {
    this.draw();
    const output = document.createElement("canvas");
    output.width = width;
    output.height = height;
    const ctx = output.getContext("2d")!;
    ctx.drawImage(this.renderer.domElement, 0, 0, width, height);
    return new Promise((resolve, reject) =>
      output.toBlob(
        (blob) => (blob ? resolve(blob) : reject(Error("PNG 导出失败"))),
        "image/png",
      ),
    );
  }
  dispose() {
    this.floor.geometry.dispose();
    this.floor.material.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
async function localModel(file: File) {
  const manager = new LoadingManager();
  // A candidate GLB is self-contained. Embedded textures use blob/data URLs.
  manager.setURLModifier((url) => {
    if (!/^(blob:|data:)/.test(url))
      throw Error("请将外部纹理和缓冲区嵌入 GLB");
    return url;
  });
  const asset = await new GLTFLoader(manager)
    .setMeshoptDecoder(MeshoptDecoder)
    .parseAsync(await file.arrayBuffer(), "");
  const bounds = new Box3().setFromObject(asset.scene, true);
  if (bounds.isEmpty()) {
    releaseAsset(asset);
    throw Error("候选模型没有可拍摄的网格");
  }
  return Object.assign(asset, { bounds });
}
export async function loadSubject(m: Member, file?: File) {
  let profile: ModelProfile | undefined;
  let asset: GLTF & { bounds: Box3 };
  if (m.kind.startsWith("local:")) {
    if (!file) throw Error("请重新选择方案使用的本地 GLB");
    asset = await localModel(file);
  } else {
    profile = profileFor({
      kind: m.kind,
      team: m.team,
      alternateForm: m.alternate,
    });
    if (!profile) throw Error("当前对象缺少模型");
    asset = await loadModel(profile, "review");
  }
  const root = new Group(),
    pivot = new Group();
  root.userData.asset = profile?.asset;
  root.userData.clipGround =
    profile?.surfaceMode === "tower" ||
    profile?.surfaceMode === "crystal" ||
    profile?.asset.startsWith("sun_disc-");
  const size = asset.bounds.getSize(new Vector3()),
    center = asset.bounds.getCenter(new Vector3());
  const normal = 1.2 / Math.max(size.x, size.y, size.z, 0.001);
  pivot.scale.setScalar(normal);
  // Offset the parent rather than editing the animated root transform.
  const origin = new Group();
  origin.position.set(-center.x, -asset.bounds.min.y, -center.z);
  origin.add(asset.scene);
  pivot.add(origin);
  root.add(pivot);
  const mixer = new AnimationMixer(asset.scene),
    surfaces = profile && modelSurfaces(asset.scene, profile);
  const unlit = new Map<MeshBasicMaterial, Color>();
  asset.scene.traverse((obj) => {
    if (obj instanceof Mesh)
      for (const mat of [obj.material].flat())
        if (mat instanceof MeshBasicMaterial) unlit.set(mat, mat.color.clone());
  });
  const clips = asset.animations.map((c) => ({
    name: c.name,
    duration: c.duration,
  }));
  const idle = profile?.idle ?? clips[0]?.name ?? "";
  let active: string | undefined;
  return {
    root,
    clips,
    idle,
    pose(m: Member, light: number) {
      root.position.set(m.x, m.y, m.z);
      root.rotation.y = MathUtils.degToRad(m.yaw);
      root.scale.setScalar(m.scale);
      unlit.forEach((base, mat) => mat.color.copy(base).multiplyScalar(light));
      const clip = asset.animations.find((c) => c.name === (m.clip || idle));
      if (!clip && m.clip) throw Error("模型已缺少动作 " + m.clip);
      if (clip) {
        if (active !== clip.name) {
          mixer.stopAllAction();
          active = clip.name;
        }
        if (
          profile &&
          (clip.name === profile.additive || clip.name === profile.setupPose)
        ) {
          const base = asset.animations.find((c) => c.name === idle)!;
          const a = mixer.clipAction(base).play();
          a.paused = true;
          a.time = m.time % (base.duration || 1);
        }
        const a = mixer.clipAction(clip).setLoop(LoopOnce, 1).play();
        a.clampWhenFinished = true;
        a.paused = true;
        a.time = Math.min(clip.duration, m.time);
        mixer.update(0);
        surfaces?.(clip.name, a.time);
      }
    },
    dispose() {
      root.removeFromParent();
      mixer.stopAllAction();
      mixer.uncacheRoot(asset.scene);
      releaseAsset(asset);
    },
  };
}
