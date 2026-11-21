//! Cast starts capture facing. Releases, pulse ticks and incoming projectiles
//! each have their own lifetime on the battle clock.
use super::units::{stat, ticks, unit};
use crate::{
    classic::Attack, targeting::Body, timeline::Origin, vitals::Change, Battle, Control, Fact, Id,
    Motion, Point, Projectile, Role, Shape, Trajectory,
};
use serde_json::Value;
#[derive(Clone, Copy)]
pub(crate) struct Pending {
    pub ctx: Origin,
    pub spec: &'static Value,
    pub due: u64,
    pub stage: Stage,
}
#[derive(Clone, Copy)]
pub(crate) enum Stage {
    Impact,
    Spin,
    Charge(Option<Id>, super::maneuvers::Kind),
    HookLaunch(Id),
    Pull(Id),
    Forge(Id),
    Release(bool, u32),
    Pulse(u32),
    Snip(i32, &'static str),
    Spawn(u8),
    ExtraHit(Id, i32),
    Sacrifice(Id, i32, crate::SoundOrigin),
}

impl Battle {
    pub(crate) fn card_ability(
        &mut self,
        ctx: Origin,
        s: &'static Value,
        changes: &mut Vec<Change>,
    ) {
        if s["kind"] == "dual_form" && !self.actors[&ctx.caster].card_state.changed_form {
            self.switch_card_form(ctx.caster, true);
        }
        let a = self.actors.get_mut(&ctx.caster).unwrap();
        let max = a
            .def
            .rules
            .map_or(0., |r| stat(r, "skill_resource_max", 0.));
        a.card_state.cast_resource = if max > 0. {
            a.card_state.resource / max
        } else {
            0.
        };
        let full = a.card_state.cast_resource >= 0.999;
        let stacks = a.card_state.resource as usize;
        if s["uses_skill_resource"] == true {
            if s["resource_consume_only_full"] != true || full {
                a.card_state.resource = 0.;
            } else {
                a.gain_resource(stat(s, "resource_nonfull_cast_gain", 0.), self.tick);
            }
        }
        if s["shield_on_cast_start"] == true {
            let amount =
                (a.card_state.cast_resource * stat(s, "resource_shield_max", 0.)).round() as i32;
            let end = self.tick + u64::from(ticks(stat(s, "shield_duration", 0.)));
            if s["shield_decay"] == true {
                a.shields.decaying(amount, self.tick, end);
            } else {
                a.shields.add(amount, end);
            }
        }
        let end = self.tick
            + u64::from(ticks(if full {
                stat(
                    s,
                    "full_resource_cast_duration",
                    stat(s, "cast_duration", 0.),
                )
            } else {
                stat(s, "cast_duration", 0.)
            }));
        if s["cast_move_forward"] == true {
            a.card_state.cast_heading = Some((end, ctx.direction));
        }
        a.card_state.cast_start = self.tick;
        a.card_state.cast_end = end;
        let locked = |key: &str| {
            s["cast_locks"]
                .as_array()
                .is_none_or(|locks| locks.iter().any(|lock| lock == key))
        };
        if locked("attack") && end > self.tick {
            a.card_state.attack_lock = end;
            a.reset_attack();
        }
        if locked("movement") {
            a.card_state.move_lock = end;
        }
        a.card_state.last_combat = self.tick;
        a.card_state.use_number = a.card_state.use_number.saturating_add(1);
        a.card_state.cast_action = a.select_cast_action(s, full, stacks);
        let delay = ticks(if full {
            stat(s, "full_resource_impact_delay", stat(s, "impact_delay", 0.))
        } else {
            stat(s, "impact_delay", 0.)
        });
        a.card_state.impact_tick = self.tick + u64::from(delay);
        if s["kind"] == "rewind_nova" {
            a.card_state.rewind = Some(a.card_state.history.front().map_or(a.pos, |(_, p)| *p));
            a.card_state.untargetable = self.tick + u64::from(delay);
            changes.push(Change::new(a.id, a.id, a.def.hp));
        }
        if let Some(seq) = s["resource_hit_damage_sequences"]
            .get(stacks)
            .and_then(Value::as_array)
        {
            for (i, n) in seq.iter().enumerate() {
                let when = s["resource_hit_delay_sequences"][stacks][i]
                    .as_f64()
                    .unwrap();
                self.card_queue.push(Pending {
                    ctx,
                    spec: s,
                    due: self.tick + u64::from(ticks(when)),
                    stage: Stage::Snip(
                        n.as_f64().unwrap() as i32,
                        if i + 1 == seq.len() {
                            "@hit_last"
                        } else if i == 0 {
                            "@hit_first"
                        } else {
                            "@hit_middle"
                        },
                    ),
                });
            }
            a.card_state.snip_heal = if full {
                stat(s, "full_resource_first_hit_heal", 0.) as i32
            } else {
                0
            };
            return;
        }
        if s["kind"] == "forward_area" {
            let creation = if s["independent_on_creation"] == true {
                ticks(if full {
                    stat(s, "full_resource_result_creation_delay", 0.)
                } else {
                    stat(s, "result_creation_delay", 0.)
                })
            } else {
                delay
            };
            self.card_queue.push(Pending {
                ctx,
                spec: s,
                due: self.tick + u64::from(creation),
                stage: Stage::Release(full, delay.saturating_sub(creation)),
            });
            return;
        }
        if delay > 0 {
            self.card_queue.push(Pending {
                ctx,
                spec: s,
                due: self.tick + u64::from(delay),
                stage: Stage::Impact,
            });
        } else {
            self.ability_impact(ctx, s, changes);
        }
    }
    pub(crate) fn advance_casts(&mut self) {
        let queue = std::mem::take(&mut self.card_queue);
        let mut changes = vec![];
        for mut job in queue {
            if let Stage::Pull(target) = job.stage {
                if job.due > self.tick {
                    self.card_queue.push(job);
                } else {
                    self.finish_hook(job.ctx, job.spec, target);
                }
                continue;
            }
            if let Stage::Sacrifice(id, damage, mut origin) = job.stage {
                if job.due > self.tick {
                    self.card_queue.push(job);
                } else if self.actors.get(&id).is_some_and(|b| {
                    b.def.role.structure() && Body::from(b).allows(job.ctx.team, job.ctx.source_pos)
                }) {
                    origin.owner = id;
                    let position = self
                        .effect_paths
                        .iter()
                        .find(|p| {
                            p.owner == job.ctx.caster
                                && p.kind == "sacrifice"
                                && p.impact == self.tick
                        })
                        .and_then(|p| p.path.last())
                        .copied()
                        .unwrap_or(self.actors[&id].pos);
                    self.sound(origin, "sacrifice:impact", position, Some(id));
                    changes.push(Change::new(job.ctx.caster, id, -damage));
                }
                continue;
            }
            let Some(a) = self.actors.get(&job.ctx.caster) else {
                continue;
            };
            if (a.has(Control::Freeze) || a.has(Control::Stasis))
                && !matches!(job.stage, Stage::ExtraHit(..))
            {
                continue;
            }
            if job.due > self.tick {
                self.card_queue.push(job);
                continue;
            }
            job.ctx.origin = a.pos;
            job.ctx.source_pos = a.pos;
            match job.stage {
                Stage::Sacrifice(..) => unreachable!(),
                Stage::Snip(n, phase) => {
                    self.frontal_amount(job.ctx, job.spec, f64::from(n), phase, &mut changes)
                }
                Stage::Release(full, delay) => self.forward_release(job.ctx, job.spec, full, delay),
                Stage::Spin => {
                    self.unit_sound(job.ctx.caster, "active:spin", None);
                    self.nova(job.ctx, job.spec, &mut changes)
                }
                Stage::Charge(target, kind) => self.start_sweep(job.ctx, job.spec, kind, target),
                Stage::HookLaunch(target) => self.launch_hook(job.ctx, job.spec, target),
                Stage::Pull(_) => unreachable!(),
                Stage::Forge(target) => self.release_forge(job.ctx, job.spec, target),
                Stage::Impact => self.ability_impact(job.ctx, job.spec, &mut changes),
                Stage::Spawn(i) => self.summon_member(job.ctx, job.spec, i),
                Stage::ExtraHit(id, n) => {
                    if self
                        .actors
                        .get(&id)
                        .is_some_and(|b| Body::from(b).allows(job.ctx.team, job.ctx.origin))
                    {
                        changes.push(Change::new(job.ctx.caster, id, -n));
                    }
                }
                Stage::Pulse(left) => {
                    self.nova(job.ctx, job.spec, &mut changes);
                    if left > 1 {
                        job.stage = Stage::Pulse(left - 1);
                        job.due += u64::from(ticks(stat(job.spec, "tick_interval", 1.)));
                        self.card_queue.push(job);
                    }
                }
            }
        }
        if !changes.is_empty() {
            self.commit(changes);
        }
    }
    pub(crate) fn nova(&mut self, ctx: Origin, s: &'static Value, changes: &mut Vec<Change>) {
        self.nova_scaled(ctx, s, 1., changes);
    }
    pub(super) fn nova_scaled(
        &mut self,
        ctx: Origin,
        s: &'static Value,
        multiplier: f64,
        changes: &mut Vec<Change>,
    ) {
        let a = &self.actors[&ctx.caster];
        let radius = if s["radius_from_attack_range"] == true {
            a.def.range + a.def.radius
        } else {
            stat(s, "radius", 0.)
        };
        let ids: Vec<_> = self
            .actors
            .values()
            .filter(|b| {
                b.team != ctx.team
                    && Body::from(*b).allows(ctx.team, ctx.source_pos)
                    && (s["ground_only"] != true || b.def.layer == crate::Layer::Ground)
                    && (b.pos - ctx.origin).length() <= radius + b.def.radius
            })
            .map(|b| b.id)
            .collect();
        for id in ids {
            if self.consume_effect_shield(id) {
                continue;
            }
            let uses = self.actors[&ctx.caster]
                .card_state
                .use_number
                .saturating_sub(1) as usize;
            let amount = s["damage_by_use"]
                .as_array()
                .and_then(|v| v.get(uses.min(v.len().saturating_sub(1))))
                .and_then(Value::as_f64)
                .unwrap_or(stat(s, "damage", 0.)) as i32;
            if amount > 0 {
                if matches!(
                    s["id"].as_str(),
                    Some("jayce.hyper-charge-lightning-field" | "ekko.chronobreak")
                ) {
                    self.emit(crate::Fact::SpellContact {
                        key: if s["kind"] == "rewind_nova" {
                            "rewind_hit"
                        } else {
                            "field_hit"
                        },
                        target: id,
                        position: self.actors[&id].pos,
                    });
                }
                let hit = Change::skill_hit(
                    ctx.caster,
                    id,
                    (f64::from(amount) * multiplier).round() as i32,
                    stat(s, "heal_ratio", 0.),
                );
                let source = self.actors[&ctx.caster].sound_origin();
                changes.push(if s["kind"] == "counter_strike" {
                    hit.on_sound(source, "counter_strike:hit")
                } else if s["kind"] == "terrain_charge" && self.actors[&id].def.role == Role::Troop
                {
                    hit.on_sound(source, "charge:knockup")
                } else {
                    hit.group_sound(source, "@hit", false)
                });
            }
            let b = self.actors.get_mut(&id).unwrap();
            if !matches!(b.def.role, Role::Troop | Role::Building) {
                continue;
            }
            if let Some(duration) = s["slow_duration"].as_f64() {
                b.slows.apply(
                    ctx.caster,
                    (1000. * stat(s, "slow_multiplier", 1.)).round() as u16,
                    if b.def.role == Role::Troop {
                        (1000. * stat(s, "attack_slow_multiplier", 1.)).round() as u16
                    } else {
                        1000
                    },
                    self.tick + u64::from(ticks(duration)),
                );
            }
            if let Some(duration) = s["stun_duration"].as_f64() {
                if duration > 0. {
                    let _ = self.apply_control(
                        id,
                        Control::Stun,
                        ctx.caster,
                        ticks(duration),
                        self.tick,
                    );
                }
            }
            if let Some(distance) = s["knockback"].as_f64() {
                let _ = self.resolve_motion(
                    id,
                    ctx.origin,
                    ctx.direction,
                    Motion::Knockback {
                        distance,
                        ticks: ticks(stat(s, "knockback_duration", 0.2)),
                        mass_cap: stat(s, "knockback_mass_factor_max", 1.4),
                    },
                    self.tick,
                );
            }
        }
    }
    pub(super) fn summon_member(&mut self, ctx: Origin, s: &'static Value, i: u8) {
        let def = unit(s["spawn_id"].as_str().unwrap());
        let count = stat(s, "spawn_count", 1.);
        let radius = self.actors.get(&ctx.caster).map_or(0., |a| a.def.radius) + def.radius + 3.;
        let angle = std::f64::consts::TAU * f64::from(i) / count;
        let offset = if let Some(forward) = s["spawn_forward_distance"].as_f64() {
            ctx.direction * forward
        } else if s["spawn_side"] == "map_side" {
            Point::new(
                if ctx.origin.x < self.map.width / 2. {
                    -radius
                } else {
                    radius
                },
                (f64::from(i) - (count - 1.) / 2.) * (2. * def.radius + 3.),
            )
        } else if s["spawn_side"] == "below" {
            Point::new(
                0.,
                if ctx.team == crate::Team::Blue {
                    radius
                } else {
                    -radius
                },
            )
        } else {
            Point::new(angle.cos(), angle.sin()) * radius
        };
        let delay = stat(
            s,
            "spawn_deploy_time",
            stat(def.rules.unwrap(), "deploy_time", 1.),
        );
        if let Ok(child) = self.spawn_near(ctx.team, ctx.origin + offset, def) {
            self.actors.get_mut(&child).unwrap().ready_tick = self.tick + u64::from(ticks(delay));
            self.emit(Fact::Summoned {
                source: ctx.caster,
                child,
            });
        }
    }
    pub(super) fn frontal(&mut self, ctx: Origin, s: &'static Value, changes: &mut Vec<Change>) {
        let a = &self.actors[&ctx.caster];
        let index = a.card_state.use_number.saturating_sub(1) as usize;
        let damage = s["damage_by_use"]
            .get(index)
            .and_then(Value::as_f64)
            .unwrap_or(stat(s, "damage", 0.));
        let ratio = a.card_state.cast_resource;
        let damage = damage
            * if ratio >= 0.999 {
                stat(s, "resource_full_damage_multiplier", 1.)
            } else {
                1.
            }
            * (1. + ratio * (stat(s, "resource_damage_scale_max", 1.) - 1.));
        if s["id"] == "sett.haymaker" {
            self.emit(crate::Fact::SkillImpact {
                caster: ctx.caster,
                skill: "sett.haymaker",
                enhanced: ratio >= 0.999,
                position: ctx.origin + ctx.direction * a.def.radius,
                direction: ctx.direction,
            });
        }
        self.frontal_amount(ctx, s, damage, "@hit", changes);
    }
    fn frontal_amount(
        &mut self,
        ctx: Origin,
        s: &'static Value,
        damage: f64,
        phase: &'static str,
        changes: &mut Vec<Change>,
    ) {
        let a = &self.actors[&ctx.caster];
        let radius = a.def.radius;
        let source_kind = a.audio_kind();
        let attack_sound = a.attack_sound(self.tick);
        let cast_action = a.card_state.cast_action;
        let length = stat(s, "length", 0.);
        if s["projectile_stop_on_hit"] == true || s["projectile_piercing"] == true {
            let group = self.next_id;
            let count = stat(s, "projectile_count", 1.) as usize;
            let rules = if s["applies_on_hit_slow"] == true {
                a.def.rules
            } else {
                None
            };
            let body = if s["shape"] == "trapezoid" {
                stat(s, "near_width", 6.) / 2.
            } else {
                3.
            };
            for i in 0..count {
                let part = if count == 1 {
                    0.
                } else {
                    i as f64 / (count - 1) as f64 - 0.5
                };
                let (sin, cos) = (stat(s, "arc_degrees", 0.).to_radians() * 0.92 * part).sin_cos();
                let d = ctx.direction;
                let dir = Point::new(d.x * cos - d.y * sin, d.x * sin + d.y * cos);
                let offset = s["projectile_spawn_offset"]
                    .as_f64()
                    .map_or(dir * radius, |x| d * x);
                let id = self.next_id;
                self.next_id += 1;
                self.shots.push(Projectile {
                    attack_sound,
                    cast_action,
                    born: self.tick,
                    source_kind,
                    id,
                    team: ctx.team,
                    owner: ctx.caster,
                    target: 0,
                    origin: ctx.origin,
                    position: ctx.origin + offset,
                    hits_air: s["ground_only"] != true,
                    radius: body,
                    damage: damage.round() as i32,
                    speed: length / stat(s, "projectile_flight_duration", 0.5),
                    trajectory: Trajectory::Line {
                        direction: dir,
                        left: length,
                        pierce: s["projectile_piercing"] == true,
                        returns: false,
                        inbound: false,
                        hit: vec![],
                    },
                    volley: Some(group),
                    on_hit: Attack {
                        rules,
                        ability: Some(s),
                        ..Default::default()
                    },
                });
                self.emit(Fact::Fired(ctx.caster, 0, id));
            }
            return;
        }
        let origin = ctx.origin + ctx.direction * radius;
        let candidates: Vec<_> = self
            .actors
            .values()
            .filter_map(|b| {
                if b.team == ctx.team
                    || !Body::from(b).allows(ctx.team, ctx.source_pos)
                    || (s["ground_only"] == true && b.def.layer == crate::Layer::Air)
                {
                    return None;
                }
                let delta = b.pos - origin;
                let along = delta.dot(ctx.direction);
                let side = (delta.x * ctx.direction.y - delta.y * ctx.direction.x).abs();
                let near = stat(s, "near_width", stat(s, "width", 0.));
                let far = stat(s, "far_width", near);
                let shape = if s["shape"] == "fan" {
                    Shape::Fan {
                        radius: length,
                        half_angle: stat(s, "arc_degrees", 0.).to_radians() / 2.,
                    }
                } else {
                    Shape::Strip {
                        length,
                        half_width: (near + (far - near) * (along / length).clamp(0., 1.)) / 2.,
                    }
                };
                if !shape.hits(delta, ctx.direction, b.def.radius) {
                    return None;
                }
                let center_width = s["center_width"]
                    .as_f64()
                    .unwrap_or(near * stat(s, "center_ratio", 0.));
                let center = center_width > 0. && side <= center_width / 2. + b.def.radius;
                let amount = if s.get("center_width").is_some() && center {
                    damage * stat(s, "center_damage_multiplier", 1.)
                } else {
                    damage
                };
                Some((b.id, amount.round() as i32, center))
            })
            .collect();
        for (id, amount, center) in candidates {
            if self.consume_effect_shield(id) {
                continue;
            }
            let bonus = if s["applies_on_hit_passive"] == true {
                Attack {
                    rules: self.actors[&ctx.caster].def.rules,
                    ..Default::default()
                }
                .bonus(&self.actors[&id])
            } else {
                0
            };
            changes.push(
                Change::delivered(ctx.caster, id, -(amount + bonus)).group_sound(
                    self.actors[&ctx.caster].sound_origin(),
                    phase,
                    center,
                ),
            );
            let heal = std::mem::take(
                &mut self
                    .actors
                    .get_mut(&ctx.caster)
                    .unwrap()
                    .card_state
                    .snip_heal,
            );
            if heal > 0 {
                changes.push(Change::new(ctx.caster, ctx.caster, heal));
            }
            if let Some(n) = s["stun_duration"].as_f64() {
                let _ = self.apply_control(id, Control::Stun, ctx.caster, ticks(n), self.tick);
            }
        }
    }
}
