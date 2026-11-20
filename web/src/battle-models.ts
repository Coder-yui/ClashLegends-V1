import {
  AdditiveAnimationBlendMode,
  AnimationAction,
  AnimationMixer,
  Box3,
  CircleGeometry,
  Color,
  Plane,
  Material,
  Group,
  Mesh,
  MeshBasicMaterial,
  Matrix4,
  Object3D,
  OrthographicCamera,
  Scene,
  SkinnedMesh,
  Vector3,
  WebGLRenderer,
} from "three";
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { clone } from "three/addons/utils/SkeletonUtils.js";
import { GroundMarks } from "./unit-ground-marks";
import { applyCrystalWell } from "./crystal-well";
import { visualRadius } from "./health-bars";
import type { Frame, Unit } from "./battle-field";
import {
  castPack,
  skillPacks,
  followupProfile,
  modelProfiles,
  clipTime,
  clipRoles,
  MotionSequence,
  motionFor,
  profileFor,
  type ModelProfile,
  type Motion,
} from "./battle-motion";

// Each instance owns its mesh visibility. Materials and textures stay shared.
export function modelSurfaces(root: Object3D, profile: ModelProfile) {
  if (profile.asset === "gnar") {
    const props: Mesh[] = [];
    root.traverse((o) => {
      if (
        o instanceof Mesh &&
        [o.material].flat().some((m) => m.name === "Gnar_Boomerang")
      )
        props.push(o);
    });
    return (clip: string) => {
      for (const prop of props)
        prop.visible =
          clip !== "gnar_runtime_Revert_Transform" && clip !== "Run1_In";
    };
  }
  if (profile.asset === "aatrox" || profile.asset === "aatrox-alt") {
    const weapon = root.getObjectByName("Weapon"),
      anchor = root.getObjectByName("Weapon_World");
    const snap = new Set([
      "Aatrox_unsheath_anm",
      "Run_Base",
      "Run_Ult",
      "Passive_Attack",
      "Passive_Attack_Ult",
      "Passive_Idle",
      "Passive_Run",
      "Passive_Attack_out",
      "Spell4",
      "Aatrox_ULT_into_anm",
      "ULT_out",
    ]);
    if (weapon?.parent && anchor) {
      const local = new Matrix4();
      return (clip: string) => {
        if (!snap.has(clip)) return;
        anchor.updateWorldMatrix(true, false);
        weapon.parent!.updateWorldMatrix(true, false);
        local
          .copy(weapon.parent!.matrixWorld)
          .invert()
          .multiply(anchor.matrixWorld);
        local.decompose(weapon.position, weapon.quaternion, weapon.scale);
        weapon.updateMatrix();
      };
    }
  }
  if (!profile.surfaceMode) return undefined;
  const meshes: Mesh[] = [];
  root.traverse((o) => {
    if (o instanceof Mesh) meshes.push(o);
  });
  return (clip: string, time: number) => {
    for (const mesh of meshes) {
      const material = Array.isArray(mesh.material)
        ? mesh.material[0].name
        : mesh.material.name;
      if (profile.surfaceMode === "tower") {
        const stage = clip.startsWith("NativeBreak")
          ? Number(clip.slice(-1))
          : clip === "Destroyed"
            ? 3
            : clip === "State3"
              ? 2
              : clip === "State2"
                ? 1
                : 0;
        mesh.visible =
          material === "InnerFoundation" ||
          material === ["Base", "Stage1", "Stage2", "Rubble"][stage] ||
          (clip.startsWith("NativeBreak") && material === "Broken" + stage);
      } else if (profile.surfaceMode === "crystal") {
        const broken =
          clip === profile.death.clip ||
          clip.toLowerCase().includes("idle_death");
        mesh.visible = (material === "Destroyed") === broken;
      } else if (
        ["R_Demon_Arm", "L_Demon_Arm", "Tongue", "Lantern"].includes(material)
      ) {
        const frame = Math.floor(time * 30);
        const idle = clip === "fiddlesticks_idle1";
        const start =
          clip === "fiddlesticks_respawn"
            ? [91, 99]
            : clip === "fiddlesticks_idlein1"
              ? [29, 61]
              : clip === "fiddlesticks_spell2_channel_toidle"
                ? [25, 58]
                : undefined;
        mesh.visible =
          material === "Tongue"
            ? idle && frame >= 64 && frame < 91
            : material === "L_Demon_Arm"
              ? false
              : idle ||
                (!!start && frame >= start[material === "Lantern" ? 1 : 0]);
      }
    }
  };
}
type ModelAsset = GLTF & { bounds: Box3 };

