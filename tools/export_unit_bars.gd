extends SceneTree
## Export native form widths and resource colors from the reference project's CardDB.
func _initialize() -> void:
	var entries := {}
	for id in CardDB.all():
		var stats := CardDB.get_unit_stats(id)
		if stats.is_empty(): continue
		var base := float(stats.get("visual_radius", stats.radius))
		var entry := {"radius": base}
		if not stats.get("show_team_ring", true): entry.teamRing = false
		var other: Dictionary = stats.get("transformed_stats", {})
		if not other.is_empty():
			var alternate := float(other.get("visual_radius", other.get("radius", base)))
			if alternate != base: entry.alternate = alternate
		if stats.has("skill_resource_full_color"):
			entry.fullColor = "#" + Color(stats.skill_resource_full_color).to_html()
		entries[id] = entry
	var file := FileAccess.open(OS.get_cmdline_user_args()[0], FileAccess.WRITE)
	file.store_string(JSON.stringify(entries, "\t") + "\n")
	quit()
