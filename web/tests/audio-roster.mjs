// Run from the repository root. Each row counts a native cue family at a given
// card/form/team profile; identical inherited profiles count only once per card.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
const tmp = await mkdtemp(join(tmpdir(), "clash-audio-audit-"));
try {
  const path = process.argv[2] ?? join(tmp, "audit.json");
  if (!process.argv[2])
    execFileSync(
      "cargo",
      [
        "test",
        "--locked",
        "-q",
        "-p",
        "clash-lobby",
        "exercise_audio_roster",
        "--",
        "--ignored",
      ],
      { env: { ...process.env, CLASH_AUDIO_AUDIT: path }, stdio: "inherit" },
    );
  const evidence = JSON.parse(await readFile(path));
  const built = await build({
    entryPoints: ["web/src/reference-audio.ts"],
    bundle: true,
    format: "esm",
    write: false,
  });
  const {
    audioCatalog: c,
    soundEvents,
    profileSelections,
  } = await import(
    "data:text/javascript;base64," +
      Buffer.from(built.outputFiles[0].contents).toString("base64")
  );
  const rows = new Map();
  for (const [v, i] of Object.entries(c.variants)) {
    const [kind] = v.split("/");
    const row = kind + "/" + i;
    if (!rows.has(row))
      rows.set(row, {
        expected: new Set(Object.keys(c.profiles[i].events ?? {})),
        observed: new Set(),
      });
  }
  const heard = process.env.AUDIO_EVIDENCE
    ? JSON.parse(await readFile(process.env.AUDIO_EVIDENCE))
    : [];
  const available = new Set(),
    observedClips = new Set();
  for (const p of c.profiles)
    for (const { spec } of profileSelections(p))
      for (const id of spec.pool) available.add(id);
  for (const s of [...evidence.sounds, ...heard]) {
    const i =
      c.variants[[s.kind, Number(!!s.form), s.team].join("/")] ??
      c.variants[[s.kind, 0, s.team].join("/")] ??
      c.variants[s.kind + "/0/0"];
    const row = rows.get(s.kind + "/" + i);
    if (
      s.phase === "projectileFlight" &&
      !c.profiles[i]?.attack_launch_until_impact
    )
      continue;
    if (row)
      for (const { name, spec } of soundEvents(s))
        if (!s.cue || s.cue === name) {
          row.observed.add(name);
          for (const id of spec.pool) observedClips.add(id);
        }
  }
  // These native definitions are inherited by the alternate profile. Deployment
  // happens in base form, and only cannon-form Jayce can start Hyper Charge.
  const inherited = new Set(
    [
      ["aatrox", "deploy:voice"],
      ["jinx", "deploy:start"],
      ["jayce", "deploy:voice"],
      ["jayce", "burst:start"],
    ].map(([kind, cue]) => kind + "/" + c.variants[kind + "/1/0"] + "/" + cue),
  );
  const missingLive = [];
  let total = 0,
    matched = 0;
  for (const [id, { expected, observed }] of rows) {
    const missing = [...expected].filter((cue) => !observed.has(cue));
    total += expected.size;
    matched += expected.size - missing.length;
    for (const name of expected) {
      const key = id + "/" + name;
      if (inherited.has(key)) {
        assert.ok(
          !observed.has(name),
          "Unexpected repeat in alternate form: " + key,
        );
      } else if (
        !observed.has(name) &&
        (heard.length || !id.startsWith("match/"))
      )
        missingLive.push(key);
    }
    if (missing.length) console.log(id, missing.join(" "));
  }
  if (available.size !== c.clips.length)
    throw new Error("Workbench preview is missing a clip");
  console.log(
    observedClips.size,
    "/",
    c.clips.length,
    "clips in the pools selected by observed events",
  );
  if (process.env.AUDIO_MISSING) {
    const missing = new Set(
      [...available].filter((id) => !observedClips.has(id)),
    );
    for (const [variant, idx] of Object.entries(c.variants)) {
      const pools = profileSelections(c.profiles[idx]).filter((e) =>
        e.spec.pool.some((id) => missing.has(id)),
      );
      if (pools.length)
        console.log(variant, pools.map((e) => e.name).join(" "));
    }
  }
  assert.deepEqual(
    missingLive,
    [],
    "Reachable native cues missing from the encounters",
  );
  // The separate terminal browser run supplies the three announcer pools.
  if (heard.length)
    assert.equal(
      observedClips.size,
      c.clips.length,
      "Native clips with no witnessed selection pool",
    );
  console.log(
    evidence.cases,
    "encounters,",
    evidence.loadouts,
    "loadouts,",
    matched,
    "/",
    total,
    "native named event mappings witnessed in these scenes",
  );
} finally {
  await rm(tmp, { recursive: true, force: true });
}
