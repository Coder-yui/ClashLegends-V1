extends SceneTree
## Run against the reference Godot project. Only its evaluated gameplay domain
## is exported. The standalone Rust match server reads the checked-in result.
func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	if args.size() != 2:
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
	for script in CardDB.DEFINITIONS:
		var key := String(script.resource_path).get_file().get_basename()
		var rules: Dictionary = script.definition().gameplay.duplicate(true)
		rules.erase("description")
		for skill in rules.get("active_skills", []):
			skill.erase("description")
			if ids.has(key):
				if not ids[key].has(skill.name):
					push_error("No catalog skill ID for %s / %s" % [key, skill.name])
					quit(1)
					return
				skill.id = ids[key][skill.name]
		cards[key] = portable(rules)
	for card in cards.values():
		for skill in card.get("active_skills", []):
			if skill.get("kind") == "buff" and skill.get("target_scope") == "deployment_group" and card.has("spawn_plan"):
				skill.member_skills = {}
				for member in card.spawn_plan.members:
					skill.member_skills[member] = ids[member][skill.name]
	# These alternate deployments carry their parent card’s chosen ability.
	for pair in [["kayle_ranged","kayle"],["kayn_assassin","kayn"],["kayn_slayer","kayn"]]:
		for skill in cards[pair[0]].active_skills:
			skill.id = ids[pair[1]][skill.name]
	var file := FileAccess.open(args[0], FileAccess.WRITE)
	if file == null:
		quit(1)
		return
	file.store_string(JSON.stringify(cards, "\t", true, true) + "\n")
	print("Exported ", cards.size(), " evaluated gameplay definitions")
	quit()

func portable(value: Variant) -> Variant:
	match typeof(value):
		TYPE_DICTIONARY:
			var out := {}
			for key in value: out[key] = portable(value[key])
			return out
		TYPE_ARRAY:
			var out := []
			for item in value: out.append(portable(item))
			return out
		TYPE_VECTOR2, TYPE_VECTOR2I:
			return [value.x, value.y]
		_: return value
