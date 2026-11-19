extends SceneTree
## Run against the reference Godot project with a graphics renderer.
## The single argument after -- is the output WebP file for the web battle stage.
const LAYOUT := preload("res://scripts/ui/battle_layout.gd")

func _initialize() -> void:
	call_deferred("capture")

func capture() -> void:
	var args := OS.get_cmdline_user_args()
	if args.size() != 1:
		quit(1)
		return
	var view := BattlePresentation3D.new()
	root.add_child(view)
	view.setup(LAYOUT.FIELD_SIZE, ArenaRules.TILE_SIZE)
	view.set_view_rect(LAYOUT.BACKDROP_BOUNDS)
	for i in 4:
		await RenderingServer.frame_post_draw
	var terrain := view._viewport.get_texture().get_image()
	var error := terrain.save_webp(args[0], true, 0.88)
	quit(0 if error == OK else 1)
