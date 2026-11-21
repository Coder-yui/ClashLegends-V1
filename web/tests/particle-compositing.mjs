// Compare the browser-composited battlefield with the same native emitter drawn
// over opaque terrain. A draw-call or geometry-count check misses black quads.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";

function installFixture(T, ParticleLibrary, ParticleActor, ParticleBackdrop) {
  const renderer = new T.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setSize(256, 256);
  document.body.append(renderer.domElement);
  const scene = new T.Scene();
  const camera = new T.OrthographicCamera(-155, 155, 155, -155, 1, 4000);
  camera.position.set(0, 810, 588);
  camera.lookAt(0, 0, 0);
  const library = new ParticleLibrary();
  const backdrop = new ParticleBackdrop(library);
  const swatch = document.createElement("canvas");
  swatch.width = swatch.height = 8;
  const ctx = swatch.getContext("2d");
  ctx.fillStyle = "#688060";
  ctx.fillRect(0, 0, 8, 8);
  const flatTerrain = swatch.toDataURL();
  const ground = new T.Color(ctx.fillStyle);
  let actor;

  // The reference camera puts the outer edges of these quads on known
  // terrain pixels. Their bright or subtractive centers must still render.
  window.edgePixels = async (name, frame, probes) => {
    actor?.dispose();
    renderer.setSize(152, 132);
    Object.assign(camera, { left: -380, right: 380, top: 330, bottom: -330 });
    camera.position.set(0, 3240, 2351);
    camera.far = 13000;
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    scene.background = new T.Color(0x78857c);
    const track = await library.load(name);
    actor = new ParticleActor(name, track);
    scene.add(actor.root);
    actor.sample(frame / track.fps, "high", new Set(), false);
    backdrop.capture(renderer, scene, camera, actor.root, actor.inputs);
    renderer.render(scene, camera);
    const canvas = document.createElement("canvas");
    canvas.width = 152;
    canvas.height = 132;
    const pixels = canvas.getContext("2d");
    pixels.drawImage(renderer.domElement, 0, 0);
    const read = ([x, y]) =>
      Array.from(pixels.getImageData(x, y, 1, 1).data).slice(0, 3);
    return {
      edge: probes.map(read),
      corner: read([0, 0]),
      center: read([76, 66]),
    };
  };
  window.draw = async (name, layer, frame, mode) => {
    actor?.dispose();
    const track = await library.load(name);
    actor = new ParticleActor(name, track);
    scene.add(actor.root);
    const muted = new Set(
      track.layers.map((l) => l.name).filter((n) => n !== layer),
    );
    actor.sample((frame + 0.5) / track.fps, "high", muted, false);
    if (!actor.drawn) throw Error("No visible geometry for " + layer);
    actor.root.visible = mode !== "bare";
    scene.background = mode === "reference" ? ground : null;
    renderer.setClearColor(0, 0);
    if (["terrain", "rift", "bare"].includes(mode)) {
      const texture = await new T.TextureLoader().loadAsync(
        mode === "terrain" ? flatTerrain : "/play/media/battle/rift-arena.webp",
      );
      texture.colorSpace = T.SRGBColorSpace;
      scene.background = texture;
    }
    backdrop.capture(
      renderer,
      scene,
      camera,
      actor.root,
      actor.root.visible ? actor.inputs : 0,
    );
    renderer.render(scene, camera);
  };
}

