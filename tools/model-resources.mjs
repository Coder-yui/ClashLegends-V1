// Build the match's public asset index from the same action profiles as the renderer.
import { readFileSync, writeFileSync } from "node:fs";
import {
  clipRoles,
  alternateProfile,
  profileFor,
  modelProfiles,
  castPack,
} from "../web/src/battle-motion.ts";
const profiles = modelProfiles.map((p) => [
  p.asset,
  {
    clips: [...clipRoles(p).keys()],
    casts: Object.fromEntries(
      Object.entries(p.casts ?? {}).map(([skill, action]) => [
        castPack(p, skill),
        action.clip,
      ]),
    ),
  },
]);
if (process.argv.includes("--clips")) {
  console.log(JSON.stringify(Object.fromEntries(profiles)));
} else {
  const rules = JSON.parse(
    readFileSync(new URL("../content/battle_rules.json", import.meta.url)),
  );
  const references = new Set([
    "assist_conversion_unit_id",
    "assist_conversion_building_id",
    "growth_ranged_id",
    "growth_melee_id",
    "deployment_upgrade_id",
    "spawn_id",
    "death_spawn_id",
    "death_replacement_id",
    "timed_revival_id",
    "rush_spawn_id",
  ]);
  function assets(root, team, skill) {
    const result = new Set(),
      seen = new Set();
    function visit(id, active) {
      const key = id + "/" + (active ?? "");
      if (seen.has(key)) return;
      seen.add(key);
      const profile = profileFor({ kind: id, team });
      const alt = alternateProfile(id);
      // Jinx and Aatrox switch only through their equipped skill. Gnar, Sion
      // and Jayce can reach their other body through ordinary combat.
      const canSwitch = active || !["jinx", "aatrox"].includes(id);
      for (const body of [profile, canSwitch && alt]) {
        if (!body) continue;
        result.add(body.asset);
        if (body.followup) result.add(body.followup.asset);
        const pack = castPack(body, active);
        if (pack) result.add(pack);
      }
      function walk(value) {
        if (!value || typeof value !== "object") return;
        for (const [field, child] of Object.entries(value)) {
          if (field === "active_skills") {
            const option = child.find((s) => (s.id ?? s.name) === active);
            if (option) walk(option);
          } else if (field === "spawn_plan") {
            for (const member of child.members) visit(member, active);
          } else if (references.has(field)) {
            const inherited = [
              "growth_ranged_id",
              "growth_melee_id",
              "deployment_upgrade_id",
              "timed_revival_id",
              "death_replacement_id",
            ].includes(field);
            visit(child, inherited ? active : null);
          } else walk(child);
        }
      }
      walk(rules[id]);
    }
    visit(root, skill);
    return [...result].sort();
  }
  const members = {};
  const photoGroups = {};
  for (const [id, rule] of Object.entries(rules)) {
    if (rule.spawn_plan?.members?.length)
      photoGroups[id] = rule.spawn_plan.members;
    else if (rule.deployment_count > 1)
      photoGroups[id] = Array(rule.deployment_count).fill(id);
    if (profileFor({ kind: id, team: 0 })) continue;
    const ids = [
      ...new Set(
        rule.spawn_plan?.members ?? (rule.spawn_id ? [rule.spawn_id] : []),
      ),
    ];
    if (ids.length) members[id] = ids;
  }
  writeFileSync(
    new URL("../web/src/model-members.json", import.meta.url),
    JSON.stringify(members, null, 2) + "\n",
  );
  writeFileSync(
    new URL("../web/src/photo-groups.json", import.meta.url),
    JSON.stringify({ ...members, ...photoGroups }, null, 2) + "\n",
  );
  const index = {};
  for (const id of [...Object.keys(rules), "princess_tower", "nexus"]) {
    const sides = [0, 1].map((team) => {
      const base = assets(id, team, null),
        variants = {};
      for (const option of rules[id]?.active_skills ?? []) {
        const skill = option.id ?? option.name;
        if (!skill) continue;
        const extra = assets(id, team, skill).filter(
          (name) => !base.includes(name),
        );
        if (extra.length) variants[skill] = extra;
      }
      return { base, ...variants };
    });
    if (sides.some((side) => Object.values(side).some((files) => files.length)))
      index[id] = sides;
  }
  writeFileSync(
    new URL("../content/model_resources.json", import.meta.url),
    JSON.stringify(index, null, 2) + "\n",
  );
}
