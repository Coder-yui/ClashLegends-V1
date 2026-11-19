use crate::targeting::{gap, Perception};
use crate::{Action, Activity, Actor, Fact, Id, Projectile, TICKS_PER_SECOND};
#[derive(Clone, Debug, Default)]
pub(crate) struct DrainState {
    targets: Vec<Id>,
    active_left: u32,
    pause_left: u32,
}
pub(crate) struct Effects {
    pub facts: Vec<Fact>,
    pub health: Vec<crate::vitals::Change>,
    pub shots: Vec<Projectile>,
    pub waves: Vec<crate::classic::zones::Wave>,
    pub next_id: Id,
    pub tick: u64,
    pub sacrifices: Vec<(Id, Id, i32)>,
}
impl Effects {
    pub fn new(next_id: Id, tick: u64) -> Self {
        Self {
            facts: vec![],
            health: vec![],
            shots: vec![],
            waves: vec![],
            next_id,
            tick,
            sacrifices: vec![],
        }
    }
}
pub(crate) fn decide(a: &mut Actor, view: &Perception, mid: f64, out: &mut Effects) {
    crate::projectiles::reload_tick(a);
    if a.disabled() || a.def.action == Action::Idle {
        a.activity = if a.flight.is_some() {
            Activity::Displaced
        } else {
            Activity::Idle
        };
        return;
    }
    let (_, attack, damage_rate) = a.rates();
    let rate = u64::from(attack);
    let scale = u64::from(crate::status::NORMAL);
    let start = a.attack_clock;
    a.attack_clock += rate;
    let Some((b, march)) = view.choose(a, mid) else {
        crate::projectiles::start_reload(a);
        a.target = None;
        a.activity = Activity::Idle;
        a.reset_attack();
        a.route_goal = None;
        a.heal_remainder = 0;
        return;
    };
    if a.target != Some(b.id) {
        a.route_goal = None;
        a.target = Some(b.id)
    }
    let distance = gap(a, b);
    let winding = a.release_at.is_some();
    let fixed = a
        .def
        .rules
        .is_some_and(|s| s.get("fixed_attack_length").is_some());
    if distance > a.def.range + 1e-8
        && !(fixed && winding)
        && (!winding
            || (a.release_at.is_some_and(|t| a.attack_clock >= t) && distance > a.def.range + 20.))
    {
        crate::projectiles::start_reload(a);
        a.activity = if march {
            Activity::March
        } else {
            Activity::Chase
        };
        a.reset_attack();
        a.heal_remainder = 0;
        return;
    }
    a.route_goal = None;
    if a.def.weapon.magazine > 0 {
        if a.rounds == 0 {
            a.activity = Activity::Recover;
            return;
        }
        a.reload_left = 0;
    }
    if a.drain.active_left == 0 && !(fixed && winding) {
        a.facing = (b.pos - a.pos).unit().unwrap_or(a.facing);
    }
    match a.def.action {
        Action::Idle => {}
        Action::Beam { per_second } => {
            a.activity = Activity::Channeling;
            pulse(a, b.id, per_second, rate, 0, out);
        }
        Action::Drain {
            per_second,
            active,
            pause,
            steal,
        } => {
            let mut state = std::mem::take(&mut a.drain);
            let eligible = |b: crate::targeting::Body| b.eligible(a) && gap(a, b) <= a.def.range;
            if state.active_left > 0 {
                state
                    .targets
                    .retain(|id| view.bodies.get(id).is_some_and(|b| eligible(*b)));
                if state.targets.is_empty() {
                    state.active_left = 0;
                    state.pause_left = pause;
                }
            }
            if state.pause_left > 0 {
                state.pause_left -= 1;
                a.activity = Activity::Recover;
                a.drain = state;
                return;
            }
            if state.active_left == 0 {
                state.targets.clear();
                view.nearby(a.pos, a.def.radius + a.def.range, |b| {
                    if eligible(b) {
                        state.targets.push(b.id)
                    }
                });
                state.targets.sort_unstable();
                state.active_left = active;
            }
            if !state.targets.contains(&b.id) {
                a.target = state.targets.first().copied()
            }
            a.activity = Activity::Channeling;
            for &id in &state.targets {
                pulse(a, id, per_second, rate, steal, out)
            }
            state.active_left = state.active_left.saturating_sub(1);
            if state.active_left == 0 {
                state.pause_left = pause
            }
            a.drain = state;
        }
        Action::Mend { per_second } => {
            a.activity = Activity::Mending;
            let total = u64::from(a.heal_remainder) + u64::from(per_second);
            let amount = total / TICKS_PER_SECOND;
            a.heal_remainder = (total % TICKS_PER_SECOND) as u32;
            if amount > 0 && a.hp < a.def.hp {
                out.health
                    .push(crate::vitals::Change::new(a.id, a.id, amount as i32))
            }
        }
        Action::Strike {
            damage,
            windup,
            interval,
        }
        | Action::Shot {
            damage,
            windup,
            interval,
            ..
        } => {
            let s = a.def.rules.unwrap_or(&serde_json::Value::Null);
            let cycle = a.card_state.swing + 1;
            let interval = crate::classic::hits::per_hit(
                s,
                "attack_pattern",
                cycle,
                f64::from(interval) / 20.,
            );
            let interval = (interval * 20.).ceil().max(1.) as u32;
            let windup = if a.card_state.empowered.is_some() {
                s["empowered_first_hit"].as_f64()
            } else if crate::classic::hits::per_hit(s, "attack_passive_multipliers", cycle, 0.) > 0.
            {
                s["passive_first_hit"].as_f64()
            } else {
                None
            }
            .map_or(windup, |t| (t * 20.).ceil() as u32);
            if a.release_at.is_none() {
                let earliest = (start + u64::from(windup) * scale).max(a.attack_clock);
                if a.next_attack > earliest {
                    if let Some(timing) = &mut a.attack {
                        timing.end = out.tick + (a.next_attack - earliest).div_ceil(rate.max(1));
                    }
                    a.activity = Activity::Recover;
                    return;
                }
                // The step that starts a swing also advances its first 50 ms.
                let due = a.next_attack.max(earliest);
                a.release_at = Some(due);
                a.attack = Some(crate::AttackTiming {
                    start: out.tick,
                    release: out.tick,
                    end: out.tick,
                    cycle,
                    released: false,
                    empowered: a.card_state.empowered.is_some(),
                    close: s["close_attack_range"]
                        .as_f64()
                        .is_some_and(|r| distance <= r),
                    structure_target: b.role.structure(),
                });
                out.facts.push(Fact::AttackStarted(a.id, b.id));
            }
            let due = a.release_at.unwrap();
            let timing = a.attack.as_mut().expect("a pending swing has a timeline");
            timing.release = out.tick + due.saturating_sub(a.attack_clock).div_ceil(rate.max(1));
            timing.end = timing.release
                + 1
                + (u64::from(interval) * scale)
                    .saturating_sub((u64::from(windup) * scale).max(rate))
                    .div_ceil(rate.max(1));
            if a.attack_clock < due {
                a.activity = Activity::Windup;
                return;
            }
            timing.released = true;
            out.facts.push(Fact::AttackReleased {
                source: a.id,
                target: b.id,
                start: timing.start,
            });
            a.release_at = None;
            a.next_attack = a.attack_clock + u64::from(interval) * scale;
            a.activity = Activity::Recover;
            crate::projectiles::spent(a);
            let mut attack = crate::classic::Attack::release(a);
            if let Some(s) = a.def.rules {
                a.gain_resource(
                    s["skill_resource_attack_gain"].as_f64().unwrap_or(0.),
                    out.tick,
                );
                attack.close = s["close_attack_range"]
                    .as_f64()
                    .is_some_and(|r| distance <= r);
                if attack.close {
                    a.next_attack = a.attack_clock
                        + (f64::from(interval) * scale as f64
                            / s["close_attack_speed_multiplier"].as_f64().unwrap_or(1.))
                        .round() as u64;
                }
            }
            if a.blind > 0 && attack.ability.is_none_or(|s| s["strike_type"] != "skill") {
                a.blind -= 1;
                out.facts.push(Fact::Missed {
                    source: a.id,
                    target: b.id,
                });
                return;
            }
            let damage = attack.damage(a, b.id, damage);
            let damage = if a.card_state.rage_until > out.tick {
                damage * 2
            } else {
                damage
            };
            let damage = ((i64::from(damage) * i64::from(damage_rate) + 500) / 1000)
                .min(i64::from(i32::MAX)) as i32;
            let s = a.def.rules.unwrap_or(&serde_json::Value::Null);
            if fixed || s.get("attack_self_radius").is_some() {
                let reach = s["fixed_attack_length"]
                    .as_f64()
                    .or(s["attack_self_radius"].as_f64())
                    .unwrap();
                view.nearby(a.pos, reach + a.def.radius, |body| {
                    let delta = body.pos - a.pos;
                    let inside = if fixed {
                        crate::Shape::Strip {
                            length: reach,
                            half_width: s["fixed_attack_width"].as_f64().unwrap() / 2.,
                        }
                        .hits(delta, a.facing, body.radius)
                    } else {
                        delta.length() <= reach + body.radius
                    };
                    if body.eligible(a) && inside {
                        out.health
                            .push(crate::vitals::Change::attack(a.id, body.id, damage, attack));
                    }
                });
                return;
            }
            if s["attack_all_in_range"] == true {
                let mut targets = vec![];
                view.nearby(a.pos, a.def.radius + a.def.range, |body| {
                    if body.eligible(a) && gap(a, body) <= a.def.range {
                        targets.push(body)
                    }
                });
                let damage = if targets.len() == 1 {
                    damage * s["isolated_attack_multiplier"].as_f64().unwrap_or(1.) as i32
                } else {
                    damage
                };
                if let Action::Shot { speed, .. } = a.def.action {
                    for body in targets {
                        crate::projectiles::fire(a, body, damage, speed, attack, out);
                    }
                }
                return;
            }
            if a.def
                .rules
                .is_some_and(|s| s.get("sacrifice_damage").is_some())
            {
                out.sacrifices.push((a.id, b.id, damage));
            } else if matches!(a.def.action, Action::Shot { .. }) && !attack.close {
                let Action::Shot { speed, .. } = a.def.action else {
                    unreachable!()
                };
                crate::projectiles::fire(a, b, damage, speed, attack, out);
            } else {
                out.health
                    .push(crate::vitals::Change::attack(a.id, b.id, damage, attack))
            }
        }
    }
}
fn pulse(a: &mut Actor, target: Id, dps: u32, rate: u64, steal: u16, out: &mut Effects) {
    let damage_rate = u128::from(a.rates().2);
    let carry = a.beam_remainders.entry(target).or_default();
    let total = u128::from(*carry) + u128::from(dps) * u128::from(rate) * damage_rate;
    let base = u128::from(TICKS_PER_SECOND) * u128::from(crate::status::NORMAL).pow(2);
    *carry = (total % base) as u64;
    let damage = (total / base).min(i32::MAX as u128) as i32;
    if damage > 0 {
        out.health
            .push(crate::vitals::Change::drain(a.id, target, damage, steal))
    }
}
