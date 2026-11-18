//! Timers and child creation shared by cards, summoned structures and waves.
use crate::{Actor, Battle, Control, Fact, Id, Point, Team, UnitDef};

#[derive(Clone, Copy, Debug)]
pub struct SpawnBatch {
    pub unit: fn() -> UnitDef,
    pub count: u8,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct Lifecycle {
    pub footprint: u8,
    /// A decaying building loses its nominal maximum health over this period.
    pub decay_ticks: u32,
    pub production: Option<(u32, SpawnBatch)>,
    pub on_death: Option<SpawnBatch>,
    pub death_area: Option<crate::TimedArea>,
    pub rebirth: Option<crate::Rebirth>,
}
#[derive(Clone, Copy)]
pub(crate) struct Generation {
    source: Id,
    team: Team,
    pos: Point,
    radius: f64,
    batch: SpawnBatch,
}
impl Generation {
    pub fn from(a: &Actor, batch: SpawnBatch) -> Self {
        Self {
            source: a.id,
            team: a.team,
            pos: a.pos,
            radius: a.def.radius,
            batch,
        }
    }
}
impl Battle {
    pub(crate) fn summon(&mut self, g: Generation) {
        let def = (g.batch.unit)();
        let separation = 3.;
        let side = if g.pos.x < self.map.width * 0.5 {
            -1.
        } else {
            1.
        };
        for i in 0..g.batch.count {
            let offset = (f64::from(i) - (f64::from(g.batch.count) - 1.) / 2.)
                * (2. * def.radius + separation);
            let desired = g.pos + Point::new(side * (g.radius + def.radius + separation), -offset);
            if let Ok(child) = self.spawn_near(g.team, desired, def.clone()) {
                self.actors.get_mut(&child).unwrap().ready_tick = self.tick + 1;
                self.emit(Fact::Summoned {
                    source: g.source,
                    child,
                });
            }
        }
    }
    pub fn spawn_near(&mut self, team: Team, pos: Point, def: UnitDef) -> Result<Id, crate::Error> {
        if !pos.finite() || !def.valid() {
            return Err(crate::Error::InvalidPoint);
        }
        let blocks = crate::movement::blockers(&self.actors);
        let q = crate::space::Query {
            map: &self.map,
            blocks: &blocks,
            id: self.next_id,
            layer: def.layer,
            radius: def.radius,
        };
        let point = q
            .nearest(pos, if team == Team::Blue { -1. } else { 1. })
            .ok_or(crate::Error::InvalidPoint)?;
        self.spawn(team, point, def)
    }
    pub(crate) fn lifecycle_step(&mut self) {
        let mut batches = vec![];
        for a in self.actors.values_mut() {
            if a.ready_tick > self.tick {
                continue;
            }
            let spec = a.def.lifecycle;
            if spec.decay_ticks > 0 && !a.has(Control::Stasis) {
                a.decay_carry += i64::from(a.def.hp);
                let decay =
                    (a.decay_carry + i64::from(spec.decay_ticks) / 2) / i64::from(spec.decay_ticks);
                a.decay_carry -= decay * i64::from(spec.decay_ticks);
                a.hp = (a.hp - decay as i32).max(0);
            }
            if a.hp == 0 {
                continue;
            }
            if let Some((interval, batch)) = spec.production {
                a.production_left = a.production_left.saturating_sub(1);
                if a.production_left == 0 && !a.disabled() {
                    batches.push(Generation::from(a, batch));
                    a.production_left = interval;
                }
            }
        }
        self.remove_dead();
        for g in batches {
            self.summon(g)
        }
    }
    pub(crate) fn remove_dead(&mut self) {
        let ids: Vec<_> = self
            .actors
            .values()
            .filter(|a| a.hp == 0)
            .map(|a| a.id)
            .collect();
        let mut batches = vec![];
        for id in ids {
            if self.rebirth(id) {
                continue;
            }
            let a = self.actors.remove(&id).unwrap();
            self.cancel_owned_areas(id);
            if let Some(spec) = a.def.lifecycle.death_area {
                self.schedule_area(
                    crate::timeline::Origin {
                        caster: id,
                        team: a.team,
                        source_pos: a.pos,
                        origin: a.pos,
                        direction: a.facing,
                    },
                    spec,
                );
            }

            if let Some(batch) = a.def.lifecycle.on_death {
                batches.push(Generation::from(&a, batch))
            }
            for other in self.actors.values_mut() {
                other.beam_remainders.remove(&id);
            }
            self.emit(Fact::Died(id));
        }
        for g in batches {
            self.summon(g)
        }
    }
}
