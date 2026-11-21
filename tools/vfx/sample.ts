// This build-time adapter runs the pinned LTK evaluator against a resolved native BIN tree.
import { readFileSync, writeFileSync } from "node:fs";
import { readVfxSystem } from "@vfx/engine/parsing/readVfxSystem";
import { createDriver } from "@vfx/engine/simulation/driver";
import {
  drawnPlace,
  drawnPlaceInto,
  frameOf,
  appearance,
  age01,
  particleBasisInto,
  spinOf,
  stretchOf,
  erosionDrive,
  travelBasisInto,
} from "@vfx/engine/simulation/particleRead";
import { mirrorInto } from "@vfx/engine/utils/basis";
import {
  facesTheCamera,
  isRay,
  isUnitQuad,
  drawPhases,
} from "@vfx/rendering/utils/drawKind";
import { footprintInto, modulateInto } from "@vfx/rendering/utils/projection";
import { fadeOf } from "@vfx/rendering/utils/softParticle";
import { drawnEmitters } from "@vfx/rendering/utils/definitions";
import {
  uvDraw,
  uvTransformInto,
  cellSize,
} from "@vfx/rendering/utils/uvTransform";
import { colorLookupInto } from "@vfx/rendering/utils/colorLookup";

const [input, output, config] = process.argv.slice(2);
const options = JSON.parse(config),
  raw = JSON.parse(readFileSync(input, "utf8"), (_key, value) => {
    if (value?.type === "asset" && value.path)
      value.asset = { standaloneUrl: value.path };
    return value;
  }),
  model = readVfxSystem(raw);
const defs = drawnEmitters(model, true).filter(
  ({ emitter: e, path }) =>
    (!options.rootOnly || !path) &&
    !e.disabled &&
    !e.culled &&
    (!options.only || options.only.includes(e.name)),
);
const driver = createDriver(79, { seekable: false });
driver.swap(model);
const moving = options.motion === "sona-wave";
const anchor = {
  originAt: (t: number) => [0, 0, Math.min(0.5, t) * 1280],
  basisInto: (_t: number, out: Float32Array) => {
    // Native missile Y points downrange, Z points up. Mirroring X converts to Three world space.
    out.set([-1, 0, 0, 0, 0, 1, 0, 1, 0]);
    return out;
  },
};
driver.steer({
  motion: moving ? { kind: "bone", anchor, target: null } : { kind: "still" },
  height: 0,
  life: "continuous",
  stopAt: moving ? 0.5 : null,
});
const layers = defs.map(({ emitter: e, rank }) => ({
  name: e.name,
  quadType: e.quadType,
  rank,
  pass: e.pass,
  groundLayer: e.groundLayer,
  phases: drawPhases(e),
  depthBias: e.depthBias,
  depthPushPull: e.depthPushPull,
  soft: fadeOf(e),
  projection: e.projection,
  blendMode: e.blendMode,
  miscRenderFlags: e.miscRenderFlags,
  billboard: facesTheCamera(e),
  meshDraw: !!e.mesh,
  ray: isRay(e),
  reach: isUnitQuad(e) ? 1 : 2,
  pivotUp: e.pivotUp,
  directionOriented: e.directionOriented,
  bind: e.bindWeight.constant[0] ?? 1,
  uv: e.uv,
  multUv: e.multUv ?? {},
  cell: cellSize(e.uv),
  cellMult: e.multUv ? cellSize(e.multUv) : [1, 1],
  beam: e.beam,
  trail: e.trail,
  erosion: e.erosion,
  distortion: e.distortion,
  alphaRef: e.alphaRef,
  texturePath: e.texture?.path,
  meshPath: e.mesh?.path,
  multPath: e.multTexture?.path,
  colorPath: e.colorTexture?.path,
  erosionPath: e.erosion?.map?.path,
  normalPath: e.distortion?.map?.path,
}));
const fps = options.fps ?? 60,
  duration = options.seconds ?? 3,
  total = Math.ceil(fps * duration) + 1;
const offsets = new Uint32Array(total * defs.length + 1);
const pieces: Buffer[] = [];
let count = 0,
  slot = 0;
const pose = drawnPlace(),
  app = { scale: new Float32Array(3), color: new Float32Array(4) };
const basis = new Float32Array(9),
  mirror = new Float32Array(9),
  uv = uvDraw(),
  lookup = new Float32Array(2);
for (let f = 0; f < total; f++) {
  if (f) driver.advance(1 / fps);
  const frame: number[] = [];
  for (const [li, { emitter: e, path }] of defs.entries()) {
    for (const source of path ? driver.sources(path) : [driver]) {
      const pool = source.pool,
        now = source.time,
        ctx = frameOf(source, e);
      for (let i = 0; i < pool.count; i++) {
        if (pool.emitter[i] !== e.index) continue;
        appearance(pool, i, e, now, app);
        drawnPlaceInto(pool, i, ctx, pose);
        if (e.directionOriented && facesTheCamera(e))
          travelBasisInto(pool, i, basis);
        else particleBasisInto(pool, i, e, ctx, basis);
        mirrorInto(basis, 0, mirror, 0);
        let xyz = [-pose.place[0], pose.place[1], pose.place[2]];
        const birth = pool.birthTime[i],
          through = age01(pool, i, now),
          bind = layers[li].bind;
        if (moving) {
          const travelled =
            1280 *
            (Math.min(0.5, birth) * (1 - bind) + Math.min(0.5, now) * bind);
          // Inverse of the authored moving orientation. Restore this motion exactly once in the browser.
          xyz = [-xyz[0], xyz[2] - travelled, xyz[1]];
          for (let column = 0; column < 3; column++) {
            const y = mirror[3 + column];
            mirror[column] *= -1;
            mirror[3 + column] = mirror[6 + column];
            mirror[6 + column] = y;
          }
        }
        const stretch = stretchOf(pool, i, e),
          camera = facesTheCamera(e);
        let rotation = (-spinOf(pool, i, e) * Math.PI) / 180;
        if (e.projection) {
          const footprint = { halfWidth: 0, halfHeight: 0, turn: 0 };
          footprintInto(e, pool, i, app.scale, basis, footprint);
          app.scale.set([footprint.halfWidth, 1, footprint.halfHeight]);
          modulateInto(e, app.color, app.color);
          rotation = footprint.turn;
        }
        frame.push(
          pool.serial[i],
          ...xyz,
          app.scale[0] * (camera ? 1 : stretch),
          app.scale[1] * (camera ? stretch : 1),
          app.scale[2],
          ...app.color,
          rotation,
          ...mirror,
        );
        for (const [j, layer] of [e.uv, e.multUv].entries()) {
          if (!layer) {
            frame.push(0, 1, 1, 0, 0, 0, 0);
            continue;
          }
          uvTransformInto(pool, i, layer, j, now - birth, through, now, uv);
          frame.push(
            uv.turn,
            uv.scaleU,
            uv.scaleV,
            uv.offsetU,
            uv.offsetV,
            uv.cellU,
            uv.cellV,
          );
        }
        colorLookupInto(e, pool, i, through, lookup, 0);
        frame.push(
          ...lookup,
          erosionDrive(pool, i, e, now),
          birth,
          pool.odometer[i],
        );
        count++;
      }
    }
    offsets[++slot] = count;
  }
  pieces.push(Buffer.from(new Float32Array(frame).buffer));
}
writeFileSync(
  output + ".json",
  JSON.stringify({
    version: 1,
    width: 40,
    frames: total,
    layers,
    fps,
    duration,
  }),
);
writeFileSync(
  output + ".bin",
  Buffer.concat([Buffer.from(offsets.buffer), ...pieces]),
);