class ActorModel {
  readonly root: Object3D;
  readonly mixer: AnimationMixer;
  readonly hands: (Object3D | undefined)[];
  private bounds: Box3;
  private lastHit = -Infinity;
  private flashStart = -Infinity;
  private flashing = false;
  private white = { value: 0 };
  private flashMeshes?: {
    mesh: Mesh;
    normal: Mesh["material"];
    flash: Mesh["material"];
  }[];
  private flashMaterials = new Map<Material, Material>();
  hit(eventTick: number, displayTick: number) {
    if (eventTick - this.lastHit < 3.6 || displayTick - eventTick > 3) return;
    this.lastHit = eventTick;
    this.flashStart = displayTick;
  }
  flash(tick: number, suppressed: boolean) {
    const age = tick - this.flashStart;
    const on = !suppressed && age >= 0 && age < 1;
    const tower = this.profile.surfaceMode === "tower" || !!this.profile.intro;
    this.white.value = on ? 0.22 * (tower ? 1 - age : 1) : 0;
    if (on === this.flashing) return;
    this.flashing = on;
    if (!this.flashMeshes) {
      this.flashMeshes = [];
      const variant = (source: Material) => {
        let m = this.flashMaterials.get(source);
        if (m) return m;
        m = source.clone();
        m.customProgramCacheKey = () => source.customProgramCacheKey() + "/hit";
        m.onBeforeCompile = (shader, renderer) => {
          source.onBeforeCompile(shader, renderer);
          shader.uniforms.hitWhite = this.white;
          shader.fragmentShader =
            "uniform float hitWhite;\n" +
            shader.fragmentShader.replace(
              "#include <opaque_fragment>",
              "outgoingLight=mix(outgoingLight,vec3(1.),hitWhite);\n#include <opaque_fragment>",
            );
        };
        this.flashMaterials.set(source, m);
        return m;
      };
      this.root.traverse((o) => {
        if (
          o instanceof Mesh &&
          ![o.material].flat().some((m) => m.name === "Yorick_Cape")
        )
          this.flashMeshes!.push({
            mesh: o,
            normal: o.material,
            flash: Array.isArray(o.material)
              ? o.material.map(variant)
              : variant(o.material),
          });
      });
    }
    for (const item of this.flashMeshes)
      item.mesh.material = on ? item.flash : item.normal;
  }
  readonly elevation: number;
  private headOffset?: number;
  private surfaces?: ReturnType<typeof modelSurfaces>;
  readonly actions = new Map<string, AnimationAction>();
  readonly sequence: MotionSequence;
  private towerStage?: number;
  private debris = new Map<
    number,
    { mesh: Mesh; action: AnimationAction; start?: number }
  >();
  private blendTicks = 2;
  private outgoing = new Map<AnimationAction, number>();
  private active?: AnimationAction;
  private key = "";
  private baseMeshes: Mesh[] = [];
  private anchorYaw?: number;
  private additive?: AnimationAction;
  private transition = 0;
  private loopTime = 0;
  lastUnit?: Unit;
  private previousTick?: number;
  death?: number;
  deathFollow?: ModelProfile["death"];

  constructor(
    readonly profile: ModelProfile,
    asset: ModelAsset,
  ) {
    this.root = clone(asset.scene);
    this.surfaces = modelSurfaces(this.root, profile);
    if (profile.asset.startsWith("sun_disc-"))
      this.root.traverse((o) => {
        if (
          o instanceof Mesh &&
          ["RuinBase", "InnerFoundation"].includes(o.material.name)
        )
          this.baseMeshes.push(o);
      });
    this.bounds = asset.bounds;
    this.elevation = profile.air
      ? 2.3 * 40 - asset.bounds.min.y * profile.scale
      : profile.groundOffset;
    this.root.scale.setScalar(profile.scale);
    this.hands = (profile.hands ?? (profile.hand ? [profile.hand] : [])).map(
      (name) => this.root.getObjectByName(name),
    );
    this.mixer = new AnimationMixer(this.root);
    for (const clip of asset.animations)
      this.actions.set(clip.name, this.mixer.clipAction(clip));
    this.sequence = new MotionSequence(
      profile,
      (clip) => this.actions.get(clip)?.getClip().duration ?? 0,
    );
    if (profile.surfaceMode === "tower")
      this.root.traverse((o) => {
        if (!(o instanceof Mesh)) return;
        const match = /^Broken([123])$/.exec(o.material.name);
        if (match)
          this.debris.set(Number(match[1]), {
            mesh: o,
            action: this.actions.get("NativeBreak" + match[1])!,
          });
      });
  }

