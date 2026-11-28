import assert from "node:assert/strict";
import { chromium } from "playwright-core";
const browser = await chromium.launch({ channel: "chrome" });
try {
  const ctx = await browser.newContext({
    baseURL: process.env.LOBBY_URL ?? "http://127.0.0.1:4317",
    viewport: { width: 1050, height: 820 },
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const live = new Map(),
    replay = new Map();
  page.on("websocket", (ws) => {
    const target = ws.url().includes("/api/recordings/")
      ? replay
      : ws.url().includes("/api/matches/")
        ? live
        : null;
    if (target)
      ws.on("framereceived", ({ payload }) => {
        const f = JSON.parse(payload);
        if (f.type === "frame") target.set(f.tick, f);
      });
  });
  const btn = (name) => page.getByRole("button", { name, exact: true });
  async function choose(label, id) {
    await page.getByRole("combobox", { name: label }).click();
    await page
      .getByRole("listbox", { name: label })
      .locator('[data-value="' + id + '"]')
      .click();
  }
  await page.goto("/play/");
  await btn("游戏设置").click();
  await choose("开局自动录制", "both");
  await btn("完成").click();
  for (const name of ["对战电脑玩家 →", "进入备战 →", "开始游戏"])
    await btn(name).click();
  const field = page.locator(".battle-input");
  await page
    .locator(".battle-hand button:enabled:not(.unaffordable)")
    .first()
    .click();
  const box = await field.boundingBox();
  await field.click({
    position: { x: box.width * 0.25, y: box.height * 0.65 },
  });
  await page.waitForFunction(
    () => Number(document.querySelector(".battle-input")?.dataset.tick) >= 100,
  );
  const reference = [...live.values()].find((f) => f.tick >= 60 && f.ack > 0);
  assert.ok(reference, "the live game accepted a stamped input");
  await btn("对局录制").click();
  await btn("停止录制").click();
  await page.getByText("视频已保存到「我的录制」").waitFor();
  await btn("关闭").click();
  const mid = page.url().split("/").pop();
  await page.goto("/play/recordings");
  await page.getByRole("link", { name: "打开回放" }).first().waitFor();
  await btn("播放视频").click();
  await page.waitForFunction(
    () => document.querySelector("video")?.readyState >= 2,
  );
  assert.deepEqual(
    await page.locator("video").evaluate((v) => [v.videoWidth, v.videoHeight]),
    [720, 1280],
  );
  assert.equal(await page.locator("video").evaluate((v) => v.controls), false);
  await btn("暂停视频").click();
  await page.getByRole("slider", { name: "视频进度" }).fill("1");
  await page.waitForFunction(
    () => Math.abs(document.querySelector("video").currentTime - 1) < 0.2,
  );
  await btn("静音").click();
  assert.equal(
    await page.locator("video").evaluate((v) => v.muted && v.paused),
    true,
  );
  await page.getByLabel("视频音量").fill("0.35");
  await choose("播放速度", "2");
  assert.deepEqual(
    await page
      .locator("video")
      .evaluate((v) => [v.volume, v.muted, v.playbackRate]),
    [0.35, false, 2],
  );
  await btn("播放视频").click();
  if (process.env.VIDEO_CAPTURE) {
    const download = page.waitForEvent("download");
    await btn("下载视频").click();
    await (await download).saveAs(process.env.VIDEO_CAPTURE);
  }
  await btn("关闭").click();
  await page.locator('a[href="/play/recordings/' + mid + '"]').click();
  await page.waitForSelector(".battle-overlay");
  const range = page.getByRole("slider", { name: "回放进度" });
  await range.fill(String(reference.tick));
  await page.waitForFunction(
    (t) => Number(document.querySelector(".battle-input").dataset.tick) === t,
    reference.tick,
  );
  const rebuilt = replay.get(reference.tick);
  for (const key of [
    "units",
    "hand",
    "spells",
    "shots",
    "areas",
    "active",
    "ack",
    "gold",
    "remaining",
  ])
    assert.deepEqual(rebuilt[key], reference[key], key);
  async function sampleSpeed(speed) {
    await range.fill("1");
    await page.waitForFunction(
      () => document.querySelector(".battle-input").dataset.tick === "1",
    );
    await choose("播放速度", speed);
    await btn("播放").click();
    await page.waitForTimeout(650);
    await btn("暂停").click();
    await page.waitForTimeout(150);
    return Number(await field.getAttribute("data-tick")) - 1;
  }
  const slow = await sampleSpeed("0.5");
  const fast = await sampleSpeed("4");
  assert.ok(slow > 0 && fast >= 3 * slow, JSON.stringify({ slow, fast }));
  const frozen = await field.getAttribute("data-tick");
  await btn("录制设置").click();
  await choose("视频画幅", "1:1");
  await choose("视频清晰度", "540");
  await choose("视频帧率", "24");
  await page.getByLabel("录入游戏声音").uncheck();
  await btn("关闭").click();
  await btn("自由镜头").click();
  await btn("录制视频").click();
  const gl = page.locator(".cinema .battle-models");
  await gl.waitFor();
  await page.waitForTimeout(550);
  const before = await gl.screenshot();
  await page.mouse.move(500, 360);
  await page.mouse.down();
  await page.mouse.move(610, 415, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(350);
  assert.notDeepEqual(await gl.screenshot(), before);
  assert.equal(await field.getAttribute("data-tick"), frozen);
  await btn("停止录制").click();
  await page.getByText("视频已保存到「我的录制」").waitFor();
  await page.getByRole("link", { name: /我的录制/ }).click();
  await page.getByRole("button", { name: "下载视频" }).nth(1).waitFor();
  assert.equal(await page.getByRole("button", { name: "下载视频" }).count(), 2);
  await btn("播放视频").first().click();
  await page.waitForFunction(
    () => document.querySelector("video")?.readyState >= 2,
  );
  assert.deepEqual(
    await page.locator("video").evaluate((v) => [v.videoWidth, v.videoHeight]),
    [540, 540],
  );
  if (process.env.CAMERA_CAPTURE) {
    const exporting = page.waitForEvent("download");
    await btn("下载视频").first().click();
    await (await exporting).saveAs(process.env.CAMERA_CAPTURE);
  }
  assert.deepEqual(errors, []);
  console.log(
    "Live video decoded at 720x1280; replay matches authoritative state at tick",
    reference.tick,
    "after deployment; 4x, seeking, frozen camera and second video passed.",
  );
} finally {
  await browser.close();
}
