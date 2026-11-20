// Compare identical seat-filtered frames in the production match page.
import { chromium } from "playwright-core";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

const { frames, matchId, match } = JSON.parse(
  await readFile(process.argv[2], "utf8"),
);
const base = process.env.LOBBY_URL ?? "http://127.0.0.1:4317";
const browser = await chromium.launch({ channel: "chrome" });
const seed = frames.find(
  (f) =>
    f.units.some((u) => u.kind === "ashe" && u.attack) &&
    f.units.some((u) => u.kind === "melee_minion"),
);
assert.ok(seed, "record live combat before benchmarking");
const ashe = seed.units.find((u) => u.kind === "ashe"),
  minion = seed.units.find((u) => u.kind === "melee_minion");
const roster = process.argv.includes("--roster")
  ? [
      "aatrox",
      "gwen",
      "samira",
      "kayn",
      "azir",
      "belveth",
      "kayle_ranged",
      "gnar",
    ]
  : undefined;
const effects = process.argv.includes("--effects");
function crowded(f, count) {
  if (!count) return f;
  const units = Array.from({ length: count }, (_, i) => {
    const u = i % 8 ? minion : ashe;
    const phase = (f.tick + i) % 20,
      start = f.tick - phase;
    const stationary = i % 3 === 0;
    return {
      ...u,
      kind: roster ? roster[i % roster.length] : u.kind,
      id: 10000 + i,
      team: i % 2,
      activity: stationary ? (phase < 6 ? "Windup" : "Recover") : "March",
      since: start,
      x: 80 + (i % 12) * 49,
      y:
        330 +
        Math.floor(i / 12) * 42 +
        (stationary ? 0 : Math.sin((f.tick + i) / 18) * 12),
      attack: stationary
        ? {
            start,
            release: start + 6,
            end: start + 20,
            cycle: 1 + Math.floor(start / 20),
            released: phase >= 6,
          }
        : null,
    };
  });
  return {
    ...f,
    units,
    shots: effects
      ? units
          .filter((_, i) => i % 4 === 0)
          .map((u, i) => {
            const age = (f.tick + i) % 12,
              born = f.tick - age;
            return {
              id: 100000 + born * count + i,
              born,
              team: u.team,
              owner: u.id,
              target: 0,
              sourceKind: "ashe",
              volley: true,
              group: born,
              direction: { x: 0, y: -1 },
              origin: { x: u.x, y: u.y },
              position: { x: u.x, y: u.y - age * 13 },
            };
          })
      : [],
    spells: [],
    areas: [],
    presentation: { after: 0, cursor: 0, events: [] },
  };
}
async function bench(geometry, count, quality = "high") {
  const page = await browser.newPage({
    baseURL: base,
    viewport: { width: 800, height: 900 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/api/matches/" + matchId, (route) =>
    route.fulfill({
      json: roster ? { ...match, modelResources: roster } : match,
    }),
  );
  await page.addInitScript(() => {
    window.samples = [];
    document.addEventListener(
      "battle-render",
      (e) => window.samples.push({ t: performance.now(), ...e.detail }),
      true,
    );
  });
  const tape = frames
    .filter((f) => f.tick >= seed.tick && f.tick < seed.tick + 100)
    .map((f) => crowded(f, count));
  let stop;
  await page.routeWebSocket("**/api/matches/*/live", (ws) => {
    ws.send(JSON.stringify({ type: "connected", protocol: 3 }));
    ws.onMessage((raw) => {
      if (JSON.parse(raw).type !== "ready") return;
      ws.send(JSON.stringify(tape[0]));
      const start = setTimeout(() => {
        let i = 0;
        const timer = setInterval(() => {
          ws.send(JSON.stringify(tape[i++]));
          if (i === tape.length) clearInterval(timer);
        }, 50);
        stop = () => clearInterval(timer);
      }, 2000);
      stop = () => clearTimeout(start);
    });
  });
  await page.goto(
    "/play/matches/" +
      matchId +
      "?battleMetrics=1&vfx=" +
      quality +
      (geometry ? "&battleView=debug" : ""),
  );
  await page.waitForFunction(
    (tick) => window.samples.at(-1)?.tick >= tick,
    tape.at(-1).tick - 1,
    { timeout: 30000 },
  );
  const data = await page.evaluate(
    ([a, b]) => window.samples.filter((s) => s.tick >= a && s.tick < b),
    [seed.tick + 8, tape.at(-1).tick - 1],
  );
  if (!geometry) assert.ok(data.some((s) => s.actors >= (count || 1)));
  const sort = (a) => a.sort((x, y) => x - y);
  const p = (a, q) => +a[Math.floor((a.length - 1) * q)].toFixed(2);
  const cpu = sort(data.map((s) => s.ms)),
    dt = sort(data.slice(1).map((s, i) => s.t - data[i].t));
  console.log(
    JSON.stringify({
      case: count || "live",
      roster: !!roster,
      ...(effects
        ? {
            quality,
            maxParticles: Math.max(...data.map((s) => s.vfx?.particles ?? 0)),
          }
        : {}),
      view: geometry ? "debug" : "models",
      samples: data.length,
      cpuP50: p(cpu, 0.5),
      cpuP95: p(cpu, 0.95),
      cpuP99: p(cpu, 0.99),
      frameP50: p(dt, 0.5),
      frameP95: p(dt, 0.95),
      frameP99: p(dt, 0.99),
      maxFrame: p(dt, 1),
      maxActors: Math.max(...data.map((s) => s.actors ?? 0)),
      maxDraws: Math.max(...data.map((s) => s.calls ?? 0)),
    }),
  );
  if (!count && !geometry && process.env.ACTION_CAPTURE)
    await page.screenshot({ path: process.env.ACTION_CAPTURE });
  assert.deepEqual(errors, []);
  stop?.();
  await page.close();
}
try {
  if (effects) {
    for (const count of [32, 64, 128])
      for (const quality of ["off", "low", "high"])
        await bench(false, count, quality);
  } else
    for (const count of roster ? [32, 64, 128] : [0, 32, 64, 128])
      for (const geometry of roster ? [false] : [true, false])
        await bench(geometry, count);
} finally {
  await browser.close();
}
