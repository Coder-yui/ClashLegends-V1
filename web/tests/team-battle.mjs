// Run against an isolated lobby. Two independent browsers play alongside two computers.
import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const baseURL = process.env.LOBBY_URL ?? "http://127.0.0.1:4317";
const browser = await chromium.launch({ channel: "chrome" });
try {
  const createPage = async (options) => {
    const page = await browser.newPage({ baseURL, ...options });
    await page.addInitScript(() => {
      const Native = WebSocket;
      window.WebSocket = class extends Native {
        constructor(...args) {
          super(...args);
          if (!String(args[0]).includes("/api/matches/")) return;
          this.addEventListener("message", ({ data }) => {
            const packet = JSON.parse(data);
            if (packet.type === "frame") window.liveFrame = packet;
          });
        }
      };
    });
    assert.ok((await page.request.get("/api/session")).ok());
    await page.goto("/play/");
    return page;
  };
  const host = await createPage({ viewport: { width: 1280, height: 900 } });
  const friend = await createPage({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const button = (p, name) => p.getByRole("button", { name, exact: true });
  await host.getByRole("button", { name: /创建组队房/ }).click();
  const mode = host.getByRole("combobox", { name: "对战模式" });
  await mode.focus();
  await mode.press("Enter");
  await host.getByRole("option", { name: "经典 2v2" }).waitFor();
  await mode.press("Escape");
  assert.ok(await mode.evaluate((el) => el === document.activeElement));
  await host
    .getByRole("dialog")
    .getByRole("button", { name: /创建房间/ })
    .click();
  await host.waitForURL("**/rooms/*");
  await button(host, "房间").click();
  const code = await host.getByTestId("invite").textContent();
  const add = button(host, "蓝方二号位 · 添加电脑玩家");
  await add.focus();
  await add.press("Enter");
  const remove = button(host, "蓝方二号位 · 移除电脑玩家");
  await remove.waitFor();
  assert.equal(
    await host.evaluate(() =>
      document.activeElement?.getAttribute("aria-label"),
    ),
    "蓝方二号位",
  );
  await remove.click();
  await add.click();
  await button(host, "红方一号位 · 添加电脑玩家").click();
  await button(host, "红方二号位 · 添加电脑玩家").click();
  await button(host, "红方二号位 · 移除电脑玩家").click();

  await friend.goto("/play/?invite=" + code);
  await friend
    .getByRole("dialog")
    .getByRole("button", { name: /加入房间/ })
    .tap();
  await friend.waitForURL("**/rooms/*");
  await button(friend, "房间").tap();
  const mobileDialog = friend.getByRole("dialog");
  assert.ok(
    await mobileDialog
      .getByRole("group", { name: "红方二号位" })
      .getByText(/· 你/)
      .isVisible(),
  );
  assert.ok(
    await mobileDialog.evaluate(
      (el) =>
        el.scrollWidth <= el.clientWidth &&
        el.getBoundingClientRect().right <= innerWidth,
    ),
  );
  assert.equal(
    await mobileDialog.getByRole("button", { name: /移除电脑玩家/ }).count(),
    0,
  );
  await button(host, "蓝方二号位 · 与我换位").click();
  await host
    .getByRole("group", { name: "蓝方二号位" })
    .getByText(/· 房主 · 你/)
    .waitFor();
  await button(host, "关闭").click();
  await button(friend, "关闭").tap();
  await button(host, "准备").click();
  await button(friend, "准备").tap();
  for (const p of [host, friend]) {
    await p.waitForURL("**/matches/*");
    await p.waitForFunction(() => window.liveFrame?.started);
    await p.waitForSelector(".battle-hand button:enabled");
  }
  const id = host.url().split("/").pop();
  const read = async (p) => (await p.request.get("/api/matches/" + id)).json();
  const [blue, red] = await Promise.all([read(host), read(friend)]);
  assert.deepEqual([blue.seat, red.seat], [2, 3]);
  assert.deepEqual([blue.me, red.me], [0, 1]);
  assert.equal(blue.teammate, "电脑玩家");
  await friend.reload();
  await friend.waitForFunction(
    () => window.liveFrame?.started && window.liveFrame.tick > 20,
  );
  const lookup = await friend.request.post("/api/recordings/lookup", {
    data: [id],
  });
  assert.equal((await lookup.json())[0].id, id);
  const replay = await friend.evaluate(
    (id) =>
      new Promise((resolve, reject) => {
        const socket = new WebSocket(
          "ws://" + location.host + "/api/recordings/" + id + "/play",
        );
        socket.onerror = () => reject(Error("replay socket"));
        socket.onmessage = ({ data }) => {
          const frame = JSON.parse(data);
          if (frame.type === "frame") {
            socket.close();
            resolve(frame);
          }
        };
      }),
    id,
  );
  assert.equal(replay.tick, 0);
  assert.equal(replay.hand.length, 4);
  // Exercise live readiness and authenticated inputs without requiring four simultaneous GPU renderers.
  const api = async (page, path, body) => {
    const response =
      body === undefined
        ? await page.request.get("/api/" + path)
        : await page.request.post("/api/" + path, { data: body });
    assert.ok(response.ok(), await response.text());
    return response.json();
  };
  for (const humans of [4, 1]) {
    const peers = [];
    for (let i = 0; i < humans; i++) peers.push(await createPage({}));
    let room = await api(peers[0], "rooms", {
      kind: humans === 1 ? "ai" : "friend",
      mode: "2v2",
      map: "rift",
    });
    for (const peer of peers.slice(1))
      await api(peer, "join", { code: room.code });
    for (const peer of peers) {
      room = await api(peer, "rooms/" + room.id);
      assert.equal(room.seats.filter((s) => s.ai).length, 4 - humans);
      room = await api(peer, "rooms/" + room.id, {
        action: "ready",
        ready: true,
        round: room.round,
        settingsVersion: room.settingsVersion,
        deckVersion: room.deckVersion,
      });
    }
    const matchId = room.matchId;
    for (const [i, peer] of peers.entries()) {
      await peer.evaluate(async (id) => {
        const socket = (window.testConnection = new WebSocket(
          "ws://" + location.host + "/api/matches/" + id + "/live",
        ));
        await new Promise((resolve, reject) => {
          socket.onerror = reject;
          socket.onmessage = ({ data }) => {
            const packet = JSON.parse(data);
            if (packet.type === "frame") {
              window.testFrame = packet;
              resolve();
            } else if (packet.type === "receipt") window.testReceipt = packet;
          };
        });
        socket.send(
          JSON.stringify({
            type: "ready",
            protocol: window.testFrame.protocol,
          }),
        );
      }, matchId);
      if (i + 1 < humans)
        assert.equal((await api(peer, "matches/" + matchId)).status, "pending");
    }
    for (const [seat, peer] of peers.entries()) {
      await peer.waitForFunction(() => window.testFrame?.started);
      await peer.evaluate((seat) => {
        const f = window.testFrame;
        window.testConnection.send(
          JSON.stringify({
            action: "play",
            inputTick: f.tick,
            sequence: 1,
            slot: f.costs.findIndex((n) => n <= f.gold),
            version: 0,
            x: seat < 2 ? 220 : 460,
            y: seat % 2 === 0 ? 860 : 420,
          }),
        );
      }, seat);
      await peer.waitForFunction(() => window.testReceipt);
      assert.equal(await peer.evaluate(() => window.testReceipt.error), null);
      await peer.waitForFunction(
        () => window.testFrame.ack === 1 && window.testFrame.version === 1,
      );
    }
    for (const peer of peers) await peer.context().close();
  }
  console.log(
    "Desktop keyboard and mouse, mobile touch, three computer slots, mixed match, second seats on both teams, reconnect, replay, four human connections and single-player with three computers passed.",
  );
} finally {
  await browser.close();
}
