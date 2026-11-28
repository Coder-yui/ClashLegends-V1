import * as T from "three";
import type { Frame } from "./battle-field";
import { profileFor, type ModelProfile } from "./battle-motion";

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

/** Screen-space cutouts let the sunken portion of a structure meet the ground. */
export class StructureOpenings {
  private wellData = new T.DataTexture(
    new Float32Array(4),
    1,
    1,
    T.RGBAFormat,
    T.FloatType,
  );
  readonly uniforms = {
    wells: { value: this.wellData },
    wellCount: { value: 0 },
  };
  update(frame: Frame, me: number) {
    const { map } = frame;
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
    this.wellData.dispose();
  }
}
