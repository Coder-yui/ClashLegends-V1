use super::{
    roster::rules,
    units::{stat, ticks, unit},
};
use crate::{targeting::Body, vitals::Change, Actor, Battle, Fact, Id, Point, Role, Team};

#[derive(Clone, Copy, Debug)]
pub(crate) struct Birth {
    pub key: &'static str,
    pub due: u64,
    pub offset: Point,
    pub delay: u32,
}
#[derive(Clone, Copy)]
pub(crate) struct Death {
    pub key: &'static str,
    pub role: Role,
    pub team: Team,
    pub pos: Point,
    pub suppress_enemy: bool,
}

fn offset(
    a: &Actor,
    key: &str,
    i: usize,
    count: usize,
    side: &str,
    distance: f64,
    width: f64,
) -> Point {
    let child_radius = stat(&rules()[key], "radius", 14.);
    let gap = a.def.radius + child_radius + 3.;
    let lateral = if a.pos.x < width / 2. { -1. } else { 1. };
    match side {
        "map_side" => Point::new(
            lateral * gap,
            (i as f64 - (count - 1) as f64 / 2.) * (child_radius * 2. + 3.),
        ),
        "bilateral" => Point::new(if i % 2 == 0 { -distance } else { distance }, 0.),
        "below" => Point::new(0., if a.team == Team::Blue { gap } else { -gap }),
        "center" => Point::default(),
        _ => {
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
        let mut born = vec![];
        for entry in std::mem::take(&mut self.pending_births) {
            if entry.3.due <= self.tick {
                born.push(entry);
            } else {
                self.pending_births.push(entry);
            }
        }
        for a in self.actors.values_mut() {
            let Some(s) = a.def.rules else {
                continue;
            };
            if a.ready_tick > self.tick || a.hp <= 0 {
                continue;
            }
            let Some(seconds) = s["spawn_interval"].as_f64() else {
                continue;
            };
            let period = u64::from(ticks(seconds));
            let due = *a
                .card_state
                .production_due
                .get_or_insert(a.ready_tick + u64::from(ticks(stat(s, "spawn_initial_delay", 0.))));
            if a.disabled() {
                for member in &mut a.card_state.pending_births {
                    member.due += 1;
                }
                continue;
            }
            if due <= self.tick {
                a.card_state.production_due = Some(self.tick + period);
                let mut keys = vec![];
                if let Some(waves) = s["spawn_waves"].as_array() {
                    let wave = &waves[a.card_state.wave % waves.len()];
                    a.card_state.wave += 1;
                    for m in wave.as_array().unwrap() {
                        let key = m["spawn_id"].as_str().unwrap();
                        keys.extend(std::iter::repeat_n(
                            key,
                            stat(m, "spawn_count", 1.) as usize,
                        ));
                    }
                } else if let Some(key) = s["spawn_id"].as_str() {
                    keys.resize(stat(s, "spawn_count", 1.) as usize, key);
                }
                let count = keys.len();
                for (i, key) in keys.into_iter().enumerate() {
                    let delay = ticks(stat(
                        s,
                        "spawn_deploy_time",
                        stat(&rules()[key], "deploy_time", 1.),
                    ));
                    let offset = offset(
                        a,
                        key,
                        i,
                        count,
                        s["spawn_side"].as_str().unwrap_or("center"),
                        stat(s, "spawn_distance", 0.),
                        self.map.width,
                    );
                    a.card_state.pending_births.push(Birth {
                        key,
                        delay,
                        offset,
                        due: self.tick
                            + i as u64 * u64::from(ticks(stat(s, "spawn_sequence_interval", 0.))),
                    });
                }
            }
            a.card_state.pending_births.retain(|b| {
                if b.due <= self.tick {
                    born.push((a.id, a.team, a.pos, *b));
                    false
                } else {
                    true
                }
            });
        }
        for (id, team, pos, b) in born {
            self.born(id, team, pos, b);
        }
    }
    pub(crate) fn card_death(
        &mut self,
        a: &Actor,
        blasts: &mut Vec<(Team, u8, Vec<Id>, Vec<Change>)>,
    ) {
        if let Some((_, target)) = a.card_state.channel {
            let _ = self.remove_control(target, crate::Control::Stun, a.id);
        }
        self.deaths.push(Death {
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
                    a,
                    key,
                    i,
                    count,
                    s["death_spawn_side"].as_str().unwrap_or("ring"),
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
                a.team,
                stat(s, "death_burst_reward", 0.) as u8,
                ids,
                changes,
            ));
        }
    }
}
