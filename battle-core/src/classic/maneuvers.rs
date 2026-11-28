//! A traversal checks the strip actually crossed each tick. The finish effect
//! has a separate target set, so a slash and its following spin may both hit.
use super::units::{stat, ticks, unit};
use crate::{
    targeting::Body, timeline::Origin, vitals::Change, Battle, Control, Id, Layer, Motion, Point,
    Role,
};
use serde_json::Value;
use std::collections::BTreeSet;

#[derive(Clone, Debug)]
pub(crate) struct Sweep {
    distance: f64,
    traveled: f64,
    next_step: u8,
    start: Point,
    target: Option<Id>,
    hit: BTreeSet<Id>,
    rules: &'static Value,
    wall: Option<Point>,
    kind: Kind,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Kind {
    Slash,
    Terrain,
    Herald,
    Kick,
    Xin,
}

impl Battle {
    pub(super) fn context(&self, id: Id) -> Origin {
        let a = &self.actors[&id];
        Origin {
            caster: id,
            team: a.team,
            origin: a.pos,
            source_pos: a.pos,
            direction: a.facing,
        }
    }
    pub(super) fn start_sweep(
        &mut self,
        ctx: Origin,
        s: &'static Value,
        kind: Kind,
        target: Option<Id>,
    ) {
        let a = &self.actors[&ctx.caster];
        if a.disabled() || a.has(Control::Root) {
            return;
        }
        let mut length = stat(s, "length", 0.);
        let mut speed = if kind == Kind::Terrain {
            stat(s, "fixed_speed", 280.)
        } else {
            length / stat(s, "dash_duration", 0.4) * a.def.speed
                / stat(s, "dash_reference_speed", a.def.speed)
        };
        let mut wall = None;
        if let Some(b) = target.and_then(|id| self.actors.get(&id)) {
            length = ((b.pos - a.pos).length() - a.def.radius - b.def.radius).max(1.);
            speed = stat(s, "charge_dash_speed", stat(s, "rush_speed", 420.));
        }
        if kind == Kind::Terrain {
            let blocks = crate::movement::blockers(&self.actors);
            let q = crate::movement::query(&self.map, &blocks, a);
            let mut lo = 0.;
            let mut hi = length;
            if !q.clear(a.pos, a.pos + ctx.direction * hi) {
                for _ in 0..16 {
                    let mid = (lo + hi) / 2.;
                    if q.clear(a.pos, a.pos + ctx.direction * mid) {
                        lo = mid;
                    } else {
                        hi = mid;
                    }
                }
                length = lo;
                wall = Some(a.pos + ctx.direction * (lo + a.def.radius));
            }
        }
        if length > 0.01
            && self
                .resolve_motion(
                    ctx.caster,
                    ctx.origin,
                    ctx.direction,
                    Motion::Dash {
                        distance: length,
                        speed,
                        extension: 0.,
                    },
                    self.tick,
                )
                .is_err()
        {
            return;
        }
        match kind {
            Kind::Herald => self.unit_sound(ctx.caster, "rush:start", None),
            Kind::Terrain => self.unit_sound(ctx.caster, "charge:step", None),
            Kind::Xin | Kind::Kick => self.unit_sound(ctx.caster, "charge:start", None),
            _ => (),
        }
        let a = self.actors.get_mut(&ctx.caster).unwrap();
        a.facing = ctx.direction;
        let action = match kind {
            Kind::Herald => Some("rush_dash"),
            Kind::Kick | Kind::Xin => Some("charge_strike"),
            _ => None,
        };
        if let Some(key) = action {
            a.card_state.visual_action = Some((
                key,
                self.tick,
                self.tick + u64::from(ticks(length / speed.max(1.)).max(1)),
            ));
        }
        a.card_state.sweep = Some(Sweep {
            distance: length,
            traveled: 0.,
            next_step: 1,
            start: ctx.origin,
            target,
            hit: Default::default(),
            rules: s,
            wall,
            kind,
        });
    }
    pub(crate) fn advance_sweeps(&mut self) {
        let ids: Vec<_> = self
            .actors
            .values()
            .filter(|a| a.card_state.sweep.is_some())
            .map(|a| a.id)
            .collect();
        let mut changes = vec![];
        for id in ids {
            let a = self.actors.get_mut(&id).unwrap();
            let mut sweep = a.card_state.sweep.take().unwrap();
            let finished = a.flight.is_none();
            let cancelled = a.has(Control::Freeze)
                || a.has(Control::Stasis)
                || a.has(Control::Root)
                || a.has(Control::Stun);
            if cancelled {
                continue;
            }
            let pos = a.pos;
            let team = a.team;
            let facing = a.facing;
            let radius = a.def.radius;
            let s = sweep.rules;
            let delta = pos - sweep.start;
            let len = delta.dot(delta);
            sweep.traveled += len.sqrt();
            if sweep.kind == Kind::Terrain {
                while sweep.next_step <= 2
                    && sweep.traveled >= sweep.distance * f64::from(sweep.next_step * 4) / 13.
                {
                    self.unit_sound(id, "charge:step", None);
                    sweep.next_step += 1;
                }
            }
            if matches!(sweep.kind, Kind::Slash | Kind::Terrain | Kind::Herald) {
                let width = stat(s, "width", radius * 2.) / 2.;
                let mut heal = false;
                let foes: Vec<_> = self
                    .actors
                    .values()
                    .filter(|b| {
                        let frac = if len > 0. {
                            ((b.pos - sweep.start).dot(delta) / len).clamp(0., 1.)
                        } else {
                            0.
                        };
                        b.team != team
                            && Body::from(*b).allows(team, sweep.start)
                            && ((sweep.start + delta * frac) - b.pos).length()
                                <= width + b.def.radius
                            && (sweep.kind == Kind::Slash && s["ground_only"] != true
                                || b.def.layer == Layer::Ground)
                            && (sweep.kind != Kind::Herald || b.def.role == Role::Troop)
                    })
                    .map(|b| b.id)
                    .collect();
                for other in foes {
                    if !sweep.hit.insert(other) || self.consume_effect_shield(other) {
                        continue;
                    }
                    let b = &self.actors[&other];
                    let extra = if b.def.role.structure() {
                        stat(s, "on_hit_tower_damage", 0.)
                    } else {
                        stat(s, "on_hit_max_health_ratio", 0.) * f64::from(b.def.hp)
                    };
                    let dmg = stat(
                        s,
                        "trail_damage",
                        stat(s, "rush_path_damage", stat(s, "damage", 0.)),
                    ) + extra;
                    let origin = self.actors[&id].sound_origin();
                    let hit = Change::delivered(id, other, -(dmg.round() as i32));
                    changes.push(match sweep.kind {
                        Kind::Herald => hit.on_sound(origin, "rush:path_hit"),
                        Kind::Terrain => hit.on_sound(origin, "charge:trail_hit"),
                        Kind::Slash => hit.group_sound(origin, "@hit", false),
                        _ => hit,
                    });
                    heal = true;
                    if sweep.kind == Kind::Herald {
                        let _ = self.resolve_motion(
                            other,
                            pos,
                            facing,
                            Motion::Knockback {
                                distance: stat(s, "rush_push_distance", 48.),
                                ticks: 5,
                                mass_cap: 1.,
                            },
                            self.tick,
                        );
                    }
                }
                if heal && s.get("hit_heal").is_some() && !sweep.hit.contains(&id) {
                    changes.push(Change::new(id, id, stat(s, "hit_heal", 0.) as i32));
                    sweep.hit.insert(id);
                }
            }
            if !finished {
                sweep.start = pos;
                self.actors.get_mut(&id).unwrap().card_state.sweep = Some(sweep);
                continue;
            }
            let ctx = self.context(id);
            match sweep.kind {
                Kind::Slash => {
                    if s.get("spin_delay").is_some() {
                        let due = self.tick
                            + u64::from(ticks(
                                (stat(s, "spin_delay", 0.) - stat(s, "dash_duration", 0.)).max(0.),
                            ));
                        self.card_queue.push(super::casts::Pending {
                            ctx,
                            spec: s,
                            due,
                            stage: super::casts::Stage::Spin,
                        });
                    }
                }
                Kind::Terrain => {
                    let name = if sweep.wall.is_some() {
                        "ornn_charge_hit"
                    } else {
                        "ornn_charge_miss"
                    };
                    self.actors.get_mut(&id).unwrap().card_state.visual_action =
                        Some((name, self.tick, self.tick + 11));
                    if let Some(wall) = sweep.wall {
                        self.sound(self.actors[&id].sound_origin(), "charge:impact", wall, None);
                        self.nova(
                            Origin {
                                origin: wall,
                                ..ctx
                            },
                            s,
                            &mut changes,
                        );
                    }
                }
                Kind::Herald => {
                    let Some(target) = sweep.target.filter(|i| self.actors.contains_key(i)) else {
                        continue;
                    };
                    changes.push(
                        Change::new(id, target, -(stat(s, "rush_building_damage", 0.) as i32))
                            .on_sound(self.actors[&id].sound_origin(), "rush:hit"),
                    );
                    let a = self.actors.get_mut(&id).unwrap();
                    a.hp -=
                        (f64::from(a.hp) * stat(s, "rush_self_health_ratio", 0.)).round() as i32;
                    a.card_state.attack_lock =
                        self.tick + u64::from(ticks(stat(s, "rush_recovery_time", 0.)));
                    a.card_state.move_lock = a.card_state.attack_lock;
                    a.card_state.visual_action =
                        Some(("rush_hit", self.tick, a.card_state.move_lock));
                    let count = stat(s, "rush_spawn_count", 0.) as u8;
                    for i in 0..count {
                        let angle = std::f64::consts::TAU * f64::from(i) / f64::from(count);
                        let point = pos
                            + Point::new(angle.cos(), angle.sin())
                                * stat(s, "rush_spawn_spread", 0.);
                        if let Ok(child) =
                            self.spawn_near(team, point, unit(s["rush_spawn_id"].as_str().unwrap()))
                        {
                            let minion = self.actors.get_mut(&child).unwrap();
                            minion.card_state.visual_action = Some((
                                "scatter_birth",
                                self.tick,
                                minion.ready_tick.max(self.tick + 1),
                            ));
                            self.summoned(id, child);
                        }
                    }
                }
                Kind::Kick | Kind::Xin => {
                    let Some(target) = sweep.target.filter(|i| self.actors.contains_key(i)) else {
                        continue;
                    };
                    let center = self.actors[&target].pos;
                    let a = self.actors.get_mut(&id).unwrap();
                    if sweep.kind == Kind::Kick {
                        a.card_state.visual_action =
                            Some(("charge_followthrough", self.tick, self.tick + 14));
                    }
                    let missed = a.blind > 0 && s["ignore_blind"] != true;
                    if missed {
                        a.blind -= 1;
                    } else {
                        let dmg = stat(a.def.rules.unwrap(), "damage", 0.) as i32;
                        let hit = super::Attack::release(a);
                        if sweep.kind == Kind::Xin {
                            a.empowerment = Some(crate::status::Empowerment {
                                attack: (1000. * stat(s, "attack_speed_multiplier", 1.)) as u16,
                                movement: 1000,
                                damage: 1000,
                                until: self.tick + u64::from(ticks(stat(s, "duration", 0.))),
                            });
                            let origin = a.sound_origin();
                            for b in self.actors.values().filter(|b| {
                                b.team != team
                                    && b.def.layer == Layer::Ground
                                    && Body::from(*b).allows(team, pos)
                                    && (b.pos - center).length()
                                        <= stat(s, "charge_impact_radius", 70.) + b.def.radius
                            }) {
                                changes.push(if b.id == target {
                                    Change::attack(id, b.id, dmg, hit)
                                        .on_sound(origin, "charge:hit")
                                } else {
                                    Change::new(id, b.id, -dmg)
                                });
                            }
                        } else {
                            changes.push(
                                Change::attack(id, target, dmg, hit)
                                    .on_sound(a.sound_origin(), "charge:hit"),
                            );
                            let _ = self.resolve_motion(
                                target,
                                pos,
                                facing,
                                Motion::Knockback {
                                    distance: stat(s, "charge_knockback", 40.),
                                    ticks: ticks(stat(s, "charge_knockback_duration", 0.5)),
                                    mass_cap: 1.,
                                },
                                self.tick,
                            );
                            let _ = self.apply_control(
                                target,
                                Control::Stun,
                                id,
                                ticks(stat(s, "charge_stun_duration", 1.5)),
                                self.tick,
                            );
                        }
                    }
                    if sweep.kind == Kind::Kick {
                        let dist = stat(s, "charge_follow_distance", 48.);
                        let _ = self.begin_displacement(
                            id,
                            facing,
                            dist,
                            dist / stat(s, "charge_follow_duration", 0.67),
                            radius,
                            self.tick,
                        );
                    }
                }
            }
        }
        if !changes.is_empty() {
            self.commit(changes);
        }
    }

