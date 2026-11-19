extends SceneTree
## Run with --path pointing to the reference game; pass the output JSON, portrait output directory and V1 catalog JSON after --.
func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	if args.size() != 3:
		quit(1)
		return
	# Last argument is V1's public catalog. Resolve legacy names once at import.
	var ids := {}
	var catalog: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(args[-1]))
	for card in catalog.cards:
		ids[card.id] = {}
		for skill in card.skills:
			ids[card.id][skill.name] = skill.id
	var cards := {}
	for key in CardDB.selectable_ids():
		var stats := CardDB.get_card(key)
		var sections := [{"title": "属性", "attributes": CardDetails.attributes(stats)}]
		for member in CardDetails.deployment_member_sections(stats):
			sections.append({"title": "%s ×%d（每只）" % [member.name, member.count], "attributes": member.attributes})
		var upgrade := CardDB.get_unit_stats(String(stats.get("deployment_upgrade_id", "")))
		if not upgrade.is_empty():
			sections.append({"title": "%s（%d金币部署）" % [upgrade.name, upgrade.cost], "attributes": CardDetails.attributes(upgrade)})
		var transformed: Dictionary = stats.get("transformed_stats", {})
		if not transformed.is_empty() and not preload("res://scripts/ui/workbench/card_catalog.gd").is_summon_spent_state(stats):
			sections.append({"title": "%s（变形后）" % transformed.name, "attributes": CardDetails.attributes(transformed)})
		var spawn := CardDB.get_unit_stats(String(stats.get("spawn_id", "")))
		if float(stats.get("spawn_interval", 0)) > 0 and not spawn.is_empty():
			var count := int(stats.get("spawn_count", 1))
			sections.append({"title": "召唤物：%s（每批 %d 只）" % [spawn.name,count], "attributes": CardDetails.attributes(spawn, "%d /批" % count)})
		var choices := []
		for skill in CardDB.active_skills_for(key):
			if not ids.get(key, {}).has(skill.name):
				push_error("No catalog skill ID for %s / %s" % [key, skill.name])
				quit(1)
				return
			choices.append({
				"id": ids[key][skill.name],
				"description": CardDetails.active_choice_description(key, choices.size()),
				"cost": skill.get("cost", 0), "costByUse": skill.get("cost_by_use", []),
				"uses": skill.get("max_uses", 1), "unlimited": skill.get("unlimited_uses", false),
				"group": String(skill.get("target_scope", "self")) == "deployment_group",
				"cooldown": skill.get("cooldown", 0)
			})
		var color: Color = stats.get("color", CardArt.DEFAULT_ACCENT)
		cards[key] = {"type": CardDetails.type_name(stats.type, stats), "air": stats.get("is_air",false),
			"color": "#" + color.to_html(false), "brief": CardDetails.brief_description(stats),
			"sections": sections, "passives": CardDetails.passives(stats), "skills": choices}
		if choices.is_empty():
			cards[key].activeDescription = CardDetails.active_choice_description(key)
		if stats.has("skill_resource_full_color"):
			var full_color: Color = stats.skill_resource_full_color
			cards[key].resourceColor = "#" + full_color.to_html()
		var art_path := String(stats.get("card_art", {}).get("path", ""))
		if art_path.ends_with(".tres"):
			var atlas := load(art_path) as AtlasTexture
			if atlas != null:
				var source := Image.load_from_file(atlas.atlas.resource_path)
				var name := String(key) + ".webp"
				if source.is_empty() or source.get_region(Rect2i(atlas.region)).save_webp(args[1].path_join(name), true, 0.86) != OK:
					quit(1)
					return
				cards[key].portrait = "/play/media/preparation/" + name
	var file := FileAccess.open(args[0], FileAccess.WRITE)
	if file == null:
		quit(1)
		return
	file.store_string(JSON.stringify(cards) + "\n")
	quit()
