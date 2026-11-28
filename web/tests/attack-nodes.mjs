// Drive the production sampler for every calibrated role, form and team.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { attackClipMarker, clipTime, motionFor, profileFor } from "../src/battle-motion.ts";
import { BattleClock } from "../src/battle-clock.ts";

const catalog = JSON.parse(await readFile(new URL("../../content/attack_nodes.json", import.meta.url)));
const timings = JSON.parse(await readFile(new URL("../../content/attack_timing.json", import.meta.url)));
const cards = JSON.parse(await readFile(new URL("../src/preparation-data.json", import.meta.url)));
for (const [key, card] of Object.entries(cards)) {
  for (const { attributes } of card.sections) {
    const i = attributes.findIndex(a => a.name === "攻击间隔");
    const j = attributes.findIndex(a => a.name === "前摇 / 后摇");
    assert.equal(j, i < 0 ? -1 : i + 1, key);
  }
}
const phaseText = (key, section = 0) =>
  cards[key].sections[section].attributes.find(a => a.name === "前摇 / 后摇").value;
assert.equal(phaseText("ashe"), "0.14 / 0.86 秒");
assert.equal(phaseText("sett"), "左拳 0.30 / 0.30 秒；右拳 0.30 / 1.10 秒");
assert.equal(phaseText("samira"), "远程 0.25 / 1.15 秒；近战 0.25 / 0.75 秒");
assert.equal(phaseText("heavy_minion_squad", 2), phaseText("siege_minion"));
assert.equal(phaseText("tombstone", 1), "0.16 / 0.54 秒");
assert.match(cards.aatrox.passives.find(p => p.name === "赐死剑气").attackTiming, /0\.44 \/ 0\.92/);
assert.match(cards.garen.skills[0].attackTiming, /0\.37 秒，接普通攻击时后摇 0\.92/);
assert.equal(cards.garen.skills[1].attackTiming, undefined);
assert.match(cards.ziggs.skills[0].attackTiming, /末击接普通攻击时后摇 1\.00/);
assert.match(phaseText("sivir"), /等待回旋镖接回/);
// Both ranged-minion attacks release on frame 14 of a 49-frame source window.
assert.deepEqual(timings.ranged_minion.base.attack, Array(2).fill(Math.round(14 / 49 * 1e6)));
for (const asset of Object.values(catalog.units.ranged_minion)) {
  assert.deepEqual(catalog.profiles[asset].attack.map(node => node.markerUs),
    Array(2).fill(Math.round(14 / 30 * 1e6)));
}
for (const [kind, { base, red }] of Object.entries(catalog.units)) {
  if (!red) continue;
  for (const [role, nodes] of Object.entries(catalog.profiles[base])) {
    assert.deepEqual(catalog.profiles[red][role].map(node => node.markerUs),
      nodes.map(node => node.markerUs), kind + "/" + role);
  }
}
let checked = 0;
for (const [kind, variants] of Object.entries(catalog.units)) {
  for (const [variant, asset] of Object.entries(variants)) {
    const unit = { kind, team: Number(variant === "red"), alternateForm: variant === "alternate",
      readyTick: 0, hp: 100, maxHp: 100, since: 0, facing: { x: 0, y: 1 }, x: 0, y: 0 };
    const profile = profileFor(unit);
    for (const [role, nodes] of Object.entries(catalog.profiles[asset])) {
      for (const [segment, node] of nodes.entries()) {
        if (kind === "princess_tower") {
          assert.equal(profile.surfaceMode, "tower");
          assert.equal(node.clip, "");
          continue;
        }
        const label = [kind, variant, role, segment].join("/");
        const sourceMark = node.markerUs / 1e6;
        assert.equal(attackClipMarker(profile, node.clip), sourceMark, label);
        const attack = { start: 10, release: 20, end: 35, cycle: segment + 1,
          segment, role, phaseTick: 15, progress: 500, released: false };
        const motion = motionFor({ ...unit, activity: "Windup", attack }, profile, 15);
        assert.equal(motion.clip, node.clip, label);
        assert.equal(motion.marker, sourceMark, label);
        // A split start ends at release. Its hit clip can have a different local origin.
        assert.ok(Math.abs(clipTime(motion, 20, 30) - sourceMark) < 1e-6, label);
        let t = clipTime(motion, 15, 30);
        for (const [tick, release, progress] of [[16, 26, 550], [17, 19, 650]]) {
          const updated = motionFor({ ...unit, activity: "Windup",
            attack: { ...attack, release, phaseTick: tick, progress } }, profile, tick);
          const next = clipTime(updated, tick, 30);
          assert.ok(next >= t && next <= sourceMark, label);
          t = next;
        }
        const hit = motionFor({ ...unit, activity: "Recover", attack: { ...attack, released: true } }, profile, 20);
        const hits = role === "empowered_attack" && profile.roles?.empowered_attack_hit
          || profile.roles?.attack_hit;
        assert.equal(hit.clip, hits?.[segment] ?? node.clip, label);
        checked++;
      }
    }
  }
}
const clock = new BattleClock();
const u = { id: 1, x: 0, y: 0, kind: "aatrox", facing: { x: 0, y: 1 } };
const frame = (tick, release, progress) => ({ tick, shots: [], units: [
  { ...u, attack: { start: 1, release, phaseTick: tick, progress, released: false } },
] });
clock.push(frame(4, 7, 400), 100);
clock.push(frame(5, 10, 460), 150);
const mid = clock.sample(225);
assert.equal(mid.tick, 4.5);
assert.equal(mid.frame.units[0].attack.progress, 430);
assert.equal(mid.frame.units[0].attack.phaseTick, 4.5);
console.log(checked, "unit/form/team attack segments passed release and mid-swing speed checks");
