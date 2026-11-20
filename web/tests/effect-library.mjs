// Load every native system through the same inspector used for manual review.
// Choose each track's densest frame, including effects that require an actual skinned model.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
const index = JSON.parse(
  readFileSync(new URL("../src/battle-effect-assets.json", import.meta.url)),
);
const browser = await chromium.launch({ channel: "chrome" });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 720 } });
  const errors = [];
  page.on("console", (m) => {
    if (/THREE.WebGLProgram|GL_INVALID|特效资源载入失败/i.test(m.text()))
      errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  // Exercise every imported resource, including ones without a selectable card.
  // The regular workbench passes only the selected object's systems to this inspector.
  const bundle = await build({
    stdin: {
      contents: `import {createRoot} from "react-dom/client";
        import {EffectInspector} from "./src/workbench-effects";
        import {systems} from "./src/native-particles";
        createRoot(document.querySelector("main")).render(<EffectInspector kind="ashe" members={[]} related={Object.keys(systems)} />);`,
      loader: "tsx",
      resolveDir: fileURLToPath(new URL("../", import.meta.url)),
    },
    jsx: "automatic",
    bundle: true,
    write: false,
    minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
  });
  await page.route("**/test-effect-inspector", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<main></main><script src="/test-effect-inspector.js"></script>',
    }),
  );
  await page.route("**/test-effect-inspector.js", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: bundle.outputFiles[0].text,
    }),
  );
  await page.goto(
    (process.env.LOBBY_URL ?? "http://127.0.0.1:4432") +
      "/test-effect-inspector",
  );
  await page.addStyleTag({
    content:
      ".wb-fx canvas {width:480px;height:320px} .choice-list {position:absolute;max-height:200px;overflow:auto;background:white;} .choice-list button {display:block;}",
  });
  const pick = page.getByLabel("原生特效"),
    slider = page.getByLabel("特效时间");
  let withPixels = 0,
    attachmentOnly = 0;
  for (const [id, s] of Object.entries(index.systems)) {
    const b = gunzipSync(
      readFileSync(new URL("../public/media/vfx/" + s.file, import.meta.url)),
    );
    const n = b.readUInt32LE(8),
      h = JSON.parse(b.subarray(12, 12 + n));
    const start = 12 + 4 * Math.ceil(n / 4);
    let max = 0,
      t = 0;
    for (let f = 0; f < h.frames; f++) {
      let count = 0;
      for (let i = 0; i < h.layers.length; i++) {
        const offset = start + 4 * (f * h.layers.length + i);
        const particles = b.readUInt32LE(offset + 4) - b.readUInt32LE(offset);
        count +=
          [4, 5].includes(h.layers[i].quadType) && particles < 2
            ? 0
            : particles;
      }
      if (count > max) {
        max = count;
        t = f;
      }
    }
    await pick.click();
    await page
      .getByRole("listbox", { name: "原生特效" })
      .locator('[data-value="' + id + '"]')
      .click();
    await page.waitForFunction(
      (k) => document.querySelector(".wb-fx canvas")?.dataset.system === k,
      id,
    );
    await slider.fill(String(Math.min(h.duration, (t + 0.5) / h.fps)));
    if (max) {
      try {
        await page.waitForFunction(
          () =>
            Number(document.querySelector(".wb-fx canvas").dataset.particles) >
            0,
          null,
          { timeout: 2500 },
        );
      } catch {
        errors.push(
          id +
            " produced no submitted geometry at " +
            t +
            "/" +
            h.fps +
            ", slider " +
            (await slider.inputValue()),
        );
      }
      if (h.layers.every((l) => l.quadType === 11)) attachmentOnly++;
      else withPixels++;
    } else errors.push(id + " has no drawable frame");
  }
  console.log(
    JSON.stringify({
      systems: Object.keys(index.systems).length,
      withStandaloneGeometry: withPixels,
      attachmentOnly,
      errors,
    }),
  );
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
