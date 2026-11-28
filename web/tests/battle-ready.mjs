// A real two-seat match with an interrupted preload and a newly revealed opposing model.
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
const base = process.env.LOBBY_URL ?? "http://127.0.0.1:4317";
const browser = await chromium.launch({ channel: "chrome" });
try {
  const reviewRequests = [];
  async function seat() {
    const p = await browser.newPage({ baseURL: base });
    p.on("request", (request) => {
      if (/\/review-animations\/|\/model-review-|\/ashe-review\.glb/.test(request.url()))
        reviewRequests.push(request.url());
    });
    await p.addInitScript(() => {
      const Native = WebSocket;
      window.WebSocket = class extends Native {
        constructor(...args) {
          super(...args);
          if (!String(args[0]).includes("/api/matches/")) return;
          window.battleSocket = this;
          this.addEventListener("message", ({ data }) => {
            const f = JSON.parse(data);
            if (f.type === "frame") {
              window.frame = f;
              if (f.presentation.baseline) window.lastBaseline = f;
            }
            if (f.type === "receipt") window.receipt = f;
          });
        }
        send(data) {
          if (JSON.parse(data).type === "ready") window.sentReady = true;
          if (JSON.parse(data).type === "ready" && window.holdReady) {
            window.deferredReady = data;
            return;
          }
          super.send(data);
        }
      };
      window.labels = new Set();
      const draw = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function (label, ...args) {
        if (this.canvas.closest(".battle-stage")) window.labels.add(label);
        return draw.call(this, label, ...args);
      };
      document.addEventListener(
        "battle-render",
        (e) => (window.actions = e.detail.actions),
        true,
      );
    });
    await p.request.get("/api/session");
    return p;
  }
  const api = async (p, path, body) => {
    const r = body
      ? await p.request.post("/api/" + path, { data: body })
      : await p.request.get("/api/" + path);
    assert.ok(r.ok(), await r.text());
    return r.json();
  };
  const [blue, red] = await Promise.all([seat(), seat()]);
  const room = await api(blue, "rooms", {
    kind: "friend",
    map: "rift",
    mode: "classic",
  });
  await api(red, "join", { code: room.code });
  const act = async (p, action, fields) => {
    const r = await api(p, "rooms/" + room.id);
    return api(p, "rooms/" + room.id, {
      action,
      round: r.round,
      deckVersion: r.deckVersion,
      settingsVersion: r.settingsVersion,
      ...fields,
    });
  };
  const cards = [
    "sivir",
    "ziggs",
    "pix",
    "malzahar",
    "kayn",
    "lulu",
    "tristana",
    "jinx",
  ];
  const catalog = await api(red, "battle/catalog");
  const skills = Object.fromEntries(
    cards.flatMap((id) => {
      const s = catalog.cards.find((c) => c.id === id).skills[0];
      return s ? [[id, s.id]] : [];
    }),
  );
  await act(red, "deck", { deck: { cards, skills } });
  await act(blue, "ready", { ready: true });
  const { matchId } = await act(red, "ready", { ready: true });
  const path = "matches/" + matchId;
  const own = await api(blue, path);
  for (const id of cards) assert.ok(!own.modelResources.includes(id));
  let fail = true,
    wanted,
    release;
  const held = new Promise((r) => (release = r));
  let finishAudio;
  const slowAudio = new Promise((resolve) => (finishAudio = resolve));
  await red.route("**/media/audio/*.flac", async (route) => {
    await slowAudio;
    await route.continue();
  });
  await blue.route("**/media/models/*.glb*", async (route) => {
    const name = new URL(route.request().url()).pathname
      .split("/")
      .pop()
      .slice(0, -4);
    if (fail && own.modelResources.includes(name)) {
      fail = false;
      return route.abort("failed");
    }
    if (name === wanted) await held;
    await route.continue();
  });
  await Promise.all(
    [blue, red].map((p) => p.goto("/play/" + path + "?animationTrace")),
  );
  await blue
    .getByRole("alert")
    .filter({ hasText: "本局资源加载失败" })
    .waitFor();
  await red.getByText("正在准备战场画面、音效和特效…").waitFor();
  assert.equal(await red.evaluate(() => !!window.sentReady), false);
  finishAudio();
  await red.getByText("等待其他玩家进入战场").waitFor();
  assert.equal(await red.locator(".battle-controls").isVisible(), false);
  assert.equal(await red.evaluate(() => window.frame.tick), 0);
  assert.equal(await blue.locator(".match-loading").isVisible(), true);
  assert.equal((await api(blue, path)).status, "pending");
  await blue.evaluate(() =>
    window.battleSocket.send(
      JSON.stringify({
        action: "activate",
        slot: 0,
        inputTick: 0,
        sequence: 1,
      }),
    ),
  );
  await blue.waitForFunction(() => window.receipt?.error?.includes("尚未完成"));
  await red.evaluate(() => {
    window.holdReady = true;
    window.battleSocket.close();
  });
  await red.waitForFunction(() => !!window.deferredReady);
  await blue.getByRole("button", { name: "重新加载资源" }).click();
  await blue.getByText("等待其他玩家进入战场").waitFor();
  assert.equal((await api(blue, path)).status, "pending");
  await red.evaluate(() => {
    window.holdReady = false;
    window.battleSocket.send(window.deferredReady);
  });
  await Promise.all(
    [blue, red].map((p) => p.waitForSelector(".battle-hand button:enabled")),
  );
  const unit = await red.evaluate(
    () =>
      window.frame.hand[
        window.frame.costs.findIndex((n) => n <= window.frame.gold)
      ],
  );
  assert.ok(cards.includes(unit));
  wanted = unit;
  const demand = blue.waitForRequest((r) =>
    new URL(r.url()).pathname.endsWith("/" + unit + ".glb"),
  );
  await red.evaluate((id) => {
    const f = window.frame;
    window.battleSocket.send(
      JSON.stringify({
        action: "play",
        inputTick: f.tick,
        sequence: f.ack + 1,
        slot: f.hand.indexOf(id),
        version: f.version,
        x: 215,
        y: 380,
      }),
    );
  }, unit);
  await demand;
  await blue.waitForFunction((id) => {
    const u = window.frame.units.find((u) => u.team === 1 && u.kind === id);
    return u && window.labels.has(u.name);
  }, unit);
  release();
  await blue.waitForFunction(
    (id) => window.actions?.some((a) => a.asset === id),
    unit,
  );
  await blue.reload();
  await blue.waitForFunction(() => window.lastBaseline?.tick > 0);
  assert.deepEqual(
    await blue.evaluate(() => window.lastBaseline.presentation.events),
    [],
  );
  assert.equal((await api(blue, path)).status, "claimed");
  assert.deepEqual(reviewRequests, []);
  console.log(
    "Slow and failed assets, readiness after disconnect, opponent reveal with placeholder, running reconnect passed:",
    unit,
  );
} finally {
  await browser.close();
}
