// Exercise the shared picker and the visible controls at desktop and phone sizes.
import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const browser = await chromium.launch({ channel: "chrome" });
try {
  const page = await browser.newPage({
    baseURL: process.env.LOBBY_URL ?? "http://127.0.0.1:4317",
  });
  await page.addInitScript(() =>
    localStorage.setItem(
      "clash.workbench.slots.v1",
      JSON.stringify([
        "ashe",
        "heavy_minion_squad",
        "stellar_convergence",
        "voidfish_ranged_army",
        "apex_turret",
        "aurelionsol",
        "gnar",
        "mega_inferno_bomb",
      ]),
    ),
  );
  await page.goto("/play/workbench");
  const button = (name) => page.getByRole("button", { name, exact: true });
  const pick = async (id) => {
    await button("选择对象").click();
    await page
      .getByRole("dialog")
      .locator('[data-value="' + id + '"]')
      .click();
  };
  for (const [width, height] of [
    [1366, 768],
    [1024, 640],
    [390, 844],
    [844, 390],
    [375, 667],
    [667, 375],
  ]) {
    await page.setViewportSize({ width, height });
    for (const [tab, selector] of [
      ["实战观察", ".wb-arena"],
      ["模型与动作", ".wb-view canvas"],
      ["音效试听", ".wb-player"],
      ["特效预览", ".wb-fx canvas"],
      ["卡牌资料", ".prep-detail dt"],
    ]) {
      await button(tab).click();
      await button("选择对象").click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("button", { name: "建筑", exact: true }).click();
      assert.equal(await dialog.locator('[data-value="ashe"]').count(), 0);
      assert.ok(await dialog.locator('[data-value="gold_ward"]').count());
      await dialog.getByRole("button", { name: "全部", exact: true }).click();
      await page.getByLabel("搜索卡牌").fill("sand_soldier");
      const art = dialog.locator('[data-value="sand_soldier"] img');
      await art.waitFor();
      assert.ok(
        await art.evaluate(async (img) => {
          await img.decode();
          return img.naturalWidth > 0;
        }),
      );
      await page.getByLabel("搜索卡牌").fill("ashe");
      await dialog.locator('[data-value="ashe"]').click();
      await page.locator(selector).first().waitFor();
      if (tab === "特效预览") {
        await page.getByRole("combobox", { name: "原生特效" }).click();
        const ids = await page
          .getByRole("listbox", { name: "原生特效" })
          .getByRole("option")
          .evaluateAll((opts) => opts.map((o) => o.dataset.value));
        assert.ok(
          ids.length && ids.every((id) => id.startsWith("ashe/")),
          JSON.stringify(ids),
        );
        await page.keyboard.press("Escape");
        await pick("stellar_convergence");
        await page.getByRole("combobox", { name: "原生特效" }).click();
        await page
          .locator('[role="option"][data-value="stellar_convergence/core"]')
          .click();
        await page.getByRole("button", { name: "下一页发射器" }).click();
        await page.locator(".wb-fx summary").click();
      }
      if (tab === "卡牌资料") {
        await pick("jinx");
        await button("查看大厅信息面板").click();
        await page
          .getByRole("dialog")
          .getByRole("button", { name: "返回工作台" })
          .click();
      }
      if (tab === "实战观察") {
        await button("场景与事件").click();
        await button("重建场景").click();
        await button("部署与单位").click();
        await page.getByRole("button", { name: "施加 1 秒" }).waitFor();
      }
      const metrics = await page.evaluate(() => {
        const visible = [
          ...document.querySelectorAll(
            ".wb button,.wb input,.wb canvas,.wb .prep-detail,.wb-arena,.wb-fx-path,.wb-emitter-list",
          ),
        ].filter(
          (e) =>
            e.getClientRects().length &&
            !e.closest(".game-list,.wb-log,.wb-clip-catalog"),
        );
        return {
          clipped: [
            ...document.querySelectorAll(".wb-tools,.wb-info,.wb-fx aside"),
          ]
            .filter((e) => e.scrollHeight > e.clientHeight + 2)
            .map((e) => [e.className, e.clientHeight, e.scrollHeight]),
          height: document.documentElement.scrollHeight,
          width: document.documentElement.scrollWidth,
          outside: visible
            .filter((e) => {
              const r = e.getBoundingClientRect();
              return (
                r.top < -1 ||
                r.bottom > innerHeight + 1 ||
                r.right > innerWidth + 1 ||
                r.left < -1
              );
            })
            .map(
              (e) => e.ariaLabel || e.textContent?.slice(0, 28) || e.tagName,
            ),
        };
      });
      assert.ok(
        metrics.height <= height + 1 &&
          metrics.width <= width + 1 &&
          !metrics.outside.length &&
          !metrics.clipped.length,
        JSON.stringify({ width, height, tab, ...metrics }),
      );
    }
  }
  await button("选择对象").click();
  await page.getByLabel("搜索卡牌").fill("freeze");
  await page.getByRole("dialog").locator('[data-value="freeze"]').click();
  await button("模型与动作").click();
  await page.getByText(/暂无可预览的模型/).waitFor();
  await button("音效试听").click();
  await page.locator(".wb-audio-panel").waitFor();
  assert.ok((await button("选择对象").innerText()).includes("冰"));
  await pick("match");
  await button("特效预览").click();
  await page.getByText("当前对象暂无已接入的特效。").waitFor();
  assert.equal(
    await page.getByRole("combobox", { name: "原生特效" }).count(),
    0,
  );
  console.log(
    "Shared picker, derived portrait, spell selection and all viewport layouts passed.",
  );
} finally {
  await browser.close();
}
