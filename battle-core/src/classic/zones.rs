//! Areas which survive their caster capture the release point, team and bonuses.
use super::units::{stat, ticks};
use crate::{targeting::Body, timeline::Origin, vitals::Change, Battle, Control, Id, Role};
use serde_json::Value;
use std::collections::BTreeSet;

pub(crate) struct Zone {
    sound: crate::SoundOrigin,
    born: u64,
    id: Id,
    ctx: Origin,
    spec: &'static Value,
    full: bool,
    stage: Phase,
    due: u64,
}
enum Phase {
    Impact,
    Pulses(u32),
    Ring { age: u32, hit: BTreeSet<Id> },
}
impl Zone {
    pub(crate) fn view(&self) -> crate::AreaView {
        let (radius, pulses) = match self.stage {
            Phase::Impact => (stat(self.spec, "radius", 0.), 1),
            Phase::Pulses(n) => (stat(self.spec, "radius", 0.), n),
            Phase::Ring { age, .. } => (
                stat(self.spec, "shockwave_end_radius", 0.) * f64::from(age)
                    / f64::from(ticks(stat(self.spec, "shockwave_duration", 1.)).max(1)),
                1,
            ),
        };
        crate::AreaView {
            born: self.born,
            phase: match self.stage {
                Phase::Impact => "warning",
                Phase::Pulses(_) => "sustain",
                Phase::Ring { .. } => "wave",
            },
            source_kind: self.sound.kind,
            enhanced: self.full,
            effect: self.sound.action,
            audio: if matches!(self.stage, Phase::Pulses(_)) {
                crate::audio_layers::cue(self.sound, "@zone_sustain")
                    .map(|phase| (self.sound, phase, self.born))
            } else {
                None
            },
            id: self.id,
            caster: self.ctx.caster,
            team: self.ctx.team,
            anchor: crate::AreaAnchor::Independent,
            position: self.ctx.origin,
            direction: self.ctx.direction,
            shape: crate::Shape::Circle { radius },
            next_tick: self.due,
            pulses,
        }
    }
}
impl Battle {
    fn start_zone(&mut self, mut zone: Zone) {
        zone.id = self.next_id;
        zone.sound.owner = zone.id;
        self.next_id += 1;
        self.emit(crate::Fact::AreaStarted(zone.id));
        self.zones.push(zone);
    }
    pub(super) fn forward_release(
        &mut self,
        mut ctx: Origin,
        s: &'static Value,
        full: bool,
        delay: u32,
    ) {
        ctx.origin = ctx.origin + ctx.direction * stat(s, "forward_distance", 0.);
        let sound = self.actors[&ctx.caster].sound_origin();
        if s["independent_on_creation"] == true && s["zone_duration"].as_f64().unwrap_or(0.) <= 0. {
            self.sound(sound, "@start", ctx.origin, None);
        }
        self.start_zone(Zone {
            born: self.tick,
            sound,
            id: 0,
            ctx,
            spec: s,
            full,
            stage: Phase::Impact,
            due: self.tick + u64::from(delay),
        });
    }
    pub(super) fn ground_pulses(
        &mut self,
        ctx: Origin,
        sound: crate::SoundOrigin,
        s: &'static Value,
    ) {
        let period = ticks(stat(s, "zone_tick_interval", 1.)).max(1);
        let count = ticks(stat(s, "zone_duration", 0.)) / period;
        if count > 0 {
            self.start_zone(Zone {
                born: self.tick,
                sound,
                id: 0,
                ctx,
                spec: s,
                full: false,
                stage: Phase::Pulses(count),
                due: self.tick + u64::from(period),
            });
        }
    }
    pub(crate) fn advance_zones(&mut self) {
        let mut changes = vec![];
        for mut z in std::mem::take(&mut self.zones) {
            if z.due > self.tick {
                self.zones.push(z);
                continue;
            }
            let s = z.spec;
            let (radius, damage, slow, duration, stun) = match &z.stage {
                Phase::Impact => (
                    stat(s, "radius", 0.),
                    stat(s, "damage", 0.)
                        * if z.full {
                            stat(s, "resource_full_damage_multiplier", 1.)
                        } else {
                            1.
                        },
                    stat(s, "slow_multiplier", 1.),
                    stat(s, "slow_duration", 0.),
                    stat(s, "stun_duration", 0.)
                        * if z.full {
                            stat(s, "resource_full_stun_multiplier", 1.)
                        } else {
                            1.
                        },
                ),
                Phase::Pulses(_) => (
                    stat(s, "radius", 0.),
                    stat(s, "zone_damage", 0.),
                    stat(s, "zone_slow_multiplier", 1.),
                    stat(s, "zone_slow_duration", 0.),
                    0.,
                ),
                Phase::Ring { age, .. } => (
                    stat(s, "shockwave_end_radius", 0.) * f64::from(*age)
                        / f64::from(ticks(stat(s, "shockwave_duration", 1.))),
                    stat(s, "shockwave_damage", 0.),
                    stat(s, "shockwave_slow_multiplier", 1.),
                    stat(s, "shockwave_slow_duration", 0.),
                    0.,
                ),
            };
            let ids: Vec<_> = self
                .actors
                .values()
                .filter(|a| {
                    a.team != z.ctx.team
                        && Body::from(*a).allows(z.ctx.team, z.ctx.source_pos)
                        && (a.pos - z.ctx.origin).length() <= radius + a.def.radius
                })
                .map(|a| a.id)
                .collect();
            for id in ids {
                if let Phase::Ring { hit, .. } = &mut z.stage {
                    if !hit.insert(id) {
                        continue;
                    }
                }
                if self.consume_effect_shield(id) {
                    continue;
                }
                let hit = Change::delivered(z.ctx.caster, id, -(damage.round() as i32));
                changes.push(if matches!(z.stage, Phase::Ring { .. }) {
                    hit.on_sound(z.sound, "@wave_hit")
                } else {
                    hit
                });
                let a = self.actors.get_mut(&id).unwrap();
                if a.def.role != Role::Nexus && duration > 0. {
                    a.slows.apply(
                        z.ctx.caster,
                        (slow * 1000.) as u16,
                        1000,
                        self.tick + u64::from(ticks(duration)),
                    );
                }
                if stun > 0. {
                    let _ =
                        self.apply_control(id, Control::Stun, z.ctx.caster, ticks(stun), self.tick);
                }
            }
            match z.stage {
                Phase::Impact => {
                    self.sound(z.sound, "@impact", z.ctx.origin, None);
                    self.ground_pulses(z.ctx, z.sound, s);
                    if z.full && s.get("shockwave_duration").is_some() {
                        z.stage = Phase::Ring {
                            age: 1,
                            hit: Default::default(),
                        };
                        z.due += 1;
                        self.zones.push(z);
                    } else {
                        self.emit(crate::Fact::AreaEnded(z.id))
                    }
                }
                Phase::Pulses(left) if left > 1 => {
                    z.stage = Phase::Pulses(left - 1);
                    z.due += u64::from(ticks(stat(s, "zone_tick_interval", 1.)));
                    self.zones.push(z);
                }
                Phase::Ring { ref mut age, .. }
                    if *age < ticks(stat(s, "shockwave_duration", 0.)) =>
                {
                    *age += 1;
                    z.due += 1;
                    self.zones.push(z);
                }
                _ => {
                    self.sound(z.sound, "@zone_end", z.ctx.origin, None);
                    self.emit(crate::Fact::AreaEnded(z.id));
                }
            }
        }
        if !changes.is_empty() {
            self.commit(changes);
        }
    }
}

