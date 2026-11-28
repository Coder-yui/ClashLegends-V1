import * as T from "three";

// The surveyed dock ends at these coordinates. Reuse its animated water beyond
// that boundary so the wave directions and tidal height agree down the estuary.
function openWater() {
  const positions: number[] = [], uvs: number[] = [], colors: number[] = [];
  const triangles: number[] = [];
  const edge = 19000;
  for (const [west, east, north, south] of [
    [-edge, -2500, -edge, edge],
    [3118, edge, -edge, edge],
    [-2500, 3118, -edge, -1860],
    [-2500, 3118, 1860, edge],
  ]) {
    const start = positions.length / 3;
    for (const [x, z] of [[west, north], [west, south], [east, south], [east, north]]) {
      positions.push(x, -27.3, z);
      uvs.push(x / 245, z / 245);
      colors.push(0.55, 0.68, 0.73);
    }
    triangles.push(start, start + 1, start + 2, start, start + 2, start + 3);
  }
  const geometry = new T.BufferGeometry();
  geometry.setIndex(triangles);
  geometry.setAttribute("position", new T.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new T.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute("color", new T.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  return geometry;
}

// A pair of low salt-marsh banks climbs inland to a rolling watershed. At
// the dock their inner edge sinks beneath the apron, then follows the inlet.
function headlands() {
  const positions: number[] = [], colors: number[] = [], triangles: number[] = [];
  const across = 84, along = 64;
  const mud = new T.Color(0x887d69), grass = new T.Color(0x697259), heath = new T.Color(0x596b61);
  const color = new T.Color();
  const { lerp, smoothstep } = T.MathUtils;
  for (const side of [-1, 1]) {
    const start = positions.length / 3;
    for (let row = 0; row <= along; row++) {
      const distance = 9800 * Math.pow(row / along, 1.28);
      const coast = 558 + smoothstep(distance, 1550, 2900) *
        (130 + 310 * Math.sin(distance / 475) + 155 * Math.cos(distance / 239));
      for (let column = 0; column <= across; column++) {
        const x = lerp(-11000, coast + 130, column / across);
        const bend = smoothstep(-x, 2500, 4200);
        const inlet = 12 + bend * (125 * Math.sin(x / 345) + 145 * Math.cos(x / 950));
        const watershed = smoothstep(-x, 4250, 5840);
        const z = inlet + side * (48 + distance - 90 * watershed);
        const field = Math.max(-2310 - x, Math.abs(z) - 1645);
        const ridges = 0.51 + 0.24 * Math.sin(x / 610 + z / 830) +
          0.17 * Math.cos(z / 370 - x / 490) + 0.08 * Math.sin(x / 169 + z / 324);
        const relief = smoothstep(field, 20, 2200);
        const bank = lerp(smoothstep(distance, 12, 170 + 70 * bend), 1, watershed);
        const shore = smoothstep(coast - x, -90, 135);
        const yard = smoothstep(field + 75 * Math.sin(z / 290 + x / 460), -85, 185);
        const height = -42 + yard * bank * shore * (67 + relief * (35 + ridges * 260));
        positions.push(x, height, z);
        color.copy(mud).lerp(grass, smoothstep(height, -5, 46))
          .lerp(heath, ridges * relief).multiplyScalar(0.90 + ridges * 0.17);
        colors.push(color.r, color.g, color.b);
        if (!row || !column) continue;
        const corner = start + row * (across + 1) + column;
        const a = corner - across - 2, b = corner - across - 1, c = corner, d = corner - 1;
        if ([a, b, c, d].every(i => positions[3 * i + 1] < -29)) continue;
        if (side > 0) triangles.push(a, d, c, a, c, b);
        else triangles.push(a, c, d, a, b, c);
      }
    }
  }

  // The opposite shore of the graving dock is a separate spit. Its surveyed
  // crest ends at x=2290, z=-1500/1470. Let its dunes turn back into the sea.
  const first = positions.length / 3;
  const slices = 55;
  const zStops = [-2500, -2290, -2000, -1760, -1500, -1160, -670, 0, 705, 1190, 1470, 1770, 2110, 2460, 2600];
  const strand = [2740, 2450, 2270, 2050, 1900, 1760, 1655, 1820, 1620, 1843, 1986, 1950, 2180, 2600, 2820];
  const rows = [...new Set([...zStops, ...Array.from({ length: slices + 1 },
    (_, i) => lerp(zStops[0], zStops[zStops.length - 1], i / slices))])].sort((a, b) => a - b);
  for (let row = 0; row < rows.length; row++) {
    const z = rows[row];
    const segment = zStops.findIndex((end, i) => i > 0 && z <= end);
    const start = segment - 1;
    const t = (z - zStops[start]) / (zStops[segment] - zStops[start]);
    const west = lerp(strand[start], strand[segment], t);
    const east = 4400 + 260 * Math.sin(z / 724) + 195 * Math.cos(z / 392);
    const tip = Math.min(smoothstep(z, -2500, -2130), 1 - smoothstep(z, 2150, 2600));
    const columns = [-62, -27, 0, 12, 83, ...Array.from({ length: 31 },
      (_, i) => lerp(160, east - west, i / 30))];
    for (let column = 0; column < columns.length; column++) {
      const d = columns[column], x = west + d;
      const shore = 1 - smoothstep(x, east - 180, east);
      // Carry the dry dock's actual rock revetment up to its four-unit crest.
      // At either end the same elevations continue under turf and tidal silt.
      const berm = -37 + 5 * smoothstep(d, -62, -27) + 20 * smoothstep(d, -27, 0) +
        13.5 * smoothstep(d, 0, 12) + 2.2 * smoothstep(d, 12, 83) + 6 * smoothstep(d, 83, 450);
      const dune = smoothstep(x, 2145, 2850) * (64 + 48 * Math.sin(z / 480 + x / 350) +
        19 * Math.sin(z / 146 - x / 230) + 8 * Math.sin(x / 84 + z / 81));
      const height = -37 + tip * shore * (berm + 37 + dune);
      positions.push(x, height, z);
      color.copy(mud).lerp(grass, smoothstep(height, 2, 44))
        .lerp(heath, 0.18 + 0.16 * Math.sin(z / 307 + x / 220));
      colors.push(color.r, color.g, color.b);
      if (!row || !column) continue;
      const c = first + row * columns.length + column;
      const b = c - columns.length, a = b - 1;
      triangles.push(a, c - 1, c, a, c, b);
    }
  }
  const geometry = new T.BufferGeometry();
  geometry.setAttribute("position", new T.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new T.Float32BufferAttribute(colors, 3));
  geometry.setIndex(triangles);
  geometry.computeVertexNormals();
  return geometry;
}

// Haze on the backlit side of the harbour is a different colour to haze
// facing away from the sun. Read a narrow atmospheric band from the same HDR.
function horizonColors(sky: T.Texture, intensity: number): T.Color[] {
  if (!(sky instanceof T.DataTexture) || sky.type !== T.HalfFloatType) return [];
  const {data, width, height} = sky.image;
  if (!data) return [];
  const colors: T.Color[] = [];
  for (let sector = 0; sector < 48; sector++) {
    const sum = new T.Color(0, 0, 0);
    for (let dx = -2; dx <= 2; dx++) {
      const x = Math.floor((sector * width / 48 + dx * width / 240 + width) % width);
      const i = (Math.floor(height * 0.49) * width + x) * 4;
      sum.r += T.DataUtils.fromHalfFloat(data[i]);
      sum.g += T.DataUtils.fromHalfFloat(data[i + 1]);
      sum.b += T.DataUtils.fromHalfFloat(data[i + 2]);
    }
    colors.push(sum.multiplyScalar(intensity * 0.86 / 5));
  }
  return colors;
}

export class LowtideHorizon {
  private root = new T.Group();
  private waterFallback = new T.MeshBasicMaterial({ color: 0x638d96 });
  private sea = new T.Mesh<T.BufferGeometry, T.Material>(openWater(), this.waterFallback);
  private land = new T.Mesh(headlands(), new T.MeshLambertMaterial({ vertexColors: true }));
  private fog = new T.Fog(0xb8cbcf);
  private prior;
  private attachedSky: T.Texture | null = null;
  private haze: T.Color[] = [];
  private direction = new T.Vector3();

  constructor(private scene: T.Scene) {
    this.prior = {
      background: scene.background,
      intensity: scene.backgroundIntensity,
      blurriness: scene.backgroundBlurriness,
      rotation: scene.backgroundRotation.clone(),
      fog: scene.fog,
    };
    this.root.add(this.sea, this.land);
    scene.add(this.root);
    scene.background = new T.Color(0xb8cbcf);
    scene.fog = this.fog;
  }

  update(camera: T.PerspectiveCamera, distance: number) {
    const scene = this.scene;
    // The replay camera can open before the terrain's asynchronous HDR and GLBs arrive.
    if (scene.environment && this.attachedSky !== scene.environment) {
      this.attachedSky = scene.environment;
      scene.background = this.attachedSky;
      scene.backgroundIntensity = 0.62;
      scene.backgroundBlurriness = 0;
      this.haze = horizonColors(this.attachedSky, scene.backgroundIntensity);
      scene.traverse(object => {
        if (object instanceof T.Mesh && object.material?.name === "Water estuary")
          this.sea.material = object.material;
      });
    }
    this.root.rotation.y = scene.environmentRotation.y;
    scene.backgroundRotation.copy(scene.environmentRotation);
    if (this.haze.length) {
      const direction = camera.getWorldDirection(this.direction);
      const angle = Math.atan2(direction.z, direction.x) + scene.environmentRotation.y;
      const u = T.MathUtils.euclideanModulo(angle / (2 * Math.PI) + 0.5, 1) * this.haze.length;
      const i = Math.floor(u);
      this.fog.color.lerpColors(this.haze[i], this.haze[(i + 1) % this.haze.length], u - i);
    }
    this.fog.near = Math.max(850, distance + 220);
    this.fog.far = this.fog.near + 4650;
  }

  dispose() {
    this.root.removeFromParent();
    this.sea.geometry.dispose();
    this.waterFallback.dispose();
    this.land.geometry.dispose();
    this.land.material.dispose();
    const scene = this.scene;
    scene.fog = this.prior.fog;
    scene.background = this.prior.background;
    scene.backgroundIntensity = this.prior.intensity;
    scene.backgroundBlurriness = this.prior.blurriness;
    scene.backgroundRotation.copy(this.prior.rotation);
  }
}
