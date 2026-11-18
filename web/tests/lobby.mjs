// Run against an isolated development lobby with Chrome installed.
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
const base = process.env.LOBBY_URL ?? "http://127.0.0.1:4317";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const errors = [];
const contexts = [];
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
  await p.getByRole("button", { name: ai ? "对战 AI" : "创建房间" }).click();
  const modal = p.getByRole("dialog");
  await modal.getByRole("combobox", { name: "对战模式" }).click();
  await modal.getByRole("option", { name: "经典模式" }).click();
  await modal.getByRole("combobox", { name: "对战地图" }).click();
  await modal.getByRole("option", { name: "晴昼峡谷" }).click();
  await modal
    .getByRole("button", { name: ai ? "进入备战" : "创建房间" })
    .click();
  await p.waitForURL("**/rooms/*");
}
try {
  const a = await visitor(true);
  if (process.env.LOBBY_SCREENSHOT)
    await a.screenshot({ path: process.env.LOBBY_SCREENSHOT });
  await open(a, true);
  await a.getByRole("link", { name: "编辑卡组与技能" }).click();
  await a.getByRole("heading", { name: "本局备战" }).waitFor();
  const c = await json(a, "catalog");
  const multi = c.cards.find(
    (x) => x.skills.length > 1 && !c.defaultDeck.includes(x.id),
  );
  assert.ok(multi);
  await a.getByRole("textbox", { name: "搜索卡牌" }).fill(multi.name);
  await a
    .locator(".collection button")
    .filter({ hasText: multi.name })
    .first()
    .click();
  await a.getByRole("button", { name: "放入第 1 位" }).click();
  await a.getByRole("radio").nth(1).check();
  await a.getByLabel("预设名称").fill("测试预设");
  await a.getByRole("button", { name: "保存预设" }).click();
  await a.getByText("个人预设已保存").waitFor();
  await a.getByRole("button", { name: "应用到本局" }).click();
  await a.getByRole("button", { name: "开始对战" }).click();
  await a.getByRole("heading", { name: "配置已锁定" }).waitFor();
  const aiMatch = a.url().split("/").pop();
  const ai = await json(a, "matches/" + aiMatch);
  assert.equal(ai.deck.cards[0], multi.id);
  assert.equal(ai.deck.skills[multi.id], multi.skills[1].id);
  await a.reload();
  await a.getByRole("heading", { name: "配置已锁定" }).waitFor();
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
  const invite = await h.getByTestId("invite").innerText();
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
  await g.getByRole("link", { name: "编辑卡组与技能" }).click();
  await g
    .locator(".slots button")
    .nth(0)
    .dragTo(g.locator(".slots button").nth(1));
  await g.getByRole("button", { name: "应用到本局" }).click();
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
  await Promise.all(
    [h, g].map((p) => p.getByRole("heading", { name: "配置已锁定" }).waitFor()),
  );
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
  await g.getByRole("heading", { name: "配置已锁定" }).waitFor();
  await h.getByRole("link", { name: "返回房间" }).click();
  await h.getByRole("button", { name: "结束本次备战，重新组局" }).click();
  await g.waitForURL("**/rooms/" + rid);
  assert.equal((await json(g, "matches/" + friendMatch)).status, "withdrawn");
  await h.getByRole("button", { name: "准备", exact: true }).click();
  await h.getByRole("button", { name: "取消准备" }).waitFor();
  await h.getByRole("button", { name: "取消准备" }).click();
  await h.getByRole("button", { name: "准备", exact: true }).waitFor();
  // WebSocket can announce the lock before the host's HTTP reply arrives.
  // Returning to the same room must not let the old page redirect again.
  let releaseReady;
  const delayReady = new Promise((resolve) => {
    releaseReady = resolve;
  });
  await h.route("**/api/rooms/" + rid, async (route) => {
    const req = route.request();
    if (req.method() !== "POST" || req.postDataJSON()?.action !== "ready")
      return route.continue();
    const reply = await route.fetch();
    await delayReady;
    await route.fulfill({ response: reply });
  });
  await g.getByRole("button", { name: "准备", exact: true }).click();
  await g.getByRole("button", { name: "取消准备" }).waitFor();
  await h.getByRole("button", { name: "准备", exact: true }).click();
  await Promise.all(
    [h, g].map((p) => p.getByRole("heading", { name: "配置已锁定" }).waitFor()),
  );
  assert.equal(h.url(), g.url());
  assert.notEqual(h.url().split("/").pop(), friendMatch);
  // Final round can be cancelled only by the host. When a prepared guest
  // loses connectivity, the host must see readiness clear before proceeding.
  await h.getByRole("link", { name: "返回房间" }).click();
  await h.getByRole("heading", { name: "好友房间" }).waitFor();
  releaseReady();

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
  await back.getByRole("button", { name: "离开房间" }).click();
  await back
    .getByRole("dialog")
    .getByRole("button", { name: "确认离开" })
    .click();
  await h.getByText("等待好友加入").waitFor();
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
