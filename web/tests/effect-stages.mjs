import { build } from "esbuild";
import { chromium } from "playwright-core";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const web = fileURLToPath(new URL("../", import.meta.url));
const [frames, out, seat = "0"] = process.argv.slice(2);
assert(
  frames && out,
  "Pass the workbench frame directory and output directory",
);
await mkdir(out, { recursive: true });
const bundle = await build({
  entryPoints: [join(web, "tests/effect-stages-scene.js")],
  bundle: true,
  write: false,
  minify: true,
});
const browser = await chromium.launch({ channel: "chrome" });
const results = {},
  allErrors = [];
try {
  const files = (await readdir(frames))
    .filter((f) => f.endsWith(".jsonl"))
    .sort();
  for (let start = 0; start < files.length; start += 6) {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (
        m.type() === "error" ||
        /资源载入失败|WebGLProgram|GL_INVALID/.test(m.text())
      )
        errors.push(m.text().slice(0, 1000));
    });
    await page.route("http://audit.test/**", (r) => {
      const p = new URL(r.request().url()).pathname;
      if (p === "/")
        return r.fulfill({
          contentType: "text/html",
          body: '<script defer src="/app.js"></script>',
        });
      if (p === "/app.js")
        return r.fulfill({
          contentType: "text/javascript",
          body: bundle.outputFiles[0].text,
        });
      if (p.startsWith("/frames/"))
        return r.fulfill({ path: resolve(frames, p.split("/").at(-1)) });
      if (p.startsWith("/play/media/"))
        return r.fulfill({ path: join(web, "public", p.slice(6)) });
      return r.abort();
    });
    await page.goto("http://audit.test/?seat=" + seat);
    for (const f of files.slice(start, start + 6)) {
      const id = f.slice(0, -6);
      const result = await page.evaluate(
        (u) => window.replay(u),
        "/frames/" + f,
      );
      for (const [tick, data] of Object.entries(result.pictures))
        await writeFile(
          join(out, id + "-" + tick + ".png"),
          Buffer.from(data, "base64"),
        );
      delete result.pictures;
      result.errors.push(...errors.splice(0));
      results[id] = result;
      allErrors.push(...result.errors.map((e) => id + ": " + e));
    }
    await page.close();
  }
} finally {
  await browser.close();
}
await writeFile(
  join(out, "measurements.json"),
  JSON.stringify(results, null, 2),
);
const observed = new Set(
  Object.values(results).flatMap((r) => [
    ...Object.keys(r.tracks),
    ...Object.keys(r.composites),
  ]),
);
const expected = {
  void_gate: ["idle"],
  pillar_of_ice: ["pillar"],
  gwen_tristana: ["rapid"],
  blitzcrank: ["qcas", "qmis", "qreturn"],
  ekko: [
    "end",
    "vanish",
    "r-TimeDevice_Active",
    "r-TrailEnd",
    "r-TrailEnd_Red",
    "r-RewindIndicator",
    "r-RewindIndicator_Red",
    "r-Tar_Impact",
    ...Array.from({ length: 6 }, (_, i) => "r-RewindPose" + (i + 1)),
  ],
  jayce: [
    "ready_m",
    "ready_r",
    "stance_m",
    "stance_r",
    "stance_hammer",
    "field_hit",
  ],
  fiddlesticks: ["channel"],
  heimerdinger: ["laser"],
  malzahar: ["portal_end"],
  pantheon: ["spear", "comet", "landing", "slide", "damage", "aftershock"],
  reksai: ["travel", "knockup"],
  void_spawn: ["trail"],
  twistedfate: ["fan", "red", "blue"],
};
for (const id of [
  ...Object.entries(expected).flatMap(([group, names]) =>
    names.map((n) => group + "/" + n),
  ),
  "pantheon_spell4_fly",
  "pantheon_spell4_slide",
  "arrival_spear",
  "rock_shards",
  "stasis/native/body",
  "pix",
  "regeneration",
  "ward",
  "grasp_zone",
  "stealth_enter",
  "stealth_exit",
])
  if (!observed.has(id)) allErrors.push("Missing " + id);
assert.deepEqual(allErrors, []);
console.log(
  filesSummary(results) +
    "; all phase, scale, position and bone checks passed.",
);
function filesSummary(r) {
  return Object.keys(r).length + " battle scenarios";
}
