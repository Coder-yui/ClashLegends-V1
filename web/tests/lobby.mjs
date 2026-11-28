// Run against an isolated development lobby with Chrome installed.
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
const base = process.env.LOBBY_URL ?? "http://127.0.0.1:4317";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const errors = [];
const contexts = [];
const lastPlay = new WeakMap();
const liveSockets = new WeakMap();
const mapFor = new WeakMap();
async function visitor(mobile = false) {
  const ctx = await browser.newContext({
    baseURL: base,
    viewport: mobile
      ? { width: 390, height: 844 }
      : { width: 1280, height: 900 },
  });
  ctx.on("dialog", async (d) => {
    errors.push("Unexpected system dialog: " + d.type());
    await d.dismiss();
  });
  contexts.push(ctx);
  const p = await ctx.newPage();
  p.on("websocket", (ws) => {
    if (!/^\/api\/matches\/[^/]+\/live$/.test(new URL(ws.url()).pathname))
      return;
    liveSockets.set(p, ws);
    ws.on("framereceived", ({ payload }) => {
      const frame = JSON.parse(payload);
      if (frame.type === "frame") mapFor.set(p, frame.map);
    });
    ws.on("framesent", ({ payload }) => {
      const command = JSON.parse(payload);
      if (command.action === "play") lastPlay.set(p, command);
    });
  });
  p.setDefaultTimeout(9000);
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto("/play/");
  await p.getByRole("heading", { name: "对战大厅" }).waitFor();
  return p;
}
async function json(p, path) {
  const res = await p.request.get("/api/" + path);
  assert.equal(res.status(), 200);
  return res.json();
}
async function open(p, ai) {
  await p.getByRole("button", { name: ai ? "对战电脑玩家" : "创建房间" }).click();
  const modal = p.getByRole("dialog");
  await modal.getByRole("combobox", { name: "对战模式" }).click();
  await modal.getByRole("option", { name: "经典模式" }).click();
  await modal.getByRole("combobox", { name: "对战地图" }).click();
  await modal
    .getByRole("option", {
      name:
        !ai && process.env.TEST_CROSSING === "1" ? "交错桥测试场" : "晴昼峡谷",
    })
    .click();
  await modal
    .getByRole("button", { name: ai ? "进入备战" : "创建房间" })
    .click();
  await p.waitForURL("**/rooms/*");
}
async function exercise(page, requireBothSkills) {
  const field = page.locator(".battle-stage .battle-input");
  const hand = page.locator(".battle-hand button");
  await page.waitForSelector(".battle-hand button:enabled");
  assert.equal(await page.locator(".battle-skills kbd").count(), 0);
  const { width, height } = page.viewportSize();
  const u = Math.min(width / 720, height / 1280);
  const leftEdge = (width - 720 * u) / 2,
    topEdge = height - 160 * u;
  // Godot CardHand and ActiveSkillBar rectangles in the 720 × 1280 design.
  for (const [selector, x, y, w, h] of [
    [".battle-controls", 0, 0, 720, 160],
    [".battle-next", 51, 11, 74, 108],
    [".battle-next .battle-card", 55, 35, 66, 72],
    ...Array.from({ length: 4 }, (_, i) => [
      `.battle-hand button:nth-child(${i + 1})`,
      143 + 134 * i,
      11,
      124,
      108,
    ]),
    [".gold-track", 154, 125, 510, 18],
    [".battle-skills button:first-child", 23, -69, 58, 58],
    [".battle-skills button:last-child", 639, -69, 58, 58],
  ]) {
    const box = await page
      .locator(selector)
      .evaluate((el) => el.getBoundingClientRect().toJSON());
    for (const [actual, expected] of [
      [box.x, leftEdge + x * u],
      [box.y, topEdge + y * u],
      [box.width, w * u],
      [box.height, h * u],
    ]) {
      assert.ok(
        Math.abs(actual - expected) < 1,
        selector + " " + actual + " vs " + expected,
      );
    }
  }
  const board = await field.boundingBox();
  const map = mapFor.get(page);
  assert.ok(map && map.tile > 0);
  const groundY = (1120 / (map.height + map.backMargin * 2)) * u,
    groundX = groundY / map.projection;
  assert.ok(Math.abs(board.x + board.width / 2 - width / 2) < 1);
  assert.ok(Math.abs(board.y + board.height / 2 - topEdge / 2) < 1);
  assert.ok(
    Math.abs(board.width - map.width * groundX) < 1 &&
      Math.abs(board.height - map.height * groundY) < 1,
  );
  await page.locator(".battle-next .coin-cost").waitFor();
  const viewer = (await json(page, "matches/" + page.url().split("/").pop()))
    .me;
  const capture = requireBothSkills
    ? process.env.BATTLE_MOBILE_SCREENSHOT
    : viewer === 1
      ? process.env.BATTLE_DESKTOP_SCREENSHOT
      : null;
  if (capture) await page.screenshot({ path: capture });
  const keys = ["q", "w", "e", "r"];
  for (const [i, key] of keys.entries()) {
    await page.keyboard.press(key);
    assert.equal(await hand.nth(i).getAttribute("aria-pressed"), "true");
  }
  await page.keyboard.press("r");
  assert.equal(await hand.nth(3).getAttribute("aria-pressed"), "false");
  const casts = new Set();
  const requiredCasts = requireBothSkills ? 2 : viewer === 1 ? 1 : 0;
  let deployed = 0,
    tries = 0;
  const until = Date.now() + 90000;
  while (Date.now() < until && (deployed < 2 || casts.size < requiredCasts)) {
    for (const [i, key] of ["d", "f"].entries()) {
      const skill = page.locator(".battle-skills button").nth(i);
      if (!casts.has(key) && (await skill.isEnabled())) {
        if (capture) await page.screenshot({ path: capture });
        const receipt = liveSockets.get(page).waitForEvent("framereceived", {
          predicate: ({ payload }) => JSON.parse(payload).type === "receipt",
        });
        if (!requireBothSkills && viewer === 1) await skill.click();
        else await page.keyboard.press(key);
        assert.equal(JSON.parse((await receipt).payload).error, null);
        casts.add(key);
      }
    }
    const choices = await hand.evaluateAll((nodes) =>
      nodes.map((n, i) => ({
        i,
        name: n.querySelector("span").textContent,
        affordable: !n.classList.contains("unaffordable"),
      })),
    );
    const options = choices.filter((c) => c.affordable);
    const needed = await page.locator(".battle-skills button").evaluateAll(
      (nodes, used) =>
        nodes
          .filter((_, i) => !used.includes(["d", "f"][i]))
          .map((n) => ({
            name: n.dataset.caster,
            deployed: n.dataset.awaiting === "false",
          })),
      [...casts],
    );
    // Reserve gold for the chosen caster and its activation instead of cycling
    // cheap cards every time the next coin arrives.
    if (casts.size < requiredCasts && needed.some((c) => c.deployed)) {
      await page.waitForTimeout(250);
      continue;
    }
    const pick =
      choices.find((c) => needed.some((s) => s.name === c.name)) ?? options[0];
    if (!pick?.affordable) {
      await page.waitForTimeout(300);
      continue;
    }
    const before = pick.name;
    await page.keyboard.press(keys[pick.i]);
    const box = await field.boundingBox();
    const left = [0.25, 0.72, 0.5, 0.37][tries++ % 4];
    const depth = deployed % 2 ? 0.72 : 0.65;
    await field.click({
      position: {
        x: box.width * left,
        y: box.height * depth,
      },
    });
    try {
      await page.waitForFunction(
        ({ i, before }) =>
          document.querySelectorAll(".battle-hand button span")[i]
            ?.textContent !== before,
        { i: pick.i, before },
        { timeout: 1000 },
      );
    } catch {
      if ((await hand.nth(pick.i).getAttribute("aria-pressed")) === "true")
        await page.keyboard.press(keys[pick.i]);
      // Occupied building footprints can reject a legal half of the field.
      await page.waitForTimeout(400);
      continue;
    }
    const command = lastPlay.get(page);
    assert.ok(
      command &&
        Math.abs(command.x - map.width * (viewer ? 1 - left : left)) < 4,
    );
    assert.ok(
      Math.abs(command.y - map.height * (viewer ? 1 - depth : depth)) < 4,
    );
    deployed++;
  }
  assert.ok(deployed >= 2);
  assert.ok(casts.size >= requiredCasts);
  console.log("Seat controls verified", { deployed, casts: [...casts] });
}
try {
  const a = await visitor(true);
  if (process.env.LOBBY_SCREENSHOT)
    await a.screenshot({ path: process.env.LOBBY_SCREENSHOT });
  await open(a, true);
  await a.getByRole("heading", { name: "备战", exact: true }).waitFor();
  const c = await json(a, "battle/catalog");
  assert.ok(c.cards.length >= 100);
  assert.ok(c.cards.reduce((n, card) => n + card.skills.length, 0) >= 106);
  const slots = a.locator(".prep-slots button"),
    pool = a.locator(".prep-collection button");
  assert.equal(await slots.count(), 8);
  assert.equal(await pool.count(), c.cards.length - 8);
  const boxes = await Promise.all(
    [
      slots.nth(0),
      slots.nth(3),
      slots.nth(4),
      a.locator(".prep-pool"),
      a.locator(".prep-start"),
    ].map((l) => l.boundingBox()),
  );
  assert.equal(boxes[0].y, boxes[1].y);
  assert.ok(
    boxes[2].y > boxes[0].y &&
      boxes[3].height > 130 &&
      boxes[3].y + boxes[3].height <= boxes[4].y &&
      boxes[4].y + boxes[4].height <= 844,
  );
  if (process.env.PREP_SCREENSHOT)
    await a.screenshot({ path: process.env.PREP_SCREENSHOT });
  await a.getByRole("button", { name: "切换排序方式" }).click();
  const poolNames = () => pool.locator(".prep-card-name").allTextContents();
  const ascending = await poolNames();
  assert.deepEqual(ascending, [...ascending].sort());
  await a.getByRole("button", { name: "升序，切换为降序" }).click();
  assert.deepEqual(await poolNames(), ascending.reverse());
  await a.getByRole("button", { name: "降序，切换为升序" }).click();
  await a.getByRole("button", { name: "切换排序方式" }).click();
  await a.getByRole("button", { name: "空军", exact: true }).click();
  const air = await pool.evaluateAll((nodes) =>
    nodes.map((n) => n.dataset.card),
  );
  assert.ok(air.includes("anivia") && !air.includes("garen"));
  await a.getByRole("button", { name: "全部", exact: true }).click();
  await slots.first().click();
  await a.getByRole("button", { name: "移除", exact: true }).click();
  assert.equal(await a.locator(".prep-start").isDisabled(), true);
  await slots.first().click();
  const first = c.cards.find((x) => x.id === "xin");
  await a.getByRole("searchbox", { name: "搜索卡牌" }).fill(first.name);
  await pool.filter({ hasText: first.name }).click();
  await slots.first().click();
  await a.getByRole("button", { name: "信息", exact: true }).click();
  await a.getByRole("combobox", { name: "主动技能" }).click();
  await a
    .getByRole("option", { name: first.skills[1].name, exact: true })
    .click();
  await a.getByText(/金币消耗.*冷却/).waitFor();
  await a.getByRole("button", { name: "返回备战" }).click();
  await a.getByLabel("卡组名称").fill("测试预设");
  await a.getByRole("button", { name: "保存预设" }).click();
  await a.getByText("个人预设已保存").waitFor();
  await a.getByRole("button", { name: "开始游戏" }).click();
  await a.waitForURL("**/matches/*");
  await a.getByRole("heading", { name: "晴昼峡谷", exact: true }).waitFor();
  const aiMatch = a.url().split("/").pop();
  const ai = await json(a, "matches/" + aiMatch);
  assert.equal(ai.deck.cards[0], first.id);
  assert.equal(ai.deck.skills[first.id], first.skills[1].id);
  await a.reload();
  await a.getByRole("heading", { name: "晴昼峡谷", exact: true }).waitFor();
  assert.ok(
    await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  );
  console.log(
    "AI mobile flow, real skill selection, preset, frozen config and refresh passed",
  );
  const h = await visitor(),
    g = await visitor(),
    third = await visitor();
  await open(h, false);
  const rid = h.url().split("/").pop();
  const invite = await h.locator(".prep-room-line b").innerText();
  await g.goto("/play/?invite=" + invite);
  await g.getByRole("button", { name: "加入房间" }).click();
  await g.waitForURL("**/rooms/" + rid);
  await third.getByRole("button", { name: "输入邀请码" }).click();
  await third.getByPlaceholder("输入 8 位邀请码").fill(invite);
  await third.getByRole("button", { name: "加入房间" }).click();
  await third.getByRole("alert").filter({ hasText: "房间已满" }).waitFor();
  const visible = await json(g, "rooms/" + rid);
  assert.equal(visible.me, 1);
  assert.equal(visible.seats.length, 2);
  assert.ok(
    visible.seats.every(
      (x) => Object.keys(x).sort().join(",") === "ai,name,online,ready",
    ),
  );
  // Edit the guest seat independently. A previous tab must not be able to
  // confirm an older loadout after another tab changes its card order.
  if (process.env.PREP_DESKTOP_SCREENSHOT)
    await g.screenshot({ path: process.env.PREP_DESKTOP_SCREENSHOT });
  await g
    .locator(".prep-slots button")
    .nth(0)
    .dragTo(g.locator(".prep-slots button").nth(1));
  await g.getByRole("button", { name: "应用到本局" }).click();
  await g.getByText("已应用到本局").waitFor();
  await g.waitForURL("**/rooms/" + rid);
  const guestRoom = await json(g, "rooms/" + rid);
  assert.equal(guestRoom.deck.cards[0], visible.deck.cards[1]);
  assert.deepEqual(
    (await json(h, "rooms/" + rid)).deck.cards,
    visible.deck.cards,
  );
  const stale = await g.request.post("/api/rooms/" + rid, {
    data: {
      action: "ready",
      ready: true,
      round: visible.round,
      deckVersion: visible.deckVersion,
      settingsVersion: visible.settingsVersion,
    },
  });
  assert.equal(stale.status(), 409);
  await Promise.all(
    [h, g].map((p) =>
      p.getByRole("button", { name: "准备", exact: true }).click(),
    ),
  );
  await Promise.all([h, g].map((p) => p.waitForURL("**/matches/*")));
  assert.equal(h.url(), g.url());
  const friendMatch = h.url().split("/").pop();
  const locked = await json(g, "rooms/" + rid);
  const replay = await g.request.post("/api/rooms/" + rid, {
    data: {
      action: "ready",
      ready: true,
      round: locked.round,
      deckVersion: locked.deckVersion,
      settingsVersion: locked.settingsVersion,
    },
  });
  assert.equal((await replay.json()).matchId, friendMatch);
  await g.reload();
  await g
    .getByRole("heading", {
      name: process.env.TEST_CROSSING === "1" ? "交错桥测试场" : "晴昼峡谷",
      exact: true,
    })
    .waitFor();
  assert.equal(
    (await third.request.get("/api/matches/" + friendMatch)).status(),
    409,
  );
  await Promise.all([
    exercise(a, true),
    exercise(h, false),
    exercise(g, false),
  ]);
  // Keep one player pushing the lane. This exercises an asymmetric friend
  // result with ordinary keyboard and pointer inputs all the way to settlement.
  let push = 0;
  const finish = Date.now() + 315000;
  while (
    !(await h.locator(".battle-result h1").count()) &&
    Date.now() < finish
  ) {
    const option = h
      .locator(".battle-hand button:enabled:not(.unaffordable)")
      .first();
    if (await option.count()) {
      const slot = await option.evaluate((b) =>
        [...b.parentElement.children].indexOf(b),
      );
      const key = ["q", "w", "e", "r"][slot];
      if (key) {
        await h.keyboard.press(key);
        const field = await h
          .locator(".battle-stage .battle-input")
          .boundingBox();
        if (field) {
          const x = [0.23, 0.31, 0.17, 0.39][push++ % 4];
          await h.mouse.click(
            field.x + x * field.width,
            field.y + 0.62 * field.height,
          );
        }
      }
    }
    await h.waitForTimeout(450);
  }
  await Promise.all(
    [a, h, g].map((p) =>
      p.locator(".battle-result h1").waitFor({ timeout: 320000 }),
    ),
  );
  const final = await json(h, "matches/" + friendMatch);
  assert.equal(final.status, "finished");
  assert.deepEqual(
    final.result,
    (await json(g, "matches/" + friendMatch)).result,
  );
  assert.equal((await json(a, "matches/" + aiMatch)).status, "finished");
  await a.reload();
  await a.locator(".battle-result h1").waitFor();
  console.log("AI and both friend seats reached persisted results", {
    ai: (await json(a, "matches/" + aiMatch)).result,
    friend: final.result,
  });
  await Promise.all(
    [h, g].map((p) => p.getByRole("link", { name: "返回房间" }).click()),
  );
  assert.equal((await json(g, "rooms/" + rid)).round, locked.round + 1);
  await h.getByRole("button", { name: "准备", exact: true }).click();
  await h.getByRole("button", { name: "取消准备" }).waitFor();
  await h.getByRole("button", { name: "取消准备" }).click();
  await h.getByRole("button", { name: "准备", exact: true }).waitFor();
  // Leave the guest on the loading screen in round two. The host can
  // withdraw until both seats have attached their battle connection.
  await g.routeWebSocket(/\/api\/matches\/.+\/live$/, () => {});
  await Promise.all(
    [h, g].map((p) =>
      p.getByRole("button", { name: "准备", exact: true }).click(),
    ),
  );
  await h.getByText("等待其他玩家进入战场").waitFor();
  assert.notEqual(h.url().split("/").pop(), friendMatch);
  await h.getByRole("link", { name: "返回房间" }).click();
  await h.getByRole("button", { name: "结束本次备战，重新组局" }).click();
  await g.waitForURL("**/rooms/" + rid);
  await g.getByRole("button", { name: "准备", exact: true }).click();
  await g.getByRole("button", { name: "取消准备" }).waitFor();
  await g.close();
  await h.getByText("重连中", { exact: true }).waitFor({ timeout: 32000 });
  assert.equal((await json(h, "rooms/" + rid)).seats[1].ready, false);
  const back = await g.context().newPage();
  await back.goto("/play/rooms/" + rid);
  await back.getByRole("button", { name: "准备", exact: true }).waitFor();
  await h.waitForFunction(() => !document.body.innerText.includes("重连中"));
  await back.getByRole("button", { name: "房间", exact: true }).click();
  await back.getByRole("button", { name: "离开房间" }).click();
  await back
    .getByRole("dialog")
    .getByRole("button", { name: "确认离开" })
    .click();
  await h.getByText(/等待好友加入/).waitFor();
  await h.getByRole("button", { name: "房间", exact: true }).click();
  await h.getByRole("button", { name: "离开房间" }).click();
  await h.getByRole("dialog").getByRole("button", { name: "确认离开" }).click();
  await h.getByRole("heading", { name: "对战大厅" }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "Friend invite, capacity, private seats, simultaneous ready, duplicate ready, reconnect, cancel and rematch passed",
  );
} finally {
  await browser.close();
}
