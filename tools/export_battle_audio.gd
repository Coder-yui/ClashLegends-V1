extends SceneTree
## Run under the reference project so inheritance, team overrides and forms match the game.
func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	if args.size() != 1:
		quit(1)
		return
	var profiles := {}
	var actions := {}
	for id in CardDB.all():
		var stats := CardDB.get_card(id)
		for form in range(2 if stats.has("transformed_stats") else 1):
			for skill in PresentationConfig.for_form(stats, form).get("active_skills", []):
				var action := {}
				for field in ["visual_action", "resource_visual_actions", "visual_actions_by_use", "full_resource_visual_action"]:
					if skill.has(field): action[field] = skill[field]
				if not action.is_empty(): actions["%s/%s/%s" % [id, form, skill.name]] = action
			for team in range(2):
				var audio := PresentationConfig.audio_for(stats, team, form)
				profiles["%s/%s/%s" % [id, form, team]] = audio
	for team in range(2):
		for structure in ["tower", "nexus"]:
			var key := "world_%s_%s" % [structure, "order" if team == 0 else "chaos"]
			var kind := "princess_tower" if structure == "tower" else "nexus"
			profiles["%s/0/%s" % [kind, team]] = PresentationConfig.audio_for(PresentationConfig.audio_stats(key), team)
	profiles["match/0/0"] = {"events": preload("res://scripts/data/match_audio.gd").EVENTS}
	var out := FileAccess.open(args[0], FileAccess.WRITE)
	if out == null:
		quit(1)
		return
	out.store_string(JSON.stringify({"profiles": profiles, "actions": actions}))
	quit()
