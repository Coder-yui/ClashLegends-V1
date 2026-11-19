//! Rule-backed unit skills and their owner-local state.
use super::units::{stat, ticks};
use crate::{
    timeline::Origin, vitals::Change, Actor, Battle, Control, Effect, Id, Point, Role, Skill,
};
use serde_json::Value;

pub(super) fn carried(s: &'static Value) -> Skill {
    Skill {
        aim: crate::AimKind::Instant,
        shape: crate::Shape::Circle { radius: 0. },
        cast_range: 0.,
        cooldown: ticks(stat(s, "cooldown", 0.)).max(1),
        effects: vec![Effect::CardAbility(s)],
    }
}

#[derive(Default, Debug, Clone)]
pub(crate) struct State {
    pub(crate) equipped_skill: Option<&'static str>,
    pub(crate) conversion: Option<(u64, Id, crate::Team, &'static Value)>,
    pub(crate) channel: Option<(u64, Id)>,
    pub(crate) rage_until: u64,
    pub(crate) free_execute: bool,
    pub(crate) bleed: std::collections::BTreeMap<Id, super::marks::Bleed>,
    pub(crate) sweep: Option<super::maneuvers::Sweep>,
    pub(crate) prepared_charge: Option<&'static Value>,
    pub(crate) last_step: Option<Point>,
    pub(crate) marched: f64,
    pub(crate) rush_used: bool,
    pub(crate) landing_due: Option<u64>,
    pub(crate) in_terrain: bool,
    pub(crate) entry: Option<(u64, u64)>,
    pub(crate) entry_hits: std::collections::BTreeSet<Id>,
    pub(crate) forged: f64,
    pub(crate) forge_due: Option<u64>,
    pub(crate) cast_heading: Option<(u64, Point)>,
    growth: Option<(u64, i32, f64)>,
    pub(crate) aura_until: u64,
    pub(crate) death_spawn: Option<(u64, &'static str)>,
    reduction: Option<(u64, f64, &'static Value)>,
    pub(crate) on_block: Option<&'static Value>,
    pub(crate) dormant: bool,
    pub(crate) aura_attack: u16,
    pub(crate) first_targets: std::collections::BTreeSet<Id>,
    pub(crate) owner_gold_at: Option<u64>,
    pub(crate) swing: u32,
    pub(crate) empowered: Option<(&'static Value, u8)>,
    pub(crate) lifesteal: Option<(u64, f64, f64)>,
    pub(crate) immunity: u64,
    pub(crate) cast_start: u64,
    pub(crate) impact_tick: u64,
    pub(crate) cast_end: u64,
    pub(crate) attack_lock: u64,
    pub(crate) move_lock: u64,
    pub(crate) ranged_base: Option<(u64, f64, crate::Action, crate::Weapon)>,
    pub(crate) last_combat: u64,
    pub(crate) use_number: u32,
    pub(crate) burst: Option<(u64, u8, f64)>,
    pub(crate) resource: f64,
    pub(crate) cast_resource: f64,
    pub(crate) snip_heal: i32,
    pub(crate) resource_updated: u64,
    pub(crate) history: std::collections::VecDeque<(u64, Point)>,
    pub(crate) repeat_hits: std::collections::BTreeMap<Id, u8>,
    pub(crate) rewind: Option<Point>,
    pub(crate) untargetable: u64,
    pub(crate) undying: u64,
    pub(crate) counter: Option<(u64, u8, &'static Value)>,
    pub(crate) heal_cycle: Option<u64>,
    pub(crate) base_key: Option<&'static str>,
    pub(crate) changed_form: bool,
    pub(crate) visual_action: Option<(&'static str, u64, u64)>,
    pub(crate) last_visual_form: Option<(u64, u32, bool)>,
    pub(crate) form_hits: u32,
    pub(crate) form_due: u64,
    pub(crate) hit_haste: Option<(u64, u8, u16)>,
    pub(crate) structure_hits: std::collections::BTreeMap<Id, u64>,
    pub(crate) blast_ratio: f64,
    pub(crate) skip_reward: bool,
    pub(crate) permanent_growth: bool,
    pub(crate) production_due: Option<u64>,
    pub(crate) wave: usize,
    pub(crate) pending_births: Vec<super::production::Birth>,
    pub(crate) buff_spec: Option<&'static Value>,
}
impl Actor {
    pub(crate) fn reduction(&self, tick: u64) -> f64 {
        self.card_state
            .reduction
            .filter(|r| tick < r.0)
            .map_or(0., |r| r.1)
            .max(if self.shields.has_deployment() {
                self.def
                    .rules
                    .map_or(0., |s| stat(s, "deployment_shield_reduction", 0.))
            } else {
                0.
            })
    }
}
impl Battle {
    pub(super) fn ability_impact(
        &mut self,
        ctx: Origin,
        s: &'static Value,
        changes: &mut Vec<Change>,
    ) {
        let tick = self.tick;
        let Some(a) = self.actors.get_mut(&ctx.caster) else {
            return;
        };
        let duration = u64::from(ticks(stat(s, "duration", 0.)));
        match s["kind"].as_str().unwrap() {
            "movement_strike" => {
                a.card_state.prepared_charge = Some(s);
                a.reset_attack();
            }
            "terrain_charge" => {
                self.card_queue.push(super::casts::Pending {
                    ctx,
                    spec: s,
                    due: tick + u64::from(ticks(stat(s, "charge_prepare_time", 0.35))),
                    stage: super::casts::Stage::Charge(None, super::maneuvers::Kind::Terrain),
                });
            }
            "dash_strike" => self.start_sweep(ctx, s, super::maneuvers::Kind::Slash, None),
            "bleeding_execute" | "channeled_attack" => {
                a.card_state.empowered = Some((s, 1));
                a.reset_attack();
            }
            "undying_rage" => {
                a.card_state.undying = tick + duration;
                a.card_state.resource = a
                    .def
                    .rules
                    .map_or(0., |r| stat(r, "skill_resource_max", 0.));
                a.reset_attack();
            }
            "counter_strike" => {
                a.card_state.counter = Some((tick + duration, 0, s));
            }
            "permanent_growth" => {
                self.grow_ally(ctx.caster, s);
            }
            "sanctuary" => {
                a.sanctuary = Some(crate::status::Sanctuary {
                    center: a.pos,
                    radius: stat(s, "radius", 0.),
                    until: tick + duration,
                });
            }
            "rewind_nova" => {
                let pos = a.card_state.rewind.take().unwrap_or(a.pos);
                let blocks = crate::movement::blockers(&self.actors);
                let a = self.actors.get_mut(&ctx.caster).unwrap();
                let q = crate::movement::query(&self.map, &blocks, a);
                if let Some(p) = q.nearest(pos, if a.team == crate::Team::Blue { -1. } else { 1. })
                {
                    a.pos = p;
                    a.route_goal = None;
                    a.flight = None;
                }
                let ctx = Origin {
                    origin: a.pos,
                    source_pos: a.pos,
                    ..ctx
                };
                self.nova(ctx, s, changes);
            }
            "timed_form" | "toggle_form" => {
                self.switch_card_form(ctx.caster, true);
            }
            "dual_form" => {
                self.frontal(ctx, s, changes);
            }
            "attack_burst" => {
                if a.card_state.changed_form {
                    let period = ticks(stat(s, "tick_interval", 0.5));
                    self.card_queue.push(super::casts::Pending {
                        ctx,
                        spec: s,
                        due: tick + u64::from(period),
                        stage: super::casts::Stage::Pulse(duration as u32 / period),
                    });
                } else {
                    a.card_state.burst = Some((
                        tick + duration,
                        stat(s, "attack_count", 1.) as u8,
                        stat(s, "attack_speed_multiplier", 1.),
                    ));
                    a.reset_attack();
                }
            }
            "blink_nova" => {
                let extension = stat(s, "landing_extension", 0.) + a.def.radius + 2.;
                if let Ok(pos) = self.resolve_motion(
                    ctx.caster,
                    ctx.origin,
                    ctx.direction,
                    crate::Motion::Blink {
                        distance: stat(s, "length", 0.),
                        extension,
                    },
                    tick,
                ) {
                    self.nova(
                        Origin {
                            origin: pos,
                            source_pos: pos,
                            ..ctx
                        },
                        s,
                        changes,
                    );
                }
            }
            "sacrifice_empower" => {
                if a.card_state.permanent_growth {
                    return;
                }
                a.card_state.permanent_growth = true;
                let bonus =
                    (f64::from(a.def.hp) * stat(s, "health_bonus_ratio", 0.)).round() as i32;
                a.def.hp += bonus;
                a.hp += bonus;
                a.def.radius *= stat(s, "body_scale_multiplier", 1.);
                a.empowerment = Some(crate::status::Empowerment {
                    until: u64::MAX,
                    damage: (1000. * stat(s, "damage_multiplier", 1.)).round() as u16,
                    movement: (1000. * stat(s, "speed_multiplier", 1.)).round() as u16,
                    attack: 1000,
                });
            }
            "self_sacrifice" | "detonate" => {
                a.card_state.blast_ratio = stat(s, "execute_health_ratio", 0.);
                a.card_state.skip_reward = true;
                a.hp = 0;
            }
            "explosive_shield" => {
                a.shields.explosive(
                    stat(s, "shield", 0.) as i32,
                    tick + u64::from(ticks(stat(s, "shield_duration", 0.))),
                    s,
                );
            }
            "nova" => self.nova(ctx, s, changes),
            "continuous_area" => {
                if let Some(rate) = s["heal_ratio"].as_f64() {
                    a.card_state.lifesteal = Some((tick + duration, rate, 1.));
                }
                let period = ticks(stat(s, "tick_interval", 1.));
                self.card_queue.push(super::casts::Pending {
                    ctx,
                    spec: s,
                    due: tick + u64::from(period),
                    stage: super::casts::Stage::Pulse(duration as u32 / period),
                });
            }
            "frontal" => self.frontal(ctx, s, changes),
            "summon" => {
                if s["transform_source"] == true {
                    self.switch_card_form(ctx.caster, true);
                }
                if s["sacrifice_source"] == true {
                    self.actors.get_mut(&ctx.caster).unwrap().hp = 0;
                }

                let count = stat(s, "spawn_count", 1.) as u8;
                let period = ticks(stat(s, "spawn_sequence_interval", 0.));
                for i in 0..count {
                    if i == 0 || period == 0 {
                        self.summon_member(ctx, s, i);
                    } else {
                        self.card_queue.push(super::casts::Pending {
                            ctx,
                            spec: s,
                            due: tick + u64::from(i) * u64::from(period),
                            stage: super::casts::Stage::Spawn(i),
                        });
                    }
                }
            }
            "dash" => {
                let length = stat(s, "length", 0.);
                let dir = ctx.direction * if s["dash_backward"] == true { -1. } else { 1. };
                let extension = stat(s, "landing_extension", 0.) + a.def.radius + 2.;
                a.rounds = a
                    .rounds
                    .saturating_add(stat(s, "ammo_restore", 0.) as u8)
                    .min(a.def.weapon.magazine);
                a.reload_left = 0;
                let _ = self.resolve_motion(
                    ctx.caster,
                    ctx.origin,
                    dir,
                    crate::Motion::Dash {
                        distance: length,
                        speed: length / stat(s, "cast_duration", 0.4),
                        extension,
                    },
                    tick,
                );
            }
            "attack_lifesteal" => {
                a.card_state.lifesteal = Some((
                    u64::MAX,
                    stat(s, "heal_ratio", 0.),
                    stat(s, "max_health_ratio", 1.),
                ));
            }
            "empowered_attack" => {
                a.card_state.empowered = Some((s, stat(s, "attack_count", 1.) as u8));
                a.reset_attack();
            }
            "buff" => {
                a.card_state.buff_spec = Some(s);
                if s["control_immunity"] == true {
                    a.card_state.immunity = tick + duration;
                    if s["cleanse_controls"] == true {
                        a.controls = Default::default();
                        a.slows = Default::default();
                    }
                }
                if s.get("shield").is_some() {
                    a.shields.add(
                        stat(s, "shield", 0.) as i32,
                        tick + u64::from(ticks(stat(s, "shield_duration", 0.))),
                    );
                }
                if s.get("heal_ratio").is_some() {
                    a.card_state.lifesteal = Some((tick + duration, stat(s, "heal_ratio", 0.), 1.));
                }
                if s["piercing_attacks"] == true {
                    let (_, range, action, weapon) = a.card_state.ranged_base.unwrap_or((
                        0,
                        a.def.range,
                        a.def.action,
                        a.def.weapon,
                    ));
                    a.card_state.ranged_base = Some((tick + duration, range, action, weapon));
                    a.def.range = range + stat(s, "range_bonus", 0.);
                    if let crate::Action::Shot {
                        damage,
                        windup,
                        interval,
                        speed,
                    } = action
                    {
                        a.def.action = crate::Action::Shot {
                            damage,
                            windup,
                            interval,
                            speed: speed * stat(s, "projectile_speed_multiplier", 1.),
                        };
                        a.def.weapon.delivery = crate::Delivery::Line {
                            count: 1,
                            degrees: 0.,
                            distance: stat(s, "piercing_distance", range),
                            pierce: true,
                            returns: false,
                        };
                    }
                }
                if s.get("heal_amount").is_some() {
                    changes.push(Change::new(a.id, a.id, stat(s, "heal_amount", 0.) as i32));
                }
                if s["untargetable"] == true {
                    a.card_state.untargetable = tick + duration;
                }
                if duration > 0 {
                    a.card_state.aura_until = tick + duration;
                    a.empowerment = Some(crate::status::Empowerment {
                        movement: (1000. * stat(s, "speed_multiplier", 1.)).round() as u16,
                        damage: (1000. * stat(s, "damage_multiplier", 1.)).round() as u16,
                        attack: (1000. * stat(s, "attack_speed_multiplier", 1.)).round() as u16,
                        until: tick + duration,
                    });
                    if let Some(ratio) = s["health_bonus_ratio"].as_f64() {
                        let (_, old_hp, old_radius) =
                            a.card_state.growth.unwrap_or((0, a.def.hp, a.def.radius));
                        let hp = (f64::from(old_hp) * (1. + ratio)).round() as i32;
                        a.hp += (hp - a.def.hp).max(0);
                        a.def.hp = hp;
                        a.def.radius = old_radius * stat(s, "body_scale_multiplier", 1.);
                        a.card_state.growth = Some((tick + duration, old_hp, old_radius));
                        a.route_goal = None;
                    }
                }
            }
            "death_spawn" => {
                a.card_state.death_spawn = Some((tick + duration, s["spawn_id"].as_str().unwrap()));
            }
            "restoration_shield" => {
                a.shields.restoration(
                    stat(s, "shield", 0.) as i32,
                    tick + u64::from(ticks(stat(s, "shield_duration", 0.))),
                );
            }
            "effect_shield" => {
                a.card_state.visual_action = Some(("effect_shield:start", tick, tick + 10));
                a.effect_shield_until = tick + duration;
                a.card_state.on_block = Some(s);
            }
            "self_stasis" => {
                let _ = self.apply_control(
                    ctx.caster,
                    Control::Stasis,
                    ctx.caster,
                    duration as u32,
                    tick,
                );
            }
            "aftershock" => {
                a.card_state.reduction =
                    Some((tick + duration, stat(s, "damage_reduction", 0.), s));
            }
            "area_shield" => {
                let radius = a.def.radius + stat(s, "radius", 0.);
                let ids: Vec<_> = self
                    .actors
                    .values()
                    .filter(|b| {
                        crate::targeting::Body::from(*b).allows(ctx.team, ctx.source_pos)
                            && (b.pos - ctx.origin).length() <= radius + b.def.radius
                    })
                    .map(|b| b.id)
                    .collect();
                for id in ids {
                    let b = &self.actors[&id];
                    if b.team == ctx.team {
                        self.actors.get_mut(&id).unwrap().shields.add(
                            stat(s, "shield", 0.) as i32,
                            tick + u64::from(ticks(stat(s, "shield_duration", 0.))),
                        );
                    } else if b.def.role == Role::Troop
                        && s.get("slow_duration").is_some()
                        && !self.consume_effect_shield(id)
                    {
                        self.actors.get_mut(&id).unwrap().slows.apply(
                            ctx.caster,
                            (stat(s, "slow_multiplier", 1.) * 1000.).round() as u16,
                            1000,
                            tick + u64::from(ticks(stat(s, "slow_duration", 0.))),
                        );
                    }
                }
            }
            _ => unreachable!("unregistered card skill"),
        }
    }
    pub(crate) fn advance_card_states(&mut self) {
        let channels: Vec<_> = self
            .actors
            .values()
            .filter_map(|a| {
                a.card_state
                    .channel
                    .filter(|(until, target)| {
                        *until <= self.tick
                            || a.disabled()
                            || a.has(Control::Silence)
                            || a.has(Control::Taunt)
                            || !self.actors.contains_key(target)
                    })
                    .map(|(_, target)| (a.id, target))
            })
            .collect();
        for (source, target) in channels {
            let a = self.actors.get_mut(&source).unwrap();
            a.card_state.channel = None;
            a.card_state.attack_lock = 0;
            a.card_state.move_lock = 0;
            let _ = self.remove_control(target, Control::Stun, source);
        }
        let mut bursts = vec![];
        let mut counters = vec![];
        for a in self.actors.values_mut() {
            if a.card_state
                .burst
                .is_some_and(|(until, charges, _)| until <= self.tick || charges == 0)
            {
                a.card_state.burst = None;
            }
            if let Some(delay) = a.def.rules.and_then(|s| s["stealth_delay"].as_f64()) {
                if a.disabled()
                    || !a.controls.types().is_empty()
                    || a.slows.rates() != (1000, 1000)
                    || a.release_at.is_some()
                    || a.card_state.cast_end > self.tick
                {
                    a.card_state.last_combat = self.tick;
                } else if self.tick.saturating_sub(a.card_state.last_combat)
                    >= u64::from(ticks(delay))
                {
                    a.hidden_until = u64::MAX;
                }
            }
            if a.card_state.undying <= self.tick {
                a.card_state.undying = 0;
            }
            if a.card_state.untargetable <= self.tick {
                a.card_state.untargetable = 0;
            }
            if let Some((until, dodges, s)) = a.card_state.counter {
                if until <= self.tick {
                    a.card_state.counter = None;
                    if !a.has(Control::Stasis) {
                        counters.push((
                            Origin {
                                caster: a.id,
                                team: a.team,
                                origin: a.pos,
                                source_pos: a.pos,
                                direction: a.facing,
                            },
                            s,
                            dodges,
                        ));
                    }
                }
            }
            if a.card_state
                .lifesteal
                .is_some_and(|(until, _, _)| until <= self.tick)
            {
                a.card_state.lifesteal = None;
            }
            if a.card_state.aura_until <= self.tick {
                a.card_state.buff_spec = None;
            }
            if let Some((until, range, action, weapon)) = a.card_state.ranged_base {
                if until <= self.tick {
                    a.def.range = range;
                    a.def.action = action;
                    a.def.weapon = weapon;
                    a.card_state.ranged_base = None;
                }
            }
            if let Some((until, hp, radius)) = a.card_state.growth {
                if until <= self.tick {
                    a.def.hp = hp;
                    a.hp = a.hp.min(hp);
                    a.def.radius = radius;
                    a.card_state.growth = None;
                    a.route_goal = None;
                }
            }
            if let Some((due, _, s)) = a.card_state.reduction {
                if due <= self.tick {
                    bursts.push((a.id, a.team, a.pos, s));
                    a.card_state.reduction = None;
                }
            }
        }
        let mut changes = vec![];
        for (ctx, s, count) in counters {
            self.nova_scaled(
                ctx,
                s,
                1. + f64::from(count) * stat(s, "damage_per_dodge", 0.),
                &mut changes,
            );
        }
        for (id, team, pos, s) in bursts {
            self.resolve_effects(
                Origin {
                    caster: id,
                    team,
                    origin: pos,
                    source_pos: pos,
                    direction: Point::new(0., 1.),
                },
                crate::Shape::Circle {
                    radius: stat(s, "radius", 0.),
                },
                &[Effect::Damage(stat(s, "damage", 0.) as i32)],
                &mut changes,
            );
        }
        if !changes.is_empty() {
            self.commit(changes);
        }
        self.update_building_auras();
    }
    fn update_building_auras(&mut self) {
        let mut fields = vec![];
        let mut turrets = vec![];
        for a in self.actors.values_mut() {
            a.card_state.aura_attack = 1000;
            let Some(s) = a.def.rules else {
                continue;
            };
            if a.ready_tick > self.tick || a.has(Control::Stasis) {
                continue;
            }
            if s["dormant_without_targets"] == true {
                turrets.push(a.id);
            }
            if s.get("haste_aura_radius").is_some() || s.get("debuff_aura_radius").is_some() {
                fields.push((a.id, a.team, a.pos, s, a.card_state.aura_until > self.tick));
            }
        }
        for id in turrets {
            let a = &self.actors[&id];
            let dormant = !self.actors.values().any(|b| {
                b.id != id
                    && crate::targeting::Body::from(b).eligible(a)
                    && (a.pos - b.pos).length() <= a.def.range + a.def.radius + b.def.radius
            });
            self.actors.get_mut(&id).unwrap().card_state.dormant = dormant;
        }
        for (id, team, pos, s, enhanced) in fields {
            let haste = s.get("haste_aura_radius").is_some();
            let radius = if haste {
                stat(s, "haste_aura_radius", 0.)
            } else if enhanced {
                stat(s, "debuff_aura_active_radius", 0.)
            } else {
                stat(s, "debuff_aura_radius", 0.)
            };
            for b in self.actors.values_mut() {
                if b.id == id
                    || (b.team == team) != haste
                    || !matches!(b.def.role, Role::Troop | Role::Building)
                    || !crate::targeting::Body::from(&*b).allows(team, pos)
                    || (b.pos - pos).length() > radius + b.def.radius
                {
                    continue;
                }
                if haste {
                    b.card_state.aura_attack = b
                        .card_state
                        .aura_attack
                        .max((1000. * stat(s, "haste_aura_multiplier", 1.)).round() as u16);
                } else {
                    b.slows.apply(
                        id,
                        (1000. * stat(s, "debuff_aura_move_multiplier", 1.)).round() as u16,
                        (1000. * stat(s, "debuff_aura_attack_multiplier", 1.)).round() as u16,
                        self.tick + 1,
                    );
                }
            }
        }
    }
}
