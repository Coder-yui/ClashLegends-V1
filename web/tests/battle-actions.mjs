// Run against a disposable running lobby. Creates a two-seat classic match.
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = process.env.LOBBY_URL ?? "http://127.0.0.1:4317";
const browser = await chromium.launch({
  channel: "chrome",
  args: [
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
  ],
});
const errors = [];
async function seat() {
  const ctx = await browser.newContext({
    baseURL: base,
    viewport: { width: 800, height: 900 },
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (
      /Battle model unavailable|战场使用几何视图|THREE.WebGLProgram/.test(
        m.text(),
      )
    )
      errors.push(m.text());
  });
  await page.addInitScript(() => {
    window.renderFrames = [];
    document.addEventListener(
      "battle-render",
      (e) => window.renderFrames.push({ ...e.detail, time: performance.now() }),
      true,
    );
  });
  await page.request.get("/api/session");
  return page;
}
async function api(page, path, body) {
  const res = body
    ? await page.request.post("/api/" + path, { data: body })
    : await page.request.get("/api/" + path);
  assert.ok(res.ok(), await res.text());
  return res.json();
}
async function act(page, id, action, fields) {
  const r = await api(page, "rooms/" + id);
  return api(page, "rooms/" + id, {
    round: r.round,
    deckVersion: r.deckVersion,
    settingsVersion: r.settingsVersion,
    action,
    ...fields,
  });
}
function observe(page) {
  const frames = [];
  page.on("websocket", (ws) => {
    if (!ws.url().endsWith("/live") || !ws.url().includes("/matches/")) return;
    ws.on("framereceived", ({ payload }) => {
      const f = JSON.parse(payload);
      if (f.type === "frame" && frames.at(-1)?.tick !== f.tick) frames.push(f);
    });
  });
  return frames;
}
async function deploy(page, frames, depth) {
  const start = Date.now();
  let last = 0,
    usedAshe = false;
  while (Date.now() - start < 65000) {
    if (frames.at(-1)?.result) break;
    const f = frames.at(-1);
    if (f?.started && f.tick > last + 10 && f.gold) {
      const hasAshe = f.hand.indexOf("ashe");
      const slot =
        hasAshe >= 0 && !usedAshe
          ? f.gold >= f.costs[hasAshe]
            ? hasAshe
            : -1
          : f.hand.findIndex(
              (k, i) => f.costs[i] <= f.gold && (k !== "ashe" || !usedAshe),
            );
      if (slot >= 0) {
        const field = page.getByLabel("对战战场");
        await page.locator(".battle-hand button").nth(slot).click();
        const box = await field.boundingBox();
        await field.click({
          position: {
            x: box.width * (depth === 0 ? 0.19 : 0.81),
            y: box.height * 0.55,
          },
        });
        last = f.tick;
        if (f.hand[slot] === "ashe") {
          await page
            .waitForFunction(
              () =>
                document.querySelector(
                  '.battle-hand button[aria-pressed="true"]',
                ) === null,
              null,
              { timeout: 2500 },
            )
            .catch(() => {});
          usedAshe = frames.at(-1)?.version > f.version;
        }
      }
    }
    const sample = await page.evaluate(() => window.renderFrames.at(-1));
    if (usedAshe && sample?.launches >= 3 && f.tick > 320) break;
    await page.waitForTimeout(250);
  }
}
function summarize(samples) {
  const percentile = (a, p) =>
    a.sort((x, y) => x - y)[Math.floor((a.length - 1) * p)];
  const costs = samples.map((s) => s.ms),
    intervals = samples.slice(1).map((s, i) => s.time - samples[i].time);
  return {
    frames: samples.length,
    cpuP50: percentile(costs, 0.5),
    cpuP95: percentile(costs, 0.95),
    intervalP95: percentile(intervals, 0.95),
    intervalP99: percentile(intervals, 0.99),
    actors: Math.max(...samples.map((s) => s.actors ?? 0)),
    draws: Math.max(...samples.map((s) => s.calls ?? 0)),
  };
}
try {
  const [blue, red] = await Promise.all([seat(), seat()]);
  const room = await api(blue, "rooms", {
    kind: "friend",
    mode: "classic",
    map: "rift",
  });
  await api(red, "join", { code: room.code });
  const catalog = await api(blue, "battle/catalog");
  const cards = [
    "ashe",
    "melee_minion",
    "melee_minion_squad",
    "ranged_minion",
    "target_dummy",
    "zap",
    "heal",
    "gold_ward",
  ];
  const deck = { cards, skills: {} };
  for (const key of cards) {
    const c = catalog.cards.find((c) => c.id === key);
    if (c.skills.length) deck.skills[key] = c.skills[0].id;
  }
  for (const p of [blue, red]) await act(p, room.id, "deck", { deck });
  await act(blue, room.id, "ready", { ready: true });
  const { matchId } = await act(red, room.id, "ready", { ready: true });
  const frames = observe(blue),
    other = observe(red);
  const match = await api(blue, "matches/" + matchId);
  const path = "/play/matches/" + matchId + "?battleMetrics=1";
  await Promise.all([blue.goto(path), red.goto(path)]);
  for (const p of [blue, red]) {
    await p.waitForFunction(() => window.renderFrames.length > 0);
    const requested = await p.evaluate(() =>
      performance
        .getEntriesByType("resource")
        .map((e) => new URL(e.name).pathname.split("/").pop())
        .filter((n) => n.endsWith(".glb")),
    );
    assert.deepEqual(
      [...new Set(requested)].sort(),
      match.modelResources.map((name) => name + ".glb").sort(),
    );
    assert.ok(requested.includes("ashe-volley.glb"));
    assert.ok(!requested.includes("ashe-review.glb"));
  }
  await Promise.all([deploy(blue, frames, 0), deploy(red, other, 1)]);
  const metrics = await Promise.all(
    [blue, red].map((p) =>
      p.evaluate(() => window.renderFrames.filter((v) => v.actors > 0)),
    ),
  );
  const events = new Map(
    frames.flatMap((f) => f.presentation.events.map((e) => [e.seq, e])),
  );
  const byKind = Object.fromEntries(
    [...new Set([...events.values()].map((e) => e.fact.kind))].map((k) => [
      k,
      [...events.values()].filter((e) => e.fact.kind === k).length,
    ]),
  );
  const gpu = await blue.evaluate(() => {
    const gl = document.querySelector(".battle-models").getContext("webgl2");
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "unknown";
  });
  console.log(
    JSON.stringify({
      gpu,
      matchId,
      events: byKind,
      active: metrics.map(summarize),
      last: metrics.map((m) => m.at(-1)),
      errors,
    }),
  );
  assert.deepEqual(errors, []);
  for (const m of metrics) {
    assert.ok(m.at(-1).meleeContacts > 0, "melee contact sampled");
    assert.ok(
      m.at(-1)?.launches >= 2,
      "both seats render arrows from the hand",
    );
    assert.ok(m.at(-1).maxMarkerError < 0.001);
  }
  const attacking = frames.filter((f) =>
    f.units.some((u) => u.kind === "ashe" && u.attack?.released),
  );
  assert.ok(attacking.length > 0);
  for (const kind of ["ashe", "melee_minion"]) {
    const cycles = new Set(
      frames.flatMap((f) =>
        f.units
          .filter((u) => u.kind === kind && u.attack?.released)
          .map((u) => u.attack.cycle % 2),
      ),
    );
    assert.equal(cycles.size, 2, "both attack variants: " + kind);
  }
  if (process.env.ACTION_CAPTURE)
    await blue.screenshot({ path: process.env.ACTION_CAPTURE });
  const file = join(tmpdir(), "clash-action-replay-" + matchId + ".json");
  await writeFile(file, JSON.stringify({ matchId, match, frames }));
  console.log("Recorded " + file);
  // Reload the running match. The first frame is a baseline and historic launches stay silent.
  await blue.reload();
  await blue.waitForFunction(() =>
    window.renderFrames.some((f) => f.actors > 0),
  );
  assert.equal(
    await blue.evaluate(
      () => window.renderFrames.find((f) => f.actors > 0).launches,
    ),
    0,
  );
  console.log(
    "Both seats, alternating attacks, hand release and reconnect passed.",
  );
} finally {
  await browser.close();
}
