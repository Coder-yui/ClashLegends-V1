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
    pub next_id: Id,
}
impl Effects {
    pub fn new(next_id: Id) -> Self {
        Self {
            facts: vec![],
            health: vec![],
            shots: vec![],
            next_id,
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
    if distance > a.def.range + 1e-8
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
    if a.drain.active_left == 0 {
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
            if a.release_at.is_none() {
                let earliest = (start + u64::from(windup) * scale).max(a.attack_clock);
                if a.next_attack > earliest {
                    a.activity = Activity::Recover;
                    return;
                }
                // The step that starts a swing also advances its first 50 ms.
                let due = a.next_attack.max(earliest);
                a.release_at = Some(due);
                out.facts.push(Fact::AttackStarted(a.id, b.id));
            }
            if a.attack_clock < a.release_at.unwrap() {
                a.activity = Activity::Windup;
                return;
            }
            a.release_at = None;
            a.next_attack = a.attack_clock + u64::from(interval) * scale;
            a.activity = Activity::Recover;
            crate::projectiles::spent(a);
            if a.blind > 0 {
                a.blind -= 1;
                out.facts.push(Fact::Missed {
                    source: a.id,
                    target: b.id,
                });
                return;
            }
            let damage = ((i64::from(damage) * i64::from(damage_rate) + 500) / 1000)
                .min(i64::from(i32::MAX)) as i32;
            if let Action::Shot { speed, .. } = a.def.action {
                crate::projectiles::fire(a, b, damage, speed, out);
            } else {
                out.health
                    .push(crate::vitals::Change::new(a.id, b.id, -damage))
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
