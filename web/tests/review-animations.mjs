// Exercise both prepared scenes and actions recovered directly from the League WAD.
import assert from "node:assert/strict";
import { chromium, devices } from "playwright-core";

const baseURL = process.env.LOBBY_URL ?? "http://127.0.0.1:4317";
const browser = await chromium.launch({ channel: "chrome" });
try {
  for (const touch of [false, true]) {
    const context = await browser.newContext({
      baseURL,
      ...(touch
        ? devices["iPhone 13"]
        : { viewport: { width: 1250, height: 860 } }),
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (/THREE\.PropertyBinding|WebGLProgram: Shader Error/.test(m.text()))
        errors.push(m.text());
    });
    const press = (element) => (touch ? element.tap() : element.click());
    for (const [model, name] of [
      ["garen", "Dance_Base"],
      ["reksai", "Dance"],
      ["scarecrow", "Spell4"],
    ]) {
      await page.goto("/play/workbench?view=models&model=" + model);
      const list = page.getByRole("listbox", { name: "动作片段" });
      const option = list.locator('[data-value="' + name + '"]');
      await option.waitFor();
      assert.match(await option.innerText(), /未接入/);
      const states = await list
        .getByRole("option")
        .evaluateAll((opts) => opts.map((o) => o.dataset.bound));
      assert.equal(states[0], "true");
      assert.ok(
        states.slice(states.indexOf("false")).every((x) => x === "false"),
      );
      if (!touch) {
        await list.locator('[aria-selected="true"]').press("End");
        assert.equal(
          await list.getByRole("option").last().getAttribute("aria-selected"),
          "true",
        );
      }
      await press(option);
      assert.equal(await option.getAttribute("aria-selected"), "true");
      await press(page.getByRole("button", { name: "暂停动作" }));
      const slider = page.getByLabel("动作时间轴");
      const canvas = page.getByLabel("模型观察");
      const before = await canvas.screenshot();
      const bounds = await slider.boundingBox();
      const position = { x: bounds.width * 0.55, y: bounds.height / 2 };
      if (touch) await slider.tap({ position });
      else await slider.click({ position });
      await page.evaluate(
        () =>
          new Promise((r) =>
            requestAnimationFrame(() => requestAnimationFrame(r)),
          ),
      );
      assert.notDeepEqual(
        await canvas.screenshot(),
        before,
        model + " pose did not change",
      );
      console.log(touch ? "touch" : "desktop", model, states.length, name);
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
} finally {
  await browser.close();
}
