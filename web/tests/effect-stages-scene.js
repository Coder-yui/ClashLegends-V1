import { BattleModels, ModelResources } from "../src/battle-models";
import { profileFor } from "../src/battle-motion";
import { Vector3 } from "three";

const c = document.createElement("canvas");
c.style.cssText = "width:360px;height:580px";
document.body.append(c);
const res = new ModelResources();
const m = new BattleModels(
  c,
  Number(new URLSearchParams(location.search).get("seat") ?? 0),
  true,
  res,
);
const fx = m.effects;
const approach = (a, b, e = 0.02) => Math.abs(a - b) < e;
const almost = (a, b) => a.every((v, i) => approach(v, b[i]));
window.replay = async (url) => {
  const frames = (await (await fetch(url)).text())
    .trim()
    .split("\n")
    .map(JSON.parse);
  const used = new Set();
  for (const f of frames)
    for (const u of f.units) {
      const p = profileFor(u);
      if (p) used.add(p.asset);
    }
  await res.prepare([...used]);
  m.reset();
  const tracks = {},
    checks = new Set(),
    errors = new Set(),
    composites = {},
    pictures = {};
  const check = (name, pass) => {
    checks.add(name);
    if (!pass) errors.add(name);
  };
  const trace = (name, tick, point, scale, start, outputs) => {
    const t = (outputs[name] ??= {
      first: tick,
      last: tick,
      position: point,
      scale,
      start,
    });
    t.last = tick;
  };
  const registered = new Map();
  const scales = {
    blitzcrank: 0.425,
    ekko: 0.538,
    jayce: 0.38,
    fiddlesticks: 0.4,
    heimerdinger: 0.4,
    reksai: 0.32,
    malzahar: 0.4,
    void_spawn: 0.6,
    pantheon: 0.4,
  };
  const past = new Map(),
    seat = Number(new URLSearchParams(location.search).get("seat") ?? 0),
    sign = seat ? -1 : 1;
  const world = (p, f, y = 0) => [
    (p.x - f.map.width / 2) * sign,
    y,
    (p.y - f.map.height / 2) * sign,
  ];
  const capture = (key) => {
    pictures[key] = c.toDataURL().split(",")[1];
  };
  const id = url.split("/").pop().split("--")[0];
  for (const f of frames) {
    m.render(f, f.tick);
    if (fx.preparing) {
      let n = 0;
      while (fx.preparing && n++ < 1500)
        await new Promise((r) => setTimeout(r, 5));
      m.render(f, f.tick);
    }
    const tick = f.tick;
    for (const u of f.units) if (u.kind === "ekko") past.set(tick, world(u, f));
    for (const e of f.cues ?? []) registered.set(e.seq, e);
    const paths = f.effectPaths ?? [];
    for (const a of fx.trace()) {
      trace(a.system, tick, a.position, a.scale, a.start, tracks);
      tracks[a.system].orientation ??= a.orientation;
      tracks[a.system].key ??= a.key;
      check(
        "finite/" + a.system,
        [...a.position, ...a.orientation, ...a.scale].every(Number.isFinite) &&
          a.scale.every((x) => x > 0) &&
          a.start <= tick,
      );
      const [group, stage] = a.system.split("/");
      if (a.system === "stasis/native/body") {
        const u = f.units.find((u) => u.id === Number(a.key.split("/")[1]));
        check(
          "gold surface owner",
          u.controls.includes("Stasis") &&
            fx.instances.get(a.key).actor.sources.length > 0,
        );
      }
      if (
        a.key.startsWith("rewind/") ||
        a.key.startsWith("travel/") ||
        a.key.startsWith("skill-hit/") ||
        a.key.startsWith("portal-end/") ||
        stage === "laser" ||
        stage === "channel" ||
        a.key.startsWith("spear/") ||
        /^(ready_|stance_)/.test(stage)
      ) {
        const desired =
          group === "pantheon" && stage !== "spear"
            ? (0.3 * 1.05) / 1.3
            : group === "ekko" && ["end", "vanish"].includes(stage)
              ? 140 / 375
              : group === "void_spawn" && ["energy", "glow"].includes(stage)
                ? 0.24
                : scales[group];
        if (desired)
          check(
            "size/" + a.system,
            a.scale.every((n) => approach(n, desired, 0.0001)),
          );
      }
      if (a.key.startsWith("skill-hit/")) {
        const event = registered.get(Number(a.key.split("/")[1]));
        check(
          "target-hit/" + stage,
          event &&
            event.tick === a.start &&
            almost(
              a.position,
              world(event.fact.data.position, f, a.position[1]),
            ),
        );
      }
      if (a.key.startsWith("portal-end/")) {
        const event = registered.get(Number(a.key.split("/")[1]));
        check(
          "portal-close",
          event &&
            a.start === event.tick + 30 &&
            almost(a.position, world(event.fact.data.position, f)),
        );
      }
      if (stage === "laser" && group === "heimerdinger") {
        const shot = f.shots.find((s) => s.id === Number(a.key.split("/")[1]));
        if (shot && tick - shot.born >= 2)
          check(
            "piercing-laser",
            shot.volley &&
              a.start === shot.born &&
              almost(a.position, world(shot.position, f, 46.75)),
          );
      }
      if (a.key.startsWith("spear/") && stage === "spear") {
        const event = registered.get(Number(a.key.split("/")[1]));
        const motion = fx.instances.get(a.key).thrust;
        check("spear timing", event.tick === a.start && tick - a.start <= 6);
        if (tick - a.start === 6) {
          const { origin, direction } = event.fact.data,
            end = {
              x: origin.x + 120 * direction.x,
              y: origin.y + 120 * direction.y,
            };
          check(
            "spear endpoint",
            almost(a.position, world(end, f, motion.launch.y)),
          );
        }
      }
      if (a.system === "void_gate/idle") {
        const owner = f.units.find((u) => u.kind === "void_gate");
        const bone = owner && m.actors.get(owner.id)?.socket("Buffbone_Ground");
        check("gate lifetime", !!owner && a.start === owner.readyTick);
        check(
          "gate ground bone",
          !!bone &&
            almost(a.position, bone.getWorldPosition(new Vector3()).toArray()),
        );
        check("gate scale", approach(a.scale[0], 0.96333333));
      }
      if (
        a.system === "pillar_of_ice/pillar" &&
        !a.key.startsWith("pillar-death/")
      ) {
        const item = fx.instances.get(a.key),
          actor = item.actor;
        const owner = f.units.find((u) => u.kind === "pillar_of_ice");
        const radius = owner.visual.slowFieldRadius;
        check("ice pillar field " + radius, item.fieldRadius === radius);
        for (const [index, batch] of actor.batches) {
          const layer = actor.track.layers[index].name;
          if (layer === "ice_pillar")
            check(
              "ice pillar body scale",
              approach(batch.mesh.scale.x * a.scale[0], 0.36),
            );
          if (layer === "ice_cracks")
            check(
              "ice cracks radius",
              approach(batch.mesh.scale.x * a.scale[0] * 330, radius),
            );
        }
      }
      if (a.system === "gwen_tristana/rapid" && a.key.startsWith("unit/")) {
        const who = Number(a.key.split("/")[1]);
        const socket = m.actors.get(who)?.socket("Buffbone_Glb_Weapon_1");
        check(
          "rapid fire weapon",
          !!socket &&
            almost(
              a.position,
              socket.getWorldPosition(new Vector3()).toArray(),
            ),
        );
      }
      if (a.system === "fiddlesticks/channel") {
        const unit = f.units.find((u) => u.id === Number(a.key.split("/")[1]));
        check(
          "drain channel",
          unit?.visual?.drainTargets?.length > 0 &&
            almost(a.position, world(unit, f)),
        );
      }
      const path = paths.find(
        (p) =>
          a.key.startsWith("travel/" + p.owner + "/") ||
          a.key.startsWith("burrow/" + p.owner + "/"),
      );
      if (path) {
        const age = tick - path.start;
        if (path.kind === "pantheon") {
          check(
            "scale/" + a.system,
            approach(a.scale[0], (0.3 * 1.05) / 1.3, 0.0001),
          );
          const stage = a.system.split("/")[1],
            intervals = {
              comet: [4, 13],
              landing: [13, 26],
              slide: [13, 26],
              damage: [13, 27],
              aftershock: [27, 45],
            };
          check(
            "phase/" + stage,
            age >= intervals[stage][0] && age < intervals[stage][1],
          );
          const dir = (path.team === "Blue" ? -1 : 1) * sign,
            end = world(path.path[0], f);
          if (stage === "aftershock")
            check(
              "aftershock parent",
              almost(a.position, [
                end[0],
                0,
                end[2] - ((450 * 0.3 * 1.05) / 1.3) * dir,
              ]),
            );
          if (stage === "slide" || stage === "damage") {
            const progress = Math.min(1, (age - 13) / 13);
            const remaining =
              stage === "slide" ? (1 - progress) ** 2 : 1 - progress;
            check(
              stage + " trajectory",
              almost(a.position, [end[0], 0, end[2] - 120 * dir * remaining]),
            );
          }
          if (stage === "landing")
            check(
              "landing",
              almost(a.position, [end[0], 0, end[2] - 120 * dir]),
            );
        }
        if (
          path.kind === "sacrifice" &&
          tick < path.impact &&
          stage === "trail"
        ) {
          const body = m.actors.get(path.owner),
            joint = body?.socket("Buffbone_Glb_Channel_Loc");
          check(
            "leap socket",
            joint &&
              almost(
                a.position,
                joint.getWorldPosition(new Vector3()).toArray(),
              ),
          );
          check(
            "leap animation",
            body.playing().clip === body.profile.attacks[0].clip,
          );
        }
        if (path.kind === "reksai" && a.system === "reksai/travel") {
          const point = a.position,
            points = path.path.map((p) => world(p, f));
          const dist = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);
          check(
            "burrow waypoints",
            points.some(
              (b, i) =>
                i > 0 &&
                Math.abs(
                  dist(point, b) +
                    dist(point, points[i - 1]) -
                    dist(b, points[i - 1]),
                ) < 0.05,
            ),
          );
        }
        if (path.kind === "hook") {
          check(
            "hook-window/" + a.system,
            a.system.endsWith("qcas") ||
              ((a.system.endsWith("qmis")
                ? tick < path.impact
                : tick >= path.impact) &&
                tick < path.end),
          );
          const hand = m.actors
            .get(path.owner)
            ?.socket("R_hand")
            ?.getWorldPosition(new Vector3());
          if (a.system.endsWith("qcas"))
            check("hook-hand", hand && almost(a.position, hand.toArray()));
          else {
            const item = fx.instances.get(a.key);
            check(
              "cable-start",
              hand &&
                item.cableStart &&
                almost(
                  item.cableStart
                    .clone()
                    .multiplyScalar(0.425)
                    .applyQuaternion(item.rotation)
                    .add(item.position)
                    .toArray(),
                  hand.toArray(),
                ),
            );
          }
        }
      }
      if (a.key.startsWith("rewind/")) {
        const u = f.units.find((u) => u.kind === "ekko"),
          actor = m.actors.get(u.id),
          kind = a.system.split("/")[1];
        const at = (t) => past.get(Math.max(1, Math.floor(t)));
        if (kind.startsWith("r-RewindPose")) {
          const n = Number(kind.at(-1)),
            pos = at(u.castStart - (80 * n) / 6);
          check(
            "pose-time/" + n,
            approach(a.start, u.castStart + 5 + ((n - 1) * 10) / 6),
          );
          if (pos) check("pose-anchor/" + n, almost(a.position, pos));
        }
        if (kind.startsWith("r-TrailEnd") && tick > 80)
          check("ghost-4s", almost(a.position, at(tick - 80)));
        if (kind === "r-TimeDevice_Active")
          check(
            "device-bone",
            almost(
              a.position,
              actor
                .socket("Weapon_Back_Base")
                .getWorldPosition(new Vector3())
                .toArray(),
            ),
          );
      }
      if (
        a.system.startsWith("jayce/ready") ||
        a.system.startsWith("jayce/stance")
      ) {
        const [_, unit, hero, stage, bone] = a.key.split("/");
        const joint = m.actors.get(Number(unit))?.socket(bone);
        check(
          "weapon/" + stage + "/" + bone,
          joint &&
            almost(a.position, joint.getWorldPosition(new Vector3()).toArray()),
        );
      }
    }
    for (const [, owner] of fx.rocks.owners) {
      const active = [...owner.shards.values()].filter((s) => s.body.visible);
      if (active.length) {
        check(
          "rock skeleton age",
          active.every((s) => s.mixer.time >= 0 && s.mixer.time <= 2.1),
        );
        trace(
          "rock_shards",
          tick,
          owner.root.position.toArray(),
          owner.root.scale.toArray(),
          tick,
          composites,
        );
      }
    }
    for (const [owner, e] of fx.arrivals.entries) {
      const p = paths.find((p) => p.owner === owner),
        age = tick - p.start;
      check("spear-lifetime", e.spear.visible === age < 26);
      check("silhouette-lifetime", e.proxy.visible === (age >= 4 && age < 26));
      if (e.proxy.visible) {
        check(
          "clip/" + e.clip,
          e.clip ===
            (age < 13 ? "pantheon_spell4_fly" : "pantheon_spell4_slide"),
        );
        trace(
          e.clip,
          tick,
          e.proxy.position.toArray(),
          e.proxy.scale.toArray(),
          p.start,
          composites,
        );
      }
      if (e.spear.visible)
        trace(
          "arrival_spear",
          tick,
          e.spear.position.toArray(),
          e.spear.scale.toArray(),
          p.start,
          composites,
        );
      if (age < 26) check("arrival hides troop", !m.actors.has(owner));
    }
    for (const [owner, s] of fx.statuses.entries) {
      const u = f.units.find((u) => u.id === owner),
        bone = s.kind === "pix" ? "spine" : "Root";
      const joint = m.actors.get(owner)?.socket(bone);
      check(
        "status-anchor/" + s.kind,
        joint &&
          almost(
            s.root.position.toArray(),
            joint.getWorldPosition(new Vector3()).toArray(),
          ),
      );
      check(
        "parts/" + s.kind,
        s.sprites.length === { pix: 5, regeneration: 9, ward: 24 }[s.kind],
      );
      trace(
        s.kind,
        tick,
        s.root.position.toArray(),
        s.sprites[0].scale.toArray(),
        tick,
        composites,
      );
    }
    for (const [id, e] of fx.groundEffects.zones) {
      const a = f.areas.find((a) => a.id === id);
      check(
        "zone",
        a &&
          almost(e.position.toArray(), world(a.position, f, 1.2)) &&
          approach(e.scale.x, 180),
      );
      trace(
        "grasp_zone",
        tick,
        e.position.toArray(),
        e.scale.toArray(),
        a.born,
        composites,
      );
    }
    for (const e of fx.groundEffects.transitions.values())
      trace(
        e.enter ? "stealth_enter" : "stealth_exit",
        tick,
        e.root.position.toArray(),
        [1, 1, 1],
        e.start,
        composites,
      );
    if (id === "pantheon" && [2, 9, 19, 26, 31].includes(tick))
      capture(String(tick));
    if (id === "ekko" && [96, 106, 111, 115].includes(tick))
      capture(String(tick));
    if (
      [
        "pix",
        "voidfish_ranged",
        "shurima_guard",
        "twisted_fate",
        "twitch",
        "malzahar",
      ].includes(id) &&
      [60, 65, 108].includes(tick)
    )
      capture(String(tick));
  }
  return {
    tracks,
    composites,
    checks: [...checks],
    errors: [...errors],
    pictures,
  };
};
