extends SceneTree
## Resolve native animations, runtime-composed clips and visible form meshes in the reference checkout.
const EXISTING := ["ashe", "melee_minion", "ranged_minion", "siege_minion", "super_minion", "apex_turret", "evolution_turret", "demacian_standard", "gold_ward", "jack_in_the_box", "inhibitor", "pillar_of_ice", "powder_keg", "queen_nest", "scarecrow", "fiddlesticks", "soul_tentacle", "sun_disc", "target_dummy", "thorn_spitter", "vine_lasher", "tombstone", "void_gate"]
var folder: String
var exported := {}
var launch_bones := {}

func _initialize() -> void:
	call_deferred("run")

func run() -> void:
	folder = OS.get_cmdline_user_args()[0]
	DirAccess.make_dir_recursive_absolute(folder)
	var result := {}
	for key in CardDB.all():
		var stats := CardDB.get_unit_stats(key)
		if stats.is_empty() or key in EXISTING: continue
		var forms := [describe(key, stats, false)]
		if not stats.get("transformed_stats", {}).is_empty():
			var alternate := stats.duplicate()
			alternate.merge(stats.transformed_stats, true)
			forms.append(describe(key, alternate, true))
		result[key] = forms
	var file := FileAccess.open(folder.path_join("profiles.json"), FileAccess.WRITE)
	file.store_string(JSON.stringify(result, "\t", true, true))
	quit()

func describe(key: String, stats: Dictionary, alternate: bool) -> Dictionary:
	var scene: String = stats.visual_scene_path
	var result := {}
	for field in ["visual_forward_yaw", "visual_animations", "is_air", "first_hit", "attack_hit_times", "projectile_launch_bone"]:
		if stats.has(field): result[field] = stats[field]
	var skills := []
	for skill in stats.get("active_skills", []):
		var entry := {}
		for field in ["name", "kind", "visual_action", "resource_dependencies", "cast_duration", "impact_delay"]:
			if skill.has(field): entry[field] = skill[field]
		skills.append(entry)
	result.skills = skills
	result.asset = bake(scene, key + ("-alt" if alternate else ""), int(alternate), result.visual_animations.idle)
	if launch_bones.has(result.asset): result.hands = launch_bones[result.asset]
	var anim: Dictionary = result.visual_animations
	if anim.has("death_followup_scene_path"):
		result.followup = bake(anim.death_followup_scene_path, key + "-death", 0, anim.death_followup_animation)
	return result

func bake(path: String, key: String, form: int, idle: String) -> String:
	var cache_key := path + "#" + str(form)
	if exported.has(cache_key): return exported[cache_key]
	var node: Node3D = load(path).instantiate()
	root.add_child(node)
	if node.has_method("prepare_visual_animations"): node.prepare_visual_animations()
	if node.has_method("set_visual_form"): node.set_visual_form(form)
	if node.has_method("set_visual_clip"): node.set_visual_clip(idle)
	if node.has_method("get_attack_launch_bones") and not node.get_attack_launch_bones().is_empty():
		launch_bones[key] = Array(node.get_attack_launch_bones())
	elif node.has_method("create_projectile_anchor"):
		var anchor = node.create_projectile_anchor()
		if anchor is BoneAttachment3D:
			var bone: String = anchor.bone_name
			if bone.is_empty() and anchor.bone_idx >= 0 and anchor.get_parent() is Skeleton3D:
				bone = anchor.get_parent().get_bone_name(anchor.bone_idx)
			if not bone.is_empty(): launch_bones[key] = [bone]
			anchor.free()
	if "--metadata" in OS.get_cmdline_user_args() and FileAccess.file_exists(folder.path_join(key + ".glb")):
		node.free()
		exported[cache_key] = key
		return key
	for mesh: MeshInstance3D in node.find_children("*", "MeshInstance3D", true, false):
		if not mesh.is_visible_in_tree() or mesh.mesh == null:
			mesh.free()
			continue
		for i in mesh.mesh.get_surface_count():
			var material := mesh.get_active_material(i) as ShaderMaterial
			if material == null: continue
			var base := StandardMaterial3D.new()
			for uniform in material.shader.get_shader_uniform_list():
				if uniform.name in ["base_texture","albedo_texture","diffuse_texture"]:
					base.albedo_texture = material.get_shader_parameter(uniform.name)
					break
			if material.shader.resource_path.ends_with("cape.gdshader"):
				var flow := Image.load_from_file("res://assets/units/yorick/cape_flow.png")
				var color := Image.load_from_file("res://assets/units/yorick/cape_color.png")
				color.resize(flow.get_width(), flow.get_height(), Image.INTERPOLATE_BILINEAR)
				for y in flow.get_height():
					for x in flow.get_width(): flow.set_pixel(x, y, flow.get_pixel(x,y) * color.get_pixel(x,y))
				base.albedo_texture = ImageTexture.create_from_image(flow)
				base.resource_name = "Yorick_Cape"
			elif material.shader.resource_path.ends_with("exalted_wings.gdshader"):
				var wing := base.albedo_texture.get_image()
				if wing.is_compressed(): wing.decompress()
				wing.convert(Image.FORMAT_RGBA8)
				var gradient := Image.load_from_file("res://assets/units/kayle/source/wing_16_gradient.png")
				for y in wing.get_height():
					for x in wing.get_width():
						var pixel := wing.get_pixel(x,y)
						var gold := gradient.get_pixel(clampi(roundi((1.0-pixel.get_luminance())*(gradient.get_width()-1)),0,gradient.get_width()-1), floori(gradient.get_height()*0.0625))
						gold.a = pixel.a
						wing.set_pixel(x,y,gold)
				base.albedo_texture = ImageTexture.create_from_image(wing)
			base.cull_mode = BaseMaterial3D.CULL_DISABLED
			base.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
			base.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA_SCISSOR
			if base.resource_name == "Yorick_Cape": base.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
			mesh.set_surface_override_material(i, base)
	var state := GLTFState.new()
	var document := GLTFDocument.new()
	var err := document.append_from_scene(node, state)
	if err == OK: err = document.write_to_filesystem(state, folder.path_join(key + ".glb"))
	if err != OK:
		push_error("Cannot export " + path)
		quit(1)
	node.free()
	exported[cache_key] = key
	return key
