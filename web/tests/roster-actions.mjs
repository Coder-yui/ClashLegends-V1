// Real battle snapshots, event windows, GLB mixers and clip masks in the workbench.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const base = process.env.LOBBY_URL ?? "http://127.0.0.1:4432";
const browser = await chromium.launch({ channel: "chrome" });
try {
  const page = await browser.newPage({
    viewport: { width: 1100, height: 800 },
  });
  const errors = [];
  page.on("pageerror", (e) => {
    errors.push(e.message);
    console.error(e.message);
  });
  page.on("console", (m) => {
    if (
      /Battle model unavailable|No target node found|Shader Error/.test(
        m.text(),
      )
    )
      errors.push(m.text());
  });
  await page.addInitScript(() => {
    window.trace = new Set();
    const Socket = WebSocket;
    window.WebSocket = class extends Socket {
      constructor(...args) {
        super(...args);
        if (!String(args[0]).endsWith("/workbench/live")) return;
        window.edit = (command) => this.send(JSON.stringify(command));
        this.addEventListener("message", (e) => {
          const message = JSON.parse(e.data);
          if (message.type === "frame") {
            if (message.lab.epoch !== window.frame?.lab.epoch)
              window.trace.clear();
            window.frame = message;
          }
          if (message.type === "error") window.labError = message.message;
        });
      }
    };
    document.addEventListener(
      "battle-render",
      (e) => {
        window.lastActions = e.detail.actions;
        for (const actor of e.detail.actions ?? []) {
          for (const name of [actor.clip, ...actor.layers])
            window.trace.add(actor.asset + "/" + name);
        }
      },
      true,
    );
  });
  await page.goto(base + "/play/workbench?animationTrace");
  const edit = (command) =>
    page.evaluate((command) => window.edit(command), command);
  async function seen(asset, clip) {
    const key = asset + "/" + clip;
    try {
      await page.waitForFunction((key) => window.trace.has(key), key, {
        timeout: 16000,
      });
    } catch {
      assert.fail(
        key +
          " missing: " +
          JSON.stringify(
            await page.evaluate(() => ({
              tick: window.frame?.tick,
              error: window.labError,
              clips: [...window.trace],
            })),
          ),
      );
    }
    console.log(key);
  }
  const clock = (paused) => edit({ action: "clock", paused, speed: 4 });
  async function reset(command) {
    await clock(true);
    const epoch = await page.evaluate(() => window.frame.lab.epoch);
    await edit(command);
    await page.waitForFunction((n) => window.frame.lab.epoch > n, epoch);
  }
  const scene = (card, skill = null, scenario = "dummy") =>
    reset({ action: "scene", scene: scenario, card, skill, team: 0 });
  await page.waitForFunction(() => window.frame && !window.frame.lab.paused);
  const profiles = JSON.parse(
    readFileSync(new URL("../src/roster-models.json", import.meta.url)),
  );
  const rules = JSON.parse(
    readFileSync(new URL("../../content/battle_rules.json", import.meta.url)),
  );
  const stats = [];
  await page.evaluate(() => {
    window.samples = [];
    document.addEventListener(
      "battle-render",
      (e) => window.samples.push(e.detail),
      true,
    );
  });
  for (const [kind, [profile]] of Object.entries(profiles)) {
    const skill = rules[kind].active_skills?.[0]?.id ?? null;
    await scene(kind, skill);
    await clock(false);
    await page.waitForFunction(
      (asset) => window.lastActions?.some((a) => a.asset === asset && a.clip),
      profile.asset,
      { timeout: 8000 },
    );
    await page.waitForFunction(() => {
      const u = window.frame.units.find(
        (u) => u.id === window.frame.lab.selected,
      );
      return !u || window.frame.tick >= Math.max(20, u.readyTick + 12);
    });
    const clips = await page.evaluate(
      (asset) => [...window.trace].filter((x) => x.startsWith(asset + "/")),
      profile.asset,
    );
    assert.ok(clips.length, kind);
    stats.push([kind, clips]);
    console.log(kind, clips.join(","));
  }
  async function castCheck(card, skill, clip) {
    await scene(card, skill);
    await clock(false);
    await page.waitForFunction(() => window.frame.tick >= 30);
    await edit({ action: "cast" });
    await seen(profiles[card][0].asset, clip);
  }
  await castCheck("garen", "garen.judgment", "Spell3_0");
  await castCheck("kayn", "kayn.reaping-slash", "Spell1_Circle");
  await scene("aatrox", "aatrox.world-ender");
  await clock(false);
  await page.waitForFunction(() => window.frame.tick >= 30);
  await edit({ action: "cast" });
  await seen(profiles.aatrox[1].asset, "Spell4");
  const ms = await page.evaluate(() =>
    window.samples
      .map((x) => x.ms)
      .filter(Number.isFinite)
      .sort((a, b) => a - b),
  );
  console.log(
    "Roster combat",
    stats.length,
    "cards",
    ms.length,
    "samples",
    "P95 render CPU ms",
    ms[Math.floor(0.95 * ms.length)],
  );
  assert.deepEqual(errors, []);
  // A frozen, two-seat match must fetch exactly its declared files on both clients.
  const opponent = await browser.newPage();
  const api = async (p, path, body) => {
    const url = base + "/api/" + path;
    const response = body
      ? await p.request.post(url, { data: body })
      : await p.request.get(url);
    assert.ok(response.ok(), await response.text());
    return response.json();
  };
  await api(opponent, "session");
  const room = await api(page, "rooms", {
    kind: "friend",
    mode: "classic",
    map: "rift",
  });
  await api(opponent, "join", { code: room.code });
  async function act(p, action, fields) {
    const current = await api(p, "rooms/" + room.id);
    return api(p, "rooms/" + room.id, {
      round: current.round,
      deckVersion: current.deckVersion,
      settingsVersion: current.settingsVersion,
      action,
      ...fields,
    });
  }
  for (const [p, cards] of [
    [
      page,
      [
        "aatrox",
        "ivern",
        "ashe",
        "jinx",
        "jayce",
        "heal",
        "zap",
        "melee_minion",
      ],
    ],
    [
      opponent,
      [
        "kayn",
        "garen",
        "gnar",
        "ashe",
        "anivia",
        "sion",
        "gold_ward",
        "minion_squad",
      ],
    ],
  ]) {
    const skills = Object.fromEntries(
      cards.flatMap((k) =>
        rules[k].active_skills?.length
          ? [[k, rules[k].active_skills[0].id]]
          : [],
      ),
    );
    await act(p, "deck", { deck: { cards, skills } });
  }
  await act(page, "ready", { ready: true });
  const { matchId } = await act(opponent, "ready", { ready: true });
  const seats = await Promise.all(
    [page, opponent].map((p) => api(p, "matches/" + matchId)),
  );
  const [blue, red] = seats.map((m) => m.modelResources);
  for (const asset of ["aatrox-alt", "daisy", "jayce-alt"]) {
    assert.ok(blue.includes(asset) && !red.includes(asset), asset);
  }
  for (const asset of [
    "garen-decisive-strike",
    "kayn_slayer-reaping-slash",
    "anivia_egg",
    "sion-alt",
    "gnar-alt",
  ]) {
    assert.ok(red.includes(asset) && !blue.includes(asset), asset);
  }
  for (const files of [blue, red]) {
    assert.ok(files.includes("ashe"));
    for (const absent of [
      "ashe-volley",
      "ashe-review",
      "jinx-alt",
      "garen-judgment",
      "gnar-alt-rage-burst",
      "samira",
    ])
      assert.ok(!files.includes(absent), absent);
  }
  await Promise.all(
    [page, opponent].map(async (p, seat) => {
      const observed = new Set();
      const prepared = new Promise((resolve) =>
        p.on("websocket", (ws) => {
          if (!ws.url().includes("/matches/" + matchId + "/live")) return;
          ws.on("framesent", ({ payload }) => {
            if (JSON.parse(payload).type === "ready")
              resolve([...observed].sort());
          });
        }),
      );
      p.on("request", (req) => {
        const path = new URL(req.url()).pathname;
        if (path.endsWith(".glb"))
          observed.add(path.split("/").pop().slice(0, -4));
      });
      await p.goto(base + "/play/matches/" + matchId);
      await p.waitForSelector(".battle-hand button:enabled");
      assert.deepEqual(await prepared, [...seats[seat].modelResources].sort());
    }),
  );
  console.log(
    "Seat-specific model manifests prepared",
    blue.length,
    red.length,
  );
} finally {
  await browser.close();
}
