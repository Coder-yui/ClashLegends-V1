// Exercise the same authoritative frames and canvas used in a match.
import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const base = process.env.LOBBY_URL ?? "http://127.0.0.1:4432";
const browser = await chromium.launch({ channel: "chrome" });
try {
  const page = await browser.newPage({
    viewport: { width: 1360, height: 1180 },
    deviceScaleFactor: 1.5,
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (msg) => {
    if (/THREE.WebGLProgram|Battle model unavailable/.test(msg.text()))
      errors.push(msg.text());
  });
  await page.addInitScript(() => {
    const Socket = WebSocket;
    window.WebSocket = class extends Socket {
      constructor(...args) {
        super(...args);
        if (!String(args[0]).endsWith("/workbench/live")) return;
        window.edit = (command) => this.send(JSON.stringify(command));
        this.addEventListener("message", (e) => {
          const f = JSON.parse(e.data);
          if (f.type === "frame") window.frame = f;
        });
      }
    };
  });
  await page.goto(base + "/play/workbench");
  const field = page.locator(".battle-overlay");
  await page.waitForFunction(() =>
    document.querySelector(".wb-stats")?.textContent.includes("模型 6"),
  );
  const edit = (command) =>
    page.evaluate((command) => window.edit(command), command);
  const clock = (paused) => edit({ action: "clock", paused, speed: 4 });
  const objectives = await field.evaluate((canvas) => {
    const ctx = canvas.getContext("2d");
    const { units, map } = window.frame;
    return units.map((u) => {
      const nexus = u.kind === "nexus";
      const offset = nexus
        ? u.team === 0
          ? 84
          : -80
        : u.team === 0
          ? -40
          : -76;
      const w = nexus ? 160 : 120;
      const at = (x, y) =>
        Array.from(ctx.getImageData(x + ctx.getTransform().e, y + ctx.getTransform().f, 1, 1).data).join(",");
      const y = Math.floor(u.y + offset / map.projection);
      const x = u.x - w / 2;
      const color = u.team === 0 ? "71,224,71,255" : "242,71,66,255";
      return [
        at(x + 2, y) === color,
        at(x + w - 2, y) === color,
        at(x - 2, y) !== color,
      ];
    });
  });
  assert.equal(objectives.length, 6);
  assert.ok(
    objectives.every((checks) => checks.every(Boolean)),
    JSON.stringify(objectives),
  );

  await edit({
    action: "scene",
    scene: "dummy",
    card: "ashe",
    skill: null,
    team: 0,
  });
  await clock(false);
  await page.waitForFunction(
    () =>
      window.frame.units.some((u) => u.kind === "ashe") &&
      window.frame.tick > 110,
  );
  await clock(true);
  await page.waitForFunction(() => window.frame.lab.paused);

  // Read a scanline above Ashe's feet, ignoring the one-pixel full-health marker.
  async function readAsheBar() {
    return field.evaluate((canvas) => {
      const u = window.frame.units.find((u) => u.kind === "ashe");
      const w = 45; // Native Ashe visual radius is 22.5.
      const left = Math.floor(u.x - w / 2),
        top = Math.floor(u.y) - 120,
        width = Math.ceil(w * 1.5) + 4;
      const pixels = canvas
        .getContext("2d")
        .getImageData(left + (canvas.width - window.frame.map.width)/2, top + (canvas.height - window.frame.map.height)/2, width, 112).data;
      let best = { life: 0, shield: 0 };
      for (let y = 0; y < 112; y++) {
        let life = 0,
          shield = 0;
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          if (pixels[i + 3] !== 255) continue;
          if (pixels[i] === 51 && pixels[i + 1] === 230 && pixels[i + 2] === 51)
            life++;
          if (
            pixels[i] === 255 &&
            pixels[i + 1] === 255 &&
            pixels[i + 2] === 255
          )
            shield++;
        }
        if (life + shield > best.life + best.shield) best = { life, shield };
      }
      return {
        ...best,
        hp: u.hp,
        max: u.maxHp,
        currentShield: u.shield,
        x: u.x,
        y: u.y,
      };
    });
  }
  const full = await readAsheBar();
  assert.equal(full.hp, full.max);
  assert.equal(full.life, 0);
  for (let i = 0; i < Math.ceil(full.max / 150) + 1; i++)
    await edit({
      action: "deploy",
      card: "heal",
      skill: "heal.overheal",
      team: 0,
      x: full.x,
      y: full.y,
    });
  await clock(false);
  await page.waitForFunction(() =>
    window.frame.units.some((u) => u.kind === "ashe" && u.shield > u.maxHp),
  );
  await clock(true);
  await page.waitForFunction(() => window.frame.lab.paused);
  await page.evaluate(
    () =>
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  const shielded = await readAsheBar();
  const scale = 67.5 / ((shielded.hp + shielded.currentShield) / shielded.max);
  assert.ok(Math.abs(shielded.life - scale) < 4, JSON.stringify(shielded));
  assert.ok(
    Math.abs(
      shielded.shield - (scale * shielded.currentShield) / shielded.max,
    ) < 4,
    JSON.stringify(shielded),
  );
  if (process.env.BAR_CAPTURE) {
    await page
      .locator(".wb-stats")
      .evaluate((e) => (e.style.visibility = "hidden"));
    await field.screenshot({ path: process.env.BAR_CAPTURE });
  }
  await clock(false);
  await page.waitForFunction(() =>
    window.frame.units.some((u) => u.kind === "ashe" && !u.shield),
  );
  await clock(true);
  await page.waitForFunction(() => window.frame.lab.paused);
  await page.evaluate(
    () =>
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  const expired = await readAsheBar();
  assert.equal(expired.life, 0);
  assert.equal(expired.shield, 0);
  // Faerie Siphon grants true excess HP. A subsequent shield must follow it.
  await edit({
    action: "scene",
    scene: "dummy",
    card: "pix",
    skill: "pix.faerie-siphon",
    team: 0,
  });
  await clock(false);
  await page.waitForFunction(() =>
    window.frame.units.some(
      (u) => u.kind.startsWith("pix") && window.frame.tick > u.readyTick,
    ),
  );
  await edit({ action: "cast" });
  await page.waitForFunction(() =>
    window.frame.units.some(
      (u) => u.kind.startsWith("pix") && u.hp >= 1.45 * u.maxHp,
    ),
  );
  await clock(true);
  await page.waitForFunction(() => window.frame.lab.paused);
  const location = await page.evaluate(() => {
    const { x, y } = window.frame.units.find(
      (u) => u.kind.startsWith("pix") && u.hp >= 1.45 * u.maxHp,
    );
    return { x, y };
  });
  await edit({
    action: "deploy",
    card: "heal",
    skill: "heal.overheal",
    team: 0,
    ...location,
  });
  await clock(false);
  await page.waitForFunction(() =>
    window.frame.units.some(
      (u) => u.kind.startsWith("pix") && u.hp >= 1.45 * u.maxHp && u.shield > 0,
    ),
  );
  await clock(true);
  await page.waitForFunction(() => window.frame.lab.paused);
  await page.waitForFunction(() => {
    const canvas = document.querySelector('.battle-overlay');
    const ctx = canvas.getContext("2d");
    for (const u of window.frame.units.filter(
      (u) => u.kind.startsWith("pix") && u.hp >= 1.45 * u.maxHp && u.shield > 0,
    )) {
      // Pix now flies at the native 2.3-world-unit elevation. Search its head
      // silhouette above that plane, keeping the old ground placeholder out.
      const projection = window.frame.map.projection;
      const lift = 2.3 * 40 * Math.sqrt(1 - projection ** 2) / projection;
      const height = 90;
      const { data } = ctx.getImageData(u.x + ctx.getTransform().e - 25, u.y + ctx.getTransform().f - lift - height, 65, height);
      for (let y = 0; y < height; y++) {
        let stage = 0;
        for (let x = 0; x < 65; x++) {
          const i = (y * 65 + x) * 4;
          if (data[i + 3] !== 255) continue;
          const r = data[i],
            g = data[i + 1],
            b = data[i + 2];
          if (r === 51 && g === 230 && b === 51) stage = 1;
          if (stage === 1 && r === 209 && g === 89 && b === 255) stage = 2;
          if (stage === 2 && r === 255 && g === 255 && b === 255) return true;
        }
      }
    }
    return false;
  });
  assert.deepEqual(errors, []);
  console.log(
    "Six objective anchors, full-health hiding, shield compression and expiry, and excess HP with shield passed.",
    shielded,
  );
} finally {
  await browser.close();
}
