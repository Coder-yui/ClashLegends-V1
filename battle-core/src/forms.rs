use crate::{movement, space::Query, Battle, Error, Fact, Id, Team, UnitDef};
#[derive(Clone, Copy, Debug)]
pub enum HealthOnChange {
    Keep,
    Full,
    Fraction,
}
#[derive(Clone, Copy, Debug)]
pub struct Transform {
    pub form: fn() -> UnitDef,
    pub health: HealthOnChange,
    pub lock: u32,
    pub revert_after: Option<u32>,
}
#[derive(Clone, Copy, Debug)]
pub struct Rebirth {
    pub form: fn() -> UnitDef,
    pub hatch_after: u32,
    pub charges: u8,
}
#[derive(Clone, Debug)]
pub(crate) struct Revert {
    form: UnitDef,
    due: u64,
    health: HealthOnChange,
}
impl Battle {
    pub(crate) fn replace_form(
        &mut self,
        id: Id,
        def: UnitDef,
        health: HealthOnChange,
        lock: u32,
    ) -> Result<UnitDef, Error> {
        if !def.valid() {
            return Err(Error::InvalidDefinition);
        }
        let a = self.actors.get(&id).ok_or(Error::NoTarget)?;
        let blocks = movement::blockers(&self.actors);
        let q = Query {
            cross_river: def
                .rules
                .is_some_and(|s| s["river_traversal"] == true || s["terrain_traversal"] == true),
            map: &self.map,
            blocks: &blocks,
            id,
            layer: def.layer,
            radius: def.radius,
        };
        let pos = q
            .nearest(a.pos, if a.team == Team::Blue { -1. } else { 1. })
            .ok_or(Error::InvalidPoint)?;
        let a = self.actors.get_mut(&id).unwrap();
        let old = std::mem::replace(&mut a.def, def);
        a.hp = match health {
            HealthOnChange::Keep => a.hp.clamp(1, a.def.hp),
            HealthOnChange::Full => a.def.hp,
            HealthOnChange::Fraction => (i64::from(a.hp) * i64::from(a.def.hp) / i64::from(old.hp))
                .clamp(1, i64::from(a.def.hp)) as i32,
        };
        a.pos = pos;
        a.deploy_start = self.tick;
        a.ready_tick = self.tick + u64::from(lock);
        a.reset_attack();
        a.target = None;
        a.route_goal = None;
        a.avoidance_turn = 0.;
        a.flight = None;
        a.production_left = 0;
        a.decay_carry = 0;
        a.rounds = a.def.weapon.magazine;
        a.reload_left = 0;
        a.beam_remainders.clear();
        a.revert = None;
        let key = a.def.key;
        self.cancel_owned_areas(id);
        self.emit(Fact::FormChanged {
            id,
            from: old.key,
            to: key,
        });
        Ok(old)
    }
    pub(crate) fn transform(&mut self, id: Id, t: Transform) -> Result<(), Error> {
        let old = self.replace_form(id, (t.form)(), t.health, t.lock)?;
        if let Some(duration) = t.revert_after {
            self.actors.get_mut(&id).unwrap().revert = Some(Revert {
                form: old,
                due: self.tick + u64::from(duration),
                health: HealthOnChange::Keep,
            });
        }
        Ok(())
    }
    pub(crate) fn rebirth(&mut self, id: Id) -> bool {
        let a = &self.actors[&id];
        let Some(r) = a.def.lifecycle.rebirth else {
            return false;
        };
        if a.lives == 0 {
            return false;
        }
        let Ok(old) = self.replace_form(id, (r.form)(), HealthOnChange::Full, 1) else {
            return false;
        };
        let a = self.actors.get_mut(&id).unwrap();
        a.lives -= 1;
        a.controls = Default::default();
        a.shields = Default::default();
        a.effect_shield_until = 0;
        a.slows = Default::default();
        a.grievous_wounds = false;
        a.sunlight = None;
        a.empowerment = None;
        a.sanctuary = None;
        a.hidden_until = 0;
        a.blind = 0;
        a.revert = Some(Revert {
            form: old,
            due: self.tick + u64::from(r.hatch_after),
            health: HealthOnChange::Full,
        });
        true
    }
    pub(crate) fn advance_forms(&mut self) {
        let due: Vec<_> = self
            .actors
            .values()
            .filter_map(|a| {
                a.revert
                    .as_ref()
                    .filter(|r| r.due <= self.tick)
                    .map(|r| (a.id, r.clone()))
            })
            .collect();
        for (id, r) in due {
            let _ = self.replace_form(id, r.form, r.health, 0);
        }
    }
}
