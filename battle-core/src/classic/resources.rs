//! Champion resources are earned on the attack or damage receipt that owns
//! them. A cast freezes its resource ratio before it schedules any impacts.
use super::{
    hits::Attack,
    units::{stat, ticks},
};
use crate::{targeting::Body, vitals::Change, Actor, Battle, Control, Id, Point, Role};
use serde_json::Value;
impl Actor {
    pub(crate) fn gain_resource(&mut self, amount: f64, tick: u64) {
        let Some(s) = self.def.rules else {
            return;
        };
        if amount <= 0.
            || (s["skill_resource_block_during_cast"] == true && self.card_state.cast_end > tick)
        {
            return;
        }
        let max = stat(s, "skill_resource_max", 0.);
        self.card_state.resource = (self.card_state.resource + amount).min(max);
        self.card_state.resource_updated = tick;
    }
    pub(crate) fn record_position(&mut self, now: u64) {
        let Some(s) = self.def.rules else {
            return;
        };
        if let Some(duration) = s["position_history_duration"].as_f64() {
            self.card_state.history.push_back((now, self.pos));
            let earliest = now.saturating_sub(u64::from(ticks(duration)));
            while self
                .card_state
                .history
                .front()
                .is_some_and(|(t, _)| *t < earliest)
            {
                self.card_state.history.pop_front();
            }
        }
        if self.card_state.resource > 0. {
            let age = now.saturating_sub(self.card_state.resource_updated);
            if s.get("skill_resource_duration").is_some()
                && age >= u64::from(ticks(stat(s, "skill_resource_duration", 0.)))
            {
                self.card_state.resource = 0.;
            }
            if s.get("skill_resource_decay_delay").is_some()
                && age > u64::from(ticks(stat(s, "skill_resource_decay_delay", 0.)))
            {
                self.card_state.resource = (self.card_state.resource
                    - stat(s, "skill_resource_decay_rate", 0.) / 20.)
                    .max(0.);
            }
        }
    }
}
impl Battle {
    pub(crate) fn landed_resource(&mut self, source: Id, target: Id, attack: Attack) {
        let s = attack.rules.unwrap_or(&Value::Null);
        let Some(a) = self.actors.get_mut(&source) else {
            return;
        };
        a.gain_resource(
            if attack.close {
                stat(
                    s,
                    "close_attack_hit_gain",
                    stat(s, "skill_resource_hit_gain", 0.),
                )
            } else {
                stat(s, "skill_resource_hit_gain", 0.)
            },
            self.tick,
        );
        if s.get("repeat_hit_count").is_some() {
            let count = a.card_state.repeat_hits.entry(target).or_default();
            *count = count.saturating_add(1);
            if *count == stat(s, "repeat_hit_count", 0.) as u8 {
                a.tidal_haste = Some((
                    self.tick + u64::from(ticks(stat(s, "repeat_hit_haste_duration", 0.))),
                    (1000. * stat(s, "repeat_hit_speed_multiplier", 1.)) as u16,
                ));
            }
        }
    }
    pub(crate) fn aura_heal_step(&mut self) {
        let mut pulses = vec![];
        for a in self.actors.values_mut() {
            a.record_position(self.tick);
            let Some(s) = a.def.rules.filter(|s| s.get("heal_aura_amount").is_some()) else {
                continue;
            };
            if self.tick < a.ready_tick {
                continue;
            }
            let start = *a.card_state.heal_cycle.get_or_insert(
                a.ready_tick + u64::from(ticks(stat(s, "heal_aura_initial_delay", 0.))),
            );
            if self.tick < start {
                continue;
            }
            let elapsed = self.tick - start;
            if elapsed == 0 && a.disabled() {
                a.card_state.heal_cycle = Some(start + 1);
                continue;
            }
            if elapsed == u64::from(ticks(stat(s, "heal_aura_trigger_interval", 5.))) {
                a.card_state.heal_cycle = Some(self.tick);
            }
            let age = self.tick - a.card_state.heal_cycle.unwrap();
            if age > 0
                && age <= u64::from(ticks(stat(s, "heal_aura_duration", 3.)))
                && age.is_multiple_of(u64::from(ticks(stat(s, "heal_aura_pulse_interval", 0.5))))
                && !a.has(Control::Stasis)
            {
                pulses.push((a.id, a.team, a.pos, s));
            }
        }
        let mut changes = vec![];
        for (source, team, pos, s) in pulses {
            for a in self.actors.values().filter(|b| {
                b.team == team
                    && b.def.role == Role::Troop
                    && Body::from(*b).allows(team, pos)
                    && (b.pos - pos).length() <= stat(s, "heal_aura_radius", 0.) + b.def.radius
            }) {
                changes.push(Change::new(
                    source,
                    a.id,
                    stat(s, "heal_aura_amount", 0.) as i32,
                ));
            }
        }
        if !changes.is_empty() {
            self.commit(changes);
        }
    }
    pub(super) fn grow_ally(&mut self, caster: Id, s: &'static Value) -> bool {
        let a = &self.actors[&caster];
        let team = a.team;
        let pos = a.pos;
        let id = self
            .actors
            .values()
            .filter(|b| {
                b.team == team
                    && b.def.role == Role::Troop
                    && b.def.key != "anivia_egg"
                    && !b.card_state.permanent_growth
                    && Body::from(*b).allows(team, pos)
                    && (b.pos - pos).length() <= stat(s, "radius", 0.)
            })
            .min_by(|a, b| {
                let price = |a: &Actor| stat(&super::roster::rules()[a.def.key], "cost", 0.);
                price(b)
                    .total_cmp(&price(a))
                    .then_with(|| (a.pos - pos).length().total_cmp(&(b.pos - pos).length()))
                    .then(a.id.cmp(&b.id))
            })
            .map(|a| a.id);
        let Some(id) = id else {
            return false;
        };
        let a = self.actors.get_mut(&id).unwrap();
        let center = a.pos;
        let add = (f64::from(a.def.hp) * stat(s, "health_bonus_ratio", 0.)).round() as i32;
        a.def.hp += add;
        a.hp += add;
        a.def.radius *= stat(s, "body_scale_multiplier", 1.);
        a.card_state.permanent_growth = true;
        a.route_goal = None;
        let ids: Vec<_> = self
            .actors
            .values()
            .filter(|b| {
                b.team != team
                    && b.def.role == Role::Troop
                    && Body::from(*b).allows(team, center)
                    && (b.pos - center).length() <= stat(s, "knockback_radius", 0.) + b.def.radius
            })
            .map(|a| a.id)
            .collect();
        for b in ids {
            if !self.consume_effect_shield(b) {
                let _ = self.resolve_motion(
                    b,
                    center,
                    Point::new(0., 1.),
                    crate::Motion::Knockback {
                        distance: stat(s, "knockback", 0.),
                        ticks: ticks(stat(s, "knockback_duration", 0.2)),
                        mass_cap: 1.4,
                    },
                    self.tick,
                );
            }
        }
        true
    }
}

