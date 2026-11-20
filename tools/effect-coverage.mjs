// Rebuild the card-to-native-resource review table from the live binding selectors.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(join(root, "web/package.json"));
const json = (file) => JSON.parse(readFileSync(join(root, file), "utf8"));
const { outputFiles } = await require("esbuild").build({
  entryPoints: [join(root, "web/src/effect-bindings.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const { associatedSystems } = await import(
  "data:text/javascript;base64," +
    Buffer.from(outputFiles[0].contents).toString("base64")
);
const { cards } = json("content/catalog.json"),
  members = json("web/src/model-members.json"),
  { systems } = json("web/src/battle-effect-assets.json");
const note = {
  sona: "治疗周期、武器挂点与 R 飞行尾迹",
  ashe: "普攻、八箭齐射与按目标去重的命中",
  final_spark: "起点、阵营方向和光束长度",
  scarecrow: "切换为费德提克后按公开目标连接汲取",
  anivia: "风暴由独立区域驱动",
  aurelionsol: "普攻双端光束和陨星区域",
  mirror: "跟随实际复制出的卡牌",
  inhibitor: "查看召唤出的单位",
  gold_ward: "查看自身凝滞",
  ivern: "查看召唤单位小菊",
  pix: "吸血回复按实际治疗事件触发",
  voidfish_ranged_army: "查看编队成员和死亡衍生物",
  voidfish_ranged: "查看增益到期与死亡衍生物",
  kayle: "远程形态与独立攻击波",
};
const lines = [
  "# 经典模式特效核对表",
  "",
  `目录包含 ${cards.length} 张卡牌和 ${cards.reduce((n, c) => n + c.skills.length, 0)} 个可选技能。资源列由正式客户端的弹体、施法、状态、事件及法术选择器生成。一次部署可能只播放其中一部分。缺少直接绑定的条目可以在工作台查看权威状态、变化后的形态或衍生单位。`,
  "",
  "| 卡牌 | 技能选项 | 直接关联的原生系统 | 复核重点 |",
  "| --- | --- | --- | --- |",
];
for (const c of cards) {
  const names = associatedSystems(
    c.id,
    c.skills.map((s) => s.id),
    members[c.id] ?? [],
  );
  for (const id of names)
    if (!systems[id]) throw Error(c.id + " references missing " + id);
  lines.push(
    `| ${c.name} | ${c.skills.map((s) => s.name).join("、") || "—"} | ${names.map((n) => "`" + n + "`").join("、") || "无直接绑定"} | ${note[c.id] ?? "待逐卡对照"} |`,
  );
}
const destination = join(root, "docs/battle/特效覆盖.md"),
  body = lines.join("\n") + "\n";
if (process.argv.includes("--check")) {
  if (readFileSync(destination, "utf8") !== body)
    throw Error("Run node tools/effect-coverage.mjs");
} else writeFileSync(destination, body);
console.log(
  cards.length + " cards, " + cards.flatMap((c) => c.skills).length + " skills",
);