  head(u: Unit, projection: number) {
    if (this.headOffset !== undefined) return this.headOffset;
    const lift = Math.sqrt(1 - projection ** 2) / projection;
    if (this.profile.barHeight !== undefined)
      return this.profile.barHeight * lift;
    // The head stays stable across animation frames. Include the model's depth
    // in the projection so back-facing units use their actual top silhouette.
    const sin = Math.sin(this.root.rotation.y),
      cos = Math.cos(this.root.rotation.y);
    const { min, max } = this.bounds;
    const back =
      -sin * (sin >= 0 ? max.x : min.x) + cos * (cos >= 0 ? min.z : max.z);
    const top =
      (max.y * lift - back) * this.profile.scale + this.elevation * lift;
    this.headOffset = Math.max(
      0,
      Math.min(top, visualRadius(u) * 3.25 + (this.profile.air ? 92 : 0)),
    );
    return this.headOffset;
  }

  playing() {
    return {
      clip: (this.additive ?? this.active)?.getClip().name,
      time: (this.additive ?? this.active)?.time,
      layers: [...this.debris.values()]
        .filter((layer) => layer.start !== undefined)
        .map((layer) => layer.action.getClip().name),
    };
  }

  shareRuin(shared: boolean) {
    this.anchorYaw ??= this.root.rotation.y;
    for (const mesh of this.baseMeshes) {
      mesh.visible = !shared;
      // gltfpack keeps the named foundation nodes above their quantized meshes.
      if (mesh.parent && mesh.parent !== this.root)
        mesh.parent.rotation.y = this.anchorYaw - this.root.rotation.y;
    }
  }

  sample(motion: Motion, tick: number, freeze: boolean) {
    if (motion.clip === this.profile.additive) {
      const layer = this.actions.get(motion.clip)!;
      if (layer !== this.additive) {
        this.additive = layer.reset().play();
        layer.paused = true;
      }
      if (!freeze)
        layer.time = clipTime(motion, tick, layer.getClip().duration);
      motion = {
        clip: this.profile.idle,
        key: "idle",
        start: this.lastUnit?.since ?? tick,
      };
    } else if (this.additive) {
      this.additive.stop();
      this.additive = undefined;
    }
    if (!this.actions.has(motion.clip)) {
      const moving =
        this.lastUnit?.activity === "March" ||
        this.lastUnit?.activity === "Chase";
      motion = {
        clip: moving ? this.profile.run : this.profile.idle,
        key: moving ? "run" : "idle",
        start: this.lastUnit?.since ?? tick,
      };
    }
    const action = this.actions.get(motion.clip)!;
    const duration = action.getClip().duration;
    const sameTick = this.previousTick === tick;
    const delta = Math.max(0, tick - (this.previousTick ?? tick));
    this.previousTick = tick;
    if (freeze && this.active) return;
    // A release event can arrive after interpolation has passed its tick.
    // Resample that exact pose before reading the muzzle's world transform.
    if (
      sameTick &&
      this.active === action &&
      motion.key === this.key &&
      (motion.end === undefined ||
        action.time === clipTime(motion, tick, duration))
    )
      return;
    const changed = motion.key !== this.key;
    if (changed) {
      this.outgoing.clear();
      for (const previous of this.actions.values()) {
        if (
          previous !== this.additive &&
          !previous.getClip().name.startsWith("NativeBreak") &&
          previous !== action &&
          previous.isScheduled() &&
          previous.getEffectiveWeight() > 0
        ) {
          this.outgoing.set(previous, previous.getEffectiveWeight());
        }
      }
      this.blendTicks =
        this.profile.clipBlends?.[
          this.active?.getClip().name + ">" + motion.clip
        ] ??
        motion.blend ??
        2;
      this.transition = tick;
      this.loopTime = clipTime(motion, tick, duration);
      this.key = motion.key;
      this.active = action;
      action.reset().play();
      action.paused = true;
    } else {
      this.loopTime += (delta * (motion.rate ?? 1)) / 20;
    }
    action.time =
      motion.end === undefined
        ? duration > 0
          ? this.loopTime % duration
          : 0
        : clipTime(motion, tick, duration);
    // A new attack must have full weight by the contact frame, even at high attack speed.
    const blend = Math.min(
      this.blendTicks,
      Math.max(0, (motion.release ?? Infinity) - this.transition),
    );
    const weight =
      this.outgoing.size && blend > 0
        ? Math.min(1, (tick - this.transition) / blend)
        : 1;
    let remaining = 0;
    for (const [old, from] of this.outgoing) {
      remaining += from;
      old.setEffectiveWeight(from * (1 - weight));
      if (weight === 1) old.stop();
    }
    if (weight === 1) this.outgoing.clear();
    action.setEffectiveWeight(1 - (1 - weight) * remaining);
    this.mixer.update(0);
    this.surfaces?.(motion.clip, action.time);
  }

