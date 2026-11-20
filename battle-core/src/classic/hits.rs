//! The projectile retains its released attack and selected ability after the
//! shooter changes forms, uses another charge, or dies.
use super::units::stat;
use crate::{vitals::Change, Actor, Battle, Control, Id, Role};
use serde_json::Value;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Attack {
    pub(crate) rules: Option<&'static Value>,
    pub(crate) ability: Option<&'static Value>,
    pub(crate) cycle: u32,
    pub(crate) close: bool,
    pub(crate) steal: u16,
}
pub(crate) fn per_hit(s: &Value, key: &str, cycle: u32, fallback: f64) -> f64 {
    s[key]
        .as_array()
        .filter(|a| !a.is_empty())
        .and_then(|a| a[(cycle as usize).saturating_sub(1) % a.len()].as_f64())
        .unwrap_or(fallback)
}
impl Attack {
    pub(crate) fn release(a: &mut Actor) -> Self {
        let ability = a.card_state.empowered.as_mut().map(|(s, count)| {
            *count -= 1;
            *s
        });
        if a.card_state.empowered.is_some_and(|(_, n)| n == 0) {
            a.card_state.empowered = None;
        }
        if let Some((_, n, _)) = &mut a.card_state.burst {
            *n = n.saturating_sub(1);
        }
        a.card_state.swing += 1;
        let s = a.def.rules.unwrap_or(&Value::Null);
        let cycle = a.card_state.swing;
        let steal = a.card_state.lifesteal.map_or(0., |(_, rate, _)| rate)
            + per_hit(s, "attack_lifesteal_ratios", cycle, 0.)
            + stat(s, "innate_lifesteal_ratio", 0.);
        Self {
            rules: a.def.rules,
            ability,
            cycle,
            close: false,
            steal: (steal * 1000.).round() as u16,
        }
    }
    pub(crate) fn damage(self, a: &mut Actor, target: Id, base: i32) -> i32 {
        let s = self.rules.unwrap_or(&Value::Null);
        let sk = self.ability.unwrap_or(&Value::Null);
        let repeat = a.card_state.repeat_hits.get(&target).copied().unwrap_or(0);
        let repeat_rate = if f64::from(repeat) + 1. == stat(s, "repeat_hit_count", 0.) {
            stat(s, "repeat_hit_multiplier", 1.)
        } else {
            1.
        };
        let crit = if s.get("rage_crit_multiplier").is_some()
            && (a.card_state.resource >= stat(s, "skill_resource_max", 2.))
        {
            if a.card_state.undying == 0 {
                a.card_state.resource = 0.;
            }
            stat(s, "rage_crit_multiplier", 1.)
        } else {
            if s.get("rage_crit_multiplier").is_some() {
                a.card_state.resource += 1.;
            }
            1.
        };
        let base = if self.close {
            (f64::from(base) * stat(s, "close_attack_damage_multiplier", 1.)).round() as i32
        } else {
            base
        };
        let base = (f64::from(base) * crit * repeat_rate).round() as i32;
        let first = if s.get("first_strike_damage_multiplier").is_some()
            && a.card_state.first_targets.insert(target)
        {
            stat(s, "first_strike_damage_multiplier", 1.)
        } else {
            1.
        };
        (f64::from(base)
            * a.card_state.forged.max(1.)
            * first
            * per_hit(s, "attack_damage_multipliers", self.cycle, 1.)
            * stat(sk, "empowered_damage_multiplier", 1.))
        .round() as i32
    }
    pub(crate) fn bonus(self, target: &Actor) -> i32 {
        let s = self.rules.unwrap_or(&Value::Null);
        let passive = per_hit(s, "attack_passive_multipliers", self.cycle, 1.);
        let tower = matches!(target.def.role, Role::LaneTower | Role::Nexus);
        let amount = if tower {
            stat(s, "on_hit_tower_damage", 0.)
        } else {
            stat(s, "on_hit_max_health_ratio", 0.) * f64::from(target.def.hp)
        };
        let first = if self.cycle == 1 {
            stat(s, "form_first_attack_damage", 0.)
                + if tower {
                    stat(s, "form_first_attack_tower_damage", 0.)
                } else {
                    stat(s, "form_first_attack_health_ratio", 0.) * f64::from(target.def.hp)
                }
        } else {
            0.
        };
        (amount * passive + first).round() as i32
    }
}
impl Battle {
    pub(crate) fn record_structure_attack(&mut self, source: Id, target: Id) {
        if !self
            .actors
            .get(&target)
            .is_some_and(|a| a.def.role.structure())
        {
            return;
        }
        if let Some(a) = self.actors.get_mut(&source) {
            let base = super::roster::rules()
                .get(a.card_state.base_key.unwrap_or(a.def.key))
                .unwrap_or(&Value::Null);
            if base.get("structure_assist_window").is_some() {
                a.card_state.structure_hits.insert(
                    target,
                    self.tick
                        + u64::from(super::units::ticks(stat(
                            base,
                            "structure_assist_window",
                            0.,
                        ))),
                );
            }
        }
    }

