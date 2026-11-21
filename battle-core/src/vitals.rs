//! Integer health and per-source shield layers. Lifesteal reads the receipt from
//! the exact hit, before corpses are removed from the current batch.
use crate::{Battle, Control, Fact, Id};
#[derive(Clone, Copy, Debug)]
pub(crate) struct Change {
    source: Id,
    target: Id,
    amount: i32,
    steal: u16,
    check_shield: bool,
    overflow: Option<(f64, u64)>,
    execute: Option<f64>,
    sound: Option<(crate::SoundOrigin, &'static str)>,
    contact: Option<crate::AttackSound>,
    group: Option<(crate::SoundOrigin, &'static str, bool)>,
    attack: Option<crate::classic::Attack>,
}
impl Change {
    pub fn new(source: Id, target: Id, amount: i32) -> Self {
        Self {
            source,
            target,
            amount,
            steal: 0,
            check_shield: true,
            overflow: None,
            execute: None,
            contact: None,
            group: None,
            sound: None,
            attack: None,
        }
    }
    pub fn attack(source: Id, target: Id, damage: i32, hit: crate::classic::Attack) -> Self {
        Self {
            attack: Some(hit),
            steal: hit.steal,
            ..Self::new(source, target, -damage)
        }
    }
    pub fn contact(mut self, sound: crate::AttackSound) -> Self {
        self.contact = Some(sound);
        self
    }
    pub fn on_sound(mut self, source: crate::SoundOrigin, phase: &'static str) -> Self {
        self.sound = Some((source, phase));
        self
    }
    pub fn group_sound(
        mut self,
        source: crate::SoundOrigin,
        phase: &'static str,
        center: bool,
    ) -> Self {
        self.group = Some((source, phase, center));
        self
    }
    pub fn execute(source: Id, target: Id, ratio: f64) -> Self {
        Self {
            execute: Some(ratio),
            ..Self::new(source, target, 0)
        }
    }
    pub fn overheal(source: Id, target: Id, amount: i32, ratio: f64, expiry: u64) -> Self {
        Self {
            overflow: Some((ratio, expiry)),
            ..Self::new(source, target, amount)
        }
    }
    pub fn delivered(source: Id, target: Id, amount: i32) -> Self {
        Self {
            check_shield: false,
            ..Self::new(source, target, amount)
        }
    }
    pub fn skill_hit(source: Id, target: Id, amount: i32, steal: f64) -> Self {
        Self {
            steal: (steal * 1000.).round() as u16,
            ..Self::delivered(source, target, -amount)
        }
    }
    pub fn drain(source: Id, target: Id, damage: i32, steal: u16) -> Self {
        Self {
            source,
            target,
            amount: -damage,
            steal,
            check_shield: true,
            overflow: None,
            execute: None,
            contact: None,
            group: None,
            sound: None,
            attack: None,
        }
    }
}
#[derive(Clone, Copy, Debug)]
struct Layer {
    capacity: i32,
    hp: i32,
    expires: u64,
    pool: bool,
    restore: bool,
    explosive: Option<&'static serde_json::Value>,
    deployment: bool,
    decay: Option<(i32, u64)>,
}
#[derive(Clone, Debug, Default)]
pub(crate) struct Shields(Vec<Layer>);
impl Shields {
    pub fn restoration_until(&self) -> Option<u64> {
        self.0
            .iter()
            .filter(|l| l.restore && l.hp > 0)
            .map(|l| l.expires)
            .max()
    }
    pub fn pool_active(&self) -> bool {
        self.0.iter().any(|l| l.pool && l.hp > 0)
    }
    pub fn explosive_active(&self) -> bool {
        self.0.iter().any(|l| l.explosive.is_some() && l.hp > 0)
    }
    pub fn add(&mut self, hp: i32, expires: u64) {
        let idx = self.0.partition_point(|l| l.expires <= expires);
        self.0.insert(
            idx,
            Layer {
                capacity: hp,
                hp,
                expires,
                pool: false,
                restore: false,
                explosive: None,
                deployment: false,
                decay: None,
            },
        );
    }
    pub fn decaying(&mut self, hp: i32, start: u64, end: u64) {
        if end <= start || hp <= 0 {
            return;
        }
        let idx = self.0.partition_point(|layer| layer.expires <= end);
        self.0.insert(
            idx,
            Layer {
                capacity: hp,
                hp,
                expires: end,
                decay: Some((hp, end - start)),
                pool: false,
                restore: false,
                explosive: None,
                deployment: false,
            },
        );
    }
    pub fn replenish(&mut self, hp: i32, expires: u64) {
        let previous = self
            .0
            .iter()
            .position(|layer| layer.pool)
            .map(|idx| self.0.remove(idx));
        let capacity = previous.map_or(0, |l| l.capacity);
        let hp = hp.saturating_add(previous.map_or(0, |l| l.hp));
        let idx = self.0.partition_point(|l| l.expires <= expires);
        self.0.insert(
            idx,
            Layer {
                hp,
                capacity: capacity.max(hp),
                expires,
                pool: true,
                restore: false,
                explosive: None,
                deployment: false,
                decay: None,
            },
        );
    }
    pub fn explosive(&mut self, hp: i32, expires: u64, s: &'static serde_json::Value) {
        self.0.retain(|l| l.explosive.is_none());
        let idx = self.0.partition_point(|l| l.expires <= expires);
        self.0.insert(
            idx,
            Layer {
                capacity: hp,
                hp,
                expires,
                pool: false,
                restore: false,
                explosive: Some(s),
                deployment: false,
                decay: None,
            },
        );
    }
    pub fn expiry_burst(&self, tick: u64) -> Option<&'static serde_json::Value> {
        self.0
            .iter()
            .find(|l| l.hp > 0 && l.expires <= tick && l.explosive.is_some())
            .and_then(|l| l.explosive)
    }
    pub fn deployment(&mut self, hp: i32) {
        self.0.push(Layer {
            capacity: hp,
            hp,
            expires: u64::MAX,
            pool: false,
            restore: false,
            explosive: None,
            deployment: true,
            decay: None,
        });
    }
    pub fn has_deployment(&self) -> bool {
        self.0.iter().any(|l| l.deployment)
    }
    pub fn restoration(&mut self, hp: i32, expires: u64) {
        let idx = self.0.partition_point(|l| l.expires <= expires);
        self.0.insert(
            idx,
            Layer {
                capacity: hp,
                hp,
                expires,
                pool: false,
                restore: true,
                explosive: None,
                deployment: false,
                decay: None,
            },
        );
    }
    pub fn expire(&mut self, tick: u64) -> bool {
        for layer in &mut self.0 {
            if let Some((initial, duration)) = layer.decay {
                let left = layer.expires.saturating_sub(tick).min(duration);
                let previous = (left + 1).min(duration);
                let original_at = |t: u64| (i64::from(initial) * t as i64 / duration as i64) as i32;
                layer.hp = layer
                    .hp
                    .saturating_sub(original_at(previous) - original_at(left))
                    .max(0);
            }
        }
        let restore = self
            .0
            .iter()
            .any(|s| s.expires <= tick && s.restore && s.hp > 0);
        self.0.retain(|s| s.expires > tick);
        restore
    }
    pub fn capacity(&self) -> i32 {
        self.0
            .iter()
            .filter(|l| l.hp > 0)
            .fold(0i32, |sum, l| sum.saturating_add(l.capacity))
    }
    pub fn total(&self) -> i32 {
        self.0.iter().fold(0i32, |sum, s| sum.saturating_add(s.hp))
    }
    fn absorb(&mut self, mut damage: i32) -> i32 {
        for l in &mut self.0 {
            let spent = l.hp.min(damage);
            damage -= spent;
            l.hp -= spent;
            if damage == 0 {
                break;
            }
        }
        self.0.retain(|s| s.hp > 0);
        damage
    }
}
impl Battle {
    pub(crate) fn commit(&mut self, changes: Vec<Change>) {
        let mut groups = std::collections::BTreeMap::new();
        let mut extras = vec![];
        for Change {
            source,
            target,
            mut amount,
            steal,
            check_shield,
            overflow,
            execute,
            sound,
            group,
            contact,
            attack,
        } in changes
        {
            if let Some(hit) = attack {
                if let Some(sk) = hit.ability.filter(|s| s["kind"] == "bleeding_execute") {
                    let stacks = self
                        .actors
                        .get(&target)
                        .and_then(|b| b.card_state.bleed.get(&source))
                        .map_or(0, |m| m.stacks);
                    let rage = if self
                        .actors
                        .get(&source)
                        .is_some_and(|a| a.card_state.rage_until > self.tick)
                    {
                        2.
                    } else {
                        1.
                    };
                    amount = -(sk["damage"].as_f64().unwrap()
                        * rage
                        * (1.
                            + f64::from(stacks) * sk["execute_damage_per_stack"].as_f64().unwrap()))
                    .round() as i32;
                }
                if hit
                    .ability
                    .is_none_or(|s| s["strike_type"] != "skill" && s["kind"] != "frontal")
                {
                    if let Some((end, n, s)) = self
                        .actors
                        .get_mut(&target)
                        .and_then(|a| a.card_state.counter.as_mut())
                    {
                        if *end > self.tick {
                            *n = n
                                .saturating_add(1)
                                .min(s["max_dodges"].as_u64().unwrap_or(5) as u8);
                            continue;
                        }
                    }
                }
            }
            if amount < 0
                && check_shield
                && self.actors.get(&target).is_some_and(|a| a.hp > 0)
                && self.consume_effect_shield(target)
            {
                continue;
            }
            let Some(a) = self.actors.get_mut(&target) else {
                continue;
            };
            if a.hp <= 0 || (a.grievous_wounds && amount > 0) {
                continue;
            }
            if let Some(hit) = attack {
                amount -= hit.bonus(a);
            }
            let mut sunlight = None;
            let position = a.pos;
            if amount < 0 {
                if let Some((origin, until, bonus)) = a.sunlight.take() {
                    if self.tick < until {
                        amount -= bonus;
                        sunlight = Some(origin);
                    }
                }
            }
            if let Some(ratio) = execute {
                if a.card_state.undying <= self.tick
                    && f64::from(a.hp) < f64::from(a.def.hp) * ratio
                {
                    a.hp = 0;
                    if let Some((origin, phase)) = sound {
                        self.sound(origin, phase, position, Some(target));
                    }
                }
                continue;
            }
            if amount < 0 {
                amount = (f64::from(amount) * (1. - a.reduction(self.tick))).round() as i32;
            }
            let explosive = a.shields.explosive_active();
            let deployment = a.shields.has_deployment();
            let before = a.hp;
            let delta = if amount < 0 {
                -a.shields.absorb(-amount)
            } else {
                amount
            };
            a.hp = if delta <= 0 {
                a.hp.saturating_add(delta).max(0)
            } else {
                a.hp.max(a.hp.saturating_add(delta).min(a.def.hp))
            };
            if a.card_state.undying > self.tick {
                a.hp = a.hp.max(1);
            }
            let change = a.hp - before;
            if change < 0 {
                let gain = a
                    .def
                    .rules
                    .and_then(|s| s["skill_resource_damage_gain_multiplier"].as_f64())
                    .unwrap_or(0.);
                a.gain_resource(f64::from(-change) * gain, self.tick);
            }
            if let Some((ratio, expiry)) = overflow {
                let hp = (f64::from(amount - change) * ratio).round() as i32;
                if hp > 0 {
                    a.shields.add(hp, expiry);
                }
            }
            let disabled = a.hp > 0 && a.def.role == crate::Role::LaneTower && a.has(Control::Stun);
            let target_origin = a.sound_origin();
            let broke_explosive = explosive && !a.shields.explosive_active();
            let broke_deployment = deployment && !a.shields.has_deployment();
            if broke_explosive {
                self.sound(
                    target_origin,
                    "explosive_shield:break",
                    position,
                    Some(target),
                );
            }
            if broke_deployment {
                self.sound(
                    target_origin,
                    "deployment_shield:break",
                    position,
                    Some(target),
                );
            }
            if let Some((origin, phase, center)) = group {
                let entry = groups
                    .entry((origin.owner, phase))
                    .or_insert((origin, false));
                entry.1 |= center;
            }
            if let Some(origin) = sunlight {
                self.sound(origin, "spell:sunlight", position, Some(target));
            }
            if let Some((origin, phase)) = sound {
                self.sound(origin, phase, position, Some(target));
                if origin.kind == "medium_lightning" && disabled {
                    self.sound(origin, "spell:tower_disable", position, Some(target));
                }
            }
            if amount < 0 {
                self.emit(Fact::Damage {
                    contact,
                    source,
                    target,
                    requested: -amount,
                    absorbed: delta - amount,
                    lost: -change,
                    killed: before + change == 0,
                });
            }
            if amount < 0 {
                for id in [source, target] {
                    if let Some(a) = self.actors.get_mut(&id) {
                        a.card_state.last_combat = self.tick;
                    }
                }
            }
            if change != 0 {
                self.emit(Fact::Health {
                    source,
                    target,
                    change,
                });
            }
            if attack.is_some() {
                self.record_structure_attack(source, target);
            }
            if amount < 0 && before + change == 0 {
                if attack
                    .is_some_and(|hit| hit.ability.is_some_and(|s| s["kind"] == "bleeding_execute"))
                {
                    self.unit_sound(source, "execute:kill", Some(target));
                }
                self.card_kill(source, target);
            }
            if let Some(hit) = attack {
                self.attack_landed(source, target, hit, -amount, -change, &mut extras);
            }
            if change < 0 && steal > 0 {
                if let Some(caster) = self
                    .actors
                    .get_mut(&source)
                    .filter(|a| a.hp > 0 && !a.has(Control::Stasis) && !a.grievous_wounds)
                {
                    let scaled = u64::from((-change) as u32) * u64::from(steal)
                        + u64::from(caster.steal_carry);
                    caster.steal_carry = (scaled % 1000) as u16;
                    let cap = (f64::from(caster.def.hp)
                        * caster.card_state.lifesteal.map_or(1., |(_, _, cap)| cap))
                    .round() as i32;
                    let heal = (scaled / 1000).min((cap - caster.hp).max(0) as u64) as i32;
                    caster.hp += heal;
                    if heal > 0 {
                        self.emit(Fact::Health {
                            source,
                            target: source,
                            change: heal,
                        })
                    }
                }
            }
        }
        for ((id, phase), (origin, center)) in groups {
            if let Some(pos) = self.actors.get(&id).map(|a| a.pos) {
                let phased = match (phase, center) {
                    ("@hit_first", true) => "@hit_first_center",
                    ("@hit_middle", true) => "@hit_middle_center",
                    ("@hit_last", true) => "@hit_last_center",
                    _ => phase,
                };
                self.sound(origin, phased, pos, None);
                if center {
                    self.sound(origin, "@hit_center", pos, None);
                }
            }
        }
        if extras.is_empty() {
            self.remove_dead()
        } else {
            self.commit(extras)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Shields;

    #[test]
    fn bar_capacity_tracks_only_live_layers_and_retains_their_peak() {
        let mut shields = Shields::default();
        shields.add(40, 5);
        shields.replenish(60, 10);
        shields.absorb(25);
        assert_eq!((shields.total(), shields.capacity()), (75, 100));
        shields.expire(5);
        assert_eq!((shields.total(), shields.capacity()), (60, 60));
        shields.absorb(30);
        shields.replenish(10, 12);
        assert_eq!((shields.total(), shields.capacity()), (40, 60));
        shields.replenish(30, 13);
        assert_eq!((shields.total(), shields.capacity()), (70, 70));
        shields.absorb(70);
        assert_eq!((shields.total(), shields.capacity()), (0, 0));
    }
}
