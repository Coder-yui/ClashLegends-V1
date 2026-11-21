// Real battle snapshots, event windows, GLB mixers and clip masks in the workbench.
import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const base = process.env.LOBBY_URL ?? "http://127.0.0.1:4432";
const browser = await chromium.launch({ channel: "chrome" });
try {
  const page = await browser.newPage({
    viewport: { width: 1100, height: 800 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
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
  const deploy = (card, team, x, y) =>
    edit({ action: "deploy", card, skill: null, team, x, y });

  // The workbench auto-plays on entry. Start the tick-zero check on a paused
  // baseline so cold model and terrain loads cannot skip the hold pose.
  await page.waitForFunction(() => window.frame && !window.frame.lab.paused);
  await reset({ action: "clear" });
  await seen("nexus-blue", "Nexus_spawn_hold.anm");
  await clock(false);
  await seen("nexus-red", "Nexus_spawn.anm");
  await seen("nexus-red", "Idle1_Base");

  for (const [kind, role, suffix, death] of [
    ["melee_minion", "melee", "", "Death"],
    ["ranged_minion", "ranged", "", "Death"],
    ["siege_minion", "siege", "_BASE", "Death"],
    ["super_minion", "super", "", "Death_Base"],
  ]) {
    await scene(kind);
    await clock(false);
    const asset = role + "-order";
    await seen(asset, "Attack1" + suffix);
    await seen(asset, "Attack2" + suffix);
    await clock(true);
    const unit = await page.evaluate(
      (kind) => window.frame.units.find((u) => u.kind === kind),
      kind,
    );
    for (let i = 0; i < Math.ceil(unit.maxHp / 180) + 1; i++)
      await deploy("explosive_cask", 1, unit.x, unit.y);
    await clock(false);
    await seen(asset, death);
  }

  await reset({ action: "clear" });
  await deploy("sun_disc", 0, 380, 820);
  await clock(false);
  await seen("sun_disc-blue", "Idle2_Base");
  await deploy("training_dummy", 1, 380, 720);
  await seen("sun_disc-blue", "Attack1_BASE");
  await seen("sun_disc-blue", "Attack2_BASE");

  await scene("apex_turret", "apex_turret.hextech-piercing-laser");
  await clock(false);
  await seen("apex_turret", "Attack1");
  await seen("target_dummy-red", "Hit");
  await edit({ action: "cast" });
  await seen("apex_turret", "Attack_Beam");

  await reset({ action: "clear" });
  await deploy("evolution_turret", 0, 380, 820);
  await clock(false);
  for (const clip of ["Spawn", "Deactivate", "Deactivate_Idle"])
    await seen("evolution_turret", clip);
  await deploy("training_dummy", 1, 380, 720);
  for (const clip of ["Activate", "Attack1", "Attack2"])
    await seen("evolution_turret", clip);

  await scene("scarecrow");
  await clock(false);
  for (const clip of [
    "fiddlesticks_respawn",
    "fiddlesticks_spell2",
    "fiddlesticks_spell2_channel",
    "fiddlesticks_spell2_channel_toidle",
  ])
    await seen("scarecrow", clip);

  await scene("powder_keg", null, "duel");
  await clock(false);
  await seen("powder_keg", "Timer");

  await scene("void_gate");
  await clock(false);
  await seen("void_gate", "Spit");
  await edit({ action: "control", kind: "freeze" });
  await page.waitForFunction(() =>
    window.frame.units.some((u) => u.kind === "void_gate" && u.frozen),
  );
  await page.waitForTimeout(160); // Allow the buffered display to reach the freeze tick.
  const pose = () =>
    page.evaluate(() =>
      window.lastActions.find((a) => a.asset === "void_gate"),
    );
  const before = await pose();
  await page.waitForTimeout(350);
  const during = await pose();
  assert.equal(during.clip, "Spit");
  assert.equal(during.time, before.time);
  await page.waitForFunction(
    (t) =>
      window.lastActions.some(
        (a) =>
          a.asset === "void_gate" && a.clip === "Spit" && a.time > t + 0.05,
      ),
    during.time,
  );

  await reset({ action: "clear" });
  const tower = await page.evaluate(() =>
    window.frame.units.find((u) => u.kind === "princess_tower" && u.team === 1),
  );
  for (const [count, clip] of [
    [14, "NativeBreak1"],
    [13, "NativeBreak2"],
    [14, "NativeBreak3"],
  ]) {
    for (let i = 0; i < count; i++)
      await deploy("explosive_cask", 0, tower.x, tower.y);
    await clock(false);
    await seen("princess_tower-red", clip);
    await clock(true);
  }
  await page.waitForFunction(
    (id) => window.lastActions?.find((a) => a.id === id)?.layers.length === 3,
    tower.id,
  );
  const nexus = await page.evaluate(() =>
    window.frame.units.find((u) => u.kind === "nexus" && u.team === 1),
  );
  for (let i = 0; i < 70; i++)
    await deploy("explosive_cask", 0, nexus.x, nexus.y);
  await clock(false);
  await seen("nexus-red", "Death");
  await page.waitForFunction(
    () =>
      !window.frame.units.some((u) => u.kind === "nexus" && u.team === 1) &&
      window.lastActions?.some(
        (a) => a.asset === "nexus-red" && a.clip === "Death" && a.time >= 7.99,
      ),
    undefined,
    { timeout: 12000 },
  );
  assert.deepEqual(errors, []);
  console.log("Live native action transitions passed.");
} finally {
  await browser.close();
}
