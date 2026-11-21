// Run against an isolated local lobby, e.g. LOBBY_URL=http://127.0.0.1:4462.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const base = process.env.LOBBY_URL ?? "http://127.0.0.1:4317";
const browser = await chromium.launch({
  channel: "chrome",
  args: [
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--disable-background-timer-throttling",
  ],
});
const errors = [];
async function seat() {
  const context = await browser.newContext({
    baseURL: base,
    viewport: { width: 640, height: 640 },
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    window.trace = [];
    window.facts = new Map();
    window.sockets = 0;
    // Observe the production socket, including the first frame of a new connection.
    const WS = window.WebSocket;
    window.WebSocket = class extends WS {
      constructor(...args) {
        super(...args);
        if (!/\/(matches\/[^/]+|workbench)\/live$/.test(String(args[0])))
          return;
        window.ws = this;
        window.sockets++;
        let first = true;
        this.addEventListener("message", ({ data }) => {
          const f = JSON.parse(data);
          if (f.type !== "frame") return;
          if (first) {
            window.firstCursor = f.presentation.cursor;
            first = false;
          }
          window.frame = f;
          for (const e of f.presentation.events) window.facts.set(e.seq, e);
        });
      }
    };
    // Record the actual master output and count scheduled sample-buffer sources.
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (dest, ...rest) {
      if (dest === this.context.destination && !window.audioTrack) {
        const monitor = this.context.createMediaStreamDestination();
        connect.call(this, monitor);
        window.audioTrack = monitor.stream.getAudioTracks()[0];
        window.analyser = this.context.createAnalyser();
        connect.call(this, window.analyser);
      }
      return connect.call(this, dest, ...rest);
    };
    const start = AudioBufferSourceNode.prototype.start;
    const stop = AudioBufferSourceNode.prototype.stop;
    const seqForNode = new WeakMap();
    window.stoppedSeq = [];
    AudioBufferSourceNode.prototype.stop = function (...args) {
      window.stoppedSeq.push(seqForNode.get(this));
      return stop.apply(this, args);
    };
    window.starts = 0;
    window.visualLaunches = [];
    window.visualHits = [];
    AudioBufferSourceNode.prototype.start = function (...args) {
      window.lastNode = this;
      window.starts++;
      return start.apply(this, args);
    };
    document.addEventListener(
      "battle-render",
      (e) => {
        if (e.detail.launches > (window.rendered?.launches ?? 0))
          window.visualLaunches.push(e.detail.tick);
        for (const hit of e.detail.hitFrames ?? [])
          window.visualHits.push({ ...hit, shown: e.detail.tick });
        window.rendered = e.detail;
        const a = window.analyser;
        if (a && window.starts > 0) {
          const buf = new Float32Array(a.fftSize);
          a.getFloatTimeDomainData(buf);
          for (const value of buf)
            window.peak = Math.max(window.peak ?? 0, Math.abs(value));
        }
        if (window.capture) window.capture(e.target);
      },
      true,
    );
    document.addEventListener(
      "battle-audio",
      (e) => {
        if (e.detail.action === "play")
          seqForNode.set(window.lastNode, e.detail.seq);
        window.trace.push({ ...e.detail, socket: window.sockets });
      },
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
async function wait(p, fn, arg, timeout = 45000) {
  try {
    await p.waitForFunction(fn, arg, { timeout, polling: 40 });
  } catch (error) {
    console.error(
      await p.evaluate(() => ({
        path: location.pathname,
        tick: window.frame?.tick,
        frame: window.rendered,
        lastSounds: window.trace.slice(-6),
        phases: [
          ...new Set(
            window.trace.map((e) => e.sound?.kind + "/" + e.sound?.phase),
          ),
        ],
        hand: window.frame?.hand,
        text: document.body.innerText.slice(-550),
      })),
    );
    throw error;
  }
}
async function record(p) {
  if (!process.env.AUDIO_CAPTURE) return;
  await p.evaluate(async () => {
    const map = window.frame.map;
    const terrain = new Image();
    terrain.src = map.terrain;
    await terrain.decode();
    const canvas = document.createElement("canvas");
    const width = 432,
      height = Math.round((width * map.height * map.projection) / map.width);
    canvas.width = width;
    canvas.height = height;
    const c = canvas.getContext("2d");
    const stream = canvas.captureStream(30);
    stream.addTrack(window.audioTrack);
    window.capture = (field) => {
      const bgWidth = (width * map.backdropWidth) / map.width;
      const bgHeight = (bgWidth * terrain.height) / terrain.width;
      c.drawImage(
        terrain,
        (width - bgWidth) / 2,
        (height - bgHeight) / 2,
        bgWidth,
        bgHeight,
      );
      const models = field.parentElement.querySelector(".battle-models");
      const dw = width * field.width / map.width, dh = height * field.height / map.height;
      if (models) c.drawImage(models, (width-dw)/2, (height-dh)/2, dw, dh);
      c.drawImage(field, (width-dw)/2, (height-dh)/2, dw, dh);
      c.fillStyle = "#11201ccd";
      c.fillRect(0, 0, width, 28);
      c.fillStyle = "#fff";
      c.font = "14px monospace";
      const last = window.trace.at(-1);
      const label = last?.sound
        ? last.sound.kind + " / " + last.sound.phase
        : (last?.action ?? "");
      c.fillText(
        "Tick " + Math.floor(window.rendered.tick) + "    " + label,
        10,
        19,
      );
    };
    const recorder = new MediaRecorder(stream, {
      mimeType: "video/webm;codecs=vp8,opus",
    });
    const parts = [];
    recorder.ondataavailable = (e) => parts.push(e.data);
    window.endRecording = () =>
      new Promise((resolve) => {
        recorder.onstop = async () => {
          window.capture = null;
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result.split(",")[1]);
          reader.readAsDataURL(new Blob(parts));
        };
        recorder.stop();
      });
    recorder.start();
  });
}
const browserCues = new Map();
async function collectCues(page) {
  if (!process.env.AUDIO_EVIDENCE) return;
  const heard = await page.evaluate(() =>
    window.trace
      .filter((e) => ["play", "layerStart", "terminal"].includes(e.action))
      .map((e) => ({
        kind: e.sound.kind,
        team: e.sound.team,
        form: !!e.sound.form,
        phase: e.sound.phase,
        cycle: e.sound.cycle,
        deploy: e.sound.deploy,
        first: e.sound.first,
        empowered: e.sound.empowered,
        buff: e.sound.buff,
        immune: e.sound.immune,
        timed: e.sound.timed,
        released: e.sound.released,
        cue: e.cue ?? e.selection?.name,
      })),
  );
  for (const sound of heard) browserCues.set(JSON.stringify(sound), sound);
}
async function save(p, name) {
  await collectCues(p);
  if (process.env.AUDIO_CAPTURE) {
    const data = await p.evaluate(() => window.endRecording());
    await writeFile(
      process.env.AUDIO_CAPTURE + "-" + name + ".webm",
      Buffer.from(data, "base64"),
    );
  }
}
async function check(p, label) {
  const result = await p.evaluate(() => {
    const plays = window.trace.filter((e) => e.action === "play");
    return {
      plays,
      starts: window.starts,
      layers: window.trace.filter(
        (e) => e.action === "layerStart" || e.action === "terminal",
      ).length,
      peak: window.peak,
      actors: window.rendered?.actors,
      bad: plays.filter(
        (e) =>
          !window.facts
            .get(e.seq)
            ?.sounds?.some(
              (s) => s.phase === e.sound.phase && s.owner === e.sound.owner,
            ),
      ),
    };
  });
  assert.ok(result.actors > 0);
  assert.ok(result.peak > 0.0001);
  assert.equal(result.starts, result.plays.length + result.layers);
  assert.deepEqual(result.bad, []);
  assert.equal(
    result.plays.length,
    new Set(
      result.plays.map((e) =>
        [e.seq, e.sound.owner, e.sound.phase, e.selection.name].join("/"),
      ),
    ).size,
  );
  for (const e of result.plays)
    assert.ok(e.shown >= e.tick && e.shown - e.tick <= 1);
  const delays = result.plays
    .map((e) => (e.shown - e.tick) * 50)
    .sort((a, b) => a - b);
  console.log(
    label,
    JSON.stringify({
      samples: delays.length,
      p95Ms: delays[Math.floor(delays.length * 0.95)],
      maxMs: delays.at(-1),
      peak: result.peak,
      cues: [
        ...new Set(result.plays.map((e) => e.sound.kind + "/" + e.sound.phase)),
      ],
    }),
  );
  return result.plays;
}
async function lab() {
  const p = await seat();
  await p.goto("/play/workbench");
  const button = (name) => p.getByRole("button", { name, exact: true });
  await button("场景与事件").click();
  await button("暂停战斗").click();
  await button("重建场景").click();
  await wait(
    p,
    () =>
      window.frame?.units.some((u) => u.kind === "ashe") &&
      window.rendered?.actors > 0,
  );
  await record(p);
  // Interrupt on the authority's next tick. The displayed windup is buffered
  // by two ticks, which is also the duration of this archer's short windup.
  await p.evaluate(() => {
    const freeze = () => {
      const f = window.frame;
      const u = f.units.find(
        (u) => u.kind === "ashe" && u.attack && !u.attack.released,
      );
      if (!u || f.tick !== u.attack.start + 1) return;
      window.interrupted = { tick: u.attack.start, sound: { owner: u.id } };
      window.ws.removeEventListener("message", freeze);
      window.ws.send(JSON.stringify({ action: "control", kind: "freeze" }));
    };
    window.ws.addEventListener("message", freeze);
  });
  await button("继续战斗").click();
  await wait(
    p,
    () => window.interrupted && window.trace.some((e) => e.action === "cancel"),
  );
  await wait(p, () =>
    window.trace.some(
      (e) =>
        e.sound?.kind === "ashe" &&
        e.sound?.phase === "hit" &&
        e.action === "play",
    ),
  );
  await button("部署与单位").click();
  await button("万箭齐发").click();
  await wait(p, () =>
    window.trace.some(
      (e) => e.sound?.phase === "volleyHit" && e.action === "play",
    ),
  );
  const events = await check(p, "工作台");
  const impacts = await p.evaluate(() =>
    window.trace
      .filter((e) => e.action === "play" && e.sound.phase === "hit")
      .map((e) => {
        const target = window.facts.get(e.seq).fact.data.target;
        const flash = window.visualHits.find(
          (hit) => hit.target === target && hit.tick === e.tick,
        );
        return { target, tick: e.tick, audio: e.shown, visual: flash?.shown };
      }),
  );
  assert.ok(impacts.length > 0);
  for (const hit of impacts)
    assert.equal(
      hit.audio,
      hit.visual,
      "arrow impact and target hit flash share a rendered frame",
    );
  const cut = await p.evaluate(() => window.interrupted);
  const windup = events.find(
    (e) =>
      e.sound.owner === cut.sound.owner &&
      e.sound.phase === "windup" &&
      e.tick === cut.tick,
  );
  assert.ok(
    windup &&
      (await p.evaluate((seq) => window.stoppedSeq.includes(seq), windup.seq)),
    "cancellation stops the Web Audio source of this exact windup",
  );
  assert.ok(
    !events.some(
      (e) =>
        e.sound.owner === cut.sound.owner &&
        e.sound.phase === "release" &&
        e.sound.key === cut.tick,
    ),
  );
  const cancelled = await p.evaluate(() =>
    window.trace
      .filter((e) => e.action === "cancel")
      .map((e) => window.facts.get(e.seq).fact.data),
  );
  assert.ok(
    cancelled.some((e) => e.id === cut.sound.owner && e.start === cut.tick),
  );
  const markers = await p.evaluate(() => window.visualLaunches);
  const releases = events.filter((e) => e.sound.phase === "release");
  assert.ok(
    releases.length &&
      releases.every((e) => markers.some((t) => Math.abs(t - e.shown) < 0.001)),
    "Ashe's bow release and its buffer source start in the same rendered frame",
  );
  assert.equal(
    events.filter((e) => e.sound.phase === "volleyRelease").length,
    1,
  );
  await save(p, "cancel");
  await p.context().close();
}
async function layers() {
  const p = await seat();
  await p.goto("/play/workbench");
  await p.getByRole("button", { name: "场景与事件", exact: true }).click();
  await p.getByRole("button", { name: "重建场景", exact: true }).click();
  await wait(p, () => window.frame?.units.some((u) => u.kind === "ashe"));
  const deploy = async (card, team = 0) =>
    p.evaluate(
      ({ card, team }) => {
        const u = window.frame.units.find((u) => u.kind === "ashe");
        window.ws.send(
          JSON.stringify({ action: "deploy", card, team, x: u.x, y: u.y }),
        );
      },
      { card, team },
    );
  await deploy("stasis");
  const heard = (kind, phase, action) =>
    wait(
      p,
      ([kind, phase, action]) =>
        window.trace.some(
          (e) =>
            e.action === action &&
            e.sound?.kind === kind &&
            e.sound.phase === phase,
        ),
      [kind, phase, action],
    );
  await heard("stasis", "spell:flight", "layerStart");
  await heard("stasis", "spell:strike", "play");
  await heard("stasis", "spell:flight", "layerEnd");
  await heard("stasis", "stasis_target:sustain", "layerStart");
  await deploy("sona");
  await heard("sona", "heal_aura:start", "play");
  await heard("sona", "heal_aura:sustain", "layerStart");
  await deploy("pool_of_reflection");
  await heard("pool_of_reflection", "spell:zone_sustain", "layerStart");
  const button = (name) => p.getByRole("button", { name, exact: true });
  await button("暂停战斗").click();
  await wait(p, () => window.frame.lab.paused);
  await button("继续战斗").click();
  await wait(
    p,
    () =>
      window.trace.filter(
        (e) =>
          e.action === "layerStart" &&
          e.sound?.phase === "spell:zone_sustain" &&
          e.sound.kind === "pool_of_reflection",
      ).length >= 2,
  );
  const resumed = await p.evaluate(() =>
    window.trace
      .filter(
        (e) =>
          e.action === "layerStart" && e.sound?.phase === "spell:zone_sustain",
      )
      .at(-1),
  );
  assert.ok(resumed.offset > 0, "a live zone resumes at the elapsed sample");
  await heard("pool_of_reflection", "spell:zone_sustain", "layerEnd");
  console.log(
    "持续声",
    resumed.offset,
    "秒处恢复，凝滞飞行、落地、琴女治疗和区域退场通过",
  );
  await collectCues(p);
  await p.context().close();
}
async function match(kind) {
  const blue = await seat();
  const red = kind === "friend" ? await seat() : null;
  const players = red ? [blue, red] : [blue];
  const room = await api(blue, "rooms", { kind, mode: "classic", map: "rift" });
  if (red) await api(red, "join", { code: room.code });
  const cat = await api(blue, "battle/catalog");
  const cards = [
    "ashe",
    "melee_minion",
    "ranged_minion",
    "melee_minion_squad",
    "ranged_minion_squad",
    "target_dummy",
    "zap",
    "heal",
  ];
  const skills = Object.fromEntries(
    cat.cards
      .filter((c) => cards.includes(c.id) && c.skills.length)
      .map((c) => [c.id, c.skills[0].id]),
  );
  let matchId;
  for (const p of players) {
    await act(p, room.id, "deck", { deck: { cards, skills } });
    ({ matchId } = await act(p, room.id, "ready", { ready: true }));
  }
  await Promise.all(
    players.map(async (p) => {
      await p.goto("/play/matches/" + matchId + "?battleMetrics=1");
      await wait(p, () => window.frame?.started && window.rendered?.actors > 0);
      await p.keyboard.press("Shift");
      await wait(p, () => !!window.audioTrack);
    }),
  );
  await record(blue);
  if (red) await record(red);
  // Use the real host's hand/version and legal placement regions.
  await blue.evaluate(() => {
    window.deployer = setInterval(() => {
      const f = window.frame;
      if (!f?.started || window.ws.readyState !== 1 || f.result) return;
      let slot = f.hand.indexOf("ashe");
      if (slot < 0)
        slot = f.costs.findIndex(
          (cost, i) => cost <= f.gold && !["zap", "heal"].includes(f.hand[i]),
        );
      if (slot < 0 || f.costs[slot] > f.gold) return;
      window.ws.send(
        JSON.stringify({
          action: "play",
          sequence: f.ack + 1,
          slot,
          version: f.version,
          inputTick: f.tick,
          x: 140,
          y: 760,
        }),
      );
    }, 450);
  });
  await wait(
    blue,
    () =>
      window.trace.some(
        (e) => e.action === "play" && e.sound?.phase === "hit",
      ) && window.frame.shots.length > 0,
    null,
    90000,
  );
  const before = await blue.evaluate(() => {
    const n = window.sockets;
    window.ws.close();
    return n;
  });
  await wait(
    blue,
    (old) =>
      window.sockets > old &&
      window.trace.some(
        (e) =>
          e.action === "play" && e.socket > old && e.sound?.phase === "hit",
      ),
    before,
  );
  const after = await blue.evaluate(
    (old) => ({
      cursor: window.firstCursor,
      plays: window.trace.filter((e) => e.socket > old && e.action === "play"),
    }),
    before,
  );
  assert.ok(
    after.plays.every((e) => e.seq > after.cursor),
    "no historic audio on reconnect",
  );
  if (red) {
    await wait(
      red,
      () =>
        window.trace.some(
          (e) =>
            e.action === "cancel" &&
            window.trace.some(
              (w) =>
                w.action === "play" &&
                w.sound.phase.startsWith("windup") &&
                w.sound.owner === window.facts.get(e.seq).fact.data.id &&
                w.sound.key === window.facts.get(e.seq).fact.data.start,
            ),
        ),
      null,
      90000,
    );
    await wait(red, allFourHit, null, 90000);
    const a = await check(blue, "双人蓝方"),
      b = await check(red, "双人红方");
    const cancels = await red.evaluate(() =>
      window.trace
        .filter((e) => e.action === "cancel")
        .map((e) => window.facts.get(e.seq).fact.data),
    );
    for (const { id, start } of cancels)
      assert.ok(
        !b.some(
          (e) =>
            e.sound.owner === id &&
            e.sound.phase === "release" &&
            e.sound.key === start,
        ),
      );
    console.log("双人局取消", cancels.length);
    const shared = a.find(
      (e) =>
        Math.abs(e.pan) > 0.05 &&
        b.some(
          (x) =>
            x.tick === e.tick &&
            x.sound.owner === e.sound.owner &&
            x.sound.phase === e.sound.phase &&
            Math.abs(e.pan + x.pan) < 0.001,
        ),
    );
    assert.ok(shared, "mirrored stereo at the same world event");
  } else {
    await wait(blue, allFourHit, null, 90000);
    await check(blue, "AI 对局");
  }
  if (process.env.AUDIO_FINISH) {
    for (const [seat, p] of players.entries()) {
      await wait(p, () => !!window.frame?.result, null, 320000);
      const result = await p.evaluate(() => window.frame.result);
      if (result.winner !== null) {
        const cue = result.winner === seat ? "victory" : "defeat";
        await wait(
          p,
          (cue) =>
            window.trace.some(
              (e) => e.action === "terminal" && e.sound?.phase === cue,
            ),
          cue,
          15000,
        );
        const terminal = await p.evaluate(() =>
          window.trace
            .filter((e) => e.action === "terminal")
            .map((e) => ({ phase: e.sound.phase, time: e.audioTime })),
        );
        assert.equal(terminal.filter((e) => e.phase === cue).length, 1);
        if (result.reason === "Nexus") {
          const death = terminal.find((e) => e.phase === "death");
          assert.ok(death);
          const delay = terminal.find((e) => e.phase === cue).time - death.time;
          assert.ok(
            delay >= 4.99 && delay < 5.25,
            `Nexus announcement delay ${delay}`,
          );
        }
        console.log("实战终局", seat, result, terminal);
      }
    }
  }
  await save(blue, kind);
  if (red) await save(red, "friend-red");
  await Promise.all(players.map((p) => p.context().close()));
}
function allFourHit() {
  return ["ashe", "melee_minion", "ranged_minion", "princess_tower"].every(
    (kind) =>
      window.trace.some(
        (e) =>
          e.action === "play" &&
          e.sound?.kind === kind &&
          e.sound.phase === "hit",
      ),
  );
}
try {
  for (const scenario of (
    process.env.AUDIO_SCENARIOS ?? "layers,lab,friend,ai"
  ).split(",")) {
    if (scenario === "lab") await lab();
    else if (scenario === "layers") await layers();
    else await match(scenario);
  }
  assert.deepEqual(errors, []);
  if (process.env.AUDIO_EVIDENCE)
    await writeFile(
      process.env.AUDIO_EVIDENCE,
      JSON.stringify([...browserCues.values()]),
    );
} finally {
  await browser.close();
}
