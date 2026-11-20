use super::{
    roster::rules,
    units::{stat, ticks, unit},
};
use crate::{targeting::Body, vitals::Change, Actor, Battle, Control, Fact, Id, Point, Role, Team};
mod config;
pub(crate) use config::Production;
use config::Side;

#[derive(Clone, Copy, Debug)]
pub(crate) struct Birth {
    pub key: &'static str,
    pub due: u64,
    pub offset: Point,
    pub delay: u32,
}
#[derive(Clone, Copy)]
pub(crate) struct Death {
    pub sound: crate::SoundOrigin,
    pub key: &'static str,
    pub role: Role,
    pub team: Team,
    pub pos: Point,
    pub suppress_enemy: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SummonFlight {
    pub source_airborne: bool,
    pub airborne: bool,
    pub source_scale: f64,
    pub source: Id,
    pub origin: Point,
    pub destination: Point,
    pub start: u64,
    pub arrival: u64,
}
pub(crate) struct ReleasedSummon {
    pub view: SummonFlight,
    team: Team,
    birth: Birth,
}

#[derive(Clone, Copy)]
struct Site {
    pos: Point,
    team: Team,
    radius: f64,
}
impl From<&Actor> for Site {
    fn from(a: &Actor) -> Self {
        Self {
            pos: a.pos,
            team: a.team,
            radius: a.def.radius,
        }
    }
}
fn offset(
    a: Site,
    child_radius: f64,
    i: usize,
    count: usize,
    side: Side,
    distance: f64,
    width: f64,
) -> Point {
    let gap = a.radius + child_radius + 3.;
    let lateral = if a.pos.x < width / 2. { -1. } else { 1. };
    match side {
        Side::MapSide => Point::new(
            lateral * gap,
            (i as f64 - (count - 1) as f64 / 2.) * (child_radius * 2. + 3.),
        ),
        Side::Bilateral => Point::new(if i % 2 == 0 { -distance } else { distance }, 0.),
        Side::Below => Point::new(0., if a.team == Team::Blue { gap } else { -gap }),
        Side::Center => Point::default(),
        Side::Ring => {
            let angle = std::f64::consts::TAU * i as f64 / count as f64;
            Point::new(angle.cos(), angle.sin()) * gap
        }
    }
}
impl Battle {
    fn born(&mut self, owner: Id, team: Team, pos: Point, b: Birth) {
        if let Ok(id) = self.spawn_near(team, pos + b.offset, unit(b.key)) {
            self.actors.get_mut(&id).unwrap().ready_tick = self.tick + u64::from(b.delay);
            if matches!(b.key, "voidfish" | "voidmite") {
                self.actors.get_mut(&id).unwrap().card_state.visual_action = Some((
                    "scatter_birth",
                    self.tick,
                    self.tick + u64::from(b.delay.max(1)),
                ));
            }
            self.emit(Fact::Summoned {
                source: owner,
                child: id,
            });
        }
    }
    pub(crate) fn advance_production(&mut self) {
        let mut sequences = vec![];
        let mut born = vec![];
        for entry in std::mem::take(&mut self.pending_births) {
            if entry.3.due <= self.tick {
                born.push(entry);
            } else {
                self.pending_births.push(entry);
            }
        }
        self.summon_flights.retain(|f| {
            if f.view.arrival > self.tick {
                return true;
            }
            born.push((f.view.source, f.team, f.view.destination, f.birth));
            false
        });
        let mut launches = Vec::new();
        for a in self.actors.values_mut() {
            if a.production.is_none() || a.ready_tick > self.tick || a.hp <= 0 {
                continue;
            }
            let blocked = a.production_blocked();
            let site = Site::from(&*a);
            let Some(s) = a.production.as_mut().and_then(|p| p.summons.as_mut()) else {
                continue;
            };
            if blocked {
                for member in &mut s.waiting {
                    member.due += 1;
                }
                continue;
            }
            if s.clock.take_due(self.tick, a.ready_tick) {
                sequences.push(a.id);
                let wave = &s.waves[s.wave];
                s.wave = (s.wave + 1) % s.waves.len();
                for (i, member) in wave.iter().enumerate() {
                    s.waiting.push(Birth {
                        key: member.key,
                        delay: member.deploy,
                        offset: offset(
                            site,
                            member.radius,
                            i,
                            wave.len(),
                            s.side,
                            s.distance,
                            self.map.width,
                        ),
                        due: self.tick + i as u64 * s.stagger,
                    });
                }
            }
            s.waiting.retain(|b| {
                if b.due > self.tick {
                    return true;
                }
                if s.flight > 0 {
                    launches.push((a.id, a.team, a.pos, *b, s.flight));
                } else {
                    born.push((a.id, a.team, a.pos, *b));
                }
                false
            });
        }
        for (source, team, origin, mut birth, duration) in launches {
            let child = unit(birth.key);
            let actor = &self.actors[&source];
            if let Ok(destination) = self.spawn_point(team, origin + birth.offset, &child) {
                birth.offset = Point::default();
                self.summon_flights.push(ReleasedSummon {
                    view: SummonFlight {
                        source,
                        origin,
                        destination,
                        start: self.tick,
                        arrival: self.tick + duration,
                        source_airborne: actor.def.layer == crate::Layer::Air,
                        airborne: child.layer == crate::Layer::Air,
                        source_scale: actor.def.rules.map_or(1., |s| {
                            actor.def.radius / stat(s, "radius", actor.def.radius)
                        }),
                    },
                    team,
                    birth,
                });
            }
        }
        for id in sequences {
            self.unit_sound(id, "summon:start", None);
        }
        for (id, team, pos, b) in born {
            self.born(id, team, pos, b);
        }
    }
    pub(crate) fn card_death(
        &mut self,
        a: &Actor,
        blasts: &mut Vec<(crate::SoundOrigin, Point, u8, Vec<Id>, Vec<Change>)>,
    ) {
        if let Some((_, target)) = a.card_state.channel {
            let _ = self.remove_control(target, crate::Control::Stun, a.id);
        }
        self.deaths.push(Death {
            sound: a.sound_origin(),
            key: a.def.key,
            role: a.def.role,
            team: a.team,
            pos: a.pos,
            suppress_enemy: a.card_state.skip_reward,
        });
        if let Some((until, source, team, r)) = a.card_state.conversion {
            if self.tick <= until && a.def.role != Role::Nexus {
                let key = r[if a.def.role.structure() {
                    "assist_conversion_building_id"
                } else {
                    "assist_conversion_unit_id"
                }]
                .as_str()
                .unwrap();
                self.born(
                    source,
                    team,
                    a.pos,
                    Birth {
                        key,
                        due: self.tick,
                        offset: Point::default(),
                        delay: ticks(stat(&rules()[key], "deploy_time", 1.)),
                    },
                );
            }
        }
        let Some(s) = a.def.rules else {
            return;
        };
        if let Some(key) = s["death_spawn_id"].as_str() {
            let count = stat(s, "death_spawn_count", 1.) as usize;
            for i in 0..count {
                let mut displacement = offset(
                    Site::from(a),
                    stat(&rules()[key], "radius", 14.),
                    i,
                    count,
                    Side::from_rule(s["death_spawn_side"].as_str().unwrap_or("ring")),
                    0.,
                    self.map.width,
                );
                if let Some(spread) = s["death_spawn_spread"].as_f64() {
                    let angle = std::f64::consts::TAU * i as f64 / count as f64;
                    displacement = Point::new(angle.cos(), angle.sin()) * spread;
                }
                self.pending_births.push((
                    a.id,
                    a.team,
                    a.pos,
                    Birth {
                        key,
                        due: self.tick
                            + (u64::from(ticks(stat(s, "death_spawn_duration", 0.))) * i as u64)
                                / (count.saturating_sub(1).max(1) as u64),
                        offset: displacement,
                        delay: ticks(stat(
                            s,
                            "death_spawn_deploy_time",
                            stat(&rules()[key], "deploy_time", 1.),
                        )),
                    },
                ));
            }
        }
        if let Some(radius) = s["death_burst_radius"].as_f64() {
            let mut ids = vec![];
            let mut changes = vec![];
            let candidates: Vec<_> = self
                .actors
                .values()
                .filter(|b| {
                    b.hp > 0
                        && b.team != a.team
                        && b.def.layer == crate::Layer::Ground
                        && Body::from(*b).allows(a.team, a.pos)
                        && (b.pos - a.pos).length() <= radius + b.def.radius
                })
                .map(|b| (b.id, b.def.role))
                .collect();
            for (id, role) in candidates {
                if self.consume_effect_shield(id) {
                    continue;
                }
                ids.push(id);
                changes.push(Change::delivered(
                    a.id,
                    id,
                    -(stat(s, "death_burst_damage", 0.) as i32),
                ));
                if role == Role::Troop && a.card_state.blast_ratio > 0. {
                    changes.push(Change::execute(a.id, id, a.card_state.blast_ratio));
                }
            }
            blasts.push((
                a.sound_origin(),
                a.pos,
                stat(s, "death_burst_reward", 0.) as u8,
                ids,
                changes,
            ));
        }
    }
}

impl Actor {
    pub(crate) fn basic_production(&mut self, tick: u64) -> Option<crate::SpawnBatch> {
        if self.production.is_none() || self.production_blocked() {
            return None;
        }
        let (period, batch) = self.production.as_mut()?.basic.as_mut()?;
        period.take_due(tick, self.ready_tick).then_some(*batch)
    }
    fn production_blocked(&self) -> bool {
        self.has(Control::Stun) || self.has(Control::Freeze) || self.has(Control::Stasis)
    }
}
impl super::ClassicMatch {
    pub(super) fn collect_income(&mut self) {
        let now = self.tick();
        for a in self.battle.actors.values_mut() {
            if a.production.is_none() || a.ready_tick > now || a.production_blocked() {
                continue;
            }
            if let Some((period, amount)) = a.production.as_mut().and_then(|p| p.income.as_mut()) {
                if period.take_due(now, a.ready_tick) {
                    let p = &mut self.players[a.team.index()];
                    p.gold = p.gold.saturating_add(*amount).min(10);
                }
            }
        }
    }
}
