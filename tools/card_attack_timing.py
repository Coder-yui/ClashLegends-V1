"""Derive the card information shown in preparation and the workbench from combat rules."""
from math import ceil, lcm

LABEL = "前摇 / 后摇"


def seconds(value):
    return f"{value:.2f}"


def rotation(stats, nodes, *, speed=1, close=False):
    """At constant speed the time after release i is interval i minus windup i+1."""
    intervals = stats.get("attack_pattern", [stats["interval"]])
    count = lcm(len(intervals), len(nodes))
    windows = [max(1, ceil(intervals[i % len(intervals)] * 20)) for i in range(count)]
    # Match the core's fixed-point cost (1000 clock units per base tick).
    before = [((t * nodes[i % len(nodes)] + 500) // 1000) / 20000 for i, t in enumerate(windows)]
    cadence = stats["close_attack_speed_multiplier"] if close else 1
    return [(w / speed, max(0, t / 20 / cadence - before[(i + 1) % count]) / speed)
            for i, (w, t) in enumerate(zip(before, windows))]


def pairs(phases, labels=()):
    values = [f"{seconds(w)} / {seconds(r)} 秒" for w, r in phases]
    if len(set(values)) == 1:
        return values[0]
    return "；".join(f"{labels[i] if labels else f'第{i + 1}击'} {v}" for i, v in enumerate(values))


def basic_text(key, stats, roles, *, speed=1):
    nodes = roles["attack"]
    if key == "samira":
        return ("远程 " + pairs(rotation(stats, nodes[:2], speed=speed)) +
                "；近战 " + pairs(rotation(stats, nodes[2:], speed=speed, close=True)))
    if key == "sivir":
        return f"{seconds(rotation(stats, nodes)[0][0])} 秒 / 等待回旋镖接回"
    if key == "sett":
        return pairs(rotation(stats, nodes, speed=speed)[:2], ["左拳", "右拳"])
    text = pairs(rotation(stats, nodes, speed=speed))
    if "attack_structure" in roles:
        text = "对单位 " + text + "；对建筑 " + pairs(rotation(stats, roles["attack_structure"], speed=speed))
    if key == "graves":
        text += "（弹匣耗尽另需换弹）"
    return text


def after_range(interval, windups):
    values = sorted({seconds(max(0, interval - w)) for w in windups}, key=float)
    return values[0] if len(values) == 1 else values[0] + "–" + values[-1]


def empowered_text(stats, roles, skill):
    normal = rotation(stats, roles["attack"])
    nodes = roles.get("empowered_attack", roles["attack"])
    special = rotation(stats, nodes)
    interval = ceil(stats["interval"] * 20) / 20
    before = sorted({seconds(w) for w, _ in special}, key=float)
    windup = "–".join(dict.fromkeys([before[0], before[-1]]))
    if skill["kind"] == "channeled_attack":
        return f"强化出手前摇 {windup} 秒。压制生效后引导 {skill['duration']:g} 秒，引导期间无法起手。"
    normal_after = after_range(interval, [w for w, _ in normal])
    if skill.get("attack_count", 1) > 1:
        repeat_after = after_range(interval, [w for w, _ in special])
        if repeat_after != normal_after:
            return f"强化前摇 {windup} 秒；连用强化时后摇 {repeat_after} 秒，末击接普通攻击时后摇 {normal_after} 秒。"
    return f"强化前摇 {windup} 秒，接普通攻击时后摇 {normal_after} 秒。"


def enrich_card_timings(cards, rules, timings):
    def phases(key, form="base", role="attack", speed=1):
        stats = rules[key] if form == "base" else rules[key]["transformed_stats"]
        return rotation(stats, timings[key][form][role], speed=speed)

    def text(key, form="base", speed=1):
        stats = rules[key] if form == "base" else rules[key]["transformed_stats"]
        return basic_text(key, stats, timings[key][form], speed=speed)

    for key, card in cards.items():
        rule = rules[key]
        forms = timings.get(key, {})
        members = list(dict.fromkeys(rule.get("spawn_plan", {}).get("members", [])))
        for section in card["sections"]:
            attrs = section["attributes"]
            attrs[:] = [a for a in attrs if a["name"] != LABEL]
            interval = next((i for i, a in enumerate(attrs) if a["name"] == "攻击间隔"), None)
            if interval is None:
                continue
            title = section["title"]
            owner, form = key, "base"
            if members:
                owner = next(m for m in members if title.startswith(rules[m]["name"] + " ×"))
            elif title.startswith("召唤物"):
                owner = rule["spawn_id"]
            elif "金币部署" in title:
                owner = rule["deployment_upgrade_id"]
            elif "变形后" in title:
                form = "alternate"
            if owner not in timings:
                assert rules[owner].get("structure_mend_per_second"), (key, title)
                attrs[interval]["name"] = "修复方式"
                attrs[interval]["value"] = "持续修复"
                continue
            if owner == "sett":
                attrs[interval]["value"] = "左拳后 0.60 秒，右拳后 1.40 秒"
                dps = sum(rule["attack_damage_multipliers"]) * rule["damage"] / sum(rule["attack_pattern"])
                next(a for a in attrs if a["name"] == "每秒伤害")["value"] = f"{dps:g}"
            if owner == "twisted_fate":
                next(a for a in attrs if a["name"] == "单次伤害")["value"] = "62（第五击 93）"
            attrs.insert(interval + 1, {"name": LABEL, "value": text(owner, form)})

        for p in card["passives"]:
            p.pop("attackTiming", None)
        def passive(name, note, description=None):
            entry = next((p for p in card["passives"] if p["name"] == name), None)
            if entry is None:
                assert description, (key, name)
                entry = {"name": name, "description": description}
                card["passives"].append(entry)
            elif description:
                entry["description"] = description
            entry["attackTiming"] = note

        # Some legacy tooltips inferred a Sett passive from any attack pattern,
        # or a Gwen passive from max-health damage. Use the actual owner.
        if key in ("nocturne", "shurima_guard", "aatrox"):
            wrong = "千穿百孔" if key == "aatrox" else "拳锋连击"
            card["passives"][:] = [p for p in card["passives"] if p["name"] != wrong]
        if key == "aatrox":
            passive("赐死剑气", "被动前摇 / 后摇 " + pairs([phases(key)[3]]) + "。",
                    "三次普通攻击后，第四击附加目标最大生命值 10% 的伤害，对塔和水晶固定附加 20 点。本击按实际生命伤害的 30% 治疗自身。")
        elif key == "sett":
            passive("拳锋连击", LABEL + "：" + text(key) + "。",
                    "左拳造成 72 点伤害，右拳造成 108 点伤害。左拳出手后 0.60 秒出右拳，右拳出手后 1.40 秒出左拳。")
        elif key in ("masteryi", "twisted_fate", "tryndamere"):
            name, description = {
                "masteryi": ("双重打击", "每第三次攻击追加一次半额伤害。"),
                "twisted_fate": ("第五击", "每第五次普通攻击造成 1.5 倍伤害。"),
                "tryndamere": ("战斗狂怒", None),
            }[key]
            passive(name, "强化一击前摇 / 后摇 " + pairs([phases(key)[-1]]) + "。", description)
        elif key == "jayce":
            passive("墨丘利变形", "首击前摇 / 后摇：炮形态 " + pairs(phases(key, role="first_strike_attack")) +
                    "，锤形态 " + pairs(phases(key, "alternate", "first_strike_attack")) + "。")
        elif key == "ekko":
            passive("Z型驱动共振", "触发时前摇 / 后摇 " + text(key) + "。", card["brief"])
        elif key == "samira":
            passive("近身刀击", "刀击前摇 / 后摇 " +
                    pairs(rotation(rule, forms["base"]["attack"][2:], close=True)) + "。",
                    "进入近战距离后改用刀刃，伤害提高 50%。")
        elif key == "darius":
            passive("血怒", "血怒普攻前摇 / 后摇：" + text(key) + "。", card["brief"])
        elif key in ("missfortune", "xin", "gwen"):
            name = {"missfortune": "先声夺人", "xin": "无畏战吼", "gwen": "千穿百孔"}[key]
            passive(name, "触发时普攻前摇 / 后摇 " + text(key) + "。")
        elif key == "gnar":
            passive("狂怒基因", "大纳尔前摇 / 后摇：" + text(key, "alternate") + "。")
        elif key == "jinx":
            stack = rule["structure_haste_attack_speed"]
            passive("罪恶快感", "一层时前摇 / 后摇：火箭炮 " + text(key, speed=stack) +
                    "；机枪 " + text(key, "alternate", speed=stack) + "（未叠机枪攻速）。")
        elif key == "hecarim":
            passive("毁灭冲锋", "冲锋接触时命中，前摇随突进距离变化，落地后可重新起手。")
        elif key == "ziggs":
            passive("爆破专家", "触发处决的普通投弹前摇 / 后摇 " + text(key) + "。")
        elif key == "kayn":
            passive("成长形态", "前摇 / 后摇：影流刺客 " + text(rule["growth_ranged_id"]) +
                    "，拉亚斯特 " + text(rule["growth_melee_id"]) + "。", "成长只影响后续部署。")
        elif key == "sion":
            passive("死后狂暴", "狂暴普攻前摇 / 后摇：" + text(key, "alternate") + "。", "首次致死后进入狂暴形态。")
        elif rule.get("hit_haste_max_stacks"):
            name = {"jax": "无情连打", "kayle": "登神之阶"}[key]
            rate = 1 + rule["hit_haste_max_stacks"] * rule["hit_haste_per_stack"]
            note = "满层普攻前摇 / 后摇：" + text(key, speed=rate)
            if rule.get("deployment_upgrade_id"):
                note += "（近战）；远程 " + text(rule["deployment_upgrade_id"], speed=rate)
            passive(name, note + "。")

        for sk, spec in zip(card["skills"], rule.get("active_skills", []), strict=True):
            assert sk["id"] == spec["id"]
            sk.pop("attackTiming", None)
            kind = spec["kind"]
            rate = spec.get("attack_speed_multiplier", 1)
            note = ""
            if kind in ("empowered_attack", "bleeding_execute", "channeled_attack"):
                note = empowered_text(rule, forms["base"], spec)
            elif spec.get("copy_member_buff"):
                lines = []
                for m, ability in spec["member_skills"].items():
                    buff = next(a for a in rules[m]["active_skills"] if a["id"] == ability)
                    lines.append(rules[m]["name"] + " " + text(m, speed=buff.get("attack_speed_multiplier", 1)))
                note = "强化期间前摇 / 后摇：" + "；".join(lines) + "。"
            elif kind == "attack_burst":
                note = "炮形态连续强化时前摇 / 后摇 " + pairs(phases(key, role="active_buff_attack", speed=rate)) + "。末击后攻速恢复。"
            elif kind == "timed_form":
                note = "大灭前摇 / 后摇：" + pairs(phases(key, "alternate"), ["赐死剑气", "强化一刀", "强化二刀"]) + "。"
            elif kind == "toggle_form" and forms.get("alternate"):
                note = "切换后基础前摇 / 后摇：" + text(key, "alternate") + "（机枪）；" + text(key) + "（火箭炮）。"
            elif kind == "dual_form" and forms.get("alternate"):
                note = "变大后普攻前摇 / 后摇：" + text(key, "alternate") + "。"
            elif key == "tryndamere":
                note = "满怒起手的前摇 / 后摇 " + pairs([phases(key)[-1]]) + "。"
            elif kind == "counter_strike":
                note = "技能期间普攻前摇 / 后摇 " + pairs(phases(key, role="active_buff_attack")) + "（无其他攻速加成）。"
            elif kind == "movement_strike":
                note = "突进接触时命中，所需时间随距离变化。命中后普攻前摇 / 后摇 " + text(key, speed=rate) + "。"
            elif kind == "continuous_area" and spec.get("heal_ratio") and forms:
                note = "领域期间普攻前摇 / 后摇 " + text(key) + "。"
            elif spec.get("spawn_id") in timings and (spec.get("transform_source") or spec["spawn_id"] == "daisy"):
                target = spec["spawn_id"]
                note = rules[target]["name"] + "前摇 / 后摇：" + text(target) + "。"
            elif kind == "spell_airdrop_bear":
                note = "攻速加成期间提伯斯前摇 / 后摇 " + text("tibbers", speed=rate) + "。"
            elif forms and (kind == "attack_lifesteal" or spec.get("block_attack_speed_multiplier")
                            or kind == "buff" and (rate != 1 or spec.get("damage_multiplier", 1) != 1)):
                role = "control_immune_attack" if spec.get("control_immunity") else "active_buff_attack"
                rate = spec.get("block_attack_speed_multiplier", rate)
                prefix = "成功抵挡后" if spec.get("block_attack_speed_multiplier") else "强化期间"
                timing = (pairs(phases(key, role=role, speed=rate)) if role in forms["base"]
                          else text(key, speed=rate))
                note = prefix + "普攻前摇 / 后摇：" + timing + "。"
            if note:
                sk["attackTiming"] = note
    return cards