    pub(super) fn landing_blast(&mut self, id: Id, s: &'static Value) {
        let ctx = self.context(id);
        let mut changes = vec![];
        let targets: Vec<_> = self
            .actors
            .values()
            .filter(|a| {
                a.team != ctx.team
                    && a.def.layer == Layer::Ground
                    && Body::from(*a).allows(ctx.team, ctx.origin)
                    && (a.pos - ctx.origin).length()
                        <= stat(s, "deploy_sweep_radius", 0.) + a.def.radius
            })
            .map(|a| a.id)
            .collect();
        for other in targets {
            if self.consume_effect_shield(other) {
                continue;
            }
            changes.push(
                Change::delivered(id, other, -(stat(s, "deploy_sweep_damage", 0.) as i32))
                    .on_sound(self.actors[&id].sound_origin(), "deploy:hit"),
            );
            let _ = self.resolve_motion(
                other,
                ctx.origin,
                ctx.direction,
                Motion::Knockback {
                    distance: stat(s, "deploy_sweep_knockback", 0.),
                    ticks: ticks(stat(s, "deploy_sweep_duration", 0.2)),
                    mass_cap: stat(s, "deploy_sweep_mass_factor_max", 1.),
                },
                self.tick,
            );
        }
        self.commit(changes);
    }
}