  sampleTower(body: Motion, tick: number, frozen: boolean) {
    const stage =
      body.clip === "Destroyed"
        ? 3
        : body.clip === "State3"
          ? 2
          : body.clip === "State2"
            ? 1
            : 0;
    if (this.towerStage !== undefined && stage > this.towerStage) {
      const layer = this.debris.get(stage)!;
      layer.start = tick;
      layer.action.reset().play();
      layer.action.paused = true;
    }
    this.towerStage = stage;
    this.sample(body, tick, frozen && stage !== 3);
    let animated = false;
    for (const layer of this.debris.values()) {
      if (layer.start === undefined) continue;
      const age = (tick - layer.start) / 20;
      layer.mesh.visible = age < layer.action.getClip().duration;
      if (layer.mesh.visible) {
        layer.action.time = age;
        animated = true;
      } else {
        layer.action.stop();
        layer.start = undefined;
      }
    }
    if (animated) this.mixer.update(0);
  }

  dispose() {
    for (const mat of this.flashMaterials.values()) mat.dispose();
    this.root.removeFromParent();
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.root);
    this.root.traverse((o) => {
      if (o instanceof SkinnedMesh) o.skeleton.dispose();
    });
  }
}

export function releaseAsset(asset: GLTF) {
  asset.scene.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    object.geometry.dispose();
    for (const material of [object.material].flat() as MeshBasicMaterial[]) {
      if (material.map) {
        if (
          typeof ImageBitmap !== "undefined" &&
          material.map.source.data instanceof ImageBitmap
        )
          material.map.source.data.close();
        material.map.dispose();
      }
      material.dispose();
    }
    if (object instanceof SkinnedMesh) object.skeleton.dispose();
  });
}

