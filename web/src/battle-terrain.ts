// Geometry and cutout masks come from the arena scene that produced the colour bake.
import * as T from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import type { Frame } from "./battle-field";
import { profileFor, type ModelProfile } from "./battle-motion";

const terrainOrder = -2_000_000_000;

export function openingRadius(profile?: ModelProfile) {
  if (profile?.asset.startsWith("nexus-")) return 54;
  if (profile?.surfaceMode === "crystal") return 32.8;
  if (
    profile?.surfaceMode === "tower" ||
    profile?.asset.startsWith("sun_disc-")
  )
    return 41.6;
  return 0;
}

// The isolated preview has no map, but still has an actual ground-depth pass.
export function previewFloor(radius = 0, size = 16000) {
  const geometry = radius
    ? new T.RingGeometry(radius, size, 96)
    : new T.PlaneGeometry(size * 2, size * 2);
  const floor = new T.Mesh(
    geometry.rotateX(-Math.PI / 2),
    new T.MeshBasicMaterial({ colorWrite: false, side: T.DoubleSide }),
  );
  floor.renderOrder = terrainOrder;
  return floor;
}

const vertex = `
varying vec3 world;
varying vec2 maskUv;
uniform mat3 maskTransform;
void main(){
  world = (modelMatrix * vec4(position,1.)).xyz;
  maskUv = (maskTransform * vec3(uv,1.)).xy;
  gl_Position = projectionMatrix * viewMatrix * vec4(world,1.);
}`;
const fragment = `
varying vec3 world;
varying vec2 maskUv;
uniform sampler2D paint,mask,wells;
uniform int wellCount;
uniform float cutoff,projected;
uniform vec2 extent,angle;
uniform vec3 plain;
void main(){
  if (cutoff > 0. && texture2D(mask,maskUv).a < cutoff) discard;
  if (world.y <= .4 && wellCount > 0) {
    vec3 eye = isOrthographic ? vec3(viewMatrix[0][2],viewMatrix[1][2],viewMatrix[2][2]) : cameraPosition-world;
    if(eye.y>.0001){
      vec2 at = world.xz - eye.xz * world.y / eye.y;
      for(int i=0;i<wellCount;i++){
        vec3 opening=texelFetch(wells,ivec2(i,0),0).xyz;
        if(distance(at,opening.xy)<opening.z) discard;
      }
    }
  }
  vec2 uv = vec2(world.x,world.y*angle.y-world.z*angle.x)/extent+.5;
  gl_FragColor=vec4(projected>.5 ? texture2D(paint,uv).rgb : plain,1.);
  #include <colorspace_fragment>
}`;

