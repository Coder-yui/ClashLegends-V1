use crate::{lifecycle, vitals::Change, Battle, Effect, Fact, Id, Point, Role, Shape, Team};
use crate::{status, Action};
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AreaAnchor {
    /// The released result remains fixed through source control and death.
    Independent,
    /// Windup or channel owned by a living caster, with a fixed destination.
    CastPoint,
    /// Pulse follows the owner. Freeze, stasis or death terminate future pulses.
    Caster,
}
#[derive(Clone, Copy, Debug)]
pub struct TimedArea {
    pub delay: u32,
    pub period: u32,
    pub pulses: u32,
    pub anchor: AreaAnchor,
    pub shape: Shape,
    pub effects: &'static [Effect],
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
            && !self.effects.is_empty()
            && self.effects.iter().all(|e| match e {
                Effect::Area(child) => {
                    allow_release
                        && self.anchor != AreaAnchor::Independent
                        && self.pulses == 1
                        && child.anchor == AreaAnchor::Independent
                        && child.valid_stage(false)
                }
                Effect::Transform(_) => false,
                Effect::RegenTroops { per_second } => *per_second > 0 && self.period > 0,
                Effect::Motion(m) if m.autonomous() => false,
                _ => e.valid(),
            })
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
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AreaView {
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
        self.emit(Fact::EffectBlocked(id));
        true
    }
    pub(crate) fn schedule_area(&mut self, ctx: Origin, spec: TimedArea) {
        let id = self.next_id;
        self.next_id += 1;
        let view = AreaView {
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
            let effects: Vec<_> = spec
                .effects
                .iter()
                .map(|&e| match e {
                    Effect::RegenTroops { per_second } => {
                        let n = u64::from(per_second) * u64::from(spec.period);
                        let amount = (u128::from(pulse + 1) * u128::from(n)) / 20
                            - (u128::from(pulse) * u128::from(n)) / 20;
                        Effect::HealTroops(amount.min(i32::MAX as u128) as i32)
                    }
                    _ => e,
                })
                .collect();
            self.resolve_effects(
                Origin {
                    caster: v.caster,
                    source_pos,
                    team: v.team,
                    origin: v.position,
                    direction: v.direction,
                },
                spec.shape,
                &effects,
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
            if matches!(effect, Effect::Transform(_) | Effect::RegenTroops { .. })
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
                self.schedule_area(ctx, spec);
                continue;
            }
            match effect {
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
                    Effect::RegenTroops { .. } | Effect::Transform(_) => {
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
