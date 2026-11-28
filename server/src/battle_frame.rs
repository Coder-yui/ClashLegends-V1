//! Public frame fields are projected once per seat. Each connection supplies its own delivery cursor.
use super::*;
pub(super) const PROTOCOL: u32 = 3;

pub(super) struct SeatFrame {
    world: Value,
    pub history: presentation::History,
}
impl SeatFrame {
    pub fn pending(&self) -> bool {
        self.world["started"] == false
    }
    pub fn new(sim: &Simulation, seat: usize, started: bool) -> Self {
        Self {
            world: field_frame(
                &sim.game,
                &sim.views[seat],
                seat,
                started,
                &sim.streams[seat],
            ),
            history: sim.streams[seat].history(),
        }
    }
    #[cfg(test)]
    pub fn full_window_bytes(&mut self, history: Value) -> usize {
        self.world["presentation"] = history;
        self.world.to_string().len()
    }
    pub fn encode(&self, delivered: Option<u64>) -> String {
        #[derive(Serialize)]
        struct Packet<'a> {
            #[serde(flatten)]
            world: &'a Value,
            presentation: presentation::Window<'a>,
        }
        serde_json::to_string(&Packet {
            world: &self.world,
            presentation: self.history.since(delivered),
        })
        .expect("JSON battle frame")
    }
}

pub(super) fn field_frame(
    game: &ClassicMatch,
    view: &MatchView,
    seat: usize,
    started: bool,
    stream: &presentation::Stream,
) -> Value {
    let hand = &view.own;
    let map = clash_battle_core::classic::maps()
        .iter()
        .find(|m| m.id == game.map().id)
        .unwrap();
    let map = json!({
        "id": map.id, "width": map.width, "height": map.height, "tile": map.tile,
        "terrain": map.terrain, "projection": map.projection, "backMargin": map.back_margin,
        "backdropWidth": map.backdrop_width, "obstacles": map.obstacles,
    });
    let ruins = game
        .ruined_towers()
        .map(|(id, team, p)| json!({"id":id, "team":team.index(), "x":p.x, "y":p.y}));
    json!({
        "type": "frame", "protocol": PROTOCOL, "started": started, "tick": game.tick(),
        "map": map, "ruinedTowers": ruins.collect::<Vec<_>>(), "deployment": game.deployment_regions_for(seat),
        "remaining": view.remaining_ticks, "overtime": view.overtime,
        "result": view.result.map(|o| outcome(o, game.tick())),
        "units": view.field.units.iter().map(unit).collect::<Vec<_>>(),
        "shots": view.field.projectiles.iter().map(shot).collect::<Vec<_>>(),
        "effectPaths": view.field.effect_paths, "areas": view.field.areas, "waves": view.field.waves, "summons": view.field.summons,
        "spells": game.spell_views().collect::<Vec<_>>(), "soundLayers": stream.layers(),
        "pending": game.pending_for(seat).collect::<Vec<_>>(), "ack": hand.acknowledged,
        "hand": hand.hand, "handForms": game.hand_forms_for(seat), "costs": hand.costs, "lastCard": hand.last, "activeCards": hand.active_keys,
        "next": hand.next, "nextCost": hand.next_cost, "gold": hand.gold, "version": hand.version,
        "skillResource": view.skill_resource, "activeWait": view.active_wait, "activeCost": view.active_cost,
        "active": hand.active.map(|a| a.map(|v| json!({"caster":v.caster, "uses":v.uses}))),
        "buttons": view.buttons.each_ref().map(|b| b.as_ref().map(|b| json!({
            "locked":b.locked, "cooldownLeft":b.cooldown_left, "cooldownTotal":b.cooldown_total, "freeRecast":b.free_recast
        }))),
    })
}
fn unit(u: &clash_battle_core::UnitView) -> Value {
    json!({
        "id":u.id, "kind":u.kind, "name":u.name, "audioKind":u.audio_kind, "team":u.team.index(),
        "x":u.position.x, "y":u.position.y, "facing":u.facing, "target":u.target, "radius":u.radius,
        "hp":u.hp, "maxHp":u.max_hp, "shield":u.shield, "bar":u.bar, "structure":u.structure,
        "footprint":u.footprint, "air":u.air, "inFlight":u.in_flight,
        "movementRate":u.movement_rate, "controls":u.controls, "hidden":u.hidden, "dormant":u.dormant,
        "frozen":u.controls.contains(&clash_battle_core::Control::Freeze),
        "visual":u.visual, "alternateForm":u.form_changed, "activity":u.activity, "attack":u.attack,
        "actionSerial":u.action_serial, "since":u.since, "readyTick":u.ready_tick, "deployStart":u.deploy_start,
        "skill":u.skill, "impactTick":u.impact_tick, "castStart":u.cast_start, "castEnd":u.cast_end,
    })
}
fn shot(p: &clash_battle_core::Projectile) -> Value {
    use clash_battle_core::Trajectory;
    let direction = match &p.trajectory {
        Trajectory::Line { direction, .. } | Trajectory::Ground { direction, .. } => {
            Some(direction)
        }
        _ => None,
    };
    let bounce = match &p.trajectory {
        Trajectory::Ground { bounces, .. }
            if p.source_kind == "ziggs" && p.attack_sound.empowered =>
        {
            3_u8.saturating_sub(*bounces)
        }
        _ => 0,
    };
    json!({
        "bounce":bounce,"id":p.id, "born":p.born, "sourceKind":p.source_kind, "team":p.team.index(),
        "owner":p.owner, "target":p.target, "origin":p.origin, "position":p.position, "direction":direction,
        "cycle":p.attack_sound.cycle, "empowered":p.attack_sound.empowered, "form":p.attack_sound.form,
        "volley":p.volley.is_some(), "group":p.volley, "action":p.cast_action,
    })
}
