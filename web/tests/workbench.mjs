// Run against a local lobby with the development workbench enabled.
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { join } from "node:path";
import { tmpdir } from "node:os";

const base = process.env.LOBBY_URL ?? "http://127.0.0.1:4430";
const browser = await chromium.launch({ channel: "chrome" });
try {
  const context = await browser.newContext({
    baseURL: base,
    viewport: { width: 1320, height: 920 },
  });
  const page = await context.newPage();
  const frames = [],
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (
      /Battle model unavailable|战场使用几何视图|THREE.WebGLProgram/.test(
        m.text(),
      )
    )
      errors.push(m.text());
  });
  page.on("websocket", (socket) => {
    if (socket.url().endsWith("/workbench/live"))
      socket.on("framereceived", ({ payload }) => {
        const f = JSON.parse(payload);
        if (f.type === "frame") frames.push(f);
      });
  });
  const button = (name) => page.getByRole("button", { name, exact: true });
  const wait = async (predicate, message) => {
    const until = Date.now() + 10000;
    while (Date.now() < until) {
      if (predicate(frames.at(-1))) return;
      await page.waitForTimeout(40);
    }
    assert.fail(message);
  };
  await page.goto(base + "/play/");
  await page.getByRole("link", { name: "开发工作台" }).click();
  await wait((f) => f?.lab.paused, "initial paused frame");
  await button("重建场景").click();
  await wait(
    (f) => f?.lab.selected && f.units.some((u) => u.kind === "training_dummy"),
    "dummy scene",
  );
  const actor = frames.at(-1).lab.selected;
  await button("单步 1 Tick").click();
  await wait((f) => f.tick === 1, "one authoritative tick");
  await button("继续战斗").click();
  await wait(
    (f) => f.presentation.events.some((e) => e.fact.kind === "fired"),
    "Ashe fired at dummy",
  );
  await button("暂停战斗").click();
  await wait((f) => f.lab.paused, "pause acknowledged");
  await button("万箭齐发").click();
  await wait(
    (f) => f.presentation.events.some((e) => e.fact.kind === "cast"),
    "manual cast",
  );
  await button("施加 1 秒").click();
  await wait(
    (f) => f.units.find((u) => u.id === actor)?.frozen,
    "single-target control",
  );
  await page.screenshot({ path: join(tmpdir(), "clash-workbench-battle.png") });
  await button("模型与动作").click();
  const clip = page.getByLabel("动作片段");
  await clip.locator('[data-value="Attack1"]').click();
  assert.equal(await clip.getByRole("option").count(), 25);
  assert.equal(await clip.locator('[data-bound="true"]').count(), 6);
  assert.equal(await page.locator("select").count(), 0);
  await button("暂停动作").click();
  await button("定位出手 · 0.30 秒").click();
  assert.equal(Number(await page.getByLabel("动作时间轴").inputValue()), 0.3);
  await page.screenshot({ path: join(tmpdir(), "clash-workbench-model.png") });
  const frozen = frames.at(-1).tick;
  await page.getByRole("combobox", { name: "对象", exact: true }).click();
  await page
    .getByRole("listbox", { name: "对象", exact: true })
    .locator('[data-value="melee_minion"]')
    .click();
  await button("红方").click();
  await clip.locator('[data-value="Attack2"]').click();
  await page.getByRole("button", { name: "卡牌信息" }).click();
  await page.getByRole("dialog").waitFor();
  await button("返回工作台").click();
  assert.equal(frames.at(-1).tick, frozen);
  await button("实战观察").click();
  await button("卡牌资料").click();
  await page.getByLabel("查找资料").fill("艾希");
  await page.getByRole("heading", { name: "艾希", exact: true }).waitFor();
  await button("实战观察").click();
  await button("选择实验卡").click();
  await page.getByLabel("搜索卡牌").fill("黄沙士兵");
  await button("黄沙士兵").click();
  await button("完成 · 3/8").click();
  await button("重建场景").click();
  await wait(
    (f) => f.units.some((u) => u.kind === "sand_soldier" && u.team === 1),
    "system object",
  );
  const box = await page.getByLabel("对战战场").boundingBox();
  assert.ok(box.width > 160 && box.height > 300);
  const place = async (x, y) =>
    page.mouse.click(
      box.x + (box.width * x) / 720,
      box.y + (box.height * y) / 1280,
    );
  await page.keyboard.press("2");
  await place(380, 880);
  await wait(
    (f) => f.units.some((u) => u.kind === "melee_minion" && u.team === 1),
    "opposite-half placement",
  );
  const count = frames.at(-1).units.length;
  await button("选择单位").click();
  await place(380, 880);
  await wait(
    (f) =>
      f.units.find((u) => u.id === f.lab.selected)?.kind === "melee_minion",
    "selection",
  );
  assert.equal(frames.at(-1).units.length, count);
  await button("清场").click();
  await wait((f) => f.units.length === 6 && !f.lab.selected, "clear field");
  const other = await page.context().newPage();
  await other.goto(base + "/play/workbench");
  await other.getByRole("button", { name: "重建场景" }).click();
  await other.getByText(/艾希 #/).waitFor();
  assert.equal(frames.at(-1).units.length, 6);
  await other.close();
  await page.bringToFront();
  await page.reload();
  await page.getByTitle("黄沙士兵", { exact: true }).waitFor();
  await button("继续战斗").click();
  await wait(
    (f) => f.tick > 2 && !f.lab.paused,
    "running before opening library",
  );
  await button("选择实验卡").click();
  await wait((f) => f.lab.paused, "library pauses running battle");
  const pausedAt = frames.at(-1).tick;
  await page.getByLabel("搜索卡牌").fill("爆破酒桶");
  await button("爆破酒桶").click();
  assert.equal(frames.at(-1).tick, pausedAt);
  await button("完成 · 4/8").click();
  await wait(
    (f) => f.tick > pausedAt && !f.lab.paused,
    "closing library restores the clock",
  );
  await button("暂停战斗").click();
  await wait((f) => f.lab.paused, "pause for spell placement");
  await page.getByRole("checkbox", { name: "启用法术技能" }).check();
  await button("重建场景").click();
  await wait(
    (f) =>
      f.spells.some((s) => s.key === "explosive_cask") &&
      f.lab.selected === null,
    "enhanced spell can be placed",
  );
  await button("选择实验卡").click();
  for (const id of ["ashe", "melee_minion", "sand_soldier", "explosive_cask"])
    await button("移除 " + id).click();
  await button("完成 · 0/8").click();
  await page.reload();
  await page.getByText("点击「选择实验卡」添加快捷槽。").waitFor();
  assert.deepEqual(errors, []);
  console.log("Workbench browser checks passed. Evidence:", tmpdir());
} finally {
  await browser.close();
}
