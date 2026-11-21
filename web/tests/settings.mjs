// Run with a local Chrome and a running lobby. Observe Web Audio output before
// the device mixer so this also works on a headless host without speakers.
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext({
    baseURL: process.env.LOBBY_URL ?? "http://127.0.0.1:4317",
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const problems = [];
  context.on("dialog", async (d) => {
    problems.push(d.type());
    await d.dismiss();
  });
  await context.addInitScript(() => {
    // Tap the actual master output, while retaining its normal speaker route.
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (target, ...args) {
      if (target === this.context.destination && !window.audioMeter) {
        window.audioMeter = this.context.createAnalyser();
        connect.call(this, window.audioMeter);
      }
      return connect.call(this, target, ...args);
    };
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on("pageerror", (e) => problems.push(e.message));
  await page.goto("/play/");
  await page.getByRole("heading", { name: "对战大厅" }).waitFor();
  const button = (name) => page.getByRole("button", { name, exact: true });
  await button("游戏设置").click();
  const dialog = page.getByRole("dialog");
  const mode = dialog.getByRole("combobox", { name: "开局自动录制" });
  await mode.tap();
  await dialog.getByRole("option", { name: "回放和视频" }).tap();
  assert.match(await mode.innerText(), /回放和视频/);
  await mode.press("Home");
  await mode.press("Enter");
  assert.match(await mode.innerText(), /关闭/);
  const audio = dialog.getByLabel("录入游戏声音");
  assert.equal(
    await audio.evaluate((el) => getComputedStyle(el).appearance),
    "none",
  );
  await audio.tap();
  assert.equal(await audio.isChecked(), false);
  const binding = dialog.getByRole("button", { name: "绑定手牌 1" });
  const labels = [
    "手牌 1",
    "手牌 2",
    "手牌 3",
    "手牌 4",
    "主动槽 1 技能",
    "主动槽 2 技能",
  ];
  async function readBindings() {
    return Promise.all(
      labels.map((name) =>
        dialog.getByRole("button", { name: "绑定" + name }).innerText(),
      ),
    );
  }
  const expected = ["Q", "W", "E", "R", "D", "F"];
  assert.deepEqual(await readBindings(), expected);

  // The previous client wrote default bindings even when only changing volume.
  const previous = {
    hand1: "Digit1",
    hand2: "Digit2",
    hand3: "Digit3",
    hand4: "Digit4",
    skill1: "KeyQ",
    skill2: "KeyW",
  };
  async function loadOld(bindings) {
    await page.evaluate(
      (bindings) =>
        localStorage.setItem(
          "clashlegends.preferences.v1",
          JSON.stringify({ master: 68, effects: 75, background: 50, bindings }),
        ),
      bindings,
    );
    await page.reload();
    await button("游戏设置").click();
  }
  await loadOld(previous);
  assert.deepEqual(await readBindings(), expected);
  assert.equal(
    await dialog.getByRole("slider", { name: "总音量" }).inputValue(),
    "68",
  );
  await loadOld({ ...previous, hand1: "KeyX" });
  assert.deepEqual(await readBindings(), ["X", "2", "3", "4", "Q", "W"]);
  await button("恢复默认键位").click();
  await binding.click();
  await binding.press("d");
  await dialog.getByText("这个键已绑定到主动槽 1 技能。").waitFor();
  await binding.press("z");
  await dialog.getByText("手牌 1已绑定 Z").waitFor();
  await binding.click();
  await binding.press("Escape");
  await dialog.getByRole("heading", { name: "游戏设置" }).waitFor();
  assert.equal(await binding.innerText(), "Z");
  const sfx = dialog.getByRole("slider", { name: "音效音量" });
  await sfx.focus();
  await sfx.press("End");
  const bg = dialog.getByRole("slider", { name: "背景音量" });
  await bg.focus();
  await bg.press("Home");
  await bg.press("ArrowRight");
  async function peak() {
    return page.evaluate(async () => {
      const meter = window.audioMeter,
        buf = new Float32Array(meter.fftSize);
      let max = 0;
      for (let i = 0; i < 25; i++) {
        meter.getFloatTimeDomainData(buf);
        for (const x of buf) max = Math.max(Math.abs(x), max);
        await new Promise((r) => setTimeout(r, 5));
      }
      return max;
    });
  }
  await button("试听音效").click();
  assert.ok((await peak()) > 0.003);
  await sfx.focus();
  await sfx.press("Home");
  await page.waitForTimeout(180);
  await button("试听音效").click();
  assert.ok((await peak()) < 0.0001);
  await button("完成").click();
  await page.reload();
  await button("游戏设置").click();
  assert.equal(await binding.innerText(), "Z");
  assert.equal(await sfx.inputValue(), "0");
  assert.equal(await bg.inputValue(), "1");
  await button("恢复默认键位").click();
  assert.deepEqual(await readBindings(), expected);
  await button("完成").click();
  await page.getByRole("link", { name: "我的卡组", exact: true }).click();
  await button("随机").click();
  const randomDeck = await page
    .locator(".prep-slots button")
    .evaluateAll((nodes) => nodes.map((n) => n.dataset.card));
  assert.equal(randomDeck.filter(Boolean).length, 8);
  assert.equal(new Set(randomDeck).size, 8);
  await page.getByLabel("卡组名称").fill("未保存草稿");
  await page.reload();
  assert.equal(await page.getByLabel("卡组名称").inputValue(), "未保存草稿");
  await page.getByRole("link", { name: "返回大厅", exact: true }).click();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await page.goBack();
  await page.getByRole("heading", { name: "对战大厅" }).waitFor();
  await page.goForward();
  assert.equal(await page.getByLabel("卡组名称").inputValue(), "未保存草稿");
  await button("建筑").click();
  assert.equal(await button("建筑").getAttribute("aria-pressed"), "true");
  await page.getByRole("link", { name: "返回大厅", exact: true }).click();
  await dialog.getByRole("button", { name: "放弃并离开" }).click();
  await page.getByRole("link", { name: "我的卡组", exact: true }).click();
  assert.equal(await page.getByLabel("卡组名称").inputValue(), "卡组 1");
  await page.getByLabel("卡组名称").fill("网页确认测试");
  await button("保存预设").click();
  await page.getByText("个人预设已保存").waitFor();
  await button("卡组 2").tap();
  assert.equal(await page.locator('.prep-slots [data-card=""]').count(), 8);
  await button("保存预设").tap();
  await page.getByText("个人预设已保存").waitFor();
  await button("卡组 1").focus();
  await page.keyboard.press("Enter");
  assert.equal(await page.getByLabel("卡组名称").inputValue(), "网页确认测试");
  assert.deepEqual(problems, []);
  console.log(
    "Web controls, native-dialog guard, audio output/mute, persisted volumes and key bindings, draft navigation and refresh passed",
  );
} finally {
  await browser.close();
}
