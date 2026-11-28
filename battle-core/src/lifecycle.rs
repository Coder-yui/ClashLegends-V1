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
                self.summoned(g.source, child);
            }
        }
    }
    pub fn spawn_near(&mut self, team: Team, pos: Point, def: UnitDef) -> Result<Id, crate::Error> {
        let point = self.spawn_point(team, pos, &def)?;
        self.spawn(team, point, def)
    }
    pub(crate) fn spawn_point(
        &self,
        team: Team,
        pos: Point,
        def: &UnitDef,
    ) -> Result<Point, crate::Error> {
        if !pos.finite() || !def.valid() {
            return Err(crate::Error::InvalidPoint);
        }
        let blocks = crate::movement::blockers(&self.actors);
        let q = crate::space::Query {
            cross_river: def
                .rules
                .is_some_and(|s| s["river_traversal"] == true || s["terrain_traversal"] == true),
            map: &self.map,
            blocks: &blocks,
            id: self.next_id,
            layer: def.layer,
            radius: def.radius,
        };
        q.nearest(pos, if team == Team::Blue { -1. } else { 1. })
            .ok_or(crate::Error::InvalidPoint)
    }
    pub(crate) fn lifecycle_step(&mut self) {
        let mut batches = vec![];
        for a in self.actors.values_mut() {
            if a.ready_tick > self.tick {
                continue;
            }
            let spec = a.def.lifecycle;
            if spec.decay_ticks > 0
                && !a.has(Control::Stasis)
                && !(a.card_state.aura_until > self.tick
                    && a.card_state
                        .buff_spec
                        .is_some_and(|s| s["pause_lifespan"] == true))
            {
                a.decay_carry += i64::from(a.def.hp);
                let decay =
                    (a.decay_carry + i64::from(spec.decay_ticks) / 2) / i64::from(spec.decay_ticks);
                a.decay_carry -= decay * i64::from(spec.decay_ticks);
                a.hp = (a.hp - decay as i32).max(0);
            }
            if a.hp == 0 {
                continue;
            }
            if let Some(batch) = a.basic_production(self.tick) {
                batches.push(Generation::from(a, batch));
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
        let mut blasts = vec![];
        for id in ids {
            if !self.actors.contains_key(&id) {
                continue;
            }
            if self.native_death_form(id) || self.rebirth(id) {
                continue;
            }
            let a = self.actors.remove(&id).unwrap();
            self.card_death(&a, &mut blasts);
            if let Some((until, key)) = a.card_state.death_spawn {
                if until > self.tick {
                    if let Ok(child) =
                        self.spawn_near(a.team, a.pos, crate::classic::units::unit(key))
                    {
                        self.summoned(a.id, child);
                    }
                }
            }
            self.cancel_owned_areas(id);
            if let Some(spec) = a.def.lifecycle.death_area {
                if let Some(rules) = a.def.rules {
                    let mut sound = a.sound_origin();
                    sound.owner = self.next_id;
                    for (field, phase) in [
                        ("death_transition_delay", "shrine:leap"),
                        ("death_shrine_delay", "shrine:start"),
                    ] {
                        if let Some(delay) = rules[field].as_f64() {
                            self.scheduled_audio.push((
                                self.tick + (delay * 20.).round() as u64,
                                sound,
                                phase,
                                a.pos,
                            ));
                        }
                    }
                }
                self.schedule_area(
                    crate::timeline::Origin {
                        caster: id,
                        team: a.team,
                        source_pos: a.pos,
                        origin: a.pos,
                        direction: a.facing,
                    },
                    spec,
                    a.def.key,
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
        for (sound, seat, position, reward, ids, changes) in blasts {
            self.commit(changes);
            if ids.iter().any(|id| !self.actors.contains_key(id)) {
                if reward > 0 {
                    self.sound(sound, "bounty:gain", position, None);
                }
                self.gold_rewards[seat] = self.gold_rewards[seat].saturating_add(reward);
            }
        }
        for g in batches {
            self.summon(g)
        }
    }
}