async function glb(name: string, version?: string) {
  const path = "/play/media/models/";
  const url =
    path + name + ".glb" + (version ? "?v=" + encodeURIComponent(version) : "");
  const abort = new AbortController();
  const timeout = window.setTimeout(() => abort.abort(), 60_000);
  let bytes: ArrayBuffer;
  try {
    const response = await fetch(url, { signal: abort.signal });
    if (!response.ok)
      throw new Error("模型 " + name + " HTTP " + response.status);
    bytes = await response.arrayBuffer();
  } finally {
    window.clearTimeout(timeout);
  }
  return new GLTFLoader()
    .setMeshoptDecoder(MeshoptDecoder)
    .parseAsync(bytes, path);
}
async function animationPack(name: string, version?: string) {
  const data = await glb(name, version);
  return data.animations;
}
export async function loadModel(
  profile: ModelProfile,
  mode: "body" | "review" = "body",
  version?: string,
) {
  const asset = await glb(profile.asset, version);
  const castNames = profile.packs
    ? Object.values(profile.packs).flat()
    : Object.values(profile.casts ?? {}).map((a) => a.clip);
  if (mode === "review") {
    const extras = skillPacks(profile).map((skill) =>
      castPack(profile, skill)!,
    );
    if (profile.asset === "ashe") extras.push("ashe-review");
    try {
      asset.animations.push(
        ...(
          await Promise.all(extras.map((name) => animationPack(name, version)))
        ).flat(),
      );
    } catch (error) {
      releaseAsset(asset);
      throw error;
    }
  }
  const overlay = asset.animations.find(
    (clip) => clip.name === profile.additive,
  );
  if (overlay) overlay.blendMode = AdditiveAnimationBlendMode;
  const idle = asset.animations.find((c) => c.name === profile.idle);
  const missing = [...clipRoles(profile).keys()].find(
    (name) =>
      !(mode === "body" && castNames.includes(name)) &&
      !asset.animations.some((clip) => clip.name === name),
  );
  if (!idle || missing) {
    releaseAsset(asset);
    throw Error("缺少已绑定的动作片段 " + (missing ?? profile.idle));
  }
  const mixer = new AnimationMixer(asset.scene);
  mixer.clipAction(idle).play();
  mixer.update(0);
  modelSurfaces(asset.scene, profile)?.(idle.name, 0);
  asset.scene.updateMatrixWorld(true);
  const bounds = new Box3(),
    v = new Vector3();
  const clipAtGround =
    profile.surfaceMode === "tower" ||
    profile.surfaceMode === "crystal" ||
    profile.asset.startsWith("sun_disc-");
  if (clipAtGround) {
    const planes = [new Plane(new Vector3(0, 1, 0), 0)];
    asset.scene.traverse((o) => {
      if (!(o instanceof Mesh)) return;
      const ruin =
        profile.asset.startsWith("sun_disc-") &&
        [o.material].flat().some((m) => m.name === "RuinBase");
      if (
        profile.surfaceMode === "crystal" ||
        profile.surfaceMode === "tower" ||
        ruin
      ) {
        const nexus = profile.asset.startsWith("nexus-");
        const radius = nexus
          ? 1.35
          : profile.surfaceMode === "crystal"
            ? 0.82
            : 1.04;
        applyCrystalWell(
          o,
          (radius * 40) / profile.scale,
          nexus ? 10 / radius : 1e6,
        );
      } else {
        for (const material of [o.material].flat())
          material.clippingPlanes = planes;
      }
    });
  }
  if (
    profile.surfaceMode === "tower" ||
    profile.asset.startsWith("sun_disc-")
  ) {
    // The source plinth is open at the bottom. Draw its stone backing before
    // the meshes, without writing depth, so the underground native surfaces
    // remain visible and empty gaps never reveal the baked grass.
    const stone = new MeshBasicMaterial({
      color: new Color(0.13, 0.15, 0.16),
      depthWrite: false,
    });
    stone.name = "InnerFoundation";
    const floor = new Mesh(
      new CircleGeometry((1.04 * 40) / profile.scale, 32).rotateX(-Math.PI / 2),
      stone,
    );
    floor.renderOrder = -101;
    asset.scene.add(floor);
  }
  asset.scene.traverseVisible((o) => {
    if (!(o instanceof Mesh)) return;
    // The small Gnar skeleton parks an unused boomerang far below the floor.
    if (
      profile.asset === "gnar" &&
      ![o.material].flat().some((m) => m.name === "Gnar")
    )
      return;
    for (let i = 0; i < o.geometry.attributes.position.count; i++) {
      o.getVertexPosition(i, v).applyMatrix4(o.matrixWorld);
      bounds.expandByPoint(v);
    }
  });
  if (clipAtGround) bounds.min.y = Math.max(0, bounds.min.y);
  mixer.stopAllAction();
  mixer.uncacheRoot(asset.scene);
  return Object.assign(asset, { bounds });
}

