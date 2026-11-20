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
const rules = JSON.parse(
  await readFile(new URL("../../content/battle_rules.json", import.meta.url)),
);
const buildings = Object.keys(rules).filter(
  (k) => rules[k].type === "building",
);
const both = new Set([
  "ranged_minion",
  "melee_minion",
  "siege_minion",
  "super_minion",
  "princess_tower",
  "nexus",
  "inhibitor",
  "sun_disc",
  "target_dummy",
]);
const kinds = [
  "melee_minion",
  "ranged_minion",
  "siege_minion",
  "super_minion",
  "princess_tower",
  "nexus",
  ...buildings,
];
const browser = await chromium.launch({ channel: "chrome" });
try {
  const context = await browser.newContext({
    baseURL: base,
    viewport: { width: 1040, height: 760 },
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
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
    for (const team of both.has(kind) ? [0, 1] : [0]) {
      await object.click();
      await page
        .getByRole("dialog", { name: "选择对象", exact: true })
        .locator('[data-value="' + kind + '"]')
        .click();
      await page
        .getByRole("button", { name: team ? "红方" : "蓝方", exact: true })
        .click();
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
      const title =
        (await object.textContent()) +
        (both.has(kind) ? (team ? " · 红" : " · 蓝") : "");
      const body = await page.getByLabel("模型观察").screenshot();
      thumbnails.push({
        title,
        src: "data:image/png;base64," + body.toString("base64"),
      });
      // Exercise every bound native clip on its actual skeleton, including
      // the static poses and independently masked falling tower pieces.
      for (const name of await clip
        .getByRole("option")
        .evaluateAll((options) => options.map((o) => o.dataset.value))) {
        await clip.locator('[data-value="' + name + '"]').click();
        await page.evaluate(
          () =>
            new Promise((done) =>
              requestAnimationFrame(() => requestAnimationFrame(done)),
            ),
        );
        sampledClips++;
      }
      console.log(kind, team, pixels, "pixels");
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
    path: join(dest, "小兵与建筑模型总览.png"),
  });
  await sheet.close();
  await page.goto(base + "/play/workbench");
  const frames = [];
  await page.addInitScript(() =>
    document.addEventListener(
      "battle-render",
      (e) => (window.modelCount = e.detail.actors),
      true,
    ),
  );
  page.on("websocket", (s) => {
    if (s.url().includes("/workbench/live"))
      s.on("framereceived", ({ payload }) => {
        const f = JSON.parse(payload);
        if (f.type === "frame") frames.push(f);
      });
  });
  await page.reload();
  await page.waitForFunction(() => window.modelCount === 6);
  await page.screenshot({ path: join(dest, "地图建筑.png") });
  const b = (name) => page.getByRole("button", { name, exact: true });
  await b("场景与事件").click();
  await b("暂停战斗").click();
  for (const kind of [
    ...buildings,
    "ranged_minion",
    "siege_minion",
    "super_minion",
  ]) {
    const name = rules[kind].name;
    await b("选择对象").click();
    await page.getByLabel("搜索卡牌").fill(kind);
    await b(name).click();
    const epoch = frames.at(-1).lab.epoch;
    await b("重建场景").click();
    for (let i = 0; i < 100 && frames.at(-1).lab.epoch === epoch; i++)
      await page.waitForTimeout(40);
    assert.ok(
      frames.at(-1).units.some((u) => u.kind === kind),
      kind + " " + (await page.getByRole("alert").allTextContents()),
    );
    await page.waitForFunction(() => window.modelCount >= 8);
    await b("选择对象").click();
    await b("移除 " + kind).click();
    await b("关闭").click();
  }
  await b("清场").click();
  await b("选择对象").click();
  await page.getByLabel("搜索卡牌").fill("explosive_cask");
  await b("爆破酒桶").click();
  const tower = frames
    .at(-1)
    .units.find((u) => u.kind === "princess_tower" && u.team === 1);
  const box = await page.getByLabel("对战战场").boundingBox();
  for (let i = 0; i < 41; i++)
    await page.mouse.click(
      box.x + (box.width * tower.x) / 720,
      box.y + (box.height * tower.y) / 1280,
    );
  await b("继续战斗").click();
  for (let i = 0; i < 160 && !frames.at(-1).ruinedTowers?.length; i++)
    await page.waitForTimeout(50);
  assert.equal(
    frames.at(-1).ruinedTowers?.[0]?.id,
    tower.id,
    "authoritative tower ruin",
  );
  await b("暂停战斗").click();
  await page.waitForFunction(
    () =>
      document.querySelector(".wb-stats")?.textContent.includes("暂停") &&
      window.modelCount === 6,
  );
  await page.evaluate(
    () =>
      new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      ),
  );
  await page.screenshot({ path: join(dest, "倒塔后的地基.png") });
  assert.deepEqual(errors, []);
  console.log(
    "Passed",
    kinds.length,
    "object types,",
    thumbnails.length,
    "team appearances,",
    sampledClips,
    "clip previews.",
    dest,
  );
} finally {
  await browser.close();
}