const bundle = await build({
  stdin: {
    resolveDir: fileURLToPath(new URL("../", import.meta.url)),
    contents: `import * as T from "three";
      import {ParticleLibrary, ParticleActor, ParticleBackdrop} from "./src/native-particles";
      (${installFixture.toString()})(T, ParticleLibrary, ParticleActor, ParticleBackdrop);`,
  },
  bundle: true,
  write: false,
});
const browser = await chromium.launch({ channel: "chrome" });
try {
  const page = await browser.newPage({ viewport: { width: 256, height: 256 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.route("http://vfx.test/**", (r) => {
    const path = new URL(r.request().url()).pathname;
    if (path === "/")
      return r.fulfill({
        contentType: "text/html",
        body: '<style>*{margin:0}body{background:#688060}canvas{display:block}</style><script defer src="/test.js"></script>',
      });
    if (path === "/test.js")
      return r.fulfill({
        contentType: "text/javascript",
        body: bundle.outputFiles[0].text,
      });
    if (path === "/play/media/battle/rift-arena.webp")
      return r.fulfill({
        path: fileURLToPath(
          new URL("../public/media/battle/rift-arena.webp", import.meta.url),
        ),
      });
    if (!/^\/play\/media\/vfx\/[a-f0-9]+\.(png|mesh\.json|vfx\.gz)$/.test(path))
      return r.abort();
    return r.fulfill({
      path: fileURLToPath(
        new URL("../public/" + path.slice(6), import.meta.url),
      ),
    });
  });
  await page.goto("http://vfx.test/");
  const results = [];
  for (const [name, layer, frame, mode, reference = "reference"] of [
    ["aatrox/hit", "flash", 2, "transparent"],
    ["lightning_spells/stormsurge", "Flash", 2, "transparent"],
    ["void_summoning", "Shockwaves1", 227, "terrain"],
    ["event_horizon/impact", "Distort1", 8, "terrain"],
    ["event_horizon/impact", "Distort1", 17, "rift", "bare"],
  ]) {
    const photos = [];
    for (const background of [mode, reference]) {
      await page.evaluate(
        (args) => window.draw(...args),
        [name, layer, frame, background],
      );
      photos.push((await page.screenshot()).toString("base64"));
    }
    const stats = await page.evaluate(async (frames) => {
      const images = await Promise.all(
        frames.map(async (src) => {
          const image = new Image();
          image.src = "data:image/png;base64," + src;
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 256;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(image, 0, 0);
          return ctx.getImageData(0, 0, 256, 256).data;
        }),
      );
      let different = 0,
        shaded = 0,
        lit = 0;
      for (let i = 0; i < images[0].length; i += 4) {
        const [a, b] = images;
        if ([0, 1, 2].some((k) => Math.abs(a[i + k] - b[i + k]) > 2))
          different++;
        if (b[i] < 101 || b[i + 1] < 125 || b[i + 2] < 93) shaded++;
        if (b[i] > 107 || b[i + 1] > 131 || b[i + 2] > 99) lit++;
      }
      return { different, shaded, lit };
    }, photos);
    results.push({ name, layer, ...stats });
  }
  console.table(results);
  assert.deepEqual(errors, []);
  for (const item of results.slice(0, 4))
    assert.equal(item.different, 0, item.name);
  assert.ok(
    results[0].lit > 50 && results[1].lit > 50,
    "native flashes must remain visible",
  );
  assert.ok(results[2].shaded > 50, "native subtract must darken the ground");
  assert.equal(
    results[3].shaded + results[3].lit,
    0,
    "refraction of flat terrain preserves its color",
  );
  assert.ok(
    results[4].different > 50 && results[4].different < (256 * 256) / 2,
    "refraction must visibly distort a bounded part of the textured map",
  );
  for (const [id, frame, probes] of [
    [
      "ashe/hit",
      1,
      [
        [57, 57],
        [75, 84],
        [94, 75],
      ],
    ],
    [
      "kayle/native/sword",
      12,
      [
        [53, 52],
        [53, 110],
        [98, 97],
      ],
    ],
    [
      "corrosion/area",
      48,
      [
        [34, 9],
        [76, 9],
        [144, 116],
      ],
    ],
  ]) {
    const result = await page.evaluate(
      (args) => window.edgePixels(...args),
      [id, frame, probes],
    );
    for (const pixel of result.edge)
      assert.ok(
        pixel.every((v, i) => Math.abs(v - result.corner[i]) <= 2),
        id + " has a visible quad seam",
      );
    assert.notDeepEqual(
      result.center,
      result.corner,
      id + " must retain its center",
    );
  }
} finally {
  await browser.close();
}