// One owner per match or lab. Bodies are shared by skilled and unskilled actors.
export class ModelResources {
  private disposed = false;
  constructor(private version?: string) {}
  private bodies = new Map<string, Promise<ModelAsset>>();
  private packs = new Map<string, ReturnType<typeof animationPack>>();
  body(profile: ModelProfile) {
    let task = this.bodies.get(profile.asset);
    if (!task) {
      task = loadModel(profile, "body", this.version).catch((error) => {
        this.bodies.delete(profile.asset);
        throw error;
      });
      this.bodies.set(profile.asset, task);
    }
    return task;
  }
  pack(name: string) {
    let task = this.packs.get(name);
    if (!task) {
      task = animationPack(name, this.version).catch((error) => {
        this.packs.delete(name);
        throw error;
      });
      this.packs.set(name, task);
    }
    return task;
  }
  async prepare(names: string[]) {
    const allowed = new Set(names);
    const prepared = new Set<string>();
    const followups = modelProfiles
      .map(followupProfile)
      .filter((p): p is ModelProfile => !!p);
    await Promise.all(
      [...modelProfiles, ...followups]
        .filter((p) => allowed.has(p.asset))
        .map(async (profile) => {
          const body = await this.body(profile);
          prepared.add(profile.asset);
          for (const skill of skillPacks(profile)) {
            if (this.disposed) return;
            const pack = castPack(profile, skill)!;
            if (!allowed.has(pack)) continue;
            const extra = await this.pack(pack);
            prepared.add(pack);
            if (!body.animations.includes(extra[0]))
              body.animations.push(...extra);
          }
        }),
    );
    if (!this.disposed && prepared.size !== allowed.size)
      throw new Error("模型清单与当前客户端不匹配");
  }
  dispose() {
    this.disposed = true;
    for (const task of this.bodies.values())
      void task.then(releaseAsset, () => {});
    this.bodies.clear();
    this.packs.clear();
  }
}

export class BattleModels {
  private renderer: WebGLRenderer;
  private scene = new Scene();
  private field = new Group();
  private ground = new GroundMarks(32);
  private camera = new OrthographicCamera();
  private assets = new Map<string, ModelAsset | null>();
  private actors = new Map<number, ActorModel>();
  private disposed = false;
  private vector = new Vector3();
  private width = 0;
  private height = 0;
  private seq = 0;
  private resources: ModelResources;
  private ownsResources: boolean;
  readonly bars = new Map<number, number>();
  readonly launches = new Map<number, { tick: number; x: number; y: number }>();
  readonly metrics = {
    actors: 0,
    calls: 0,
    triangles: 0,
    launches: 0,
    maxMarkerError: 0,
    meleeContacts: 0,
    maxDisplayDelayMs: 0,
  };

  constructor(
    private canvas: HTMLCanvasElement,
    private me: number,
    private collect = false,
    resources?: ModelResources,
  ) {
    this.resources = resources ?? new ModelResources();
    this.ownsResources = !resources;
    this.renderer = new WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.localClippingEnabled = true;
    this.renderer.setClearColor(0, 0);
    this.scene.add(this.field, this.ground.mesh);
  }

  private load(profile: ModelProfile, skill?: string | null) {
    const pack = castPack(profile, skill);
    const clips =
      skill &&
      (profile.packs?.[skill] ??
        (profile.casts?.[skill] ? [profile.casts[skill].clip] : []));
    const prepared = this.assets.get(profile.asset);
    if (
      clips &&
      prepared &&
      clips.every((c) => prepared.animations.some((a) => a.name === c))
    )
      return prepared;
    const key = pack ?? profile.asset;
    if (this.assets.has(key)) return this.assets.get(key);
    this.assets.set(key, null);
    const body = this.resources.body(profile);
    const task = pack
      ? Promise.all([body, this.resources.pack(pack)]).then(
          ([asset, extra]) => ({
            ...asset,
            animations: [...new Set([...asset.animations, ...extra])],
          }),
        )
      : body;
    void task
      .then((asset) => {
        if (!this.disposed) this.assets.set(key, asset);
      })
      .catch((error) => {
        console.warn("Battle model unavailable", key, error);
        setTimeout(() => this.assets.delete(key), 2000);
      });
  }

  private actorFor(id: number, profile: ModelProfile, skill?: string | null) {
    const asset = this.load(profile, skill);
    if (!asset) return;
    let actor = this.actors.get(id);
    if (!actor || actor.profile !== profile) {
      actor?.dispose();
      actor = new ActorModel(profile, asset);
      this.field.add(actor.root);
      this.actors.set(id, actor);
    }
    if (skill && castPack(profile, skill)) {
      for (const clip of asset.animations) {
        if (!actor.actions.has(clip.name))
          actor.actions.set(clip.name, actor.mixer.clipAction(clip));
      }
    }
    return actor;
  }

  private place(actor: ActorModel, u: Unit, frame: Frame) {
    const { width, height } = frame.map;
    const sign = this.me ? -1 : 1;
    actor.root.position.set(
      sign * (u.x - width / 2),
      actor.elevation,
      sign * (u.y - height / 2),
    );
    actor.root.rotation.y =
      (actor.profile.fixedFacing
        ? u.team === this.me
          ? Math.PI
          : 0
        : Math.atan2(sign * u.facing.x, sign * u.facing.y)) +
      (actor.profile.yaw ?? 0);
  }

