// Run against the local development lobby with the workbench enabled.
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
const base = process.env.LOBBY_URL ?? "http://127.0.0.1:4432";
const browser = await chromium.launch({ channel: "chrome" });
try {
  const page = await browser.newPage({
    ...(process.argv.includes("--mobile")
      ? {
          viewport: { width: 390, height: 844 },
          deviceScaleFactor: 3,
          isMobile: true,
          hasTouch: true,
        }
      : { viewport: { width: 1120, height: 820 } }),
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (/THREE.WebGLProgram|GL_INVALID|特效资源载入失败/i.test(m.text()))
      errors.push(m.text());
  });
  await page.addInitScript(() => {
    window.nativeSamples = new Map();
    const Socket = WebSocket;
    window.WebSocket = class extends Socket {
      constructor(...args) {
        super(...args);
        if (!String(args[0]).endsWith("/workbench/live")) return;
        window.edit = (cmd) => this.send(JSON.stringify(cmd));
        this.addEventListener("message", (e) => {
          const d = JSON.parse(e.data);
          if (d.type === "frame") window.frame = d;
        });
      }
    };
    document.addEventListener(
      "battle-render",
      (e) => {
        for (const fx of e.detail.effects ?? [])
          window.nativeSamples.set(fx.system, fx);
      },
      true,
    );
    window.fxSeen = 0;
    document.addEventListener(
      "battle-render",
      (e) => {
        window.fxSeen = Math.max(window.fxSeen, e.detail.vfx?.particles ?? 0);
      },
      true,
    );
  });
  await page.goto(base + "/play/workbench?view=effects&animationTrace");
  const fx = page.getByLabel("原生特效"),
    canvas = page.getByLabel("原生粒子预览");
  for (const [id, age] of [
    ["ashe/arrow", 0.24],
    ["sona/heal_self", 0.45],
    ["sona/wave", 0.35],
    ["final_spark/beam", 1.04],
  ]) {
    await page.getByRole("button", { name: "选择对象", exact: true }).click();
    await page
      .getByRole("dialog")
      .locator('[data-value="' + id.split("/")[0] + '"]')
      .click();
    await fx.click();
    await page
      .getByRole("listbox", { name: "原生特效" })
      .locator('[data-value="' + id + '"]')
      .click();
    await page.waitForFunction(
      (k) => document.querySelector(".wb-fx canvas")?.dataset.system === k,
      id,
    );
    await page.waitForFunction(() =>
      document.querySelector(".wb-emitter-list input"),
    );
    const slider = page.getByLabel("特效时间");
    await slider.fill(String(age));
    await page.waitForTimeout(180);
    const count = Number(await canvas.getAttribute("data-particles"));
    assert(count > 0, id + " has no active native particles");
    const before = await canvas.screenshot({
      path: join(tmpdir(), id.replace("/", "-") + "-vfx.png"),
    });
    const next = page.getByRole("button", { name: "下一页发射器" });
    do {
      await page
        .locator(".wb-emitter-list input")
        .evaluateAll((checks) =>
          checks.filter((x) => x.checked).forEach((x) => x.click()),
        );
      if (!(await next.count()) || !(await next.isEnabled())) break;
      await next.click();
    } while (true);
    await page.waitForFunction(
      () => document.querySelector(".wb-fx canvas").dataset.particles === "0",
    );
    assert(
      !before.equals(await canvas.screenshot()),
      id + " had no visible pixels",
    );
    console.log(id, count);
  }
  await page.getByRole("button", { name: "实战观察" }).click();
  await page.getByRole("button", { name: "选择对象", exact: true }).click();
  await page.getByRole("dialog").locator('[data-value="ashe"]').click();
  await page.getByRole("button", { name: "场景与事件", exact: true }).click();
  await page.getByRole("button", { name: "重建场景" }).click();
  await page.waitForFunction(() => window.fxSeen > 0, null, { timeout: 20000 });
  console.log(
    "live battle particles",
    await page.evaluate(() => window.fxSeen),
  );
  const edit = (cmd) => page.evaluate((v) => window.edit(v), cmd);
  const seen = (key) =>
    page.waitForFunction((k) => window.nativeSamples.has(k), key, {
      timeout: 15000,
    });
  await seen("ashe/arrow");
  await seen("ashe/hit");
  await edit({ action: "cast" });
  await seen("ashe/volley");
  await seen("ashe/volley_hit");
  for (const team of [0, 1]) {
    await edit({ action: "clock", paused: true, speed: 4 });
    const epoch = await page.evaluate(() => window.frame.lab.epoch);
    await edit({
      action: "scene",
      scene: "dummy",
      card: "sona",
      skill: "sona.crescendo",
      team,
    });
    await page.waitForFunction((n) => window.frame.lab.epoch > n, epoch);
    await page.evaluate(() => window.nativeSamples.clear());
    await edit({ action: "clock", paused: false, speed: 4 });
    await seen("sona/heal_self");
    await seen("sona/basic");
    await edit({ action: "cast" });
    await seen("sona/cast");
    await seen("sona/wave");
    const wave = await page.evaluate(() =>
      window.nativeSamples.get("sona/wave"),
    );
    assert(wave.position[1] > 0, "wave height");
    const [qx, , qz] = wave.orientation;
    assert(
      Math.abs(1 - 2 * (qx * qx + qz * qz)) < 0.0001,
      "native missile Y lies in the ground plane",
    );
    await edit({ action: "control", kind: "stun" });
    await seen("annie/stunned");
    console.log(
      "Sona W, attack, R and stun",
      team,
      "wave height",
      wave.position[1],
    );
  }
  await edit({
    action: "deploy",
    card: "final_spark",
    skill: null,
    team: 0,
    x: 360,
    y: 840,
  });
  await seen("final_spark/cast");
  await seen("final_spark/beam");
  await edit({ action: "clock", paused: true, speed: 4 });
  const age = await page.evaluate(
    () => window.nativeSamples.get("final_spark/beam").start,
  );
  await page.waitForTimeout(160);
  assert.equal(
    await page.evaluate(
      () => window.nativeSamples.get("final_spark/beam").start,
    ),
    age,
  );
  await edit({
    action: "scene",
    scene: "surround",
    card: "fiddlesticks",
    skill: null,
    team: 0,
  });
  await edit({ action: "clock", paused: false, speed: 4 });
  await seen("fiddlesticks/tether");
  console.log("Final Spark and Fiddlesticks reached in live battle");
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
