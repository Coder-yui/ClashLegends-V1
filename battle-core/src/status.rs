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
        let (movement, attack) = self.slows.rates();
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
