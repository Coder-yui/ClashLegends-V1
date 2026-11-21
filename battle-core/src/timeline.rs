use crate::{lifecycle, vitals::Change, Battle, Effect, Fact, Id, Point, Role, Shape, Team};
use crate::{status, Action};
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
pub enum AreaAnchor {
    /// The released result remains fixed through source control and death.
    Independent,
    /// Windup or channel owned by a living caster, with a fixed destination.
    CastPoint,
    /// Pulse follows the owner. Freeze, stasis or death terminate future pulses.
    Caster,
}
/// A periodic heal accumulates fractional hit points across its own pulses.
#[derive(Clone, Copy, Debug)]
pub enum AreaPulse {
    Effects(&'static [Effect]),
    RegenTroops { per_second: f64 },
}
#[derive(Clone, Copy, Debug)]
pub struct TimedArea {
    pub delay: u32,
    pub period: u32,
    pub pulses: u32,
    pub anchor: AreaAnchor,
    pub shape: Shape,
    pub pulse: AreaPulse,
}
impl TimedArea {
    pub(crate) fn valid(self) -> bool {
        self.valid_stage(true)
    }
    fn valid_stage(self, allow_release: bool) -> bool {
        self.delay > 0
            && self.pulses > 0
            && (self.period > 0 || self.pulses == 1)
            && self.shape.valid()
            && match self.pulse {
                AreaPulse::RegenTroops { per_second } => {
                    per_second.is_finite() && per_second > 0. && self.period > 0
                }
                AreaPulse::Effects(effects) => {
                    !effects.is_empty()
                        && effects.iter().all(|e| match e {
                            Effect::Area(child) => {
                                allow_release
                                    && self.anchor != AreaAnchor::Independent
                                    && self.pulses == 1
                                    && child.anchor == AreaAnchor::Independent
                                    && child.valid_stage(false)
                            }
                            Effect::Transform(_) => false,
                            Effect::Motion(m) if m.autonomous() => false,
                            _ => e.valid(),
                        })
                }
            }
    }
}
#[derive(Clone, Copy, Debug)]
pub(crate) struct Origin {
    pub caster: Id,
    pub team: Team,
    pub origin: Point,
    pub source_pos: Point,
    pub direction: Point,
}
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize)]
pub struct AreaView {
    pub born: u64,
    pub phase: &'static str,
    pub source_kind: &'static str,
    pub enhanced: bool,
    pub effect: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio: Option<(crate::SoundOrigin, &'static str, u64)>,
    pub id: Id,
    pub caster: Id,
    pub team: Team,
    pub anchor: AreaAnchor,
    pub position: Point,
    pub direction: Point,
    pub shape: Shape,
    pub next_tick: u64,
    pub pulses: u32,
}
pub(crate) struct Area {
    pub view: AreaView,
    spec: TimedArea,
    source_pos: Point,
}
impl Battle {
    pub(crate) fn consume_effect_shield(&mut self, id: Id) -> bool {
        let a = self.actors.get_mut(&id).unwrap();
        if a.effect_shield_until <= self.tick {
            return false;
        }
        a.effect_shield_until = 0;
        if let Some(s) = a.card_state.on_block.take() {
            let heal = s["block_heal"].as_f64().unwrap_or(0.) as i32;
            if let Some(duration) = s["block_haste_duration"].as_f64() {
                a.empowerment = Some(crate::status::Empowerment {
                    movement: 1000,
                    attack: (s["block_attack_speed_multiplier"].as_f64().unwrap_or(1.) * 1000.)
                        .round() as u16,
                    damage: 1000,
                    until: self.tick + (duration * 20.).ceil() as u64,
                });
            }
            if heal > 0 {
                self.commit(vec![Change::new(id, id, heal)]);
            }
        }
        self.emit(Fact::EffectBlocked(id));
        true
    }
    pub(crate) fn schedule_area(
        &mut self,
        ctx: Origin,
        spec: TimedArea,
        source_kind: &'static str,
    ) {
        let id = self.next_id;
        self.next_id += 1;
        let view = AreaView {
            born: self.tick,
            phase: "",
            source_kind,
            enhanced: false,
            effect: "",
            audio: None,
            id,
            caster: ctx.caster,
            team: ctx.team,
            anchor: spec.anchor,
            position: ctx.origin,
            direction: ctx.direction,
            shape: spec.shape,
            next_tick: self.tick + u64::from(spec.delay),
            pulses: spec.pulses,
        };
        self.areas.insert(
            id,
            Area {
                view,
                spec,
                source_pos: ctx.source_pos,
            },
        );
        self.emit(Fact::AreaStarted(id));
    }
    pub(crate) fn cancel_owned_areas(&mut self, source: Id) {
        let ids: Vec<_> = self
            .areas
            .iter()
            .filter(|(_, a)| a.view.caster == source && a.spec.anchor != AreaAnchor::Independent)
            .map(|(&id, _)| id)
            .collect();
        for id in ids {
            self.areas.remove(&id);
            self.emit(Fact::AreaEnded(id));
        }
    }
    pub(crate) fn tick_areas(&mut self) {
        let ids: Vec<_> = self
            .areas
            .iter_mut()
            .filter_map(|(&id, a)| {
                if a.spec.anchor == AreaAnchor::Caster {
                    if let Some(owner) = self.actors.get(&a.view.caster) {
                        a.view.position = owner.pos;
                    }
                }
                (a.view.next_tick <= self.tick).then_some(id)
            })
            .collect();
        let mut changes = vec![];
        for id in ids {
            let Some(a) = self.areas.get_mut(&id) else {
                continue;
            };
            let v = a.view;
            let spec = a.spec;
            let source_pos = self.actors.get(&v.caster).map_or(a.source_pos, |s| s.pos);
            a.view.pulses -= 1;
            a.view.next_tick += u64::from(spec.period);
            let finished = a.view.pulses == 0;
            let pulse = u64::from(spec.pulses - v.pulses);
            let heal;
            let effects = match spec.pulse {
                AreaPulse::Effects(effects) => effects,
                AreaPulse::RegenTroops { per_second } => {
                    let through = |n: u64| {
                        (n as f64 * f64::from(spec.period) * per_second
                            / crate::TICKS_PER_SECOND as f64)
                            .floor()
                    };
                    heal = [Effect::HealTroops(
                        (through(pulse + 1) - through(pulse)) as i32,
                    )];
                    &heal[..]
                }
            };
            self.resolve_effects(
                Origin {
                    caster: v.caster,
                    source_pos,
                    team: v.team,
                    origin: v.position,
                    direction: v.direction,
                },
                spec.shape,
                effects,
                &mut changes,
            );
            if finished && self.areas.remove(&id).is_some() {
                self.emit(Fact::AreaEnded(id))
            }
        }
        self.commit(changes)
    }
    pub(crate) fn resolve_effects(
        &mut self,
        ctx: Origin,
        shape: Shape,
        effects: &[Effect],
        changes: &mut Vec<Change>,
    ) {
        let mut blocked = std::collections::BTreeSet::new();
        for &effect in effects {
            if matches!(effect, Effect::Transform(_))
                || matches!(effect,Effect::Motion(m) if m.autonomous())
            {
                continue;
            }
            if let Effect::Summon(batch) = effect {
                if let Some(a) = self.actors.get(&ctx.caster) {
                    self.summon(lifecycle::Generation::from(a, batch))
                }
                continue;
            }
            if let Effect::Area(spec) = effect {
                self.schedule_area(
                    ctx,
                    spec,
                    self.actors.get(&ctx.caster).map_or("", |a| a.def.key),
                );
                continue;
            }
            match effect {
                Effect::CardAbility(s) => {
                    self.card_ability(ctx, s, changes);
                    continue;
                }
                Effect::Empower {
                    movement,
                    attack,
                    damage,
                    ticks,
                } => {
                    if let Some(a) = self.actors.get_mut(&ctx.caster) {
                        a.empowerment = Some(crate::status::Empowerment {
                            movement,
                            attack,
                            damage,
                            until: self.tick + u64::from(ticks),
                        });
                    }
                    continue;
                }
                Effect::SelfShield { amount, ticks } => {
                    if let Some(a) = self.actors.get_mut(&ctx.caster) {
                        a.shields.add(amount, self.tick + u64::from(ticks));
                    }
                    continue;
                }
                Effect::EffectShield { ticks } => {
                    if let Some(a) = self.actors.get_mut(&ctx.caster) {
                        a.effect_shield_until = self.tick + u64::from(ticks);
                    }
                    continue;
                }
                Effect::Stealth { ticks } => {
                    if let Some(a) = self.actors.get_mut(&ctx.caster) {
                        a.hidden_until = self.tick + u64::from(ticks)
                    }
                    continue;
                }
                Effect::Sanctuary { radius, ticks } => {
                    if let Some(a) = self.actors.get_mut(&ctx.caster) {
                        a.sanctuary = Some(status::Sanctuary {
                            center: a.pos,
                            radius,
                            until: self.tick + u64::from(ticks),
                        })
                    }
                    continue;
                }
                _ => {}
            }
            let targets: Vec<_> = self
                .actors
                .values()
                .filter(|b| {
                    (b.team == ctx.team) == effect.ally()
                        && crate::targeting::Body::from(*b).allows(ctx.team, ctx.source_pos)
                        && shape.hits(b.pos - ctx.origin, ctx.direction, b.def.radius)
                })
                .map(|b| b.id)
                .collect();
            for id in targets {
                if !effect.ally() && (blocked.contains(&id) || self.consume_effect_shield(id)) {
                    blocked.insert(id);
                    continue;
                }
                match effect {
                    Effect::Motion(m) => {
                        let _ = self.resolve_motion(id, ctx.origin, ctx.direction, m, self.tick);
                    }
                    Effect::Area(_)
                    | Effect::Summon(_)
                    | Effect::Empower { .. }
                    | Effect::EffectShield { .. }
                    | Effect::Stealth { .. }
                    | Effect::Sanctuary { .. } => {
                        unreachable!("summon resolves once per cast")
                    }
                    Effect::Slow {
                        movement,
                        attack,
                        ticks,
                    } => {
                        let b = self.actors.get_mut(&id).unwrap();
                        if matches!(b.def.role, Role::Troop | Role::Building) {
                            let attack = if b.def.role.structure() {
                                status::NORMAL
                            } else {
                                attack
                            };
                            b.slows.apply(
                                ctx.caster,
                                movement,
                                attack,
                                self.tick + u64::from(ticks),
                            );
                        }
                    }
                    Effect::Shield { amount, ticks } => self
                        .actors
                        .get_mut(&id)
                        .unwrap()
                        .shields
                        .add(amount, self.tick + u64::from(ticks)),
                    Effect::Blind { charges } => {
                        let b = self.actors.get_mut(&id).unwrap();
                        if matches!(b.def.action, Action::Strike { .. } | Action::Shot { .. }) {
                            b.blind = b.blind.max(charges)
                        }
                    }
                    Effect::Damage(n) => {
                        changes.push(crate::vitals::Change::delivered(ctx.caster, id, -n))
                    }
                    Effect::HealTroops(n) => {
                        if self.actors[&id].def.role == Role::Troop {
                            changes.push(Change::new(ctx.caster, id, n))
                        }
                    }
                    Effect::CardAbility(_) | Effect::SelfShield { .. } | Effect::Transform(_) => {
                        unreachable!("resolved by action owner")
                    }
                    Effect::Heal(n) => changes.push(crate::vitals::Change::new(ctx.caster, id, n)),
                    Effect::Control { kind, ticks } => {
                        let _ = self.apply_control(id, kind, ctx.caster, ticks, self.tick);
                    }
                    Effect::Push {
                        distance,
                        speed,
                        extension,
                    } => {
                        let _ = self.begin_displacement(
                            id,
                            ctx.direction,
                            distance,
                            speed,
                            extension,
                            self.tick,
                        );
                    }
                }
            }
        }
    }
}
