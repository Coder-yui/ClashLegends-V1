// Re-sample the approved vector plan into the same world space used by terrain and combat.
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const root = new URL("../", import.meta.url);
const { chromium } = createRequire(new URL("web/package.json", root))(
  "playwright-core",
);
const browser = await chromium.launch({ channel: "chrome" });
try {
  const page = await browser.newPage();
  await page.setContent(
    await readFile(new URL("docs/battle/退潮船坞-二维布局.svg", root), "utf8"),
  );
  const plan = await page.evaluate(() => {
    const svg = document.querySelector("svg");
    const world = (x, y) => [
      Math.round((x - 126) * 200) / 100,
      Math.round((y - 132) * 200) / 100,
    ];
    const node = (id) => document.getElementById(id);
    const coord = (g) => world(Number(g.dataset.x), Number(g.dataset.y));
    function sample(path, step, closed = false) {
      const length = path.getTotalLength(),
        n = Math.ceil(length / step);
      const m = svg.getScreenCTM().inverse().multiply(path.getScreenCTM());
      return Array.from({ length: n + (closed ? 0 : 1) }, (_, i) => {
        const p = path.getPointAtLength((length * i) / n).matrixTransform(m);
        return world(p.x, p.y);
      });
    }
    const teams = {};
    for (const team of ["blue", "red"]) {
      teams[team] = {
        nexus: coord(node(team + "-nexus")),
        spawn: coord(node(team + "-spawn")),
        towers: [1, 2, 3].map((i) => coord(node(team + "-tower-" + i))),
      };
    }
    const lanes = [1, 2, 3].map((i) =>
      sample(node("lane-" + i).querySelector("path"), 18),
    );
    const bed = node("tidal-bed-area");
    // The contour runs west to east along the north bank, then rotates back along the south.
    const segments = bed.getAttribute("d").match(/[MLQ][^MLQZ]*/g);
    const east = bed.getBBox().x + bed.getBBox().width;
    const turn = segments.findIndex(
      (segment) => Number(segment.trim().split(/\s+/).at(-2)) === east,
    );
    if (turn < 1) throw Error("Cannot identify the east mouth of the dock");
    const d = segments.slice(0, turn + 1).join(" ");
    const north = document.createElementNS(svg.namespaceURI, "path");
    north.setAttribute("d", d);
    svg.append(north);
    const bank = sample(north, 5);
    north.remove();
    const south = bank
      .map(([x, y]) => [
        Math.round((1096 - x) * 100) / 100,
        Math.round((1744 - y) * 100) / 100,
      ])
      .reverse();
    return {
      width: 1096,
      height: 1744,
      tile: 32,
      tileOrigin: [4, 8],
      outline: [
        [150, 132],
        [650, 132],
        [674, 156],
        [674, 980],
        [650, 1004],
        [150, 1004],
        [126, 980],
        [126, 156],
      ].map(([x, y]) => world(x, y)),
      river: { north: bank, south },
      bridges: [1, 2, 3].map((i) => {
        const r = node("ground-crossing-" + i);
        const x = r.x.baseVal.value;
        return {
          left: world(x, 0)[0],
          right: world(x + r.width.baseVal.value, 0)[0],
        };
      }),
      lanes,
      teams,
      props: ["red", "blue"].flatMap((team) =>
        [1, 2].map((i) => {
          const g = node(team + "-barrier-" + i),
            p = g.querySelector(".contact-contour");
          const m = svg.getScreenCTM().inverse().multiply(g.getScreenCTM());
          return {
            kind: g.dataset.kind,
            center: coord(g),
            angle: Math.round((Math.atan2(m.b, m.a) * 180) / Math.PI),
            polygon: sample(p, 2, true),
          };
        }),
      ),
    };
  });
  const rows = Object.entries(plan).map(
    ([key, value]) => "  " + JSON.stringify(key) + ": " + JSON.stringify(value),
  );
  await writeFile(
    fileURLToPath(new URL("content/lowtide-layout.json", root)),
    "{\n" + rows.join(",\n") + "\n}\n",
  );
} finally {
  await browser.close();
}