impl Actor {
    pub(crate) fn visual_state(&self, tick: u64) -> crate::model::VisualState {
        let state = &self.card_state;
        let max = self
            .def
            .rules
            .and_then(|s| s["skill_resource_max"].as_f64())
            .unwrap_or(0.);
        let casting = state.cast_end > tick;
        let form = state.last_visual_form.filter(|(start, ticks, _)| {
            tick < start + u64::from(if *ticks == 0 { 6 } else { *ticks })
        });
        crate::model::VisualState {
            action: state
                .visual_action
                .filter(|v| tick < v.2 && (v.0 != "channel" || state.channel.is_some())),
            empowered: state.empowered.is_some(),
            buff: state.buff_spec.is_some()
                || state.counter.is_some()
                || state.burst.is_some_and(|b| b.0 > tick && b.1 > 0),
            immune: state.immunity > tick,
            charge: self.def.rules.is_some_and(|s| {
                s["charge_distance"]
                    .as_f64()
                    .is_some_and(|d| state.marched >= d)
            }) || state.prepared_charge.is_some()
                || state.sweep.is_some(),
            terrain: state.in_terrain,
            reload: self.reload_left > 0,
            full: max > 0. && state.resource >= max,
            strong: casting && state.cast_resource >= 0.999,
            big: casting && state.use_number > 0 && state.use_number % 3 == 0,
            cast_resource: (casting && max > 0.)
                .then(|| (state.cast_resource * max).round() as u32),
            form_start: form.map(|f| f.0),
            form_ticks: form.map(|f| u64::from(f.1)),
            active_form: form.is_some_and(|f| f.2),
        }
    }
    pub(crate) fn bar_indicators(&self, tick: u64) -> Option<crate::model::BarIndicators> {
        use crate::model::BarIndicators;
        let resource = self.def.rules.and_then(|s| {
            let max = s.get("skill_resource_max")?.as_f64()?;
            let equipped = self.card_state.equipped_skill.is_some()
                && self.def.skill.as_ref().is_some_and(|skill| {
                    skill.effects.iter().any(|effect| match effect {
                        crate::Effect::CardAbility(ability) => {
                            ability["uses_skill_resource"] == true
                        }
                        _ => false,
                    })
                });
            let passive =
                s["skill_resource_passive"] == true || stat(s, "rage_crit_multiplier", 1.) > 1.;
            (max > 0. && (equipped || passive)).then_some((self.card_state.resource, max))
        });
        let recovery_ticks =
            if self.def.key == "sion" && self.card_state.changed_form && tick < self.ready_tick {
                u64::from(ticks(stat(
                    &super::roster::rules()["sion"],
                    "death_form_delay",
                    0.,
                )))
            } else {
                0
            };
        let bar = BarIndicators {
            shield_capacity: if matches!(self.def.role, Role::LaneTower | Role::Nexus) {
                self.shields.capacity()
            } else {
                0
            },
            untargetable: self.card_state.untargetable > tick || self.card_state.dormant,
            wounds: self.grievous_wounds,
            bleed_stacks: self
                .card_state
                .bleed
                .values()
                .map(|mark| u32::from(mark.stacks))
                .sum(),
            forged: self.card_state.forged > 1.,
            resource,
            rounds: (self.def.weapon.magazine > 0).then_some(self.rounds),
            recovery_ticks,
        };
        (bar != BarIndicators::default()).then_some(bar)
    }
}