export class BattleTerrain {
  readonly root = new T.Group();
  preparing = false;
  private generation = 0;
  private key = "";
  private meshes: T.Mesh<T.BufferGeometry, T.ShaderMaterial>[] = [];
  private textures = new Set<T.Texture>();
  private wellData = new T.DataTexture(
    new Float32Array(4),
    1,
    1,
    T.RGBAFormat,
    T.FloatType,
  );
  private uniforms = {
    paint: { value: null as T.Texture | null },
    projected: { value: 0 },
    extent: { value: new T.Vector2() },
    angle: { value: new T.Vector2() },
    wells: { value: this.wellData },
    wellCount: { value: 0 },
  };
  private material(color: number, mask: T.Texture | null = null, cutoff = 0) {
    if (mask) {
      mask.wrapS = mask.wrapT = T.ClampToEdgeWrapping;
      mask.updateMatrix();
    }
    return new T.ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: fragment,
      side: T.DoubleSide,
      uniforms: {
        ...this.uniforms,
        plain: { value: new T.Color(color) },
        mask: { value: mask },
        maskTransform: { value: mask?.matrix ?? new T.Matrix3() },
        cutoff: { value: cutoff },
      },
    });
  }
  private add(
    geometry: T.BufferGeometry,
    material: T.ShaderMaterial,
    matrix?: T.Matrix4,
  ) {
    const mesh = new T.Mesh(geometry, material);
    if (matrix) mesh.applyMatrix4(matrix);
    mesh.renderOrder = terrainOrder;
    this.meshes.push(mesh);
    this.root.add(mesh);
    return mesh;
  }
  private clear() {
    this.root.clear();
    for (const m of this.meshes) {
      m.geometry.dispose();
      m.material.dispose();
    }
    this.meshes = [];
    for (const t of this.textures) {
      t.dispose();
      if (typeof ImageBitmap !== "undefined" && t.image instanceof ImageBitmap)
        t.image.close();
    }
    this.textures.clear();
    this.uniforms.paint.value = null;
    this.uniforms.projected.value = 0;
  }
  private load(map: Frame["map"], me: number) {
    this.clear();
    const generation = ++this.generation;
    this.preparing = false;
    const size = Math.max(map.backdropWidth, map.height + 320) * 2;
    const floor = this.add(
      new T.PlaneGeometry(size, size).rotateX(-Math.PI / 2),
      this.material(0x213a32),
    );
    this.uniforms.angle.value.set(
      map.projection,
      Math.sqrt(1 - map.projection ** 2),
    );
    if (!map.terrain) {
      for (const [x, z, right, bottom] of map.obstacles) {
        const patch = this.add(
          new T.PlaneGeometry(right - x, bottom - z).rotateX(-Math.PI / 2),
          this.material(0x44647a),
        );
        patch.position.set(
          ((me ? -1 : 1) * (x + right - map.width)) / 2,
          0.01,
          ((me ? -1 : 1) * (z + bottom - map.height)) / 2,
        );
      }
      return;
    }
    this.preparing = true;
    const paintReady = new T.TextureLoader()
      .loadAsync(map.terrain)
      .then((t) => {
        if (generation !== this.generation) {
          t.dispose();
          return;
        }
        t.colorSpace = T.SRGBColorSpace;
        this.textures.add(t);
        this.uniforms.extent.value.set(
          map.backdropWidth,
          (map.backdropWidth * t.image.height) / t.image.width,
        );
        this.uniforms.paint.value = t;
        this.uniforms.projected.value = 1;
      });
    const geometryReady =
      map.id === "rift"
        ? new GLTFLoader()
            .setMeshoptDecoder(MeshoptDecoder)
            .loadAsync("/play/media/battle/rift-terrain.glb")
            .then(({ scene }) => {
              const live = generation === this.generation;
              scene.scale.set(map.tile, map.tile, map.tile / Math.SQRT2);
              scene.updateMatrixWorld(true);
              const materials = new Set<T.Material>();
              const unused = new Set<T.Texture>();
              scene.traverse((o) => {
                if (!(o instanceof T.Mesh)) return;
                const original = o.material as T.MeshStandardMaterial;
                materials.add(original);
                if (live) {
                  if (original.map) this.textures.add(original.map);
                  this.add(
                    o.geometry,
                    this.material(0x213a32, original.map, original.alphaTest),
                    o.matrixWorld,
                  );
                } else {
                  o.geometry.dispose();
                  if (original.map) unused.add(original.map);
                }
              });
              for (const m of materials) m.dispose();
              for (const t of unused) {
                t.dispose();
                if (
                  typeof ImageBitmap !== "undefined" &&
                  t.image instanceof ImageBitmap
                )
                  t.image.close();
              }
              if (live) floor.visible = false;
            })
        : undefined;
    void Promise.allSettled([paintReady, geometryReady]).then((results) => {
      if (generation !== this.generation) return;
      this.preparing = false;
      for (const result of results)
        if (result.status === "rejected")
          console.error("战场地形资源加载失败", result.reason);
    });
  }
  update(frame: Frame, me: number) {
    const { map } = frame;
    const key = [
      map.id,
      map.terrain,
      map.width,
      map.height,
      map.tile,
      map.projection,
      map.backdropWidth,
      me,
    ].join("/");
    if (key !== this.key) {
      this.key = key;
      this.load(map, me);
    }
    const openings: number[] = [];
    const sign = me ? -1 : 1;
    const add = (x: number, y: number, r: number) =>
      openings.push(
        sign * (x - map.width / 2),
        sign * (y - map.height / 2),
        r,
        0,
      );
    for (const u of frame.units) {
      const radius = openingRadius(profileFor(u));
      if (radius) add(u.x, u.y, radius);
    }
    for (const r of frame.ruinedTowers ?? []) add(r.x, r.y, 41.6);
    const count = openings.length / 4;
    if (count > this.wellData.image.width) {
      this.wellData.dispose();
      const width = 2 ** Math.ceil(Math.log2(count));
      this.wellData = new T.DataTexture(
        new Float32Array(width * 4),
        width,
        1,
        T.RGBAFormat,
        T.FloatType,
      );
      this.uniforms.wells.value = this.wellData;
    }
    const pixels = this.wellData.image.data as Float32Array;
    if (
      count !== this.uniforms.wellCount.value ||
      openings.some((v, i) => pixels[i] !== Math.fround(v))
    ) {
      pixels.set(openings);
      this.wellData.needsUpdate = true;
    }
    this.uniforms.wellCount.value = count;
  }
  dispose() {
    this.generation++;
    this.clear();
    this.wellData.dispose();
    this.root.removeFromParent();
  }
}
