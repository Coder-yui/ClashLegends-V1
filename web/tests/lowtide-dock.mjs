// Two real guests exercise the room, their own pointer projection and the replay stream.
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";

const baseURL = process.env.LOBBY_URL ?? "http://127.0.0.1:4326";
const out = process.env.BATTLE_CAPTURE_DIR;
if (out) await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: "chrome" });
const mobile = { width: 390, height: 844 },
  desktop = { width: 1440, height: 900 };
const button = (p, name) => p.getByRole("button", { name, exact: true });
const note = /建议在电脑上游玩/;
const errors = [];
const rules = JSON.parse(
  await readFile(
    new URL("../../content/battle_rules.json", import.meta.url),
    "utf8",
  ),
);

async function screenshot(page, name) {
  if (out) await page.screenshot({ path: path.join(out, name + ".png") });
}
async function watch(touch) {
  const page = await browser.newPage({
    baseURL,
    viewport: touch ? mobile : desktop,
    hasTouch: touch,
    isMobile: touch,
  });
  page.setDefaultTimeout(40000);
  const media = new Set(),
    live = new Map(),
    replay = new Map();
  const stats = {
    last: null,
    receipt: null,
    command: null,
    finished: null,
    replay: null,
  };
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (
      m.type() === "error" ||
      /战场使用几何视图|GL_INVALID|WebGL.*(?:failed|lost)/i.test(m.text())
    )
      errors.push(m.type() + " " + m.text());
  });
  page.on("response", (r) => {
    if (!r.url().includes("/media/battle/lowtide-dock/")) return;
    if (!r.ok() && r.status() !== 304) errors.push(r.status() + " " + r.url());
    else media.add(new URL(r.url()).pathname.split("/").pop());
  });
  page.on("websocket", (ws) => {
    const playback = ws.url().includes("/api/recordings/");
    if (!playback && !ws.url().includes("/api/matches/")) return;
    ws.on("framesent", ({ payload }) => {
      const m = JSON.parse(payload);
      if (m.action === "play") stats.command = m;
    });
    ws.on("framereceived", ({ payload }) => {
      const f = JSON.parse(payload);
      if (f.type === "receipt") stats.receipt = f;
      if (f.type !== "frame") return;
      (playback ? replay : live).set(f.tick, f);
      if (playback) stats.replay = f;
      else {
        stats.last = f;
        const event = f.presentation.events.find(
          (e) =>
            e.fact.kind === "commandFinished" &&
            e.fact.data.sequence === stats.command?.sequence,
        );
        if (event) stats.finished = { event, units: f.units };
      }
    });
  });
  await page.addInitScript(() => {
    const captured = new WeakSet();
    const originalStream = HTMLCanvasElement.prototype.captureStream;
    HTMLCanvasElement.prototype.captureStream = function (...args) {
      captured.add(this);
      return originalStream.apply(this, args);
    };
    window.recordedGround = new Set();
    const drawImage = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (image, ...args) {
      if (
        captured.has(this.canvas) &&
        image instanceof HTMLImageElement &&
        image.src.includes("/media/battle/lowtide-dock/")
      ) {
        window.recordedGround.add(new URL(image.src).pathname);
      }
      return drawImage.call(this, image, ...args);
    };
    // A rect participates only when the overlay actually strokes that path in the legal color.
    const ctx = CanvasRenderingContext2D.prototype;
    const paths = new WeakMap();
    const { beginPath, fill, rect, stroke } = ctx;
    ctx.fill = function (...args) {
      if (
        window.dockPreviewInk &&
        args[0] instanceof Path2D &&
        this.canvas.matches(".battle-overlay")
      )
        window.dockPreviewZone = args[0];
      return fill.apply(this, args);
    };
    ctx.beginPath = function () {
      paths.delete(this);
      return beginPath.call(this);
    };
    ctx.rect = function (x, y, w, h) {
      if (
        this.strokeStyle === window.dockPreviewInk &&
        this.canvas.matches(".battle-overlay")
      ) {
        const matrix = this.getTransform();
        const a = matrix.transformPoint({ x, y });
        const b = matrix.transformPoint({ x: x + w, y: y + h });
        paths.set(this, [a.x, a.y, b.x, b.y]);
      }
      return rect.call(this, x, y, w, h);
    };
    ctx.stroke = function (...args) {
      const result = stroke.apply(this, args);
      if (paths.has(this) && this.strokeStyle === window.dockPreviewInk)
        window.dockPreviewRect = paths.get(this);
      return result;
    };
    document.addEventListener(
      "battle-render",
      (e) => {
        window.dockDraw = e.detail;
      },
      true,
    );
  });
  await page.goto("/play/");
  return { page, media, live, replay, stats, touch };
}
async function chooseMap(p, touch) {
  const choice = p.getByRole("combobox", { name: "对战地图" });
  if (touch) {
    await choice.tap();
    await p.getByRole("option", { name: "退潮船坞" }).tap();
  } else {
    await choice.focus();
    await choice.press("End");
    await choice.press("Enter");
  }
  assert.ok(await choice.evaluate((el) => el === document.activeElement));
  await p.getByRole("dialog").getByText(note).waitFor();
}
async function ready(p) {
  await p.locator(".battle-hand button:enabled").first().waitFor();
  await p.waitForFunction(
    () => window.dockDraw?.calls > 0 && window.dockDraw.triangles > 1000,
  );
}
async function deploy(peer, def, me) {
  const { page, stats, touch } = peer;
  const field = page.locator(".battle-input");
  const board = await field.boundingBox();
  assert.ok(
    board.x >= -0.6 && board.x + board.width <= page.viewportSize().width + 0.6,
  );
  assert.ok(
    Math.abs(
      board.width / board.height - def.width / (def.height * def.projection),
    ) < 0.003,
  );
  const f = stats.last;
  assert.equal(f.deploymentZones.length, 4);
  assert.ok(!("obstacles" in f.map) && !("deployment" in f));
  assert.equal(def.tile, 32);
  const slot = f.hand.findIndex((card, i) => {
    const rule = rules[f.handForms[i] ?? card];
    const order = rules[card];
    return (
      rule?.type === "unit" &&
      !rule.is_air &&
      order &&
      !order.spawn_plan &&
      (order.deployment_count ?? 1) === 1 &&
      (rule.footprint_tiles ?? [1, 1]).every((span) => span === 1) &&
      f.costs[i] <= f.gold &&
      Array.isArray(f.deploymentZones[i]?.Home)
    );
  });
  assert.ok(
    slot >= 0,
    "affordable single-cell ground troop in opening hand: " + f.hand,
  );
  const form = f.handForms[slot] ?? f.hand[slot];
  const [ox, oy] = def.tileOrigin;
  const choices = (me ? def.redHome : def.home).flatMap(([x, y, w, h]) =>
    Array.from({ length: w * h }, (_, i) => ({
      x: ox + (x + (i % w) + 0.5) * def.tile,
      y: oy + (y + Math.floor(i / w) + 0.5) * def.tile,
    })),
  );
  function clearance(p) {
    return Math.min(
      p.x,
      def.width - p.x,
      p.y,
      def.height - p.y,
      ...f.units.map((u) => Math.hypot(p.x - u.x, p.y - u.y) - u.radius),
      ...[...def.obstacles, ...def.landObstacles].map(([l, t, r, b]) =>
        Math.hypot(
          Math.max(l - p.x, 0, p.x - r),
          Math.max(t - p.y, 0, p.y - b),
        ),
      ),
    );
  }
  const p = choices
    .filter((c) => Math.abs(c.x - def.width / 2) > def.width / 8)
    .sort((a, b) => clearance(b) - clearance(a))[0];
  // Deliberately inside the cell but away from both center axes, including on narrow touch screens.
  const pointer = { x: p.x + 9, y: p.y - 10 };
  const cx =
    board.x +
    board.width * (me ? 1 - pointer.x / def.width : pointer.x / def.width);
  const cy =
    board.y +
    board.height * (me ? 1 - pointer.y / def.height : pointer.y / def.height);
  async function checkPreview() {
    await page
      .locator('.placement-state[data-state="legal"]')
      .evaluate((el) => {
        const ctx = document.createElement("canvas").getContext("2d");
        ctx.strokeStyle = el.style.color;
        window.dockPreviewRect = null;
        window.dockPreviewZone = null;
        window.dockPreviewInk = ctx.strokeStyle;
      });
    await page.waitForFunction(
      () => !!window.dockPreviewRect && !!window.dockPreviewZone,
    );
    const { bounds, width, height, litCells } = await page
      .locator(".battle-overlay")
      .evaluate((el, map) => {
        window.dockPreviewInk = undefined;
        const ctx = document.createElement("canvas").getContext("2d");
        const [ox, oy] = map.tileOrigin;
        let litCells = 0;
        for (let y = oy + map.tile / 2; y < map.height - oy; y += map.tile)
          for (let x = ox + map.tile / 2; x < map.width - ox; x += map.tile)
            if (ctx.isPointInPath(window.dockPreviewZone, x, y)) litCells++;
        return {
          bounds: window.dockPreviewRect,
          width: el.width,
          height: el.height,
          litCells,
        };
      }, def);
    assert.equal(
      litCells,
      769,
      "opening troop overlay excludes occupied cells on this bank",
    );
    const [left, top, right, bottom] = bounds;
    assert.deepEqual(
      [right - left, bottom - top],
      [32, 32],
      "painted one deployment cell",
    );
    const center = [
      (left + right) / 2 - (width - def.width) / 2,
      (top + bottom) / 2 - (height - def.height) / 2,
    ];
    assert.deepEqual(
      center,
      me ? [def.width - p.x, def.height - p.y] : [p.x, p.y],
      "painted cell center including the camera rotation and actual canvas margins",
    );
    return { canvasBounds: bounds, viewCenter: center };
  }
  const card = page.locator(".battle-hand button").nth(slot);
  let preview;
  if (touch) {
    const box = await card.boundingBox();
    const cdp = await page.context().newCDPSession(page);
    const send = (type, x, y) =>
      cdp.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: x == null ? [] : [{ x, y }],
      });
    await send("touchStart", box.x + box.width / 2, box.y + box.height / 2);
    await send("touchMove", cx, cy);
    preview = await checkPreview();
    await screenshot(page, "red-deployment-grid");
    await send("touchEnd");
    await cdp.detach();
  } else {
    await card.click();
    await page.mouse.move(cx, cy);
    preview = await checkPreview();
    await screenshot(page, "blue-deployment-grid");
    await page.mouse.click(cx, cy);
  }
  const until = Date.now() + 8000;
  while (
    Date.now() < until &&
    !stats.receipt?.error &&
    (!stats.receipt || !stats.finished)
  )
    await page.waitForTimeout(70);
  assert.equal(stats.receipt?.error, null, JSON.stringify(stats.receipt));
  assert.equal(stats.command?.slot, slot);
  assert.equal(
    stats.last.ack,
    stats.command.sequence,
    "authority acknowledged this command",
  );
  assert.ok(
    Math.abs(stats.command.x - pointer.x) <= def.width / board.width &&
      Math.abs(stats.command.y - pointer.y) <= def.height / board.height,
    "the off-center press reached the intended world location within one CSS pixel",
  );
  assert.equal(
    stats.finished?.event.fact.data.error,
    null,
    "deployment executed",
  );
  const tick = stats.receipt.executeTick;
  assert.equal(stats.finished.event.tick, tick);
  const unit = stats.finished.units.find(
    (u) =>
      u.team === me &&
      u.kind === form &&
      u.deployStart === tick &&
      u.x === p.x &&
      u.y === p.y,
  );
  assert.ok(
    unit,
    "server spawned " +
      form +
      " at the previewed cell center " +
      JSON.stringify(p),
  );
  return {
    seat: me,
    card: form,
    ...preview,
    worldPointer: [stats.command.x, stats.command.y],
    worldSpawn: [unit.x, unit.y],
    executeTick: tick,
  };
}
try {
  const blue = await watch(false),
    red = await watch(true);
  const b = blue.page,
    r = red.page;
  const catalog = await (await b.request.get("/api/battle/catalog")).json();
  const def = catalog.maps.find((m) => m.id === "lowtide-dock");
  assert.ok(
    def.desktopRecommended &&
      catalog.modes.every((m) => m.mapIds.includes(def.id)),
  );
  await b.getByRole("button", { name: /创建房间/ }).click();
  await chooseMap(b, false);
  await b
    .getByRole("dialog")
    .getByRole("button", { name: /创建房间/ })
    .click();
  await b.waitForURL("**/rooms/*");
  await button(b, "房间").click();
  await b.getByRole("dialog").getByText(note).waitFor();
  const code = await b.getByTestId("invite").textContent();
  await screenshot(b, "room-desktop");
  await button(b, "关闭").click();
  // Touch also exercises selection, focus return, and closing the modal before joining.
  await r.getByRole("button", { name: /对战电脑玩家/ }).tap();
  await chooseMap(r, true);
  await button(r, "关闭").tap();
  await r.goto("/play/?invite=" + code);
  await r
    .getByRole("dialog")
    .getByRole("button", { name: /加入房间/ })
    .tap();
  await r.waitForURL("**/rooms/*");
  await button(r, "准备").tap();
  await button(b, "准备").click();
  for (const p of [b, r]) await p.waitForURL("**/matches/*");
  // Refresh both seats to exercise the complete frame after reconnect.
  const id = b.url().split("/").pop();
  await Promise.all(
    [b, r].map((p) => p.goto("/play/matches/" + id + "?battleMetrics")),
  );
  await Promise.all([ready(b), ready(r)]);
  const deployments = [];
  for (const [peer, me] of [
    [blue, 0],
    [red, 1],
  ]) {
    const p = peer.page,
      f = peer.stats.last;
    assert.equal(
      (await (await p.request.get("/api/matches/" + id)).json()).me,
      me,
    );
    assert.equal(f.map.id, def.id);
    assert.equal(f.map.terrain, me ? def.terrainRed : def.terrain);
    const bg = await p
      .locator(".battle-stage")
      .evaluate((el) => getComputedStyle(el).backgroundImage);
    assert.ok(bg.includes(f.map.terrain));
    // The center crystal is visible on either camera even at the narrow touch width.
    const hud = await p.evaluate(() => {
      const box = (selector) =>
        document.querySelector(selector).getBoundingClientRect();
      return {
        leftEnd: Math.max(
          box(".battle-tools").right,
          box(".battle-title").right,
        ),
        clockStart: box(".battle-time").left,
        center: innerWidth / 2,
        fieldLeft: box(".battle-input").left,
      };
    });
    assert.ok(
      hud.leftEnd < hud.center - 30 && hud.clockStart > hud.center + 30,
    );
    if (!peer.touch)
      assert.ok(
        hud.leftEnd < hud.fieldLeft,
        "wide HUD stays outside the field",
      );
    const u = f.units.filter((u) => u.structure);
    for (const side of [0, 1]) {
      assert.equal(
        u.filter((v) => v.kind === "princess_tower" && v.team === side).length,
        3,
      );
      assert.equal(
        u.filter((v) => v.kind === "nexus" && v.team === side).length,
        1,
      );
    }
    for (const filename of [
      "harbor.glb",
      "props.glb",
      "sky.hdr",
      "weathering.webp",
      me ? "overview-red.webp" : "overview.webp",
      "preview.webp",
    ])
      assert.ok(
        peer.media.has(filename),
        filename + " downloaded by seat " + me,
      );
    deployments.push(await deploy(peer, def, me));
  }
  await Promise.all([
    screenshot(b, "blue-desktop"),
    screenshot(r, "red-touch"),
  ]);
  // Capture and decode a real red-side video frame before replay verification.
  await button(r, "对局录制").tap();
  const saved = r
    .getByRole("dialog")
    .getByRole("button", { name: /保存对局回放|回放已保存/ });
  await saved.waitFor();
  if (await saved.isEnabled()) await saved.tap();
  await button(r, "录制视频").tap();
  await button(r, "关闭").tap();
  await r.waitForTimeout(2200);
  await button(r, "对局录制").tap();
  await button(r, "停止录制").tap();
  await r.getByText("视频已保存到「我的录制」").waitFor();
  assert.deepEqual(await r.evaluate(() => [...window.recordedGround]), [
    def.terrainRed,
  ]);
  await r.goto("/play/recordings");
  await button(r, "播放视频").first().tap();
  await r.waitForFunction(
    () => document.querySelector("video")?.readyState >= 2,
  );
  const decoded = await r.locator("video").evaluate((v) => {
    const c = document.createElement("canvas");
    c.width = 60;
    c.height = 72;
    const ctx = c.getContext("2d");
    ctx.drawImage(v, 0, 0, 60, 72);
    const d = ctx.getImageData(4, 10, 50, 48).data;
    const unique = new Set();
    for (let i = 0; i < d.length; i += 4)
      unique.add(
        ((d[i] >> 3) << 10) + ((d[i + 1] >> 3) << 5) + (d[i + 2] >> 3),
      );
    return [v.videoWidth, v.videoHeight, unique.size];
  });
  assert.ok(
    decoded[0] > 0 && decoded[1] > 0 && decoded[2] > 65,
    "decoded scene pixels: " + decoded,
  );
  await screenshot(r, "red-video");
  await button(r, "关闭").tap();
  await r.goto("/play/recordings/" + id + "?battleMetrics");
  await r.locator(".battle-overlay").waitFor();
  const slider = r.getByRole("slider", { name: "回放进度" });
  const end = Number(await slider.getAttribute("max"));
  const ref = [...red.live.values()].find(
    (f) => f.tick > 0 && f.tick <= end && f.ack > 0,
  );
  assert.ok(ref, "recorded checkpoint contains the deployed command");
  await slider.fill(String(ref.tick));
  await r.waitForFunction(
    (t) => Number(document.querySelector(".battle-input")?.dataset.tick) === t,
    ref.tick,
  );
  const rebuilt = red.replay.get(ref.tick);
  for (const key of ["map", "units", "deploymentZones", "hand", "ack", "gold"])
    assert.deepEqual(rebuilt[key], ref[key], key);
  await r.setViewportSize(desktop);
  await screenshot(r, "red-desktop-replay");
  await button(r, "自由镜头").click();
  await r.locator(".cinema .battle-models").waitFor();
  await screenshot(r, "red-free-camera");
  // Save the first wave after it has fanned out across all three approaches.
  if (out) {
    const anchors = def.lanes.map(
      (lane) =>
        [...lane].sort(
          (a, b) =>
            Math.abs(a[1] - def.height / 2) - Math.abs(b[1] - def.height / 2),
        )[0][0],
    );
    const deadline = Date.now() + 85000;
    let split;
    do {
      const units = blue.stats.last.units.filter(
        (u) =>
          u.team === 0 &&
          u.kind.endsWith("_minion") &&
          Math.abs(u.y - def.height / 2) < def.height * 0.13,
      );
      split = anchors.every((x) => units.some((u) => Math.abs(u.x - x) < 85));
      if (!split) await b.waitForTimeout(200);
    } while (!split && Date.now() < deadline);
    assert.ok(split, "first wave reached all three bridge approaches");
    await screenshot(b, "blue-three-lanes");
  }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      map: def.name,
      match: id,
      deployments,
      replayTick: ref.tick,
      redVideo: decoded,
      screenshots: out,
    }),
  );
} finally {
  await browser.close();
}