pub(crate) struct Wave {
    sound: crate::SoundOrigin,
    ctx: Origin,
    start: u64,
    travel: f64,
    length: f64,
    spec: &'static Value,
    hit: BTreeSet<Id>,
}
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize)]
pub struct WaveView {
    pub caster: Id,
    pub team: crate::Team,
    pub start: u64,
    pub origin: crate::Point,
    pub direction: crate::Point,
    pub travel: f64,
    pub length: f64,
    pub width: f64,
}
impl Wave {
    pub(crate) fn view(&self) -> WaveView {
        let progress = (self.travel / self.length.max(0.001)).clamp(0., 1.);
        WaveView {
            caster: self.ctx.caster,
            team: self.ctx.team,
            start: self.start,
            origin: self.ctx.origin,
            direction: self.ctx.direction,
            travel: self.travel,
            length: self.length,
            width: stat(self.spec, "attack_wave_near_width", 48.)
                * (1. + progress * (stat(self.spec, "attack_wave_max_scale", 2.) - 1.)),
        }
    }

    pub(crate) fn new(
        a: &crate::Actor,
        target: crate::targeting::Body,
        s: &'static Value,
        tick: u64,
    ) -> Self {
        let direction = (target.pos - a.pos).unit().unwrap_or(a.facing);
        let origin = a.pos + direction * a.def.radius;
        Self {
            sound: a.sound_origin(),
            ctx: Origin {
                caster: a.id,
                team: a.team,
                source_pos: a.pos,
                origin,
                direction,
            },
            start: tick + u64::from(ticks(stat(s, "attack_wave_delay", 0.))),
            travel: 0.,
            length: (target.pos - origin).length() + stat(s, "attack_wave_tail_distance", 40.),
            spec: s,
            hit: Default::default(),
        }
    }
}
impl Battle {
    pub(crate) fn advance_waves(&mut self) {
        let mut damage = vec![];
        for mut w in std::mem::take(&mut self.attack_waves) {
            if self.tick < w.start {
                self.attack_waves.push(w);
                continue;
            }
            if w.travel == 0. {
                self.sound(w.sound, "attack_wave:launch", w.ctx.origin, None);
            }
            let next = (w.travel + stat(w.spec, "attack_wave_speed", 420.) / 20.).min(w.length);
            for a in self.actors.values() {
                let offset = a.pos - w.ctx.origin;
                let along = offset.dot(w.ctx.direction);
                let side = (offset - w.ctx.direction * along).length();
                let width = stat(w.spec, "attack_wave_near_width", 48.)
                    * 0.5
                    * (1.
                        + (along / w.length).clamp(0., 1.)
                            * (stat(w.spec, "attack_wave_max_scale", 2.) - 1.));
                if a.team != w.ctx.team
                    && Body::from(a).allows(w.ctx.team, w.ctx.source_pos)
                    && along + a.def.radius >= w.travel
                    && along - a.def.radius <= next
                    && side <= width + a.def.radius
                    && w.hit.insert(a.id)
                {
                    damage.push(
                        Change::new(
                            w.ctx.caster,
                            a.id,
                            -(stat(w.spec, "attack_wave_damage", 0.) as i32),
                        )
                        .on_sound(w.sound, "attack_wave:hit"),
                    );
                }
            }
            if next < w.length {
                w.travel = next;
                self.attack_waves.push(w);
            }
        }
        if !damage.is_empty() {
            self.commit(damage);
        }
    }
}
