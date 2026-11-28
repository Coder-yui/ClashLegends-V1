// World-space PBR geometry for the working dock, including the beds below the three bridges.
import * as T from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { HDRLoader } from "three/addons/loaders/HDRLoader.js";
import type { Frame } from "./battle-field";
import { StructureOpenings } from "./structure-openings";

const assets = "/play/media/battle/lowtide-dock/";
const wellTest = `
  if (dockWorld.y > -1. && dockWorld.y < 1.5) {
    vec3 eye = isOrthographic ? vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]) : cameraPosition-dockWorld;
    if(eye.y>.0001){
      vec2 at = dockWorld.xz-eye.xz*dockWorld.y/eye.y;
      for(int i=0;i<wellCount;i++){
        vec3 hole=texelFetch(wells,ivec2(i,0),0).xyz;
        if(distance(at,hole.xy)<hole.z) discard;
      }
    }
  }
`;

function release(object: T.Object3D) {
  const geometry = new Set<T.BufferGeometry>();
  const materials = new Set<T.Material>();
  const textures = new Set<T.Texture>();
  object.traverse((child) => {
    if (!(child instanceof T.Mesh)) return;
    if (child instanceof T.InstancedMesh) child.dispose();
    geometry.add(child.geometry);
    for (const material of [child.material].flat()) materials.add(material);
  });
  for (const material of materials) {
    for (const [key, value] of Object.entries(material)) {
      if (key !== "envMap" && value instanceof T.Texture) textures.add(value);
    }
    material.dispose();
  }
  for (const texture of textures) {
    texture.dispose();
    if (
      typeof ImageBitmap !== "undefined" &&
      texture.image instanceof ImageBitmap
    )
      texture.image.close();
  }
  for (const item of geometry) item.dispose();
}

export class LowtideTerrain {
  readonly root = new T.Group();
  readonly ready: Promise<void>;
  preparing = true;
  private disposed = false;
  private openings = new StructureOpenings();
  private sky?: T.Texture;
  private priorEnvironment?: {
    scene: T.Scene;
    map: T.Texture | null;
    rotation: T.Euler;
    intensity: number;
  };
  private weathering = { value: null as T.Texture | null };
  private facing = { value: 1 };
  private waveTime = { value: 0 };
  private sun = new T.DirectionalLight(0xffdfc7, 3.28);
  private reflectiveMaterials = new Set<T.MeshStandardMaterial>();
  private objects: T.Group[] = [];

  constructor(private renderer: T.WebGLRenderer) {
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = T.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.sun.position.set(-1120, 1600, -754);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    Object.assign(this.sun.shadow.camera, {
      left: -1500,
      right: 1500,
      top: 1450,
      bottom: -1450,
      near: 30,
      far: 4100,
    });
    this.sun.shadow.camera.updateProjectionMatrix();
    this.sun.shadow.normalBias = 0.65;
    this.sun.shadow.bias = -0.00022;
    this.root.add(
      this.sun,
      this.sun.target,
      new T.HemisphereLight(0xc9dbec, 0xb8a089, 0.69),
    );
    this.ready = this.load();
  }

