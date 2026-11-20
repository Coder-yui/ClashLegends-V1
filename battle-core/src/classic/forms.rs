use super::{
    roster::rules,
    units::{from_stats, stat, ticks},
};
use crate::{Battle, HealthOnChange, Id};
impl Battle {
    pub(super) fn switch_card_form(&mut self, id: Id, active: bool) -> bool {
        let Some(a) = self.actors.get(&id) else {
            return false;
        };
        let key = a.card_state.base_key.unwrap_or(a.def.key);
        let base = &rules()[key];
        let entering = !a.card_state.changed_form;
        let spec = if entering {
            &base["transformed_stats"]
        } else {
            base
        };
        if !spec.is_object() {
            return false;
        }
        let mut def = from_stats(
            if entering && key == "scarecrow" {
                "fiddlesticks"
            } else {
                key
            },
            spec,
        );
        def.skill = a.def.skill.clone();
        let grant = entering && matches!(key, "gnar" | "aatrox");
        let old_hp = a.hp;
        let old_max = a.def.hp;
        let max = def.hp;
        let lock = ticks(stat(
            base,
            if !entering {
                "revert_duration"
            } else if active && grant {
                "active_transform_duration"
            } else {
                "transform_duration"
            },
            0.,
        ));
        if self
            .replace_form(id, def, HealthOnChange::Keep, lock)
            .is_err()
        {
            return false;
        }
        let a = self.actors.get_mut(&id).unwrap();
        a.hp = (old_hp + if grant { (max - old_max).max(0) } else { 0 }).clamp(1, max);
        a.card_state.base_key = Some(key);
        a.card_state.changed_form = entering;
        a.card_state.last_visual_form = Some((self.tick, lock, active));
        a.card_state.form_hits = 0;
        a.card_state.hit_haste = None;
        a.card_state.swing = 0;
        let lifetime = stat(base, "form_lifetime", 0.);
        let cycle = stat(base, "form_cycle_interval", 0.);
        a.card_state.form_due = if cycle > 0. {
            self.tick + u64::from(ticks(cycle))
        } else if entering && lifetime > 0. {
            self.tick
                + u64::from(ticks(lifetime))
                + if base["form_lifetime_after_transition"] == true {
                    u64::from(lock)
                } else {
                    0
                }
        } else {
            0
        };
        if entering && base.get("form_speed_boost_multiplier").is_some() {
            a.tidal_haste = Some((
                self.tick + u64::from(ticks(stat(base, "form_speed_boost_duration", 0.))),
                (1000. * stat(base, "form_speed_boost_multiplier", 1.)).round() as u16,
            ));
        }
        true
    }
    pub(crate) fn card_form_step(&mut self) {
        let mut switches = vec![];
        for a in self.actors.values_mut() {
            let Some(s) = a.def.rules else {
                continue;
            };
            if self.tick < a.ready_tick {
                continue;
            }
            if a.card_state.form_due == 0 && s.get("form_cycle_interval").is_some() {
                a.card_state.form_due =
                    self.tick + u64::from(ticks(stat(s, "form_cycle_interval", 0.)));
            }
            if a.card_state.form_due > 0 && self.tick >= a.card_state.form_due && !a.disabled() {
                switches.push(a.id);
            }
            if a.card_state
                .hit_haste
                .is_some_and(|(until, _, _)| until <= self.tick)
            {
                a.card_state.hit_haste = None;
            }
        }
        for id in switches {
            self.switch_card_form(id, false);
        }
    }
    pub(crate) fn hit_form_progress(&mut self, id: Id) {
        let Some(a) = self.actors.get_mut(&id) else {
            return;
        };
        let Some(s) = a.def.rules else {
            return;
        };
        if let Some(gain) = s["hit_haste_per_stack"].as_f64() {
            let (_, stacks, _) = a.card_state.hit_haste.unwrap_or_default();
            let next = (stacks + 1).min(stat(s, "hit_haste_max_stacks", 1.) as u8);
            a.card_state.hit_haste = Some((
                self.tick + u64::from(ticks(stat(s, "hit_haste_duration", 0.))),
                next,
                (1000. * (1. + gain * f64::from(next))).round() as u16,
            ));
        }
        let base = &rules()[a.card_state.base_key.unwrap_or(a.def.key)];
        let threshold = base[if a.card_state.changed_form {
            "revert_after_hits"
        } else {
            "transform_after_hits"
        }]
        .as_u64();
        if let Some(n) = threshold {
            a.card_state.form_hits += 1;
            if u64::from(a.card_state.form_hits) >= n {
                self.switch_card_form(id, false);
            }
        }
    }
    pub(crate) fn card_kill(&mut self, id: Id, target: Id) {
        let structure = self
            .actors
            .get(&target)
            .is_some_and(|a| a.def.role.structure());
        if let Some((a, s)) = self
            .actors
            .get_mut(&id)
            .and_then(|a| a.def.rules.map(|s| (a, s)))
        {
            let key = a.card_state.base_key.unwrap_or(a.def.key);
            let base = &rules()[key];
            if a.card_state.changed_form && base["form_refresh_on_kill"] == true {
                a.card_state.form_due =
                    self.tick + u64::from(ticks(stat(base, "form_lifetime", 0.)));
                a.tidal_haste = Some((
                    self.tick + u64::from(ticks(stat(base, "form_speed_boost_duration", 0.))),
                    (1000. * stat(base, "form_speed_boost_multiplier", 1.)).round() as u16,
                ));
            }
            a.card_state.resource = (a.card_state.resource
                + stat(s, "skill_resource_kill_gain", 0.))
            .min(stat(s, "skill_resource_max", 0.));
        }
        let mut audible = vec![];
        if self
            .actors
            .get(&id)
            .is_some_and(|a| a.card_state.changed_form && a.def.key == "aatrox")
        {
            self.unit_sound(id, "form:refresh", None);
        }
        if structure {
            for a in self.actors.values_mut() {
                if a.card_state
                    .structure_hits
                    .remove(&target)
                    .is_some_and(|until| until >= self.tick)
                {
                    audible.push(a.id);
                    let s = &rules()[a.card_state.base_key.unwrap_or(a.def.key)];
                    let until =
                        self.tick + u64::from(ticks(stat(s, "structure_haste_duration", 0.)));
                    a.empowerment = Some(crate::status::Empowerment {
                        until,
                        movement: (1000. * (1. + stat(s, "structure_haste_speed_bonus", 0.)))
                            .round() as u16,
                        attack: (1000. * stat(s, "structure_haste_attack_speed", 1.)).round()
                            as u16,
                        damage: 1000,
                    });
                }
            }
        }
        for unit in audible {
            self.unit_sound(unit, "structure_haste:start", None);
        }
    }
    pub(crate) fn native_death_form(&mut self, id: Id) -> bool {
        let a = &self.actors[&id];
        if a.def.key != "sion" || a.def.rules.is_none() || a.card_state.changed_form {
            return false;
        }
        self.unit_sound(id, "rebirth:begin", None);
        self.unit_sound(id, "rebirth:voice", None);
        if !self.switch_card_form(id, false) {
            return false;
        }
        let a = self.actors.get_mut(&id).unwrap();
        a.hp = a.def.hp;
        a.def.skill = None;
        a.controls = Default::default();
        a.shields = Default::default();
        a.grievous_wounds = false;
        let s = &rules()["sion"];
        a.ready_tick = self.tick + u64::from(ticks(stat(s, "death_form_delay", 0.)));
        a.card_state.visual_action = Some(("death_form", self.tick, a.ready_tick));
        a.card_state.untargetable = a.ready_tick;
        a.def.lifecycle.decay_ticks = ticks(stat(s, "death_form_decay_duration", 0.));
        true
    }
}
