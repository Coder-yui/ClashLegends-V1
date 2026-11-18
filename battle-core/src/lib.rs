//! Server-owned fixed-step 2D simulation. No clocks, renderer or transport.
pub mod classic;
mod combat;
mod forms;
pub use forms::{HealthOnChange, Rebirth, Transform};
mod content;
mod lifecycle;
pub use lifecycle::{Lifecycle, SpawnBatch};
mod model;
mod movement;
mod navigation;
pub mod path_search;
mod projectiles;
pub use projectiles::{Delivery, Trajectory, Weapon};
mod skills;
mod space;
mod status;
mod timeline;
pub use timeline::{AreaAnchor, AreaView, TimedArea};
mod targeting;
mod vitals;
use model::Actor;
pub use model::{
    Action, Activity, Control, Event, Fact, Id, Projectile, Role, Snapshot, Team, UnitDef, UnitView,
};
mod motion;
pub use motion::Motion;
pub use skills::{Aim, AimKind, Cast, Effect, Shape, Skill};
pub use space::{Arena, Layer, Point, Rect};
use std::collections::BTreeMap;
pub const TICKS_PER_SECOND: u64 = 20;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    InvalidDefinition,
    InvalidPoint,
    InvalidDirection,
    NoTarget,
    Ownership,
    NoSkill,
    Controlled,
    Cooldown,
    WrongAim,
    InvalidMotion,
}