  private async load() {
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const skyTask = new HDRLoader()
      .loadAsync(assets + "sky.hdr")
      .then((sky) => {
        if (this.disposed) {
          sky.dispose();
          return;
        }
        sky.mapping = T.EquirectangularReflectionMapping;
        this.sky = sky;
      });
    const wearTask = new T.TextureLoader()
      .loadAsync(assets + "weathering.webp")
      .then((wear) => {
        if (this.disposed) {
          wear.dispose();
          return;
        }
        this.weathering.value = wear;
      });
    const glbs = ["harbor.glb", "props.glb"].map(async (name) => {
      const { scene } = await loader.loadAsync(assets + name);
      if (this.disposed) {
        release(scene);
        return;
      }
      scene.traverse((child) => {
        if (!(child instanceof T.Mesh)) return;
        const materials = [child.material].flat() as T.MeshStandardMaterial[];
        child.receiveShadow = true;
        child.castShadow =
          name === "props.glb" || !child.name.startsWith("Floor");
        for (const material of materials) {
          if (material.map)
            material.map.anisotropy = Math.min(
              4,
              this.renderer.capabilities.getMaxAnisotropy(),
            );
          if (name === "harbor.glb" && child.name.startsWith("Floor")) {
            material.onBeforeCompile = (shader) => {
              Object.assign(shader.uniforms, this.openings.uniforms, {
                dockWear: this.weathering,
                dockFacing: this.facing,
              });
              shader.vertexShader =
                "varying vec3 dockWorld;\n" +
                shader.vertexShader.replace(
                  "#include <project_vertex>",
                  "#include <project_vertex>\ndockWorld = (modelMatrix * vec4(transformed,1.)).xyz;",
                );
              shader.fragmentShader =
                "varying vec3 dockWorld; uniform sampler2D wells, dockWear; uniform int wellCount; uniform float dockFacing;\n" +
                shader.fragmentShader
                  .replace(
                    "#include <clipping_planes_fragment>",
                    "#include <clipping_planes_fragment>\n" + wellTest,
                  )
                  .replace(
                    "#include <map_fragment>",
                    `#include <map_fragment>
                vec2 survey = dockWorld.xz * dockFacing / 2048.;
                vec3 wear = texture2D(dockWear, vec2(survey.x,-survey.y)+0.5).rgb;
                diffuseColor.rgb *= mix(vec3(1.),vec3(.34,.43,.43),wear.r);
                diffuseColor.rgb *= mix(vec3(1.),vec3(1.09,.62,.36),wear.g*1.8);
                diffuseColor.rgb *= 1.+wear.b*.15;`,
                  )
                  .replace(
                    "#include <roughnessmap_fragment>",
                    `#include <roughnessmap_fragment>
                roughnessFactor = mix(roughnessFactor, .32, wear.r*.76);`,
                  );
            };
            material.customProgramCacheKey = () => "lowtide-structure-openings";
          } else if (material.name === "Water estuary") {
            material.onBeforeCompile = (shader) => {
              Object.assign(shader.uniforms, {
                dockTide: this.waveTime,
                dockWear: this.weathering,
                dockFacing: this.facing,
              });
              shader.vertexShader =
                "varying vec3 tideWorld;\n" +
                shader.vertexShader.replace(
                  "#include <project_vertex>",
                  `#include <project_vertex>
                tideWorld = (modelMatrix * vec4(transformed, 1.)).xyz;`,
                );
              shader.fragmentShader =
                "varying vec3 tideWorld; uniform float dockTide, dockFacing; uniform sampler2D dockWear;\n" +
                shader.fragmentShader
                  .replace(
                    "#include <map_fragment>",
                    `#include <map_fragment>
                  vec2 port = tideWorld.xz * dockFacing;
                  float shore = texture2D(dockWear, vec2(port.x,-port.y)/2048.+.5).a;
                  float sheltered = 1.-smoothstep(558.,845.,port.x);
                  float shelf = smoothstep(.16,.81,shore)*sheltered;
                  vec2 uvWater = vMapUv;
                  vec2 bed = texture2D(normalMap, uvWater*.37+vec2(.21,.56)).rg;
                  vec3 deep = vec3(.20,.55,.51);
                  vec3 shallow = mix(vec3(.50,.90,.42),vec3(1.74,1.74,.85),
                                     smoothstep(.40,.61,bed.g));
                  float inlet = sheltered * (1.-smoothstep(65.,118.,abs(port.y)));
                  float sand = smoothstep(.36,.66,texture2D(normalMap,uvWater*.17+vec2(.41,.16)).r);
                  vec3 inletBed = mix(vec3(.27,.58,.67),vec3(.85,1.30,1.11),sand);
                  vec3 channel = mix(deep,inletBed,inlet);
                  diffuseColor.rgb *= mix(channel,shallow,shelf);
                `,
                  )
                  .replace(
                    "#include <normal_fragment_maps>",
                    `
                  #ifdef USE_NORMALMAP_TANGENTSPACE
                    vec2 uv = vNormalMapUv;
                    // The panoramic margins use the same camera bake at zero phase.
                    float liveArea = isOrthographic ? (1.-smoothstep(555.,690.,abs(tideWorld.x)))*
                                      (1.-smoothstep(856.,948.,abs(tideWorld.z))) : 1.;
                    vec2 flow = vec2(.0047,-.0022)*dockTide*liveArea;
                    vec2 swell = texture2D(normalMap,uv + flow).xy*2.-1.;
                    vec2 chop = texture2D(normalMap,vec2(-uv.y,uv.x)*1.63-flow*.74).xy*2.-1.;
                    vec2 rollers = texture2D(normalMap,uv*vec2(.25,.48)+flow*.64).xy*2.-1.;
                    vec2 slope = (.73*swell + rollers*.97 + vec2(chop.y,-chop.x)*.32) * normalScale * 1.63;
                    normal = normalize(tbn * vec3(slope,1.));
                    // Narrow bands of refracted light fall across the shallow bed.
                    float crest = abs(rollers.y + .34*swell.x - .11);
                    float caustic = 1.-smoothstep(.013,.078+fwidth(crest),crest);
                    diffuseColor.rgb *= 1.+caustic*(.10+1.34*shelf)*(.55+1.16*bed.r);
                  #endif`,
                  )
                  .replace(
                    "#include <roughnessmap_fragment>",
                    `#include <roughnessmap_fragment>
                    roughnessFactor = mix(.19,.28,shelf);`,
                  );
            };
            material.customProgramCacheKey = () => "lowtide-water";
          }
        }
      });
      this.objects.push(scene);
      this.root.add(scene);
    });
    const results = await Promise.allSettled([skyTask, wearTask, ...glbs]);
    this.preparing = false;
    if (this.disposed) return;
    const scene = this.root.parent;
    if (this.sky && scene instanceof T.Scene) {
      this.priorEnvironment = {
        scene,
        map: scene.environment,
        rotation: scene.environmentRotation.clone(),
        intensity: scene.environmentIntensity,
      };
      scene.environment = this.sky;
      scene.environmentIntensity = 0.32;
      scene.environmentRotation.y = this.facing.value < 0 ? Math.PI : 0;
    }
    for (const object of this.objects)
      object.traverse((child) => {
        if (!(child instanceof T.Mesh)) return;
        for (const mat of [child.material].flat() as T.MeshStandardMaterial[]) {
          if (!this.sky) continue;
          mat.envMap = this.sky;
          mat.envMapIntensity = mat.name === "Water estuary" ? 0.57 : 0.29;
          mat.envMapRotation.y = this.facing.value < 0 ? Math.PI : 0;
          this.reflectiveMaterials.add(mat);
          mat.needsUpdate = true;
        }
      });
    this.renderer.shadowMap.needsUpdate = true;
    for (const result of results)
      if (result.status === "rejected")
        console.error("船坞资源载入失败", result.reason);
  }

  update(frame: Frame, me: number) {
    const orientation = me ? -1 : 1;
    if (orientation !== this.facing.value) {
      this.facing.value = orientation;
      if (this.priorEnvironment)
        this.priorEnvironment.scene.environmentRotation.y = me ? Math.PI : 0;
      for (const material of this.reflectiveMaterials)
        material.envMapRotation.y = me ? Math.PI : 0;
    }
    this.waveTime.value = (frame.tick || 0) / 20;
    this.openings.update(frame, me);
  }

  dispose() {
    this.disposed = true;
    const prior = this.priorEnvironment;
    if (prior && prior.scene.environment === this.sky) {
      prior.scene.environment = prior.map;
      prior.scene.environmentIntensity = prior.intensity;
      prior.scene.environmentRotation.copy(prior.rotation);
    }
    this.root.removeFromParent();
    this.openings.dispose();
    this.sun.shadow.dispose();
    for (const scene of this.objects) release(scene);
    this.objects = [];
    this.reflectiveMaterials.clear();
    this.root.clear();
    this.sky?.dispose();
    this.weathering.value?.dispose();
  }
}
