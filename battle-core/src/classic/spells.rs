//! Card spells have no unit caster. Flights, repeated strikes and persistent
//! fields are owned by the match and advance on the same clock as card inputs.
use super::{roster::rules, ClassicMatch};
use crate::{targeting::Body, vitals::Change, Control, Id, Motion, Point, Role, Team};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
mod fields;

pub use super::spell_kind::CardSpell;
impl CardSpell {
    pub(super) fn for_key(key: &str) -> Option<Self> {
        Self::from_kind(rules()[key]["spell_kind"].as_str()?)
    }
}
fn number(spec: &Value, field: &str, default: f64) -> f64 {
    spec[field].as_f64().unwrap_or(default)
}
fn ticks(seconds: f64) -> u64 {
    (seconds * 20.).round() as u64
}

pub(super) struct SpellCast {
    key: &'static str,
    kind: CardSpell,
    spec: &'static Value,
    skill: &'static Value,
    team: Team,
    pos: Point,
    pub(super) id: Id,
    born: u64,
    origin: Point,
    impact: u64,
    last: u64,
    interval: u64,
    contacted: BTreeSet<Id>,
    blocked: BTreeSet<Id>,
    struck: BTreeSet<Id>,
    previous: BTreeMap<Id, Point>,
    matter: Option<(u64, Point)>,
    bear: Option<Id>,
    offsets: Vec<Point>,
    damage_remainder: BTreeMap<Id, f64>,
}
impl SpellCast {
    pub(super) fn new(
        game: &mut ClassicMatch,
        key: &'static str,
        choice: Option<usize>,
        kind: CardSpell,
        team: Team,
        pos: Point,
    ) -> Self {
        let spec = &rules()[key];
        let skill = choice.map_or(&Value::Null, |i| &spec["active_skills"][i]);
        let origin = game.map.sides[team.index()].nexus;
        let speed = number(spec, "flight_speed", 0.);
        let flight = if speed > 0. {
            (((origin - pos).length() / speed).max(number(spec, "flight_min_duration", 0.)) * 20.
                - 1e-8)
                .ceil() as u64
        } else {
            0
        };
        let mut impact = game.tick() + flight + ticks(number(spec, "spell_windup", 0.));
        if matches!(kind, CardSpell::Bolt | CardSpell::Bear) {
            impact += ticks(number(spec, "duration", 0.));
        }
        let interval = ticks(number(
            spec,
            "strike_interval",
            number(spec, "interval", 0.05),
        ))
        .max(1);
        let duration = match kind {
            CardSpell::Lightning | CardSpell::Zap => {
                (number(skill, "strike_count", number(spec, "strike_count", 1.)) as u64 - 1)
                    * interval
            }
            CardSpell::Horizon
            | CardSpell::Stellar
            | CardSpell::Summoning
            | CardSpell::Tidal
            | CardSpell::Pool
            | CardSpell::Corrosion => ticks(spec["duration"].as_f64().unwrap()),
            CardSpell::Freeze if !skill.is_null() => {
                ticks(number(spec, "duration", 0.) + number(skill, "slow_duration", 0.))
            }
            _ => 0,
        };
        let id = game.battle.next_id;
        game.battle.next_id += 1;
        game.battle.emit(crate::Fact::SpellPlayed {
            range: number(spec, "range", 0.),
            wave_width: number(spec, "wave_width", 0.),
            speed: number(spec, "speed", 0.),
            impact,
            end: impact + duration,
            origin,
            enhanced: !skill.is_null(),
            radius: number(spec, "radius", 0.),
            id,
            key,
            team,
            position: pos,
        });
        let cast = Self {
            key,
            kind,
            spec,
            skill,
            team,
            pos,
            id,
            born: game.tick(),
            origin,
            impact,
            last: impact + duration,
            interval,
            contacted: Default::default(),
            blocked: Default::default(),
            struck: Default::default(),
            previous: Default::default(),
            matter: None,
            bear: None,
            offsets: if kind == CardSpell::Summoning {
                fields::summon_offsets(game, pos, spec)
            } else {
                vec![]
            },
            damage_remainder: Default::default(),
        };
        cast.start_audio(&mut game.battle);
        cast
    }
    fn audio_source(&self) -> crate::SoundOrigin {
        crate::SoundOrigin {
            spell: true,
            owner: self.id,
            kind: self.key,
            team: self.team,
            form: false,
            action: "spell",
        }
    }
    fn start_audio(&self, battle: &mut crate::Battle) {
        use CardSpell::*;
        let source = self.audio_source();
        let mut play = |phase, at| battle.sound(source, phase, at, None);
        match self.kind {
            Stasis | Cask | InfernoBomb => play("spell:cast", self.origin),
            Heal | Freeze | SolarFlare | Pool | Horizon | Tidal | Stellar => {
                play("spell:cast", self.pos)
            }
            Pulse => {
                play("spell:cast", self.pos);
                play("spell:charge", self.pos);
            }
            FinalSpark => {
                let range =
                    number(self.spec, "range", 0.) * if self.team == Team::Blue { -1. } else { 1. };
                play("spell:cast", self.pos);
                play("spell:middle", self.pos + Point::new(0., range * 0.5));
                play("spell:end", self.pos + Point::new(0., range));
            }
            MediumLightning => {
                play("spell:cast", self.pos);
                play("spell:warning", self.pos);
            }
            _ => {}
        }
    }
    pub(super) fn active_after(&self, game: &ClassicMatch) -> bool {
        game.tick() < self.last
            || self.matter.is_some()
            || self
                .bear
                .is_some_and(|id| game.battle.actors.contains_key(&id))
    }
    pub(super) fn run(
        &mut self,
        game: &mut ClassicMatch,
        changes: &mut Vec<Change>,
        pool: &mut BTreeSet<Id>,
    ) {
        let tick = game.tick();
        let sound = self.audio_source();
        if tick == self.born + ticks(number(self.spec, "spell_windup", 0.)) {
            match self.kind {
                CardSpell::Bolt => {
                    game.battle.sound(sound, "spell:launch", self.pos, None);
                    game.battle.sound(sound, "spell:warning", self.pos, None);
                }
                CardSpell::Bear => game.battle.sound(sound, "spell:cast", self.pos, None),
                _ => {}
            }
        }
        if self.kind == CardSpell::MediumLightning
            && tick == self.impact.saturating_sub(20).max(self.born)
        {
            game.battle
                .sound(sound, "spell:warning_enemy", self.pos, None);
        }
        if tick == self.impact {
            let phase = match self.kind {
                CardSpell::Stasis
                | CardSpell::Cask
                | CardSpell::InfernoBomb
                | CardSpell::MediumLightning => Some("spell:strike"),
                CardSpell::Bolt | CardSpell::SolarFlare | CardSpell::Bear => Some("spell:impact"),
                CardSpell::Tidal => Some("spell:launch"),
                _ => None,
            };
            if let Some(phase) = phase {
                game.battle.sound(sound, phase, self.pos, None);
            }
            game.battle.emit(crate::Fact::SpellImpact {
                id: self.id,
                key: self.key,
                position: self.pos,
            });
        }
        if tick == self.last && matches!(self.kind, CardSpell::Stellar | CardSpell::Pool) {
            game.battle.sound(sound, "spell:zone_end", self.pos, None);
        }
        if tick < self.impact {
            return;
        }
        if matches!(
            self.kind,
            CardSpell::Horizon | CardSpell::Stellar | CardSpell::Bear | CardSpell::Summoning
        ) {
            self.field_step(game, changes);
            return;
        }
        let elapsed = tick - self.impact;
        let s = self.spec;
        let sk = self.skill;
        let enhanced = !sk.is_null();
        let radius = number(s, "radius", 0.);
        let global_heal = sk["global_heal"] == true;
        let origin = game.map.sides[self.team.index()].nexus;
        let battle = &mut game.battle;
        let heading = Point::new(0., if self.team == Team::Blue { -1. } else { 1. });
        let mut targets: Vec<_> = battle
            .actors
            .values()
            .filter(|a| {
                if !Body::from(*a).allows(self.team, origin) || a.hp <= 0 {
                    return false;
                }
                match self.kind {
                    CardSpell::FinalSpark | CardSpell::Tidal => {
                        let range = number(s, "range", 0.);
                        let mut start = 0.;
                        let mut end = range;
                        if self.kind == CardSpell::Tidal {
                            if a.def.layer == crate::Layer::Air || self.struck.contains(&a.id) {
                                return false;
                            }
                            let step = number(s, "speed", 0.) / 20.;
                            start = (elapsed.saturating_sub(1) as f64 * step).min(range);
                            end = (elapsed as f64 * step).min(range);
                        }
                        crate::Shape::Strip {
                            length: end - start,
                            half_width: number(s, "wave_width", 0.) / 2.,
                        }
                        .hits(
                            a.pos - self.pos - heading * start,
                            heading,
                            a.def.radius,
                        )
                    }
                    _ => {
                        (self.pos - a.pos).length()
                            <= radius.max(number(sk, "radius", 0.)) + a.def.radius
                            || (global_heal && a.team == self.team)
                    }
                }
            })
            .map(|a| a.id)
            .collect();
        let enemy_count = targets
            .iter()
            .filter(|id| battle.actors[id].team != self.team)
            .count();
        if self.kind == CardSpell::Tidal {
            self.struck.extend(&targets);
        }
        if matches!(self.kind, CardSpell::Lightning | CardSpell::Zap)
            && !elapsed.is_multiple_of(self.interval)
        {
            return;
        }
        if self.kind == CardSpell::Lightning {
            targets.retain(|id| battle.actors[id].team != self.team && !self.struck.contains(id));
            targets.sort_by_key(|id| (std::cmp::Reverse(battle.actors[id].hp), *id));
            targets.truncate(1);
            self.struck.extend(&targets);
        }
        if self.kind == CardSpell::Zap {
            battle.sound(sound, "spell:strike", self.pos, None);
        } else if self.kind == CardSpell::Lightning {
            if let Some(id) = targets.first() {
                battle.sound(sound, "spell:strike", battle.actors[id].pos, Some(*id));
            }
        }
        for id in targets {
            let a = &battle.actors[&id];
            let ally = a.team == self.team;
            let troop = a.def.role == Role::Troop;
            let role = a.def.role;
            let edge = (self.pos - a.pos).length() - a.def.radius;
            let tower = matches!(role, Role::LaneTower | Role::Nexus);
            let base_damage = number(s, "damage", 0.);
            let tower_rate = if tower {
                number(s, "tower_damage_multiplier", 1.)
            } else {
                1.
            };
            if ally
                && !matches!(
                    self.kind,
                    CardSpell::Heal
                        | CardSpell::MediumLightning
                        | CardSpell::Stasis
                        | CardSpell::Pool
                        | CardSpell::Tidal
                )
            {
                continue;
            }
            if !ally && matches!(self.kind, CardSpell::Heal | CardSpell::Pool) {
                continue;
            }
            let affects = match self.kind {
                CardSpell::Corrosion => {
                    (elapsed > 0 && elapsed.is_multiple_of(self.interval)) || (enhanced && troop)
                }
                CardSpell::Freeze => {
                    (elapsed == 0 && edge <= radius && role != Role::Nexus)
                        || (enhanced && matches!(role, Role::Troop | Role::Building))
                }
                CardSpell::Stasis => role != Role::Nexus,
                _ => true,
            };
            if !affects {
                continue;
            }
            if !ally && self.contacted.insert(id) && battle.consume_effect_shield(id) {
                self.blocked.insert(id);
            }
            if self.blocked.contains(&id) {
                continue;
            }
            let a = battle.actors.get_mut(&id).unwrap();
            let mut damage = 0.;
            let mut control = None;
            let mut slow = None;
            match self.kind {
                CardSpell::Heal if troop && !a.grievous_wounds => {
                    let heal = (number(s, "heal_amount", 0.)
                        * if edge <= radius {
                            number(sk, "heal_multiplier", 1.)
                        } else {
                            1.
                        })
                    .round() as i32;
                    changes.push(Change::overheal(
                        game.nexus[self.team.index()],
                        id,
                        heal,
                        number(sk, "overheal_shield_ratio", 0.),
                        tick + ticks(number(sk, "shield_duration", 0.)),
                    ));
                }
                CardSpell::Freeze => {
                    if elapsed == 0 && edge <= radius {
                        control = Some((Control::Freeze, number(s, "duration", 0.)));
                    }
                    if enhanced && matches!(role, Role::Troop | Role::Building) {
                        slow = Some((
                            number(sk, "slow_multiplier", 1.),
                            number(sk, "attack_speed_multiplier", 1.),
                            2,
                        ));
                    }
                }
                CardSpell::Stasis => {
                    control = Some((
                        Control::Stasis,
                        if ally {
                            number(sk, "duration", number(s, "duration", 0.))
                        } else {
                            number(s, "duration", 0.)
                        },
                    ))
                }
                CardSpell::Lightning | CardSpell::Zap => {
                    damage = base_damage
                        * number(sk, "strike_damage_multiplier", 1.)
                            .powi((elapsed / self.interval) as i32);
                    control = Some((Control::Stun, number(s, "stun_duration", 0.)));
                }
                CardSpell::MediumLightning if ally && enhanced && troop => a.shields.add(
                    number(sk, "shield", 0.) as i32,
                    tick + ticks(number(sk, "shield_duration", 0.)),
                ),
                CardSpell::MediumLightning if !ally => {
                    damage = base_damage;
                    if role == Role::LaneTower {
                        a.card_state.tower_disable_audio_until =
                            tick + ticks(number(s, "stun_duration", 0.));
                        control = Some((Control::Stun, number(s, "stun_duration", 0.)));
                    } else if enhanced && troop {
                        slow = Some((
                            number(sk, "slow_multiplier", 1.),
                            1.,
                            ticks(number(sk, "slow_duration", 0.)),
                        ));
                    }
                }
                CardSpell::Corrosion => {
                    if elapsed > 0 && elapsed.is_multiple_of(self.interval) {
                        damage = base_damage;
                    }
                    if enhanced && troop {
                        slow = Some((number(sk, "slow_multiplier", 1.), 1., 2));
                    }
                }
                CardSpell::Bolt => {
                    let mut multiplier = if enemy_count == 1 {
                        number(
                            sk,
                            "isolated_damage_multiplier",
                            number(s, "isolated_damage_multiplier", 1.),
                        )
                    } else {
                        1.
                    };
                    if a.has(Control::Stun)
                        || a.has(Control::Freeze)
                        || a.has(Control::Root)
                        || a.flight
                            .is_some_and(|f| f.kind == crate::motion::MotionKind::Knockback)
                    {
                        multiplier = multiplier.max(number(
                            sk,
                            "controlled_damage_multiplier",
                            number(s, "controlled_damage_multiplier", 1.),
                        ));
                    }
                    damage = base_damage * multiplier;
                }
                CardSpell::FinalSpark => {
                    damage = base_damage;
                    if troop {
                        a.blind = a.blind.max(number(sk, "blind_charges", 0.) as u8);
                    }
                }
                CardSpell::Pulse => {
                    damage = number(sk, "damage", base_damage);
                    let dir = self.pos - a.pos;
                    if troop && dir.length() > 0.001 {
                        let distance = number(sk, "pull_distance", number(s, "pull_distance", 0.));
                        let duration = number(sk, "duration", number(s, "duration", 0.));
                        let _ = battle.begin_displacement(
                            id,
                            dir,
                            distance,
                            distance / duration,
                            0.,
                            tick,
                        );
                    }
                }
                CardSpell::Tidal if ally => {
                    if enhanced && troop {
                        a.tidal_haste = Some((
                            tick + ticks(number(sk, "duration", 0.)),
                            (number(sk, "speed_multiplier", 1.) * 1000.).round() as u16,
                        ));
                    }
                }
                CardSpell::Tidal => {
                    damage = base_damage;
                    let origin = a.pos - heading;
                    let _ = battle.resolve_motion(
                        id,
                        origin,
                        heading,
                        Motion::Knockback {
                            distance: number(s, "knockback", 0.),
                            ticks: 4,
                            mass_cap: 1.4,
                        },
                        tick,
                    );
                }
                CardSpell::Cask => {
                    damage = number(sk, "damage", base_damage);
                    let _ = battle.resolve_motion(
                        id,
                        self.pos,
                        Point::new(0., 1.),
                        Motion::Knockback {
                            distance: number(s, "knockback", 0.),
                            ticks: 4,
                            mass_cap: 1.4,
                        },
                        tick,
                    );
                }
                CardSpell::InfernoBomb => {
                    damage = if edge <= number(s, "inner_radius", 0.) {
                        number(s, "inner_damage", 0.)
                    } else {
                        base_damage
                    };
                    if enhanced {
                        a.shields = Default::default();
                        if troop {
                            a.grievous_wounds = true;
                        }
                    }
                }
                CardSpell::SolarFlare => {
                    let duration = number(s, "duration", 0.);
                    if edge <= number(s, "inner_radius", 0.) {
                        control = Some((Control::Stun, duration));
                    } else if troop {
                        slow = Some((number(s, "slow_multiplier", 1.), 1., ticks(duration)));
                    }
                    if enhanced {
                        a.sunlight = Some((
                            sound,
                            tick + ticks(number(sk, "duration", 0.)),
                            (number(sk, "damage", 0.)
                                * if tower {
                                    number(sk, "tower_damage_multiplier", 1.)
                                } else {
                                    1.
                                })
                            .round() as i32,
                        ));
                    }
                }
                CardSpell::Pool if troop => {
                    let amount = if elapsed == 0 {
                        number(sk, "shield", 0.) as i32
                    } else if pool.insert(id) {
                        (number(s, "shield_per_second", 0.) / 20.).round() as i32
                    } else {
                        0
                    };
                    if amount > 0 {
                        a.shields
                            .replenish(amount, tick + ticks(number(s, "shield_duration", 0.)));
                    }
                }
                _ => {}
            }
            if damage > 0. {
                let change = Change::delivered(
                    game.nexus[self.team.index()],
                    id,
                    -(damage * tower_rate).round() as i32,
                );
                if matches!(self.kind, CardSpell::Cask | CardSpell::Bolt) {
                    battle.emit(crate::Fact::SpellContact {
                        key: self.key,
                        target: id,
                        position: battle.actors[&id].pos,
                    });
                }
                changes.push(match self.kind {
                    CardSpell::MediumLightning | CardSpell::Tidal | CardSpell::Pulse => {
                        change.on_sound(sound, "spell:hit")
                    }
                    _ => change,
                });
            }
            if let Some((kind, duration)) = control {
                let _ = battle.apply_control(id, kind, self.id, ticks(duration) as u32, tick);
            }
            if let Some((movement, attack, duration)) = slow {
                battle.actors.get_mut(&id).unwrap().slows.apply(
                    self.id,
                    (movement * 1000.).round() as u16,
                    if troop {
                        (attack * 1000.).round() as u16
                    } else {
                        1000
                    },
                    tick + duration,
                );
            }
        }
    }
}
impl ClassicMatch {
    pub(super) fn tick_spells(&mut self, changes: &mut Vec<Change>) {
        let mut casts = std::mem::take(&mut self.spells);
        let mut pool = BTreeSet::new();
        for cast in &mut casts {
            let first = changes.len();
            cast.run(self, changes, &mut pool);
            for change in &mut changes[first..] {
                change.credit = self.battle.owners.get(&cast.id).copied();
            }
        }
        casts.retain(|cast| cast.active_after(self));
        self.spells = casts;
    }
}

impl ClassicMatch {
    pub fn spell_views(&self) -> impl Iterator<Item = serde_json::Value> + '_ {
        self.spells.iter().map(|s|serde_json::json!({"id":s.id,"key":s.key,"team":s.team.index(),"position":s.pos,"born":s.born,"origin":s.origin,"impact":s.impact,"end":s.last,"range":number(s.spec,"range",0.),"waveWidth":number(s.spec,"wave_width",0.),"speed":number(s.spec,"speed",0.),"enhanced":!s.skill.is_null(),"radius":number(s.spec,"radius",0.)}))
    }
}
