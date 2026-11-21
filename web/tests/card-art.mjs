// Capture card crops through the real workbench and preparation components.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const base = process.env.LOBBY_URL ?? "http://127.0.0.1:4317";
const ids = process.argv.slice(2);
const smoke = !ids.length;
const out =
  process.env.CARD_ART_OUTPUT ??
  (await mkdtemp(join(tmpdir(), "clash-card-art-")));
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: "chrome" });
try {
  const page = await browser.newPage({
    baseURL: base,
    viewport: { width: 1280, height: 860 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (/THREE.WebGLProgram|GL_INVALID/.test(m.text())) errors.push(m.text());
  });
  const art = JSON.parse(
    await readFile(
      new URL("../../content/card_art.json", import.meta.url),
      "utf8",
    ),
  );
  const catalog = await (await page.request.get("/api/battle/catalog")).json();
  assert.ok(catalog.workbench, "需要启用开发工作台的本机宿主");
  const button = (name) => page.getByRole("button", { name, exact: true });
  const shot = () => page.waitForEvent("download");
  const readPixels = async (selector) =>
    page.locator(selector).evaluate(async (el) => {
      await el.decode();
      const c = document.createElement("canvas");
      c.width = 76;
      c.height = 140;
      const ctx = c.getContext("2d");
      ctx.drawImage(el, 0, 0, 76, 140);
      return new Set(
        ctx.getImageData(0, 0, 76, 140).data.filter((_, i) => i % 4 === 0),
      ).size;
    });
  for (const id of smoke
    ? ["sand_soldier", "heavy_minion_squad", "sun_disc", "sona"]
    : ids) {
    assert.match(id, /^[a-z0-9_-]+$/);
    await page.goto("/play/workbench?view=photo&model=" + id);
    await page.locator(".photo-layout").waitFor();
    const card = catalog.cards.find((c) => c.id === id);
    // Non-selectable objects arrive in the host's objects message.
    await button("查看卡槽裁切").waitFor();
    await button("查看卡槽裁切").click();
    const proof = page.getByLabel("卡面裁切对照");
    const images = await proof.locator("img").evaluateAll(async (imgs) =>
      Promise.all(
        imgs.map(async (i) => {
          await i.decode();
          return i.getAttribute("src");
        }),
      ),
    );
    assert.ok(images.length >= 3 && images.every((url) => url === images[0]));
    if (art[id]) assert.equal(images[0], art[id].image);
    if (smoke && id === "sona" && !art[id])
      assert.match(images[0], /preparation\/sona\.webp$/);
    await proof.screenshot({ path: join(out, id + "-crops.png") });
    if (smoke && id !== "sona") {
      await button("返回取景").click();
      await page.waitForFunction(
        () => !document.querySelector(".photo-tools footer button")?.disabled,
      );
      if (id === "heavy_minion_squad") {
        assert.equal(await button("1 超级兵").count(), 1);
        assert.equal(await button("2 炮车兵").count(), 1);
        await page.getByLabel("定格时间（秒）").fill("0.25");
      }
      await button("机位与光线").click();
      await page.locator(".photo-color summary").click();
      await page.getByRole("slider", { name: "红", exact: true }).fill("204");
      assert.match(
        await page.locator(".photo-color summary").innerText(),
        /#cc[0-9a-f]{4}/i,
      );
      await page.getByLabel("透明背景").check();
      await page.getByLabel("水平环绕").fill("24");
      await button("成片与方案").click();
      const recipe = shot();
      await button("保存方案").click();
      const recipePath = join(out, id + "-shot.json");
      await (await recipe).saveAs(recipePath);
      const first = shot();
      await button("拍摄卡面 PNG").click();
      const path = join(out, id + "-card.png");
      await (await first).saveAs(path);
      const png = await readFile(path);
      assert.equal(png.readUInt32BE(16), 308);
      assert.equal(png.readUInt32BE(20), 560);
      assert.ok((await readPixels(".photo-proof .prep-art >> nth=0")) > 12);
      await page.reload();
      await button("成片与方案").click();
      await page.locator('input[accept=".json"]').setInputFiles(recipePath);
      await page.getByText("已恢复构图", { exact: true }).waitFor();
      const second = shot();
      await button("拍摄卡面 PNG").click();
      assert.deepEqual(
        await readFile(await (await second).path()),
        png,
        "恢复方案应导出同一帧",
      );
      await proof.screenshot({ path: join(out, id + "-candidate-crops.png") });
    }
    if (card) {
      await page.goto("/play/decks/collection");
      const pool = page.locator('.prep-pool [data-card="' + id + '"]');
      await page.locator(".prep-slots").waitFor();
      const equipped = page.locator('.prep-slots [data-card="' + id + '"]');
      if (await equipped.count()) {
        await equipped.click();
        await button("移除").click();
      }
      await pool.scrollIntoViewIfNeeded();
      assert.equal(
        await pool.locator(".prep-art").getAttribute("src"),
        images[0],
      );
      await pool.screenshot({ path: join(out, id + "-pool.png") });
      await pool.click();
      await button("信息").click();
      const detail = page.getByRole("dialog").locator(".prep-detail");
      assert.equal(
        await detail.locator(".prep-art").getAttribute("src"),
        images[0],
      );
      await detail.screenshot({ path: join(out, id + "-detail.png") });
    }
  }
  if (smoke) {
    await page.goto("/play/workbench?view=photo&model=gnar");
    await button("机位与光线").click();
    await button("完整取景").click();
    assert.ok(Number(await page.getByLabel("镜头距离").inputValue()) < 12);
    await button("成员与动作").click();
    await button("变身形态").click();
    await button("红方").click();
    await page.waitForFunction(
      () => !document.querySelector(".photo-tools footer button")?.disabled,
    );
    // A spell with no native body can start a shot from a candidate GLB.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/play/workbench?view=photo&model=freeze");
    const glb = fileURLToPath(
      new URL("../public/media/models/ashe.glb", import.meta.url),
    );
    const file = page.locator('input[accept=".glb"]');
    await file.setInputFiles(glb);
    await button("播放动作").click();
    await page.waitForFunction(
      () =>
        Number(
          document.querySelector('input[aria-label="定格时间（秒）"]').value,
        ) > 0.1,
    );
    await button("定格动作").click();
    await button("成片与方案").click();
    const saved = shot();
    await button("保存方案").click();
    await saved;
    await page.reload();
    await button("成片与方案").click();
    await button("恢复已存方案").click();
    await page.getByRole("alert").filter({ hasText: "重新选择" }).waitFor();
    await button("成员与动作").click();
    await file.setInputFiles(glb);
    const photo = shot();
    await button("拍摄卡面 PNG").click();
    await photo;
    await button("返回取景").click();
    const box = await page.getByLabel("卡面取景").boundingBox();
    assert.ok(
      box.width > 80 && Math.abs(box.width / box.height - 308 / 560) < 0.01,
    );
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.screenshot({ path: join(out, "mobile-studio.png") });
  }
  assert.deepEqual(errors, []);
  console.log("卡面裁切与拍摄结果", out);
} finally {
  await browser.close();
}
