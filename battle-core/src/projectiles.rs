use crate::targeting::{Body, Perception};
use crate::vitals::Change;
use crate::{Actor, Battle, Fact, Id, Layer, Point, Projectile, TICKS_PER_SECOND};
#[derive(Clone, Copy, Debug)]
pub enum Delivery {
    Homing,
    /// One trigger fires the whole spread; each ray has independent collisions.
    Line {
        count: u8,
        degrees: f64,
        distance: f64,
        pierce: bool,
        returns: bool,
    },
    Ground {
        radius: f64,
        bounces: u8,
        hop_distance: f64,
    },
}
#[derive(Clone, Copy, Debug)]
pub struct Weapon {
    pub delivery: Delivery,
    pub radius: f64,
    pub magazine: u8,
    pub reload: u32,
}
impl Default for Weapon {
    fn default() -> Self {
        Self {
            delivery: Delivery::Homing,
            radius: 4.,
            magazine: 0,
            reload: 0,
        }
    }
}
impl Weapon {
    pub fn valid(self) -> bool {
        self.radius.is_finite()
            && self.radius >= 0.
            && (self.magazine == 0 || self.reload > 0)
            && match self.delivery {
                Delivery::Homing => true,
                Delivery::Line {
                    count,
                    degrees,
                    distance,
                    ..
                } => {
                    count > 0
                        && degrees.is_finite()
                        && (0.0..=360.).contains(&degrees)
                        && distance.is_finite()
                        && distance > 0.
                }
                Delivery::Ground {
                    radius,
                    bounces,
                    hop_distance,
                } => {
                    bounces > 0
                        && radius.is_finite()
                        && radius >= 0.
                        && hop_distance.is_finite()
                        && hop_distance >= 0.
                }
            }
    }
}
#[derive(Clone, Debug, PartialEq)]
pub enum Trajectory {
    Homing,
    Line {
        direction: Point,
        left: f64,
        pierce: bool,
        returns: bool,
        inbound: bool,
        hit: Vec<Id>,
    },
    Ground {
        destination: Point,
        direction: Point,
        radius: f64,
        bounces: u8,
        hop_distance: f64,
    },
}
pub(crate) fn fire(
    a: &Actor,
    target: Body,
    damage: i32,
    speed: f64,
    on_hit: crate::classic::Attack,
    out: &mut crate::combat::Effects,
) {
    let d = (target.pos - a.pos).unit().unwrap_or(a.facing);
    let spawn_offset = a.def.rules.map_or(0., |s| {
        s["projectile_spawn_offset"].as_f64().unwrap_or(0.)
            + if s["projectile_spawn_at_edge"] == true {
                a.def.radius
            } else {
                0.
            }
    });
    let muzzle = a.pos + d * spawn_offset;
    if let Some(s) = on_hit
        .rules
        .filter(|s| s.get("attack_wave_damage").is_some())
    {
        out.waves
            .push(crate::classic::zones::Wave::new(a, target, s, out.tick));
    }
    let mut launch = |trajectory| {
        let id = out.next_id;
        out.next_id += 1;
        out.shots.push(Projectile {
            attack_sound: a.attack_sound(out.tick),
            cast_action: "",
            born: out.tick,
            source_kind: a.audio_kind(),
            id,
            owner: a.id,
            team: a.team,
            origin: a.pos,
            hits_air: a.def.hits_air,
            radius: a.def.weapon.radius,
            target: target.id,
            position: muzzle,
            damage,
            speed,
            trajectory,
            on_hit,
            volley: None,
        });
        out.facts.push(Fact::Fired(a.id, target.id, id));
    };
    let delivery = if let Some(s) = on_hit.ability.filter(|s| s.get("bounce_count").is_some()) {
        Delivery::Ground {
            radius: s["radius"].as_f64().unwrap(),
            bounces: s["bounce_count"].as_u64().unwrap() as u8,
            hop_distance: s["bounce_distance"].as_f64().unwrap(),
        }
    } else {
        a.def.weapon.delivery
    };
    match delivery {
        Delivery::Homing => launch(Trajectory::Homing),
        Delivery::Line {
            count,
            degrees,
            distance,
            pierce,
            returns,
        } => {
            for n in 0..count {
                let t = if count == 1 {
                    0.
                } else {
                    f64::from(n) / f64::from(count - 1) - 0.5
                };
                let (sin, cos) = (degrees.to_radians() * t).sin_cos();
                launch(Trajectory::Line {
                    direction: Point::new(d.x * cos - d.y * sin, d.x * sin + d.y * cos),
                    left: distance,
                    pierce,
                    returns,
                    inbound: false,
                    hit: vec![],
                });
            }
        }
        Delivery::Ground {
            radius,
            bounces,
            hop_distance,
        } => launch(Trajectory::Ground {
            destination: target.pos,
            direction: d,
            radius,
            bounces,
            hop_distance,
        }),
    }
}
fn first_hit(start: Point, dir: Point, length: f64, center: Point, radius: f64) -> Option<f64> {
    let offset = center - start;
    let along = offset.dot(dir);
    let disc = radius * radius - (offset.dot(offset) - along * along);
    if disc < 0. {
        return None;
    }
    let root = disc.sqrt();
    (along + root >= 0. && along - root <= length).then_some((along - root).max(0.))
}
impl Battle {
    pub(crate) fn projectile_step(&mut self) {
        if self.shots.is_empty() {
            return;
        }
        let view = Perception::new(&self.actors);
        let mut changes = vec![];
        let mut events = vec![];
        let mut caught = Vec::new();
        let mut audio = Vec::new();
        self.shots.retain_mut(|p| {
            let sound = crate::SoundOrigin {
                owner: p.id,
                kind: p.source_kind,
                form: p.attack_sound.form,
                team: p.team,
                action: p.cast_action,
                spell: false,
            };
            let mut hit = |b: Body, position: Point| {
                if p.volley
                    .is_some_and(|id| !self.volley_hits.entry(id).or_default().insert(b.id))
                {
                    return;
                }
                changes.push(Change::attack(p.owner, b.id, p.damage, p.on_hit));
                events.push(Fact::ProjectileHit {
                    first: p.attack_sound.first,
                    position,
                    source_kind: p.source_kind,
                    projectile: p.id,
                    target: b.id,
                });
            };
            let source_pos = view.bodies.get(&p.owner).map_or(p.origin, |b| b.pos);
            let eligible = |b: Body| {
                b.team != p.team
                    && b.allows(p.team, source_pos)
                    && (p.hits_air || b.layer != Layer::Air)
            };
            let step = p.speed / TICKS_PER_SECOND as f64;
            match &mut p.trajectory {
                Trajectory::Homing => {
                    let Some(&b) = view.bodies.get(&p.target).filter(|b| eligible(**b)) else {
                        return false;
                    };
                    let d = b.pos - p.position;
                    if d.length() <= step + p.radius + b.radius {
                        let distance = (d.length() - p.radius - b.radius).max(0.);
                        hit(b, p.position + d.unit().unwrap_or_default() * distance);
                        false
                    } else {
                        p.position = p.position + d.unit().unwrap_or_default() * step;
                        true
                    }
                }
                Trajectory::Line {
                    direction,
                    left,
                    pierce,
                    returns,
                    inbound,
                    hit: already,
                } => {
                    let home = view.bodies.get(&p.owner).map_or(p.origin, |b| b.pos);
                    if *inbound {
                        let delta = home - p.position;
                        *left = delta.length();
                        *direction = delta.unit().unwrap_or(*direction);
                    }
                    let travel = step.min(*left);
                    let mid = p.position + *direction * (travel / 2.);
                    let mut contacts = vec![];
                    view.nearby(mid, travel / 2. + p.radius, |b| {
                        if eligible(b) && !already.contains(&b.id) {
                            if let Some(t) = first_hit(
                                p.position,
                                *direction,
                                travel,
                                b.pos,
                                p.radius + b.radius,
                            ) {
                                contacts.push((t, b));
                            }
                        }
                    });
                    contacts.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.id.cmp(&b.1.id)));
                    for (distance, b) in contacts {
                        hit(b, p.position + *direction * distance);
                        if !*pierce {
                            return false;
                        }
                        already.push(b.id);
                    }
                    p.position = p.position + *direction * travel;
                    *left -= travel;
                    if *left > 1e-8 {
                        return true;
                    }
                    if *returns && !*inbound {
                        audio.push((sound, "attack_return:launch", p.position));
                        *inbound = true;
                        already.clear();
                        return true;
                    }
                    if *inbound {
                        caught.push(p.owner);
                    }
                    false
                }
                Trajectory::Ground {
                    destination,
                    direction,
                    radius,
                    bounces,
                    hop_distance,
                } => {
                    let d = *destination - p.position;
                    if d.length() > step {
                        p.position = p.position + d.unit().unwrap() * step;
                        return true;
                    }
                    p.position = *destination;
                    view.nearby(p.position, *radius, |b| {
                        if eligible(b) && (b.pos - p.position).length() <= *radius + b.radius {
                            hit(b, b.pos)
                        }
                    });
                    let total = p
                        .on_hit
                        .ability
                        .and_then(|s| s["bounce_count"].as_u64())
                        .unwrap_or(1);
                    let bounce = total.saturating_sub(u64::from(*bounces));
                    audio.push((
                        sound,
                        if total > 1 {
                            "bomb:impact"
                        } else {
                            "bomb:basic_impact"
                        },
                        p.position,
                    ));
                    *bounces -= 1;
                    if *bounces > 0 {
                        audio.push((
                            sound,
                            if bounce == 0 {
                                "bomb:second_launch"
                            } else {
                                "bomb:third_launch"
                            },
                            p.position,
                        ));
                    }
                    *destination = *destination + *direction * *hop_distance;
                    *bounces > 0
                }
            }
        });
        for (origin, cue, pos) in audio {
            self.sound(origin, cue, pos, None);
        }
        for owner in caught {
            if let Some(a) = self.actors.get_mut(&owner) {
                a.card_state.visual_action = Some(("attack:return", self.tick, self.tick + 4));
            }
        }
        self.volley_hits
            .retain(|id, _| self.shots.iter().any(|p| p.volley == Some(*id)));
        for f in events {
            self.emit(f)
        }
        self.commit(changes)
    }
}
pub(crate) fn start_reload(a: &mut Actor) {
    if a.def.weapon.magazine > 0 && a.rounds < a.def.weapon.magazine && a.reload_left == 0 {
        a.reload_left = a.def.weapon.reload
    }
}
pub(crate) fn reload_tick(a: &mut Actor) {
    if a.reload_left == 0 || a.disabled() {
        return;
    }
    a.reload_left -= 1;
    if a.reload_left == 0 {
        a.rounds = a.def.weapon.magazine
    }
}
pub(crate) fn spent(a: &mut Actor) {
    if a.def.weapon.magazine > 0 {
        a.rounds = a.rounds.saturating_sub(1);
        a.reload_left = 0;
        if a.rounds == 0 {
            start_reload(a)
        }
    }
}