pub struct Battle {
    map: Arena,
    actors: BTreeMap<Id, Actor>,
    shots: Vec<Projectile>,
    tick: u64,
    areas: BTreeMap<Id, timeline::Area>,
    next_id: Id,
    sequence: u64,
    events: Vec<Event>,
}
impl Battle {
    pub fn new(map: Arena) -> Result<Self, Error> {
        if !map.width.is_finite()
            || !map.height.is_finite()
            || map.width <= 0.
            || map.height <= 0.
            || map.ground_obstacles.iter().any(|r| {
                !map.contains(r.min)
                    || !map.contains(r.max)
                    || r.min.x > r.max.x
                    || r.min.y > r.max.y
            })
        {
            return Err(Error::InvalidDefinition);
        }
        Ok(Self {
            map,
            actors: BTreeMap::new(),
            shots: vec![],
            tick: 0,
            areas: BTreeMap::new(),
            next_id: 1,
            sequence: 0,
            events: vec![],
        })
    }
    pub fn spawn(&mut self, team: Team, pos: Point, def: UnitDef) -> Result<Id, Error> {
        if !def.valid() {
            return Err(Error::InvalidDefinition);
        }
        let id = self.next_id;
        let a = Actor::new(id, team, pos, def);
        let blocks = movement::blockers(&self.actors);
        if !movement::query(&self.map, &blocks, &a).legal(pos) {
            return Err(Error::InvalidPoint);
        }
        if a.def.role.structure()
            && self.actors.values().any(|b| {
                b.flight.is_none()
                    && b.def.layer == a.def.layer
                    && (b.pos - pos).length() < b.def.radius + a.def.radius + 1.5
            })
        {
            return Err(Error::InvalidPoint);
        }
        self.next_id += 1;
        self.actors.insert(id, a);
        self.emit(Fact::Spawned(id));
        Ok(id)
    }
    pub fn control(&mut self, id: Id, kind: Control, ticks: u32) -> Result<(), Error> {
        self.control_from(id, kind, 0, ticks)
    }
    pub fn control_from(
        &mut self,
        id: Id,
        kind: Control,
        source: Id,
        ticks: u32,
    ) -> Result<(), Error> {
        self.apply_control(id, kind, source, ticks, self.tick + 1)
    }
    pub fn remove_control(&mut self, id: Id, kind: Control, source: Id) -> Result<(), Error> {
        self.actors
            .get_mut(&id)
            .ok_or(Error::NoTarget)?
            .controls
            .remove(kind, source);
        Ok(())
    }
    fn apply_control(
        &mut self,
        id: Id,
        kind: Control,
        source: Id,
        ticks: u32,
        first_tick: u64,
    ) -> Result<(), Error> {
        if ticks == 0 {
            return Err(Error::InvalidDefinition);
        }
        if kind == Control::Taunt {
            let actor = self.actors.get(&id).ok_or(Error::NoTarget)?;
            let src = self.actors.get(&source).ok_or(Error::NoTarget)?;
            if src.def.layer != Layer::Ground
                || actor.def.role.structure()
                || !targeting::Body::from(src).eligible(actor)
            {
                return Err(Error::NoTarget);
            }
        }
        let a = self.actors.get_mut(&id).ok_or(Error::NoTarget)?;
        if a.def.role == Role::Nexus || (a.has(Control::Stasis) && kind != Control::Stasis) {
            return Err(Error::Controlled);
        }
        if a.flight.is_some_and(|f| {
            kind == Control::Stasis
                || (f.kind == motion::MotionKind::Dash
                    && matches!(kind, Control::Root | Control::Stun | Control::Freeze))
        }) {
            let blocks = movement::blockers(&self.actors);
            let a = self.actors.get_mut(&id).unwrap();
            if !movement::settle(&self.map, &blocks, a) {
                return Err(Error::InvalidPoint);
            }
        }
        let a = self.actors.get_mut(&id).unwrap();
        let until = first_tick + u64::from(ticks);
        a.controls.apply(kind, source, until);
        if kind == Control::Taunt && a.target != Some(source) {
            a.reset_attack();
            a.route_goal = None;
        }
        if a.disabled() {
            a.reset_attack();
            a.activity = Activity::Idle;
        }
        if matches!(kind, Control::Freeze | Control::Stasis) {
            self.cancel_owned_areas(id)
        }
        self.emit(Fact::Controlled(id, kind));
        Ok(())
    }
    fn emit(&mut self, fact: Fact) {
        self.sequence += 1;
        self.events.push(Event {
            tick: self.tick,
            sequence: self.sequence,
            fact,
        });
    }
    pub fn drain_events(&mut self) -> impl Iterator<Item = Event> + '_ {
        self.events.drain(..)
    }
    pub fn snapshot(&self) -> Snapshot {
        Snapshot {
            tick: self.tick,
            projectiles: self.shots.clone(),
            areas: self.areas.values().map(|a| a.view).collect(),
            units: self
                .actors
                .values()
                .map(|a| UnitView {
                    sight: a.def.sight,
                    range: a.def.range,
                    radius: a.def.radius,
                    max_hp: a.def.hp,
                    id: a.id,
                    kind: a.def.key,
                    team: a.team,
                    position: a.pos,
                    facing: a.facing,
                    hp: a.hp,
                    target: a.target,
                    activity: a.activity,
                    action_serial: a.action_serial,
                    since: a.since,
                    rounds: a.rounds,
                    reload_left: a.reload_left,
                    shield: a.shields.total(),
                    effect_shield: a.effect_shield_until > self.tick,
                    controls: a.controls.types(),
                    hidden: a.hidden_until > 0,
                    movement_rate: a.rates().0,
                    attack_rate: a.rates().1,
                    damage_rate: a.rates().2,
                })
                .collect(),
        }
    }
    pub fn snapshot_for(&self, team: Team) -> Snapshot {
        let mut field = self.snapshot();
        field.units.retain(|u| u.team == team || !u.hidden);
        for u in &mut field.units {
            if u.target.is_some_and(|id| {
                self.actors
                    .get(&id)
                    .is_some_and(|a| a.team != team && a.hidden_until > 0)
            }) {
                u.target = None
            }
        }
        field
    }
    fn cast(
        &mut self,
        team: Team,
        command: Cast,
        changes: &mut Vec<crate::vitals::Change>,
    ) -> Result<(), Error> {
        let a = self.actors.get(&command.caster).ok_or(Error::NoTarget)?;
        let (skill, mut origin, dir) = skills::resolve(&self.map, a, team, self.tick, command.aim)?;
        if let Some(Effect::Transform(t)) = skill.effects.first() {
            self.transform(command.caster, *t)?;
        }
        if let Some(Effect::Motion(m)) = skill.effects.first() {
            if m.autonomous() {
                let end = self.resolve_motion(command.caster, origin, dir, *m, self.tick)?;
                if matches!(m, Motion::Blink { .. }) {
                    origin = end;
                }
            }
        }
        self.actors.get_mut(&command.caster).unwrap().next_skill =
            self.tick + u64::from(skill.cooldown);
        self.emit(Fact::Cast {
            caster: command.caster,
            origin,
            direction: dir,
        });
        self.resolve_effects(
            timeline::Origin {
                caster: command.caster,
                source_pos: self.actors[&command.caster].pos,
                team,
                origin,
                direction: dir,
            },
            skill.shape,
            &skill.effects,
            changes,
        );
        Ok(())
    }
    /// Commands arrive in host-accepted order. Validation failure does not spend cooldown.
    pub fn step(&mut self, commands: &[(Team, Cast)]) {
        self.begin_step();
        let mut changes = vec![];
        for &(team, cmd) in commands {
            if let Err(reason) = self.cast(team, cmd, &mut changes) {
                self.emit(Fact::Rejected {
                    caster: cmd.caster,
                    reason,
                })
            }
        }
        self.commit(changes);
        self.finish_step();
    }
    fn begin_step(&mut self) {
        self.tick += 1;
        for a in self.actors.values_mut() {
            a.shields.expire(self.tick);
            a.slows.expire(self.tick);
            if a.empowerment.is_some_and(|e| e.until <= self.tick) {
                a.empowerment = None;
            }
            a.controls.expire(self.tick);
            if a.hidden_until <= self.tick {
                a.hidden_until = 0
            }
            if a.sanctuary
                .is_some_and(|s| s.until <= self.tick || !s.contains(a.pos))
            {
                a.sanctuary = None;
            }
        }
        self.advance_forms();
        self.tick_areas();
    }
    fn finish_step(&mut self) {
        self.lifecycle_step();
        let view = targeting::Perception::new(&self.actors);
        for a in self.actors.values_mut() {
            if let Some(src) = a.controls.source(Control::Taunt) {
                if view
                    .bodies
                    .get(&src)
                    .is_none_or(|b| b.layer != Layer::Ground || !b.eligible(a))
                {
                    a.controls.remove(Control::Taunt, src);
                }
            }
        }
        let mut out = combat::Effects::new(self.next_id);
        for a in self.actors.values_mut() {
            let old = a.published_activity;
            let start = out.facts.len();
            if a.ready_tick > self.tick {
                a.activity = Activity::Deploying;
            } else {
                combat::decide(a, &view, self.map.width / 2., &mut out)
            }
            let cycle = out.facts[start..]
                .iter()
                .any(|f| matches!(f, Fact::AttackStarted(_, _)));
            if old != a.activity || cycle {
                a.action_serial += 1;
                a.since = self.tick;
                a.published_activity = a.activity;
                out.facts.push(Fact::ActionChanged {
                    id: a.id,
                    serial: a.action_serial,
                    activity: a.activity,
                });
            }
        }
        self.next_id = out.next_id;
        self.shots.extend(out.shots);
        for f in out.facts {
            self.emit(f)
        }
        self.commit(out.health);
        let mut facts = vec![];
        movement::advance(&self.map, &mut self.actors, self.tick, &mut facts);
        for f in facts {
            self.emit(f)
        }
        for a in self.actors.values_mut() {
            if a.sanctuary.is_some_and(|s| !s.contains(a.pos)) {
                a.sanctuary = None
            }
        }
        self.projectile_step();
        let mut transitions = vec![];
        for a in self
            .actors
            .values_mut()
            .filter(|a| a.activity != a.published_activity)
        {
            a.action_serial += 1;
            a.published_activity = a.activity;
            a.since = self.tick;
            transitions.push(Fact::ActionChanged {
                id: a.id,
                serial: a.action_serial,
                activity: a.activity,
            });
        }
        for fact in transitions {
            self.emit(fact)
        }
    }
}
