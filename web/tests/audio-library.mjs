// Exercise the actual preview controls and independently decode the shipped banks in Chrome.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";
const catalog = JSON.parse(
  await readFile(new URL("../src/battle-audio-banks.json", import.meta.url)),
);
const browser = await chromium.launch({ channel: "chrome" });
try {
  const page = await browser.newPage({
    baseURL: process.env.LOBBY_URL ?? "http://127.0.0.1:4317",
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    window.previewStarts = [];
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) {
      if (this.buffer && args.length >= 3)
        window.previewStarts.push({ offset: args[1], duration: args[2] });
      return start.apply(this, args);
    };
  });
  await page.goto("/play/workbench");
  await page.getByRole("button", { name: "音效试听", exact: true }).click();
  // These four actions occur in base form in live matches. Inspect their inherited
  // definitions in the alternate-form preview without injecting any live cues.
  for (const [kind, event] of [
    ["aatrox", "deploy:voice"],
    ["jayce", "deploy:voice"],
    ["jayce", "burst:start"],
    ["jinx", "deploy:start"],
  ]) {
    await page.getByRole("button", { name: "选择对象", exact: true }).click();
    await page.getByLabel("搜索卡牌").fill(kind);
    await page.getByRole("dialog").locator(`[data-value="${kind}"]`).click();
    await page.getByRole("button", { name: "变身形态", exact: true }).click();
    const spec =
      catalog.profiles[catalog.variants[kind + "/1/0"]].events[event];
    const index = spec.pool.length - 1;
    const before = await page.evaluate(() => window.previewStarts.length);
    await page
      .getByRole("button", {
        name: event + " 变体 " + (index + 1),
        exact: true,
      })
      .click();
    await page.waitForFunction((n) => window.previewStarts.length > n, before);
    const actual = await page.evaluate(() => window.previewStarts.at(-1));
    const [, offset, length] = catalog.clips[spec.pool[index]];
    assert.equal(actual.offset, offset / 44100);
    assert.equal(actual.duration, length / 44100);
    await page.getByRole("button", { name: "停止", exact: true }).click();
  }
  const timeline = page.getByRole("slider", { name: "音频时间轴" });
  const playButton = (name) => page.getByRole("button", { name, exact: true });
  const duration = Number(await timeline.getAttribute("max"));
  const startPosition = duration * 0.2;
  await timeline.fill(String(startPosition));
  await playButton("继续播放").click();
  await playButton("暂停").click();
  const paused = Number(await timeline.inputValue());
  assert.ok(paused >= startPosition && paused < duration);
  await page.waitForTimeout(100);
  assert.equal(Number(await timeline.inputValue()), paused);
  await playButton("继续播放").click();
  await playButton("暂停").waitFor();
  await page.waitForFunction(
    (d) => Math.abs(window.previewStarts.at(-1).duration - d) < 0.001,
    duration - paused,
  );
  await timeline.fill(String(duration / 2));
  await page.waitForFunction(
    (d) => Math.abs(window.previewStarts.at(-1).duration - d) < 0.001,
    duration / 2,
  );
  await playButton("停止").click();
  assert.equal(Number(await timeline.inputValue()), 0);
  async function selectCard(target, kind) {
    await target.getByRole("button", { name: "选择对象", exact: true }).click();
    await target.getByLabel("搜索卡牌").fill(kind);
    await target.getByRole("dialog").locator(`[data-value="${kind}"]`).click();
  }
  const details = page.getByLabel("当前变体的音频来源与处理");
  await selectCard(page, "graves");
  const voice = playButton("deploy:voice 变体 2");
  await voice.focus();
  await page.keyboard.press("Enter");
  assert.equal(await voice.getAttribute("aria-pressed"), "true");
  assert.match(await details.innerText(), /未加工，保留原声/);
  assert.match(await details.innerText(), /增益 -18 dB/);
  await playButton("deploy:voice 变体 1").click();
  assert.match(await details.innerText(), /增益 0 dB/);
  await selectCard(page, "jinx");
  await playButton("deploy:start 变体 1").click();
  assert.match(await details.innerText(), /加速约 2.567 倍/);
  await selectCard(page, "interface_audio");
  await page.getByText(/正弦波/).waitFor();
  await playButton("确认").click();

  const phone = await browser.newPage({
    baseURL: page.url(),
    viewport: { width: 375, height: 667 },
    hasTouch: true,
    isMobile: true,
  });
  await phone.goto("/play/workbench");
  await phone.getByRole("button", { name: "音效试听", exact: true }).tap();
  await selectCard(phone, "freeze");
  const cast = phone.getByRole("button", { name: "spell:cast 变体 1" });
  await cast.tap();
  assert.match(await cast.innerText(), /外来音效/);
  const external = phone.getByLabel("当前变体的音频来源与处理");
  assert.match(await external.innerText(), /皇室战争/);
  assert.match(await external.innerText(), /截取前 3 秒/);
  assert.match(await external.innerText(), /增益 -12 dB/);
  for (const viewport of [
    { width: 375, height: 667 },
    { width: 667, height: 375 },
  ]) {
    await phone.setViewportSize(viewport);
    const rect = await external.boundingBox();
    assert.ok(
      rect &&
        rect.x >= 0 &&
        rect.y >= 0 &&
        rect.x + rect.width <= viewport.width &&
        rect.y + rect.height <= viewport.height,
    );
    assert.ok(
      await phone
        .locator(".wb-clip-catalog")
        .evaluate((el) => el.clientHeight >= 44),
    );
  }
  await phone.close();
  const checked = await page.evaluate(async ({ files, clips }) => {
    const offline = new OfflineAudioContext(2, 1, 44100);
    let total = 0;
    for (let i = 0; i < files.length; i++) {
      const response = await fetch("/play/media/audio/" + files[i]);
      if (!response.ok) throw Error(files[i]);
      const buffer = await offline.decodeAudioData(
        await response.arrayBuffer(),
      );
      for (const [bank, start, size] of clips)
        if (bank === i) {
          if (
            size <= 0 ||
            start < 0 ||
            start + size > buffer.length ||
            buffer.sampleRate !== 44100
          )
            throw Error("Bad slice " + files[i]);
          total++;
        }
    }
    return total;
  }, catalog);
  assert.equal(checked, catalog.clips.length);
  assert.deepEqual(errors, []);
  console.log(
    "Chrome decoded",
    catalog.files.length,
    "banks and checked",
    checked,
    "clip boundaries; four inherited events played from the workbench",
  );
} finally {
  await browser.close();
}
