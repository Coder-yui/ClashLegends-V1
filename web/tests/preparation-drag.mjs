import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const browser = await chromium.launch({ channel: "chrome" });
const baseURL = process.env.LOBBY_URL ?? "http://127.0.0.1:4317";
try {
  for (const mobile of [false, true]) {
    const page = await browser.newPage({
      baseURL,
      hasTouch: mobile,
      viewport: mobile
        ? { width: 390, height: 844 }
        : { width: 1200, height: 850 },
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.request.get("/api/session");
    const response = await page.request.post("/api/rooms", {
      data: { kind: "ai", map: "rift", mode: "classic" },
    });
    assert.ok(response.ok(), await response.text());
    const room = await response.json();
    await page.goto("/play/rooms/" + room.id);
    const slots = page.locator(".prep-slots button");
    const pool = page.locator(".prep-pool");
    const search = page.getByRole("searchbox", { name: "搜索卡牌" });
    const ghost = page.locator(".prep-drag-ghost");
    const cards = () =>
      slots.evaluateAll((nodes) => nodes.map((n) => n.dataset.card));
    // Fill a repeatable starting deck before exercising real pointer input.
    await page
      .getByRole("button", { name: "随机", exact: true })
      .evaluate((button) => {
        const random = Math.random;
        try {
          Math.random = () => 0;
          button.click();
        } finally {
          Math.random = random;
        }
      });
    const original = await cards();
    assert.equal(new Set(original).size, 8);
    const catalog = await (
      await page.request.get("/api/battle/catalog")
    ).json();
    const incoming = catalog.cards.find(
      (c) => !original.includes(c.id) && c.skills.length > 1,
    );
    const candidate = pool.locator('[data-card="' + incoming.id + '"]');
    const cdp = await page.context().newCDPSession(page);
    const touch = (type, point) =>
      cdp.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: point ? [point] : [],
      });
    const center = async (locator) => {
      const b = await locator.boundingBox();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    };
    async function drag(from, to, cancel = false) {
      const start = await center(from),
        end = await center(to);
      if (mobile) {
        await touch("touchStart", start);
        if (await from.evaluate((el) => !!el.closest(".prep-pool")))
          await ghost.waitFor();
        await touch("touchMove", {
          x: start.x + (end.x - start.x) * 0.25,
          y: start.y + (end.y - start.y) * 0.25,
        });
        await touch("touchMove", end);
      } else {
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        await page.mouse.move(end.x, end.y, { steps: 5 });
      }
      await ghost.waitFor();
      if (!cancel) await page.locator("[data-drop-target=true]").waitFor();
      if (mobile) await touch(cancel ? "touchCancel" : "touchEnd");
      else {
        if (cancel) await page.keyboard.press("Escape");
        await page.mouse.up();
      }
      await ghost.waitFor({ state: "detached" });
      assert.equal(await page.locator(".prep-menu").count(), 0);
    }
    if (mobile) {
      const start = await center(pool);
      await touch("touchStart", start);
      await touch("touchMove", { x: start.x, y: start.y - 25 });
      await touch("touchMove", { x: start.x, y: start.y - 85 });
      await touch("touchEnd");
      await page.waitForFunction(
        () => document.querySelector(".prep-pool").scrollTop > 0,
      );
      assert.deepEqual(await cards(), original);
    }
    await search.fill(incoming.name);
    if (mobile) await candidate.tap();
    else {
      await candidate.focus();
      await page.keyboard.press("Enter");
    }
    await page.getByRole("button", { name: "信息", exact: true }).click();
    const dialog = page.getByRole("dialog");
    const bounds = await dialog.boundingBox();
    assert.ok(
      bounds.y >= 0 &&
        bounds.y + bounds.height <= page.viewportSize().height + 1,
    );
    await dialog.getByRole("combobox", { name: "主动技能" }).click();
    await page
      .getByRole("option", { name: incoming.skills[1].name, exact: true })
      .click();
    await dialog.getByRole("button", { name: "返回备战" }).click();
    await drag(candidate, slots.nth(0));
    const expected = [...original];
    expected[0] = incoming.id;
    assert.deepEqual(await cards(), expected);
    await search.fill("");
    assert.equal(
      await pool.locator('[data-card="' + original[0] + '"]').count(),
      1,
    );
    await drag(slots.nth(5), slots.nth(0));
    [expected[0], expected[5]] = [expected[5], expected[0]];
    assert.deepEqual(await cards(), expected);
    await drag(slots.nth(5), pool);
    expected[5] = "";
    assert.deepEqual(await cards(), expected);
    assert.ok(
      await page.getByRole("button", { name: "应用到本局" }).isDisabled(),
    );
    await search.fill(incoming.name);
    await drag(candidate, slots.nth(5), true);
    assert.deepEqual(await cards(), expected);
    await drag(candidate, slots.nth(5));
    expected[5] = incoming.id;
    assert.deepEqual(await cards(), expected);
    await page.getByRole("button", { name: "应用到本局" }).click();
    await page.getByText("已应用到本局", { exact: true }).waitFor();
    const saved = await (
      await page.request.get("/api/rooms/" + room.id)
    ).json();
    assert.deepEqual(saved.deck.cards, expected);
    assert.equal(saved.deck.skills[incoming.id], incoming.skills[1].id);
    assert.deepEqual(errors, []);
    await page.close();
    console.log(
      mobile
        ? "Touch preparation drag and library scroll passed"
        : "Mouse preparation drag and keyboard card menu passed",
    );
  }
} finally {
  await browser.close();
}