  traceActions() {
    return Array.from(this.actors, ([id, actor]) => ({
      id,
      asset: actor.profile.asset,
      ...actor.playing(),
    }));
  }

  playing(id: number | undefined) {
    return id === undefined ? undefined : this.actors.get(id)?.playing();
  }

  reset(cursor = 0) {
    for (const actor of this.actors.values()) actor.dispose();
    this.actors.clear();
    this.launches.clear();
    this.bars.clear();
    this.seq = cursor;
  }

  render(frame: Frame, tick: number, deathTick = tick) {
    const { width, height, projection } = frame.map;
    const w = Math.max(
      1,
      Math.round(this.canvas.clientWidth * Math.min(devicePixelRatio, 2)),
    );
    const h = Math.max(
      1,
      Math.round(this.canvas.clientHeight * Math.min(devicePixelRatio, 2)),
    );
    if (
      w !== this.width ||
      h !== this.height ||
      this.camera.right !== width / 2
    ) {
      this.width = w;
      this.height = h;
      this.renderer.setSize(w, h, false);
      Object.assign(this.camera, {
        left: -width / 2,
        right: width / 2,
        top: (height * projection) / 2,
        bottom: (-height * projection) / 2,
        near: 1,
        far: height * 5,
      });
      this.camera.position.set(
        0,
        projection * height * 2,
        Math.sqrt(1 - projection ** 2) * height * 2,
      );
      this.camera.lookAt(0, 0, 0);
      this.camera.updateProjectionMatrix();
      this.camera.updateMatrixWorld();
    }
    if (frame.units.length > this.ground.capacity) {
      this.ground.dispose();
      this.ground = new GroundMarks(
        2 ** Math.ceil(Math.log2(frame.units.length)),
      );
      this.scene.add(this.ground.mesh);
    }
    this.ground.update(frame.units, this.me, width, height, tick);
    this.bars.clear();
    const visible = new Set<number>();
    for (const u of frame.units) {
      const profile = profileFor(u);
      if (!profile) continue;
      const actor = this.actorFor(u.id, profile, u.equippedSkill ?? u.skill);
      if (!actor) continue;
      this.place(actor, u, frame);
      if (u.kind === "sun_disc")
        actor.shareRuin(
          !!frame.ruinedTowers?.some((r) => r.x === u.x && r.y === u.y),
        );
      actor.lastUnit = u;
      visible.add(u.id);
      this.bars.set(u.id, actor.head(u, projection));
    }

    const ruins = new Set<number>();
    for (const ruin of frame.ruinedTowers ?? []) {
      const profile = profileFor({ kind: "princess_tower", team: ruin.team })!;
      const actor = this.actorFor(ruin.id, profile);
      if (!actor) continue;
      ruins.add(ruin.id);
      const sign = this.me ? -1 : 1;
      actor.root.position.set(
        sign * (ruin.x - width / 2),
        0,
        sign * (ruin.y - height / 2),
      );
      actor.root.rotation.y = ruin.team === this.me ? Math.PI : 0;
      actor.sampleTower(
        {
          clip: profile.death.clip,
          key: "ruin",
          start: tick - 1,
          end: tick,
          blend: 0,
        },
        tick,
        false,
      );
    }
    const units = new Map(frame.units.map((u) => [u.id, u]));
    for (const event of frame.cues ?? []) {
      if (event.seq <= this.seq || event.tick > tick) continue;
      this.seq = event.seq;
      if (event.fact.kind === "died") {
        const actor = this.actors.get(Number(event.fact.data));
        if (actor) actor.death = event.tick;
      }
      const data = event.fact.data;
      if (event.fact.kind === "damage") {
        const hit = data as { target: number; lost: number; killed: boolean };
        const actor = this.actors.get(hit.target);
        if (actor && !hit.killed) actor.hit(event.tick, tick);
        if (actor && hit.lost > 0 && !hit.killed)
          actor.sequence.trigger(
            actor.profile.events?.hit,
            event.tick,
            event.seq,
          );
      } else if (event.fact.kind === "summoned") {
        const actor = this.actors.get((data as { source: number }).source);
        if (actor)
          actor.sequence.trigger(
            actor.profile.events?.summon,
            event.tick,
            event.seq,
          );
      }
      const fired = event.fact.kind === "fired" && Array.isArray(data);
      const strike = this.collect && event.fact.kind === "attackReleased";
      if (!fired && !strike) continue;
      const owner = fired ? data[0] : (data as { source: number }).source;
      const actor = this.actors.get(owner);
      const u = units.get(owner) ?? actor?.lastUnit;
      const hand =
        actor?.hands[((u?.attack?.cycle ?? 1) - 1) % actor.hands.length];
      if (!actor || !u || (fired && !hand) || (strike && hand)) continue;
      const motion = motionFor(u, actor.profile, event.tick);
      if (
        motion.release !== event.tick ||
        (!fired && motion.marker === undefined)
      )
        continue;
      actor.sample(motion, event.tick, false);
      if (fired) {
        hand!.getWorldPosition(this.vector).project(this.camera);
        this.launches.set(data[2], {
          tick: event.tick,
          x: ((this.vector.x + 1) * width) / 2,
          y: ((1 - this.vector.y) * height) / 2,
        });
        this.metrics.launches++;
      } else {
        this.metrics.meleeContacts++;
      }
      this.metrics.maxDisplayDelayMs = Math.max(
        this.metrics.maxDisplayDelayMs,
        (tick - event.tick) * 50,
      );
      if (motion.marker !== undefined) {
        const error = Math.abs(
          actor.actions.get(motion.clip)!.time - motion.marker,
        );
        this.metrics.maxMarkerError = Math.max(
          this.metrics.maxMarkerError,
          error,
        );
      }
    }
    for (const [id, actor] of this.actors) {
      actor.flash(
        tick,
        ruins.has(id) ||
          actor.death !== undefined ||
          !!units.get(id)?.controls.includes("Stasis"),
      );
      if (ruins.has(id)) continue;
      const follow = actor.profile.followup;
      if (actor.death !== undefined && follow && !actor.deathFollow) {
        const start =
          actor.death + (follow.immediate ? 0 : actor.profile.death.ticks);
        if (deathTick >= start) {
          const next = followupProfile(actor.profile)!;
          const body = this.load(next);
          if (!body) continue;
          const replacement = new ActorModel(next, body);
          replacement.root.position.copy(actor.root.position);
          replacement.root.position.y = replacement.elevation;
          replacement.root.rotation.copy(actor.root.rotation);
          replacement.death = start;
          replacement.deathFollow = {
            clip: follow.clip,
            blend: 0,
            ticks:
              follow.ticks ??
              replacement.actions.get(follow.clip)!.getClip().duration * 20,
          };
          actor.dispose();
          this.field.add(replacement.root);
          this.actors.set(id, replacement);
          continue;
        }
      }
      const death = actor.deathFollow ?? actor.profile.death;
      const u = units.get(id);
      if (
        actor.death !== undefined &&
        (deathTick < actor.death + death.ticks || !!actor.profile.intro)
      ) {
        actor.sample(
          {
            key: "death",
            clip: death.clip,
            blend: death.blend,
            clipEnd: death.clipEnd,
            start: actor.death,
            end:
              actor.death +
              (death.holdEnd
                ? actor.actions.get(death.clip)!.getClip().duration * 20
                : death.ticks),
          },
          deathTick,
          false,
        );
      } else if (u && visible.has(id)) {
        const frozen = u.frozen || u.controls.includes("Stasis");
        const motion = motionFor(u, actor.profile, tick);
        if (actor.profile.surfaceMode === "tower")
          actor.sampleTower(motion, tick, frozen);
        else
          actor.sample(
            actor.sequence.resolve(motion, tick, frozen),
            tick,
            frozen,
          );
      } else {
        actor.dispose();
        this.actors.delete(id);
      }
    }
    for (const [id, launch] of this.launches)
      if (tick - launch.tick > 3) this.launches.delete(id);
    this.renderer.render(this.scene, this.camera);
    this.metrics.actors = this.actors.size;
    this.metrics.calls = this.renderer.info.render.calls;
    this.metrics.triangles = this.renderer.info.render.triangles;
  }
  dispose() {
    this.disposed = true;
    this.reset();
    if (this.ownsResources) this.resources.dispose();
    this.assets.clear();
    this.ground.dispose();
    this.renderer.dispose();
  }
}
