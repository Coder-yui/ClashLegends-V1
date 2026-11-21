// Exercise the depth buffer itself, not just flags or submitted draw counts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";

async function check(
  T,
  BattleTerrain,
  ParticleLibrary,
  ParticleActor,
  ParticleBackdrop,
  maps,
) {
  const renderer = new T.WebGLRenderer({ antialias: false });
  renderer.setSize(192, 192);
  document.body.append(renderer.domElement);
  const gl = renderer.getContext();
  const scene = new T.Scene(),
    terrain = new BattleTerrain();
  scene.add(terrain.root);
  const frame = { map: maps[0], units: [] };
  terrain.update(frame, 0);
  const start = performance.now();
  while (
    terrain.root.children.length < 2 ||
    !terrain.root.children[0].material.uniforms.projected.value
  ) {
    if (performance.now() - start > 10000)
      throw Error("Failed to load actual Rift geometry");
    await new Promise(requestAnimationFrame);
  }
  const ortho = new T.OrthographicCamera(-40, 40, 40, -40, 1, 4000);
  const perspective = new T.PerspectiveCamera(35, 1, 1, 4000);
  const marker = new T.Mesh(
    new T.SphereGeometry(2, 16, 12),
    new T.MeshBasicMaterial({ color: 0xff00ff }),
  );
  scene.add(marker);
  function pixel(camera) {
    renderer.render(scene, camera);
    const bytes = new Uint8Array(4);
    gl.readPixels(96, 96, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    return [...bytes];
  }
  const magenta = (p) => p[0] > 245 && p[1] < 8 && p[2] > 245;
  const hits = [];
  // Sample the actual bridge, river and rocky bank. A single flat quad cannot pass.
  const ray = new T.Raycaster();
  terrain.root.updateMatrixWorld(true);
  for (const [x, z] of [
    [-220, 0],
    [0, 0],
    [425, 0],
    [425, 200],
  ]) {
    ray.set(new T.Vector3(x, 1500, z), new T.Vector3(0, -1, 0));
    const hit = ray
      .intersectObjects(terrain.root.children, false)
      .find(
        (i) => i.object.visible && !i.object.material.uniforms.cutoff.value,
      );
    if (!hit) throw Error("No solid terrain at " + [x, z]);
    hits.push(hit.point.toArray());
  }
  const occlusion = [];
  for (const [x, y, z] of hits.slice(0, 2)) {
    for (const camera of [ortho, perspective]) {
      camera.up.set(0, 0, -1);
      camera.position.set(x, y + 220, z + 0.01);
      camera.lookAt(x, y, z);
      for (const dh of [-6, 6]) {
        marker.position.set(x, y + dh, z);
        occlusion.push(magenta(pixel(camera)));
      }
    }
  }
  const oblique = [];
  const target = new T.Vector3(...hits[3]);
  const direction = new T.Vector3(0.5, 1, 0.6).normalize();
  for (const camera of [ortho, perspective]) {
    camera.up.set(0, 1, 0);
    camera.position.copy(target).addScaledVector(direction, 240);
    camera.lookAt(target);
    ray.set(camera.position, direction.clone().negate());
    const hit = ray
      .intersectObjects(terrain.root.children, false)
      .find(
        (i) => i.object.visible && !i.object.material.uniforms.cutoff.value,
      );
    for (const distance of [-5, 5]) {
      marker.position.copy(hit.point).addScaledVector(direction, distance);
      oblique.push(magenta(pixel(camera)));
    }
  }

  // Use the alternative map's actual ground material as a known plane. Both
  // cameras look down -Y, so the soft particle's view-space gap is its height.
  frame.map = maps[1];
  terrain.update(frame, 1);
  marker.visible = false;
  const baseline = {},
    light = {},
    soft = {},
    order = {},
    aperture = {},
    offset = {},
    projection = {};
  const library = new ParticleLibrary(),
    backdrop = new ParticleBackdrop(library);
  const load = async (name, layerName) => {
    const track = await library.load(name);
    const index = track.layers.findIndex((l) => l.name === layerName);
    if (index < 0) throw Error(name + "/" + layerName);
    const material = track.materials[index];
    // White illumination isolates depth state from the chosen animation frame's colour.
    const white = new T.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    white.needsUpdate = true;
    material.uniforms.image.value = white;
    material.uniforms.has.value.set(0, 0, 0, 0);
    const rows = new Float32Array(40);
    rows.set([
      0, 0, 0, 0, 16, 16, 16, 1, 1, 1, 1, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1,
    ]);
    const actor = new ParticleActor(name, {
      ...track,
      layers: [track.layers[index]],
      shapes: [track.shapes[index]],
      materials: [material],
      frames: 1,
      rows,
      offsets: new Uint32Array([0, 1]),
    });
    scene.add(actor.root);
    actor.sample(0, "high", new Set(), false);
    actor.root.visible = false;
    return actor;
  };
  const free = await load("sona/wave", "motes");
  const tested = await load("sona/wave", "notetrail");
  const dust = await load("sett/max", "dust1");
  const push = await load("missfortune_w/left", "Basic3");
  const forward = await load("blitzcrank/ebuf", "glowOverlay");
  const back = await load("aurelionsol_q", "Flash");
  const decal = await load("solar_flare/warning", "Focused_Sun");
  const flame = await load("olaf/r_buff_weap", "FlameBits");
  const cutout = {};
  for (const [key, camera] of [
    ["ortho", ortho],
    ["perspective", perspective],
  ]) {
    camera.up.set(0, 0, -1);
    camera.position.set(0, 240, 200);
    camera.lookAt(0, 0, 200);
    const read = (actor, y) => {
      actor.root.position.set(0, y, 200);
      actor.root.visible = true;
      backdrop.capture(renderer, scene, camera, actor.root, actor.inputs);
      const r = pixel(camera)[0];
      actor.root.visible = false;
      return r;
    };
    baseline[key] = pixel(camera)[0];
    light[key] = [read(free, -18), read(tested, -18), read(tested, 18)];
    soft[key] = [read(dust, 0.2), read(dust, 25), read(dust, 55)];
    offset[key] = [
      read(push, -25),
      read(push, -65),
      read(forward, 0),
      read(back, 0),
    ];
    const extent = decal.track.materials[0].uniforms.heightFade.value;
    projection[key] = [read(decal, 0), read(decal, extent.x + extent.y + 2)];
    // An alpha-tested foreground writes depth only where the texel survives.
    // Draw the light behind it afterwards through the regular particle pass.
    flame.root.position.set(0, 15, 200);
    flame.root.visible = true;
    const mask = flame.track.materials[0].uniforms.image.value;
    mask.image.data.fill(0);
    mask.image.data[3] = 255;
    mask.needsUpdate = true;
    const blocked = read(tested, 5);
    mask.image.data[3] = 0;
    mask.needsUpdate = true;
    cutout[key] = [blocked, read(tested, 5)];
    flame.root.visible = false;

    marker.position.set(0, -12, 200);
    marker.visible = true;
    const noWell = magenta(pixel(camera));
    frame.units = [{ kind: "nexus", x: 400, y: 440, team: 1 }];
    terrain.update(frame, 1);
    aperture[key] = [noWell, magenta(pixel(camera))];
    frame.units = [];
    terrain.update(frame, 1);
    marker.visible = false;
  }
  // A disabled-Z ground layer still draws before a character, an ordinary
  // disabled-Z layer draws over it. Test the production order on the framebuffer.
  const ground = await load("olaf/r_buf", "Basic");
  ground.track.materials[0].uniforms.flags.value.y = 1; // face the test camera
  marker.visible = true;
  marker.position.set(0, 12, 200);
  for (const [key, actor] of [
    ["ground", ground],
    ["over", free],
  ]) {
    actor.root.visible = true;
    actor.root.position.set(0, 0, 200);
    order[key] = magenta(pixel(ortho));
    actor.root.visible = false;
  }
  const warp = await load("event_horizon/cage", "DistortFIXED_OUT");
  warp.root.position.set(0, 0, 200);
  warp.root.visible = true;
  backdrop.capture(renderer, scene, ortho, warp.root, warp.inputs, [marker]);
  const sampleScene = new T.Scene();
  const sampleMaterial = new T.MeshBasicMaterial();
  sampleScene.add(new T.Mesh(new T.PlaneGeometry(2, 2), sampleMaterial));
  const screenCamera = new T.OrthographicCamera(-1, 1, 1, -1, 0.1, 2);
  screenCamera.position.z = 1;
  const phases = [];
  for (const sampler of [library.earlyScreen, library.screen]) {
    sampleMaterial.map = sampler.value;
    sampleMaterial.needsUpdate = true;
    renderer.render(sampleScene, screenCamera);
    const bytes = new Uint8Array(4);
    gl.readPixels(96, 96, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    phases.push(magenta(bytes));
  }
  const err = gl.getError();
  return {
    hits,
    occlusion,
    oblique,
    light,
    soft,
    baseline,
    order,
    aperture,
    offset,
    projection,
    cutout,
    phases,
    err,
  };
}

const root = new URL("../", import.meta.url);
const maps = JSON.parse(
  readFileSync(new URL("../../content/maps.json", import.meta.url)),
);
const bundle = await build({
  stdin: {
    resolveDir: fileURLToPath(root),
    contents: `
import * as T from "three";
import {BattleTerrain} from "./src/battle-terrain";
import {ParticleLibrary,ParticleActor,ParticleBackdrop} from "./src/native-particles";
window.check=()=> (${check.toString()})(T,BattleTerrain,ParticleLibrary,ParticleActor,ParticleBackdrop,${JSON.stringify(maps)});
`,
  },
  bundle: true,
  write: false,
});
const browser = await chromium.launch({ channel: "chrome" });
try {
  const page = await browser.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" || m.text().includes("GL_INVALID"))
      errors.push(m.text());
  });
  await page.route("http://depth.test/**", (r) => {
    const path = new URL(r.request().url()).pathname;
    if (path === "/")
      return r.fulfill({
        contentType: "text/html",
        body: '<script src="/run.js"></script>',
      });
    if (path === "/run.js")
      return r.fulfill({
        contentType: "text/javascript",
        body: bundle.outputFiles[0].text,
      });
    if (!path.startsWith("/play/media/")) return r.abort();
    return r.fulfill({
      path: fileURLToPath(new URL("public/" + path.slice(6), root)),
    });
  });
  await page.goto("http://depth.test");
  const v = await page.evaluate(() => window.check());
  console.log(JSON.stringify(v));
  assert.deepEqual(errors, []);
  assert.equal(v.err, 0);
  assert.ok(
    Math.abs(v.hits[0][1] - v.hits[1][1]) > 2,
    "bridge and river have distinct surface heights",
  );
  assert.deepEqual(v.occlusion, [
    false,
    true,
    false,
    true,
    false,
    true,
    false,
    true,
  ]);
  assert.deepEqual(v.oblique, [false, true, false, true]);
  assert.deepEqual(v.phases, [false, true]);
  for (const key of ["ortho", "perspective"]) {
    const [through, behind, above] = v.light[key],
      [near, mid, far] = v.soft[key];
    assert.ok(through > 200 && above > 200);
    assert.equal(behind, v.baseline[key]);
    assert.ok(near < mid && mid < far, "soft fade is continuous in view space");
    assert.deepEqual(v.aperture[key], [false, true]);
    const [pulled, tooDeep, frontBias, backBias] = v.offset[key];
    assert.ok(pulled > 200 && frontBias > 200);
    assert.equal(tooDeep, v.baseline[key]);
    assert.equal(backBias, v.baseline[key]);
    assert.ok(v.projection[key][0] > 200);
    assert.equal(v.projection[key][1], v.baseline[key]);
    assert.deepEqual(v.cutout[key], [0, 255]);
  }
  assert.deepEqual(v.order, { ground: true, over: false });
} finally {
  await browser.close();
}