    pub(crate) fn attack_landed(
        &mut self,
        source: Id,
        target: Id,
        hit: Attack,
        amount: i32,
        lost: i32,
        extras: &mut Vec<Change>,
    ) {
        let Some(b) = self.actors.get(&target) else {
            return;
        };
        let pos = b.pos;
        let team = b.team;
        let role = b.def.role;
        let mass = b.def.mass;
        let s = hit.rules.unwrap_or(&Value::Null);
        let sk = hit.ability.unwrap_or(&Value::Null);
        if let Some(a) = self.actors.get_mut(&source) {
            if let Some(ratio) = sk.get("hit_heal").and_then(Value::as_f64) {
                extras.push(Change::new(source, source, ratio as i32));
            }
            if s["heal_every_hits"]
                .as_u64()
                .is_some_and(|n| u64::from(hit.cycle).is_multiple_of(n))
            {
                extras.push(
                    Change::new(source, source, stat(s, "heal_amount", 0.) as i32)
                        .on_sound(a.sound_origin(), "passive_heal"),
                );
            }
            if let Some(n) = sk.get("heal_ratio").and_then(Value::as_f64) {
                extras.push(Change::new(
                    source,
                    source,
                    (f64::from(lost) * n).round() as i32,
                ));
            }
            if s.get("attack_knockback_max_mass").is_some()
                && role == Role::Troop
                && mass < stat(s, "attack_knockback_max_mass", 0.)
            {
                let origin = a.pos;
                let facing = a.facing;
                let _ = self.resolve_motion(
                    target,
                    origin,
                    facing,
                    crate::Motion::Knockback {
                        distance: stat(s, "knockback", 0.),
                        ticks: 4,
                        mass_cap: 1.4,
                    },
                    self.tick,
                );
            }
        }
        if s.get("bleed_max_stacks").is_some() {
            self.apply_bleed(source, target, s, sk["kind"] == "bleeding_execute");
        }
        if s.get("growth_melee_hits").is_some() && role == Role::Troop {
            let ranged = self.actors[&target].def.range > 80.;
            self.kayn_forms[team.enemy().index()].record(ranged, s);
        }
        if role.structure() && s.get("structure_execute_ratio").is_some() {
            let fraction = stat(
                s,
                if role == Role::Building {
                    "structure_execute_ratio"
                } else {
                    "tower_execute_ratio"
                },
                0.,
            );
            if self.actors[&target].hp > 0
                && f64::from(self.actors[&target].hp)
                    < fraction * f64::from(self.actors[&target].def.hp)
            {
                extras.push(Change::execute(source, target, fraction));
            }
        }
        if hit.rules.is_some() {
            self.hit_form_progress(source);
        }
        self.landed_resource(source, target, hit);
        let extras_spec = &s["attack_extra_hit_damage_multipliers"];
        if let Some(seq) = extras_spec.as_array().filter(|seq| !seq.is_empty()) {
            let i = hit.cycle.saturating_sub(1) as usize % seq.len();
            if let Some(multipliers) = seq[i].as_array() {
                for (n, m) in multipliers.iter().enumerate() {
                    let ctx = crate::timeline::Origin {
                        caster: source,
                        team: team.enemy(),
                        origin: pos,
                        source_pos: pos,
                        direction: crate::Point::new(0., 1.),
                    };
                    let delay =
                        super::units::ticks(s["attack_extra_hit_delays"][i][n].as_f64().unwrap());
                    self.card_queue.push(super::casts::Pending {
                        ctx,
                        spec: s,
                        due: self.tick + u64::from(delay),
                        stage: super::casts::Stage::ExtraHit(
                            target,
                            (f64::from(amount) * m.as_f64().unwrap()).round() as i32,
                        ),
                    });
                }
            }
        }
        if let Some(window) = s["assist_conversion_window"].as_f64() {
            self.actors.get_mut(&target).unwrap().card_state.conversion = Some((
                self.tick + u64::from(super::units::ticks(window)),
                source,
                team.enemy(),
                s,
            ));
        }
        if sk["kind"] == "channeled_attack" {
            if let Some(a) = self.actors.get_mut(&source) {
                let duration = super::units::ticks(stat(sk, "duration", 0.));
                let ctx = crate::timeline::Origin {
                    caster: source,
                    team: a.team,
                    source_pos: a.pos,
                    origin: pos,
                    direction: a.facing,
                };
                a.card_state.visual_action =
                    Some(("channel", self.tick, self.tick + u64::from(duration)));
                a.card_state.channel = Some((self.tick + u64::from(duration), target));
                a.card_state.attack_lock = self.tick + u64::from(duration);
                a.card_state.move_lock = a.card_state.attack_lock;
                let mut sound = a.sound_origin();
                sound.action = "channel";
                let _ = self.apply_control(target, Control::Stun, source, duration, self.tick);
                self.ground_pulses(ctx, sound, sk);
            }
        }
        let b = self.actors.get_mut(&target).unwrap();
        if b.hp > 0 {
            if role == Role::Troop {
                b.blind = b.blind.max(stat(sk, "blind_charges", 0.) as u8);
                if let Some(slow) = s["on_hit_slow_multiplier"].as_f64() {
                    b.slows.apply(
                        source,
                        (slow * 1000.).round() as u16,
                        1000,
                        self.tick
                            + u64::from(super::units::ticks(stat(s, "on_hit_slow_duration", 0.))),
                    );
                }
            }
            let stun = stat(
                sk,
                "stun_duration",
                per_hit(s, "attack_stun_durations", hit.cycle, 0.),
            );
            if stun > 0. {
                let _ = self.apply_control(
                    target,
                    Control::Stun,
                    source,
                    super::units::ticks(stun),
                    self.tick,
                );
            }
        }
        let radius = stat(
            sk,
            "cleave_radius",
            stat(sk, "radius", stat(s, "splash_radius", 0.)),
        );
        let radius = sk["projectile_explosion_radius"].as_f64().unwrap_or(radius);
        if radius > 0. && sk["kind"] != "channeled_attack" && s["ballistic_attack"] != true {
            let damage = stat(sk, "cleave_damage", f64::from(amount)).round() as i32;
            let source_pos = self.actors.get(&source).map_or(pos, |x| x.pos);
            for a in self.actors.values().filter(|a| {
                a.id != target
                    && a.team == team
                    && (a.pos - pos).length() <= radius + a.def.radius
                    && crate::targeting::Body::from(*a).allows(team.enemy(), source_pos)
            }) {
                extras.push(Change::new(source, a.id, -damage));
            }
        }
    }
}
