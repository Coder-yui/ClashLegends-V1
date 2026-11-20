// Measured with Node 26 against an isolated lobby. Each room uses PostgreSQL and two real WebSockets.
import assert from "node:assert/strict";
const base = process.env.LOBBY_URL ?? "http://127.0.0.1:4317";
const count = Number(process.argv[2] ?? 4);
const through = Number(process.argv[3] ?? 600);
assert.ok(
  Number.isSafeInteger(count) &&
    count > 0 &&
    Number.isSafeInteger(through) &&
    through > 0,
);
async function guest() {
  const session = await fetch(base + "/api/session");
  assert.equal(session.status, 200);
  const cookie = session.headers.getSetCookie()[0].split(";")[0];
  async function api(path, body) {
    const res = await fetch(base + "/api/" + path, {
      method: body ? "POST" : "GET",
      headers: { cookie, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const value = await res.json();
    assert.ok(res.ok, JSON.stringify(value));
    return value;
  }
  return { cookie, api };
}
async function prepareRoom() {
  const seats = await Promise.all([guest(), guest()]);
  const room = await seats[0].api("rooms", {
    kind: "friend",
    mode: "classic",
    map: "rift",
  });
  await seats[1].api("join", { code: room.code });
  let matchId;
  for (const seat of seats) {
    const r = await seat.api("rooms/" + room.id);
    ({ matchId } = await seat.api("rooms/" + room.id, {
      action: "ready",
      ready: true,
      round: r.round,
      deckVersion: r.deckVersion,
      settingsVersion: r.settingsVersion,
    }));
  }
  return { seats, matchId };
}
function measure(seat, match, side) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      base.replace(/^http/, "ws") + "/api/matches/" + match + "/live",
      { headers: { cookie: seat.cookie } },
    );
    const start = performance.now();
    let last,
      lastTick = 0,
      cursor,
      bytes = 0,
      events = 0,
      frames = 0,
      skipped = 0,
      releases = 0,
      accepted = 0;
    const gaps = [],
      sizes = [];
    const timer = setTimeout(
      () => {
        ws.close();
        reject(Error("match stream timeout"));
      },
      through * 70 + 15000,
    );
    function finish(err, result) {
      clearTimeout(timer);
      ws.close();
      if (err) reject(err);
      else resolve(result);
    }
    ws.onerror = () => finish(Error("WebSocket failed"));
    ws.onclose = () => {
      clearTimeout(timer);
      if (lastTick < through) reject(Error("early disconnect at " + lastTick));
    };
    ws.onmessage = ({ data }) => {
      try {
        const f = JSON.parse(data);
        if (f.type === "connected") {
          ws.send(JSON.stringify({ type: "ready", protocol: f.protocol }));
          return;
        }
        if (f.type === "receipt") {
          if (!f.error) accepted++;
          return;
        }
        if (f.type !== "frame") return;
        const now = performance.now(),
          w = f.presentation;
        if (w.baseline) {
          assert.deepEqual(w.events, []);
          cursor = w.cursor;
        } else {
          assert.equal(w.after, cursor);
          for (const e of w.events) {
            assert.equal(e.seq, ++cursor);
            if (e.fact.kind === "attackReleased") releases++;
          }
          assert.equal(w.cursor, cursor);
        }
        events += w.events.length;
        if (!f.started) return;
        if (last !== undefined) gaps.push(now - last);
        last = now;
        skipped += Math.max(0, f.tick - lastTick - 1);
        lastTick = f.tick;
        const size = Buffer.byteLength(data);
        bytes += size;
        sizes.push(size);
        frames++;
        if (f.tick >= through || f.result) {
          finish(null, {
            bytes,
            events,
            skipped,
            accepted,
            releases,
            frames,
            gaps,
            sizes,
            elapsed: now - start,
          });
          return;
        }
        if (f.tick % 23 !== 0) return;
        const slot = f.costs.findIndex((cost) => cost <= f.gold);
        if (slot >= 0)
          ws.send(
            JSON.stringify({
              action: "play",
              inputTick: f.tick,
              sequence: f.ack + 1,
              version: f.version,
              slot,
              x: f.tick % 46 === 0 ? 205 : 515,
              y: side ? 380 : 900,
            }),
          );
      } catch (e) {
        finish(e);
      }
    };
  });
}
const rooms = await Promise.all(Array.from({ length: count }, prepareRoom));
const samples = await Promise.all(
  rooms.flatMap(({ seats, matchId }) =>
    seats.map((s, i) => measure(s, matchId, i)),
  ),
);
const sum = (k) => samples.reduce((n, s) => n + s[k], 0);
const percentile = (k, q) => {
  const a = samples.flatMap((s) => s[k]).sort((a, b) => a - b);
  return a.length ? +a[Math.floor((a.length - 1) * q)].toFixed(2) : null;
};
if (through >= 100) {
  assert.ok(samples.every((s) => s.accepted > 0));
  assert.ok(sum("events") > 0);
}
console.log(
  JSON.stringify({
    rooms: count,
    seats: samples.length,
    through,
    frames: sum("frames"),
    skipped: sum("skipped"),
    accepted: sum("accepted"),
    events: sum("events"),
    releases: sum("releases"),
    seatKiBps: +(sum("bytes") / 1024 / (sum("elapsed") / 1000)).toFixed(1),
    frameBytesP95: percentile("sizes", 0.95),
    arrivalMsP95: percentile("gaps", 0.95),
    arrivalMsP99: percentile("gaps", 0.99),
  }),
);
