use crate::Id;
use std::collections::BTreeMap;
/// Rates are thousandths of the base value. Separate sources expire independently.
pub(crate) const NORMAL: u16 = 1000;
#[derive(Clone, Copy, Debug)]
struct Slow {
    movement: u16,
    attack: u16,
    until: u64,
}
#[derive(Clone, Debug, Default)]
pub(crate) struct Slows(BTreeMap<Id, Slow>);
impl Slows {
    pub fn apply(&mut self, source: Id, movement: u16, attack: u16, until: u64) {
        let until = self
            .0
            .get(&source)
            .filter(|s| s.movement == movement && s.attack == attack)
            .map_or(until, |s| s.until.max(until));
        self.0.insert(
            source,
            Slow {
                movement,
                attack,
                until,
            },
        );
    }
    pub fn expire(&mut self, tick: u64) {
        self.0.retain(|_, s| s.until > tick);
    }
    pub fn rates(&self) -> (u16, u16) {
        self.0
            .values()
            .fold((NORMAL, NORMAL), |(movement, attack), s| {
                (movement.min(s.movement), attack.min(s.attack))
            })
    }
}

#[derive(Clone, Debug, Default)]
pub(crate) struct Controls(BTreeMap<crate::Control, BTreeMap<Id, u64>>);
impl Controls {
    pub fn has(&self, kind: crate::Control) -> bool {
        self.0.contains_key(&kind)
    }
    pub fn apply(&mut self, kind: crate::Control, source: Id, until: u64) {
        let sources = self.0.entry(kind).or_default();
        if kind == crate::Control::Taunt && !sources.contains_key(&source) {
            sources.clear()
        }
        let expiry = sources.entry(source).or_default();
        *expiry = (*expiry).max(until);
    }
    pub fn remove(&mut self, kind: crate::Control, source: Id) {
        if let Some(s) = self.0.get_mut(&kind) {
            s.remove(&source);
            if s.is_empty() {
                self.0.remove(&kind);
            }
        }
    }
    pub fn source(&self, kind: crate::Control) -> Option<Id> {
        self.0.get(&kind)?.keys().next().copied()
    }
    pub fn types(&self) -> Vec<crate::Control> {
        self.0.keys().copied().collect()
    }
    pub fn expire(&mut self, tick: u64) {
        self.0.retain(|_, s| {
            s.retain(|_, until| *until > tick);
            !s.is_empty()
        });
    }
}
#[derive(Clone, Copy, Debug)]
pub(crate) struct Sanctuary {
    pub center: crate::Point,
    pub radius: f64,
    pub until: u64,
}
impl Sanctuary {
    pub fn contains(self, p: crate::Point) -> bool {
        (self.center - p).length() <= self.radius
    }
}

/// An active self-empowerment refreshes its own duration. Enemy slows stay
/// independently sourced and expire on their original clocks.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Empowerment {
    pub movement: u16,
    pub attack: u16,
    pub damage: u16,
    pub until: u64,
}
impl crate::Actor {
    pub fn rates(&self) -> (u16, u16, u16) {
        let (mut movement, mut attack) = self.slows.rates();
        if let Some((_, _, haste)) = self.card_state.hit_haste {
            attack = (u32::from(attack) * u32::from(haste) / 1000) as u16;
        }
        if let Some((_, _, rate)) = self.card_state.burst {
            attack = (f64::from(attack) * rate).round() as u16;
        }
        if let Some(s) = self.card_state.buff_spec {
            if s["ignore_attack_speed_slow"] == true {
                attack = 1000;
            }
            if s["ignore_movement_slow"] == true {
                movement = 1000;
            }
        }
        if let Some((s, _)) = self.card_state.empowered {
            movement = (f64::from(movement)
                * s["empowered_speed_multiplier"].as_f64().unwrap_or(1.))
            .round() as u16;
        }
        let attack =
            (u32::from(attack) * u32::from(self.card_state.aura_attack.max(1000)) / 1000) as u16;
        let movement = if let Some(s) = self.def.rules {
            let m = if self.card_state.in_terrain {
                s["terrain_entry_speed_multiplier"].as_f64().unwrap_or(1.)
            } else if s["charge_distance"]
                .as_f64()
                .is_some_and(|d| self.card_state.marched >= d)
            {
                s["charge_speed_multiplier"].as_f64().unwrap_or(1.)
            } else {
                1.
            };
            (f64::from(movement) * m).round() as u16
        } else {
            movement
        };
        let movement = if let Some(s) = self
            .def
            .rules
            .filter(|s| s.get("skill_resource_move_per_stack").is_some())
        {
            let bonus = if self.card_state.resource >= s["skill_resource_max"].as_f64().unwrap() {
                s["skill_resource_full_move_bonus"].as_f64().unwrap()
            } else {
                self.card_state.resource * s["skill_resource_move_per_stack"].as_f64().unwrap()
            };
            (f64::from(movement) * (1. + bonus)).round() as u16
        } else {
            movement
        };
        let movement = self.tidal_haste.map_or(movement, |(_, rate)| {
            (u32::from(movement) * u32::from(rate) / 1000) as u16
        });
        let Some(b) = self.empowerment else {
            return (movement, attack, NORMAL);
        };
        let combine = |a: u16, b: u16| ((u32::from(a) * u32::from(b)) / u32::from(NORMAL)) as u16;
        (
            combine(movement, b.movement),
            combine(attack, b.attack),
            b.damage,
        )
    }
}
