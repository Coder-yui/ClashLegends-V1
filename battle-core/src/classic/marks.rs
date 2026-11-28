use super::units::{stat, ticks};
use crate::{targeting::Body, vitals::Change, Battle, Id, Role, Team};
use serde_json::Value;

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct Bleed {
    pub stacks: u8,
    until: u64,
    remainder: u32,
    dps: u32,
}

impl Battle {
    pub(super) fn apply_bleed(&mut self, source: Id, target: Id, s: &'static Value, execute: bool) {
        let Some(a) = self.actors.get(&source) else {
            return;
        };
        let raging = a.card_state.rage_until > self.tick;
        let cap = stat(s, "bleed_max_stacks", 4.) as u8;
        let b = self.actors.get_mut(&target).unwrap();
        let killed = b.hp <= 0;
        let mark = b.card_state.bleed.entry(source).or_default();
        mark.stacks = if raging {
            cap
        } else {
            (mark.stacks + 1).min(cap)
        };
        mark.dps = stat(s, "bleed_damage_per_second", 0.) as u32;
        mark.until = self.tick + u64::from(ticks(stat(s, "bleed_duration", 0.)));
        if mark.stacks == cap || (execute && killed) {
            let a = self.actors.get_mut(&source).unwrap();
            a.card_state.rage_until =
                self.tick + u64::from(ticks(stat(s, "blood_rage_duration", 0.)));
            if execute && killed {
                a.card_state.free_execute = true;
            }
        }
    }
    pub(crate) fn advance_marks(&mut self) {
        let mut changes = vec![];
        let mut reveals = vec![];
        let mut groups = [vec![], vec![]];
        for a in self.actors.values_mut() {
            let id = a.id;
            a.card_state.bleed.retain(|&source, mark| {
                let total = mark.remainder + mark.dps * u32::from(mark.stacks);
                mark.remainder = total % 20;
                if total >= 20 {
                    changes.push(Change::new(source, id, -((total / 20) as i32)));
                }
                mark.until > self.tick
            });
            if a.def.key == "jack_in_the_box" && a.hidden_until > 0 && a.ready_tick <= self.tick {
                reveals.push(id);
            }
            groups[a.team.index()].push((id, a.pos, a.def.radius, Body::from(&*a)));
        }
        for id in reveals {
            let a = &self.actors[&id];
            let foes = &groups[a.team.enemy().index()];
            let found = foes.iter().any(|(_, p, r, b)| {
                b.eligible(a) && (*p - a.pos).length() <= a.def.range + a.def.radius + r
            });
            if !found {
                continue;
            }
            let range = a.def.range + a.def.radius;
            let pos = a.pos;
            let team = a.team;
            let duration = ticks(stat(a.def.rules.unwrap(), "proximity_reveal_stun", 1.));
            self.actors.get_mut(&id).unwrap().hidden_until = 0;
            for &(other, p, r, b) in foes {
                if b.role == Role::Troop
                    && b.allows(team, pos)
                    && (p - pos).length() <= range + r
                    && !self.consume_effect_shield(other)
                {
                    let _ =
                        self.apply_control(other, crate::Control::Stun, id, duration, self.tick);
                }
            }
        }
        if !changes.is_empty() {
            self.commit(changes);
        }
    }
    pub(super) fn deployment_form(&self, key: &'static str, team: Team, gold: u8) -> &'static str {
        self.seat_deployment_form(key, team.index(), gold)
    }
    pub(super) fn seat_deployment_form(
        &self,
        key: &'static str,
        seat: usize,
        gold: u8,
    ) -> &'static str {
        if key == "kayn" {
            return self.kayn_forms[seat].unlocked.unwrap_or(key);
        }
        let s = &super::roster::rules()[key];
        s["deployment_upgrade_id"]
            .as_str()
            .filter(|k| stat(&super::roster::rules()[*k], "cost", 11.) <= f64::from(gold))
            .unwrap_or(key)
    }
}
#[derive(Clone, Copy, Default)]
pub(crate) struct Growth {
    hits: [u8; 2],
    unlocked: Option<&'static str>,
}
impl Growth {
    pub(super) fn record(&mut self, ranged: bool, s: &'static Value) {
        if self.unlocked.is_some() {
            return;
        }
        let n = &mut self.hits[usize::from(ranged)];
        *n += 1;
        let (count, key) = if ranged {
            ("growth_ranged_hits", "growth_ranged_id")
        } else {
            ("growth_melee_hits", "growth_melee_id")
        };
        if *n >= stat(s, count, 255.) as u8 {
            self.unlocked = s[key].as_str();
        }
    }
}
