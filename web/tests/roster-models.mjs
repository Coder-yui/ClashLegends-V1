// Exercise the real workbench model and combat paths, and produce a contact sheet.
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const base = process.env.LOBBY_URL ?? "http://127.0.0.1:4432";
const dest =
  process.env.MODEL_REVIEW_DIR ??
  (await mkdtemp(join(tmpdir(), "clash-model-review-")));

const profiles = JSON.parse(
  await readFile(new URL("../src/roster-models.json", import.meta.url)),
);
const kinds = Object.keys(profiles);
const rules = JSON.parse(
  await readFile(new URL("../../content/battle_rules.json", import.meta.url)),
);
const index = JSON.parse(
  await readFile(
    new URL("../../content/model_resources.json", import.meta.url),
  ),
);
const { profileFor } = await import("../src/battle-motion.ts");
for (const [kind, rule] of Object.entries(rules)) {
  if (typeof rule.hp === "number")
    for (const team of [0, 1])
      assert.ok(
        index[kind][team].base.includes(profileFor({ kind, team }).asset),
        kind,
      );
}

const browser = await chromium.launch({ channel: "chrome" });
try {
  const context = await browser.newContext({
    baseURL: base,
    viewport: { width: 1040, height: 760 },
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => {
    console.error(e.message);
    errors.push(e.message);
  });
  page.on("console", (m) => {
    if (
      /Battle model unavailable|WebGLProgram: Shader Error|NaN|THREE.PropertyBinding: No target node found/.test(
        m.text(),
      )
    )
      errors.push(m.text());
  });
  await page.goto(base + "/play/workbench?view=models&model=princess_tower");
  const object = page.getByRole("button", { name: "选择对象", exact: true }),
    clip = page.getByLabel("动作片段");
  const thumbnails = [];
  let sampledClips = 0;
  for (const kind of kinds) {
    for (let form = 0; form < profiles[kind].length; form++) {
      await object.click();
      await page
        .getByRole("dialog", { name: "选择对象", exact: true })
        .locator('[data-value="' + kind + '"]')
        .click();
      if (profiles[kind].length > 1) {
        await page.getByRole("combobox", { name: "形态", exact: true }).click();
        await page
          .getByRole("listbox", { name: "形态", exact: true })
          .locator('[data-value="' + (form ? "alternate" : "base") + '"]')
          .click();
      }
      await page.waitForFunction(
        () =>
          document.querySelectorAll('[aria-label="动作片段"] [role="option"]')
            .length > 0,
      );
      await page.getByRole("button", { name: "暂停动作", exact: true }).click();
      // Read rendered alpha while the preview canvas is still the current framebuffer.
      const pixels = await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => {
              const c = document.querySelector('canvas[aria-label="模型观察"]'),
                gl = c.getContext("webgl2"),
                p = new Uint8Array(c.width * c.height * 4);
              gl.readPixels(
                0,
                0,
                c.width,
                c.height,
                gl.RGBA,
                gl.UNSIGNED_BYTE,
                p,
              );
              let visible = 0;
              for (let i = 3; i < p.length; i += 4) if (p[i] > 64) visible++;
              resolve(visible);
            }),
          ),
      );
      assert.ok(pixels > 120, kind + " rendered only " + pixels + " pixels");
      const title = (await object.textContent()) + (form ? " · 变身" : "");
      const body = await page.getByLabel("模型观察").screenshot();
      thumbnails.push({
        title,
        src: "data:image/png;base64," + body.toString("base64"),
      });
      // Exercise every bound native clip on its actual skeleton, including
      // the static poses and independently masked falling tower pieces.
      sampledClips += await clip.evaluate(async (root) => {
        const options = [...root.querySelectorAll("[role=option]")];
        for (const option of options) {
          option.click();
          await new Promise((r) =>
            requestAnimationFrame(() => requestAnimationFrame(r)),
          );
        }
        return options.length;
      });
      console.log(kind, form, pixels, "pixels");
    }
  }
  const sheet = await context.newPage();
  await sheet.setViewportSize({ width: 1400, height: 850 });
  await sheet.setContent(
    "<meta charset=utf-8><style>*{box-sizing:border-box}body{margin:0;padding:18px;background:#17242b;color:#f0dfb1;font:16px system-ui}main{display:grid;grid-template-columns:repeat(6,1fr);gap:9px}figure{margin:0;background:#23323a;border:1px solid #47565c}img{width:100%;display:block}figcaption{text-align:center;padding:3px}</style><main></main>",
  );
  await sheet.evaluate((list) => {
    for (const { src, title } of list) {
      const f = document.createElement("figure"),
        i = document.createElement("img"),
        t = document.createElement("figcaption");
      i.src = src;
      t.textContent = title;
      f.append(i, t);
      document.querySelector("main").append(f);
    }
  }, thumbnails);
  await sheet.evaluate(() =>
    Promise.all([...document.images].map((i) => i.decode())),
  );
  await sheet.screenshot({
    fullPage: true,
    path: join(dest, "英雄与衍生物模型总览.png"),
  });
  await sheet.close();
  assert.deepEqual(errors, []);
  console.log(
    "Passed",
    kinds.length,
    "objects,",
    thumbnails.length,
    "forms,",
    sampledClips,
    "clips.",
    dest,
  );
} finally {
  await browser.close();
}
