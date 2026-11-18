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
}
impl Change {
    pub fn new(source: Id, target: Id, amount: i32) -> Self {
        Self {
            source,
            target,
            amount,
            steal: 0,
            check_shield: true,
        }
    }
    pub fn delivered(source: Id, target: Id, amount: i32) -> Self {
        Self {
            check_shield: false,
            ..Self::new(source, target, amount)
        }
    }
    pub fn drain(source: Id, target: Id, damage: i32, steal: u16) -> Self {
        Self {
            source,
            target,
            amount: -damage,
            steal,
            check_shield: true,
        }
    }
}
#[derive(Clone, Copy, Debug)]
struct Layer {
    hp: i32,
    expires: u64,
}
#[derive(Clone, Debug, Default)]
pub(crate) struct Shields(Vec<Layer>);
impl Shields {
    pub fn add(&mut self, hp: i32, expires: u64) {
        let idx = self.0.partition_point(|l| l.expires <= expires);
        self.0.insert(idx, Layer { hp, expires });
    }
    pub fn expire(&mut self, tick: u64) {
        self.0.retain(|s| s.expires > tick)
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
        for Change {
            source,
            target,
            amount,
            steal,
            check_shield,
        } in changes
        {
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
            if a.hp <= 0 {
                continue;
            }
            let before = a.hp;
            let delta = if amount < 0 {
                -a.shields.absorb(-amount)
            } else {
                amount
            };
            a.hp = a.hp.saturating_add(delta).clamp(0, a.def.hp);
            let change = a.hp - before;
            if amount < 0 {
                self.emit(Fact::Damage {
                    source,
                    target,
                    requested: -amount,
                    absorbed: delta - amount,
                    lost: -change,
                    killed: before + change == 0,
                });
            }
            if change != 0 {
                self.emit(Fact::Health {
                    source,
                    target,
                    change,
                });
            }
            if change < 0 && steal > 0 {
                if let Some(caster) = self
                    .actors
                    .get_mut(&source)
                    .filter(|a| a.hp > 0 && !a.has(Control::Stasis))
                {
                    let scaled = u64::from((-change) as u32) * u64::from(steal)
                        + u64::from(caster.steal_carry);
                    caster.steal_carry = (scaled % 1000) as u16;
                    let heal = (scaled / 1000).min((caster.def.hp - caster.hp) as u64) as i32;
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
        self.remove_dead()
    }
}
