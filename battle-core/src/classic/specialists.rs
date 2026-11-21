//! Automatic actions use the same target visibility, control and movement
//! queries as a player's command. A prepared rush reserves its action window.
use super::{
    casts::{Pending, Stage},
    maneuvers::Kind,
    units::{stat, ticks},
};
use crate::{
    targeting::Body, timeline::Origin, vitals::Change, Activity, Battle, Control, Id, Layer,
    Motion, Point, Role,
};
use serde_json::Value;
pub(crate) struct Grant {
    sound: crate::SoundOrigin,
    target: Id,
    due: u64,
    multiplier: f64,
}

impl Battle {
    pub(crate) fn advance_specialists(&mut self) {
        let tick = self.tick;
        for g in std::mem::take(&mut self.grants) {
            if g.due > tick {
                self.grants.push(g);
            } else if let Some(a) = self.actors.get_mut(&g.target) {
                if !a.has(Control::Stasis) {
                    a.card_state.forged = g.multiplier;
                    let pos = a.pos;
                    self.sound(g.sound, "forge:arrive", pos, Some(g.target));
                }
            }
        }
        let ids: Vec<_> = self
            .actors
            .values()
            .filter(|a| {
                a.def.rules.is_some_and(|s| {
                    [
                        "charge_distance",
                        "rush_distance",
                        "auto_pull_range",
                        "team_attack_boost_interval",
                        "terrain_traversal",
                        "deploy_sweep_radius",
                        "pre_deploy_sweep_damage",
                    ]
                    .iter()
                    .any(|k| s.get(*k).is_some())
                }) || a.card_state.prepared_charge.is_some()
            })
            .map(|a| a.id)
            .collect();
        let blocks = crate::movement::blockers(&self.actors);
        for id in ids {
            let Some(a) = self.actors.get_mut(&id) else {
                continue;
            };
            let s = a.def.rules.unwrap();
            let pos = a.pos;
            let team = a.team;
            if a.card_state.landing_due == Some(tick) {
                a.card_state.landing_due = None;
                if s.get("deploy_sweep_radius").is_some() {
                    self.landing_blast(id, s);
                }
            }
            if !self.actors.contains_key(&id) {
                continue;
            }
            if let Some((start, end)) = self.actors[&id].card_state.entry {
                if tick >= start && tick <= end && s.get("pre_deploy_sweep_damage").is_some() {
                    let dir = if team == crate::Team::Blue { -1. } else { 1. };
                    let dist = stat(s, "pre_deploy_sweep_distance", 0.);
                    let center = pos
                        - Point::new(0., dir)
                            * (dist * (end - tick) as f64 / (end - start).max(1) as f64);
                    let radius = stat(s, "pre_deploy_sweep_radius", 0.);
                    let foes: Vec<_> = self
                        .actors
                        .values()
                        .filter(|b| {
                            b.team != team
                                && b.def.layer == Layer::Ground
                                && Body::from(*b).allows(team, center)
                                && (b.pos - center).length() <= radius + b.def.radius
                                && (b.pos - center).y * dir
                                    >= -stat(s, "pre_deploy_sweep_flat_rear", 0.) - b.def.radius
                        })
                        .map(|b| b.id)
                        .collect();
                    let mut damage = vec![];
                    for other in foes {
                        if self
                            .actors
                            .get_mut(&id)
                            .unwrap()
                            .card_state
                            .entry_hits
                            .insert(other)
                            && !self.consume_effect_shield(other)
                        {
                            damage.push(
                                Change::delivered(
                                    id,
                                    other,
                                    -(stat(s, "pre_deploy_sweep_damage", 0.) as i32),
                                )
                                .on_sound(self.actors[&id].sound_origin(), "deploy:hit"),
                            );
                        }
                    }
                    self.commit(damage);
                }
                if tick >= end {
                    if let Some(a) = self.actors.get_mut(&id) {
                        a.card_state.entry = None;
                    }
                }
            }
            let Some(a) = self.actors.get_mut(&id) else {
                continue;
            };
            if a.ready_tick > tick {
                continue;
            }
            if s["terrain_traversal"] == true {
                let mut q = crate::movement::query(&self.map, &blocks, a);
                q.cross_river = false;
                q.blocks = &blocks;
                let inside = !q.legal(pos);
                if inside && !a.card_state.in_terrain {
                    if !a.grievous_wounds {
                        a.hp = (a.hp + stat(s, "terrain_entry_heal", 0.) as i32).min(a.def.hp);
                    }
                }
                a.card_state.in_terrain = inside;
                if inside
                    && a.target.and_then(|t| self.actors.get(&t)).is_some_and(|b| {
                        (b.pos - pos).length()
                            <= b.def.radius
                                + self.actors[&id].def.radius
                                + self.actors[&id].def.range
                    })
                {
                    let a = self.actors.get_mut(&id).unwrap();
                    if let Some(p) =
                        q.nearest(pos, if team == crate::Team::Blue { -1. } else { 1. })
                    {
                        a.pos = p;
                        a.card_state.in_terrain = false;
                        a.route_goal = None;
                    }
                }
            }
            let a = self.actors.get_mut(&id).unwrap();
            if s.get("charge_distance").is_some() {
                let prev = a.card_state.last_step.replace(a.pos);
                if !a.disabled() && matches!(a.activity, Activity::Chase | Activity::March) {
                    a.card_state.marched += (a.pos - prev.unwrap_or(a.pos)).length();
                } else if a.disabled() {
                    a.card_state.marched = 0.;
                }
            }
            if a.disabled()
                || a.card_state.attack_lock > tick
                || a.card_state.cast_end > tick
                || a.card_state.sweep.is_some()
            {
                continue;
            }
            let ctx = self.context(id);
            let a = &self.actors[&id];
            if let Some(interval) = s["team_attack_boost_interval"].as_f64() {
                if tick
                    < a.card_state.forge_due.unwrap_or(
                        a.ready_tick
                            + u64::from(ticks(stat(s, "team_attack_boost_first_delay", 4.))),
                    )
                {
                    continue;
                }
                let target = self
                    .actors
                    .values()
                    .filter(|b| {
                        b.team == team
                            && b.def.role == Role::Troop
                            && b.def.key != "anivia_egg"
                            && b.card_state.forged <= 1.
                            && Body::from(*b).allows(team, pos)
                            && !self.grants.iter().any(|g| g.target == b.id)
                            && !self
                                .card_queue
                                .iter()
                                .any(|j| matches!(j.stage,Stage::Forge(v) if v==b.id))
                    })
                    .min_by(|x, y| {
                        let cost =
                            |b: &crate::Actor| stat(&super::roster::rules()[b.def.key], "cost", 0.);
                        cost(y)
                            .total_cmp(&cost(x))
                            .then_with(|| (x.pos - pos).length().total_cmp(&(y.pos - pos).length()))
                            .then(x.id.cmp(&y.id))
                    })
                    .map(|b| b.id);
                if let Some(target) = target {
                    let a = self.actors.get_mut(&id).unwrap();
                    a.card_state.forge_due = Some(tick + u64::from(ticks(interval)));
                    a.card_state.attack_lock =
                        tick + u64::from(ticks(stat(s, "team_attack_boost_forge_duration", 1.)));
                    a.card_state.move_lock = a.card_state.attack_lock;
                    a.card_state.visual_action = Some(("ornn_forge", tick, a.card_state.move_lock));
                    self.card_queue.push(Pending {
                        ctx,
                        spec: s,
                        due: tick
                            + u64::from(ticks(stat(s, "team_attack_boost_release_time", 0.65))),
                        stage: Stage::Forge(target),
                    });
                }
                continue;
            }
            let charge = a.card_state.prepared_charge;
            let reach = if let Some(sk) = charge {
                stat(sk, "charge_attack_range", 0.)
            } else if !a.card_state.rush_used && s.get("rush_distance").is_some() {
                stat(s, "rush_distance", 0.)
            } else if a.card_state.marched >= stat(s, "charge_distance", f64::INFINITY) {
                stat(s, "charge_attack_range", 0.)
            } else {
                stat(s, "auto_pull_range", 0.)
            };
            if reach == 0. {
                continue;
            }
            let Some((b, gap)) = self
                .actors
                .values()
                .filter(|b| Body::from(*b).eligible(a))
                .map(|b| (b, (b.pos - pos).length() - a.def.radius - b.def.radius))
                .filter(|(_, g)| *g <= reach)
                .min_by(|(a, g), (b, h)| g.total_cmp(h).then(a.id.cmp(&b.id)))
            else {
                continue;
            };
            let dir = (b.pos - pos).unit().unwrap_or(a.facing);
            let ctx = Origin {
                direction: dir,
                ..ctx
            };
            let target = b.id;
            if s.get("auto_pull_range").is_some() {
                if b.def.role != Role::Troop || gap < stat(s, "auto_pull_min_range", 0.) {
                    continue;
                }
                let due = tick + u64::from(ticks(stat(s, "auto_pull_windup", 1.)));
                let a = self.actors.get_mut(&id).unwrap();
                a.facing = dir;
                a.card_state.visual_action = Some(("auto_pull", tick, due));
                a.card_state.attack_lock = due
                    + u64::from(ticks(
                        stat(s, "auto_pull_flight", 0.3) + stat(s, "auto_pull_duration", 0.3),
                    ));
                a.card_state.move_lock = a.card_state.attack_lock;
                self.card_queue.push(Pending {
                    ctx,
                    spec: s,
                    due,
                    stage: Stage::HookLaunch(target),
                });
                self.unit_sound(id, "pull:start", None);
            } else if s.get("rush_distance").is_some() {
                let visible = self.map.ground_obstacles.iter().all(|r| {
                    r.interval(pos, b.pos - pos)
                        .is_none_or(|(lo, hi)| lo > 1. || hi < 0.)
                });
                if !visible {
                    continue;
                }
                let a = self.actors.get_mut(&id).unwrap();
                a.card_state.rush_used = true;
                let due = tick + u64::from(ticks(stat(s, "rush_prepare_time", 2.5)));
                a.card_state.move_lock = due;
                a.card_state.visual_action = Some(("rush_prepare", tick, due));
                a.card_state.attack_lock = due;
                a.card_state.cast_end = due;
                self.card_queue.push(Pending {
                    ctx,
                    spec: s,
                    due,
                    stage: Stage::Charge(Some(target), Kind::Herald),
                });
            } else {
                let a = self.actors.get_mut(&id).unwrap();
                a.card_state.marched = 0.;
                a.card_state.prepared_charge = None;
                self.start_sweep(
                    ctx,
                    charge.unwrap_or(s),
                    if charge.is_some() {
                        Kind::Xin
                    } else {
                        Kind::Kick
                    },
                    Some(target),
                );
            }
        }
    }
    pub(super) fn launch_hook(&mut self, ctx: Origin, s: &'static Value, target: Id) {
        let a = &self.actors[&ctx.caster];
        let Some(b) = self.actors.get(&target) else {
            return;
        };
        let gap = (a.pos - b.pos).length() - a.def.radius - b.def.radius;
        if a.disabled()
            || !Body::from(b).eligible(a)
            || gap <= a.def.range
            || gap > stat(s, "auto_pull_break_range", 0.)
        {
            return;
        }
        let impact = self.tick + u64::from(ticks(stat(s, "auto_pull_flight", 0.3)));
        self.effect_paths.push(crate::model::EffectPath {
            owner: ctx.caster,
            team: ctx.team,
            kind: "hook",
            target: Some(target),
            path: vec![a.pos, b.pos],
            start: self.tick,
            impact,
            end: impact + u64::from(ticks(stat(s, "auto_pull_duration", 0.3))),
        });
        self.card_queue.push(Pending {
            ctx,
            spec: s,
            due: impact,
            stage: Stage::Pull(target),
        });
    }
    pub(super) fn finish_hook(&mut self, ctx: Origin, s: &'static Value, target: Id) {
        let Some(b) = self.actors.get(&target) else {
            return;
        };
        if !Body::from(b).allows(ctx.team, ctx.origin) {
            return;
        }
        let dist = (b.pos - ctx.origin).length();
        let offset = self.actors.get(&ctx.caster).map_or(14., |a| a.def.radius) + b.def.radius + 1.;
        let dir = (b.pos - ctx.origin).unit().unwrap_or(ctx.direction);
        if !self.consume_effect_shield(target) {
            self.unit_sound(ctx.caster, "pull:hit", Some(target));
            let _ = self.resolve_motion(
                target,
                ctx.origin,
                dir,
                Motion::Pull {
                    offset,
                    search_radius: offset + 10.,
                    speed: ((dist - offset) / stat(s, "auto_pull_duration", 0.3)).max(1.),
                },
                self.tick,
            );
        }
    }
    pub(super) fn release_forge(&mut self, ctx: Origin, s: &'static Value, target: Id) {
        let Some(b) = self.actors.get(&target) else {
            return;
        };
        if self.actors[&ctx.caster].disabled() || b.team != ctx.team {
            return;
        }
        let sound = self.actors[&ctx.caster].sound_origin();
        self.grants.push(Grant {
            sound,
            target,
            due: self.tick
                + u64::from(ticks(
                    (0.35 + (b.pos - ctx.origin).length() / 500.).clamp(0.35, 2.5),
                )),
            multiplier: stat(s, "team_attack_boost_multiplier", 1.),
        });
        self.unit_sound(ctx.caster, "forge:strike", None);
    }
}
