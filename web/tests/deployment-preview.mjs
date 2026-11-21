// Fixed hand and seat snapshots keep the pointer, resource and orientation cases reproducible.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";

const base = process.env.LOBBY_URL ?? "http://127.0.0.1:4317";
const map = JSON.parse(
  readFileSync(new URL("../../content/maps.json", import.meta.url)),
)[0];
const hand = ["olaf", "gold_ward", "solar_flare", "final_spark"];
const deck = {
  cards: [...hand, "mirror", "ashe", "freeze", "jinx"],
  skills: {},
};
const browser = await chromium.launch({ channel: "chrome" });
try {
  for (const me of [0, 1]) {
    const mobile = me === 1;
    const page = await browser.newPage({
      baseURL: base,
      hasTouch: mobile,
      viewport: mobile
        ? { width: 390, height: 844 }
        : { width: 1280, height: 900 },
    });
    const errors = [],
      plays = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() => {
      document.addEventListener(
        "battle-render",
        (e) => {
          window.ghosts = e.detail.previewModels;
        },
        true,
      );
      const original = CanvasRenderingContext2D.prototype.arc;
      window.radii = new Set();
      window.oldSpellMarker = false;
      const strokeRect = CanvasRenderingContext2D.prototype.strokeRect;
      CanvasRenderingContext2D.prototype.strokeRect = function (x, y, w, h) {
        if (
          this.canvas.classList.contains("battle-overlay") &&
          this.strokeStyle === "#f6df99" &&
          w === 16 &&
          h === 16
        )
          window.oldSpellMarker = true;
        return strokeRect.call(this, x, y, w, h);
      };
      window.rectangles = new Set();
      const rect = CanvasRenderingContext2D.prototype.rect;
      CanvasRenderingContext2D.prototype.rect = function (x, y, w, h) {
        if (this.canvas.classList.contains("battle-overlay"))
          window.rectangles.add([x, y, w, h].join(","));
        return rect.call(this, x, y, w, h);
      };
      CanvasRenderingContext2D.prototype.arc = function (x, y, r, ...rest) {
        if (this.canvas.classList.contains("battle-overlay"))
          window.radii.add(r);
        return original.call(this, x, y, r, ...rest);
      };
    });
    await page.route("**/api/matches/preview", (r) =>
      r.fulfill({
        json: {
          id: "preview",
          status: "claimed",
          round: 1,
          opponent: "测试席位",
          map: "rift",
          mode: "classic",
          deck,
          me,
          playable: true,
          result: null,
        },
      }),
    );
    const home = [{ x: 0, y: me ? 0 : 17, width: 18, height: 15 }];
    const frame = {
      type: "frame",
      protocol: 3,
      tick: 1,
      started: true,
      remaining: 2000,
      map,
      hand,
      deployment: [home, home, [{ x: 0, y: 0, width: 18, height: 32 }], home],
      version: 1,
      gold: 4,
      costs: [4, 5, 3, 4],
      next: "freeze",
      nextCost: 4,
      active: [null, null],
      activeWait: [0, 0],
      activeCards: [null, null],
      activeCost: [0, 0],
      pending: [],
      ack: 0,
      units: [],
      shots: [],
      spells: [
        {
          id: 7,
          key: "solar_flare",
          team: me,
          origin: { x: 360, y: 1160 },
          position: { x: 300, y: 820 },
          born: 1,
          impact: 20,
          end: 40,
          radius: 100,
        },
      ],
      areas: [],
      presentation: { after: 0, cursor: 0, events: [] },
      result: null,
    };
    let socket;
    await page.routeWebSocket("**/api/matches/preview/live", (ws) => {
      socket = ws;
      ws.onMessage((msg) => {
        const command = JSON.parse(msg);
        if (command.type === "ready") ws.send(JSON.stringify(frame));
        if (command.action === "play") {
          plays.push(command);
          ws.send(JSON.stringify({ type: "receipt", error: null }));
          frame.tick++;
          frame.version++;
          frame.ack++;
          ws.send(JSON.stringify(frame));
        }
      });
      ws.send(
        JSON.stringify({ type: "connected", protocol: 3, preview: false }),
      );
    });
    await page.goto("/play/matches/preview?battleMetrics&vfx=off");
    const cards = page.locator(".battle-hand button");
    await cards.first().waitFor();
    await page.waitForSelector(".battle-hand button:enabled");
    const box = await page.locator(".battle-input").boundingBox();
    const homePoint = {
      x: box.x + box.width * 0.4,
      y: box.y + box.height * 0.7,
    };
    const enemy = { x: homePoint.x, y: box.y + box.height * 0.22 };
    const state = (value) =>
      page.locator('.placement-state[data-state="' + value + '"]').waitFor();
    const cdp = await page.context().newCDPSession(page);
    const touch = (type, p) =>
      cdp.send("Input.dispatchTouchEvent", { type, touchPoints: p ? [p] : [] });
    if (!mobile) {
      const atRest = await cards.first().boundingBox();
      await page.mouse.move(homePoint.x, homePoint.y);
      await page.keyboard.press("q");
      await state("legal");
      await page.waitForFunction(() => window.ghosts === 2);
      await page.waitForFunction(
        (y) =>
          document.querySelector(".battle-hand button").getBoundingClientRect()
            .y <
          y - 4,
        atRest.y,
      );
      await page.mouse.move(enemy.x, enemy.y);
      await state("invalid");
      await page.mouse.click(enemy.x, enemy.y);
      assert.equal(plays.length, 0);
      await page.keyboard.press("w");
      await page.mouse.move(homePoint.x, homePoint.y);
      await state("poor");
      await page.waitForFunction(
        () => window.ghosts === 1 && window.rectangles.has("-40,-40,80,80"),
      );
      await page.mouse.click(homePoint.x, homePoint.y);
      assert.equal(plays.length, 0);
      frame.gold = 6;
      frame.tick++;
      socket.send(JSON.stringify(frame));
      await state("legal");
      await page.mouse.click(homePoint.x, homePoint.y);
      await page.waitForFunction(() => window.ghosts === 0);
      assert.equal(plays.length, 1);
      await cards.nth(2).click();
      await page.mouse.move(enemy.x, enemy.y);
      await state("legal");
      await page.waitForFunction(
        () => window.radii.has(100) && window.radii.has(40),
      );
      await page.keyboard.press("Escape");
      assert.equal(await cards.nth(2).getAttribute("aria-pressed"), "false");
      await page.keyboard.press("r");
      await page.locator(".battle-input").focus();
      await page.mouse.move(homePoint.x, homePoint.y);
      await state("legal");
      await page.keyboard.press("ArrowDown");
      await state("legal");
      await page.waitForFunction(() =>
        window.rectangles.has("-20,-800,40,800"),
      );
      await page.keyboard.press("Enter");
      await page.waitForFunction(
        () => !document.querySelector(".battle-hand [aria-pressed=true]"),
      );
      assert.equal(plays.length, 2);
      assert.ok(Math.abs(plays[1].y - (map.height * 0.7 + map.tile)) < 3);
    } else {
      await cards.first().tap();
      await page.getByRole("button", { name: "游戏设置" }).tap();
      const dialog = page.getByRole("dialog");
      const bounds = await dialog.boundingBox();
      assert.ok(
        bounds.x >= 0 &&
          bounds.y >= 0 &&
          bounds.x + bounds.width <= 391 &&
          bounds.y + bounds.height <= 845,
      );
      await dialog.getByRole("button", { name: "关闭", exact: true }).tap();
      assert.equal(await cards.first().getAttribute("aria-pressed"), "true");
      await touch("touchStart", enemy);
      await state("invalid");
      await touch("touchMove", homePoint);
      await state("legal");
      await page.waitForFunction(() => window.ghosts === 2);
      await touch("touchCancel");
      await page.waitForFunction(() => window.ghosts === 0);
      assert.equal(plays.length, 0);
      await touch("touchStart", homePoint);
      await state("legal");
      await touch("touchEnd");
      await page.waitForFunction(
        () => !document.querySelector(".battle-hand [aria-pressed=true]"),
      );
      assert.equal(plays.length, 1);
      assert.ok(
        Math.abs(plays[0].x - map.width * 0.6) < 2 &&
          Math.abs(plays[0].y - map.height * 0.3) < 2,
      );
    }
    const moveTo = (point) =>
      mobile ? touch("touchMove", point) : page.mouse.move(point.x, point.y);
    const letGo = () => (mobile ? touch("touchEnd") : page.mouse.up());
    async function cardCenter(slot) {
      const card = await cards.nth(slot).boundingBox();
      return { x: card.x + card.width / 2, y: card.y + card.height / 2 };
    }
    async function grab(slot) {
      const start = await cardCenter(slot);
      if (mobile) await touch("touchStart", start);
      else {
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
      }
    }
    const cleared = () =>
      page.waitForFunction(
        () =>
          !document.querySelector(
            ".battle-hand [aria-pressed=true], .placement-state",
          ) && window.ghosts === 0,
      );
    const beforeDrag = plays.length;
    await grab(0);
    await moveTo(enemy);
    await state("invalid");
    await letGo();
    assert.equal(await cards.first().getAttribute("aria-pressed"), "true");
    assert.equal(plays.length, beforeDrag);

    // Return to another slot and release: no deployment and no trailing click on either card.
    await grab(0);
    await moveTo(enemy);
    await state("invalid");
    await moveTo(homePoint);
    await state("legal");
    await page.waitForFunction(() => window.ghosts === 2);
    assert.deepEqual(
      await page.evaluate(() => [...window.rectangles].filter(r => r.endsWith(",40,40"))),
      ["-20,-20,40,40"],
    );
    await moveTo(await cardCenter(1));
    await page.waitForFunction(
      () => !document.querySelector(".placement-state"),
    );
    await letGo();
    await cleared();
    assert.equal(plays.length, beforeDrag);

    frame.gold = 3;
    frame.tick++;
    socket.send(JSON.stringify(frame));
    await grab(1);
    await moveTo(homePoint);
    await state("poor");
    await page.waitForFunction(() => window.ghosts === 1);
    assert.equal(await page.locator(".placement-state").innerText(), "金币不足");
    await letGo();
    assert.equal(plays.length, beforeDrag);
    // Dragging the selected card again must still deploy. A change of funds applies mid-gesture.
    await grab(1);
    await moveTo(homePoint);
    await state("poor");
    frame.gold = 6;
    frame.tick++;
    socket.send(JSON.stringify(frame));
    await state("legal");
    await letGo();
    await cleared();
    assert.equal(plays.length, beforeDrag + 1);
    assert.equal(plays.at(-1).slot, 1);
    assert.ok(Math.abs(plays.at(-1).y - map.height * (me ? 0.3 : 0.7)) < 3);

    await grab(2);
    await moveTo(enemy);
    await state("legal");
    await page.waitForFunction(
      () => window.radii.has(100) && window.radii.has(40),
    );
    await letGo();
    await cleared();
    assert.equal(plays.length, beforeDrag + 2);
    assert.equal(plays.at(-1).slot, 2);

    await grab(0);
    await moveTo(homePoint);
    await state("legal");
    if (mobile) await touch("touchCancel");
    else {
      await page.keyboard.press("Escape");
      await letGo();
    }
    await cleared();
    assert.equal(plays.length, beforeDrag + 2);
    // A hand version change while the card is held cannot deploy its replacement.
    await grab(0);
    await moveTo(homePoint);
    await state("legal");
    frame.version++;
    frame.tick++;
    socket.send(JSON.stringify(frame));
    await cleared();
    await letGo();
    assert.equal(plays.length, beforeDrag + 2);
    assert.equal(await page.evaluate(() => window.oldSpellMarker), false);
    assert.deepEqual(errors, []);
    await page.close();
    console.log(
      mobile
        ? "Red touch aim, hand drag, tray cancellation and release passed"
        : "Desktop placement, hand drag, tray cancellation, spells and keyboard passed",
    );
  }
} finally {
  await browser.close();
}
