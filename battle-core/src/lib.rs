//! Server-owned fixed-step 2D simulation. No clocks, renderer or transport.
mod audio_layers;
mod battle_audio;
pub use audio_layers::AudioState;
pub use battle_audio::{AttackSound, SoundOrigin};
pub mod classic;
pub use classic::production::SummonFlight;
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
pub use timeline::{AreaAnchor, AreaPulse, AreaView, TimedArea};
mod targeting;
mod vitals;
use model::Actor;
pub use model::{
    Action, Activity, AttackTiming, Control, Event, Fact, Id, Projectile, Role, Snapshot, Team,
    UnitDef, UnitView,
};
mod motion;
pub use motion::Motion;
pub use skills::{Aim, AimKind, Cast, Effect, Shape, Skill};
pub use space::{Arena, Layer, Point, Rect};
use std::collections::BTreeMap;
pub const TICKS_PER_SECOND: u64 = 20;
#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize)]
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
    card_queue: Vec<classic::casts::Pending>,
    volley_hits: BTreeMap<Id, std::collections::BTreeSet<Id>>,
    kayn_forms: [classic::marks::Growth; 2],
    scheduled_audio: Vec<(u64, SoundOrigin, &'static str, Point)>,
    grants: Vec<classic::specialists::Grant>,
    attack_waves: Vec<classic::zones::Wave>,
    effect_paths: Vec<model::EffectPath>,
    summon_flights: Vec<classic::production::ReleasedSummon>,
    pending_births: Vec<(Id, Team, Point, classic::production::Birth)>,
    zones: Vec<classic::zones::Zone>,
    deaths: Vec<classic::production::Death>,
    gold_rewards: [u8; 2],
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
            kayn_forms: Default::default(),
            scheduled_audio: vec![],
            grants: vec![],
            attack_waves: vec![],
            pending_births: vec![],
            effect_paths: vec![],
            summon_flights: vec![],
            zones: vec![],
            deaths: vec![],
            gold_rewards: [0; 2],
            card_queue: vec![],
            volley_hits: Default::default(),
        })
    }
    pub fn spawn(&mut self, team: Team, pos: Point, def: UnitDef) -> Result<Id, Error> {
        if !def.valid() {
            return Err(Error::InvalidDefinition);
        }
        let id = self.next_id;
        let mut a = Actor::new(id, team, pos, def);
        a.since = self.tick;
        a.deploy_start = self.tick;
        if let Some(shield) = a.def.rules.and_then(|s| s["deployment_shield"].as_i64()) {
            a.shields.deployment(shield as i32);
        }
        if a.def.key == "jack_in_the_box"
            || a.def
                .rules
                .is_some_and(|s| s.get("stealth_delay").is_some())
        {
            a.hidden_until = u64::MAX;
        }
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
        if a.card_state.immunity > self.tick
            || a.def.role == Role::Nexus
            || (a.has(Control::Stasis) && kind != Control::Stasis)
        {
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
            effect_paths: self.effect_paths.clone(),
            tick: self.tick,
            projectiles: self.shots.clone(),
            summons: self.summon_flights.iter().map(|f| f.view).collect(),
            waves: self.attack_waves.iter().map(|w| w.view()).collect(),
            areas: self
                .areas
                .values()
                .map(|a| a.view)
                .chain(self.zones.iter().map(|z| z.view()))
                .collect(),
            units: self
                .actors
                .values()
                .map(|a| UnitView {
                    visual: a.visual_state(self.tick),
                    bar: a.bar_indicators(self.tick),
                    dormant: a.card_state.dormant,
                    attack_sound: a.attack_sound(self.tick),
                    cast_action: a.card_state.cast_action,
                    audio_states: a.audio_states(self.tick),
                    audio_kind: a.audio_kind(),
                    deployment_group: a.card_state.deployment_group,
                    sight: a.def.sight,
                    range: a.def.range,
                    radius: a.def.radius,
                    max_hp: a.def.hp,
                    id: a.id,
                    cast_end: a.card_state.cast_end,
                    skill: a
                        .card_state
                        .equipped_skill
                        .filter(|_| a.card_state.cast_end > self.tick),
                    form_changed: a.card_state.changed_form,
                    kind: a.def.key,
                    name: a.def.rules.and_then(|s| s["name"].as_str()),
                    structure: a.def.role.structure(),
                    footprint: a.def.lifecycle.footprint.max(1),
                    air: a.def.layer == Layer::Air,
                    in_flight: a.flight.is_some(),
                    team: a.team,
                    position: a.pos,
                    facing: a.facing,
                    hp: a.hp,
                    target: a.target,
                    activity: a.activity,
                    action_serial: a.action_serial,
                    attack: a.attack,
                    cast_start: a.card_state.cast_start,
                    impact_tick: a.card_state.impact_tick,
                    since: a.since,
                    deploy_start: a.deploy_start,
                    ready_tick: a.ready_tick,
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
        field
            .units
            .retain(|u| u.team == team || !u.hidden || u.kind == "twitch");
        for u in &mut field.units {
            if u.target.is_some_and(|id| {
                self.actors
                    .get(&id)
                    .is_some_and(|a| a.team != team && a.hidden_until > 0)
            }) {
                u.target = None
            }
        }
        let hidden = |id: &Id| {
            self.actors
                .get(id)
                .is_some_and(|a| a.team != team && a.hidden_until > 0 && a.def.key != "twitch")
        };
        field
            .projectiles
            .retain(|shot| !hidden(&shot.owner) && !hidden(&shot.target));
        for unit in &mut field.units {
            unit.visual.drain_targets.retain(|id| !hidden(id));
        }
        field.effect_paths.retain(|p| {
            p.target.is_none_or(|id| !hidden(&id))
                && (matches!(p.kind, "pantheon" | "reksai") || !hidden(&p.owner))
        });
        field.summons.retain(|f| !hidden(&f.source));
        field.waves.retain(|wave| !hidden(&wave.caster));
        field.areas.retain(|area| !hidden(&area.caster));
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
        self.actors
            .get_mut(&command.caster)
            .unwrap()
            .card_state
            .cast_action = "";
        self.emit(Fact::Cast {
            skill: self.actors[&command.caster].card_state.equipped_skill,
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
        self.effect_paths.retain(|p| p.end > self.tick);
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
        if !self.scheduled_audio.is_empty() {
            for (due, source, phase, pos) in std::mem::take(&mut self.scheduled_audio) {
                if due <= self.tick {
                    self.sound(source, phase, pos, None);
                } else {
                    self.scheduled_audio.push((due, source, phase, pos));
                }
            }
        }
        self.deaths.clear();
        let mut bursts = vec![];
        for a in self.actors.values_mut() {
            if let Some(s) = a.shields.expiry_burst(self.tick) {
                a.card_state.visual_action = Some(("shield:explode", self.tick, self.tick + 12));
                bursts.push((
                    timeline::Origin {
                        caster: a.id,
                        team: a.team,
                        origin: a.pos,
                        source_pos: a.pos,
                        direction: a.facing,
                    },
                    s,
                ));
            }
            if a.shields.expire(self.tick) && !a.grievous_wounds {
                a.hp = a.def.hp;
            }
            if a.tidal_haste.is_some_and(|(until, _)| until <= self.tick) {
                a.tidal_haste = None;
            }
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
        let mut changes = vec![];
        for (ctx, s) in bursts {
            self.unit_sound(ctx.caster, "shield:explode", None);
            self.nova(ctx, s, &mut changes);
        }
        if !changes.is_empty() {
            self.commit(changes);
        }
        self.advance_forms();
        self.card_form_step();
        self.aura_heal_step();
        self.advance_card_states();
        self.advance_casts();
        self.advance_zones();
        self.advance_marks();
        self.advance_specialists();
        self.tick_areas();
    }
    fn finish_step(&mut self) {
        self.lifecycle_step();
        self.advance_production();
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
        let mut out = combat::Effects::new(self.next_id, self.tick);
        for a in self.actors.values_mut() {
            let old = a.published_activity;
            let start = out.facts.len();
            if a.ready_tick > self.tick {
                a.activity = Activity::Deploying;
            } else if a.card_state.attack_lock > self.tick {
                a.activity = if a.card_state.move_lock > self.tick {
                    Activity::Channeling
                } else if let Some((target, march)) = view.choose(a, self.map.width / 2.) {
                    a.target = Some(target.id);
                    if march {
                        Activity::March
                    } else {
                        Activity::Chase
                    }
                } else {
                    Activity::Channeling
                };
            } else if a
                .def
                .rules
                .is_some_and(|s| s.get("returning_attack_distance").is_some())
                && self.shots.iter().any(|p| p.owner == a.id)
            {
                a.activity = Activity::Recover;
            } else {
                combat::decide(a, &view, self.map.width / 2., &mut out)
            }
            let cycle = out.facts[start..]
                .iter()
                .any(|f| matches!(f, Fact::AttackStarted(_, _)));
            if cycle {
                a.card_state.last_combat = self.tick;
                a.hidden_until = 0;
            }
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
        self.attack_waves.extend(out.waves);
        self.shots.extend(out.shots);
        for f in out.facts {
            self.emit(f)
        }
        for (source, target, damage) in out.sacrifices {
            self.unit_sound(source, "sacrifice:start", None);
            let to = &self.actors[&target];
            let from = &self.actors[&source];
            let dir = (to.pos - from.pos).unit().unwrap_or(from.facing);
            let impact = self.tick
                + (from.def.rules.unwrap()["sacrifice_delay"].as_f64().unwrap() * 20.).ceil()
                    as u64;
            self.effect_paths.push(model::EffectPath {
                owner: source,
                team: from.team,
                kind: "sacrifice",
                target: Some(target),
                path: vec![from.pos, to.pos - dir * to.def.radius],
                start: self.tick,
                impact,
                end: impact + 1,
            });
            let a = self.actors.get_mut(&source).unwrap();
            let s = a.def.rules.unwrap();
            self.card_queue.push(classic::casts::Pending {
                ctx: timeline::Origin {
                    caster: source,
                    team: a.team,
                    origin: a.pos,
                    source_pos: a.pos,
                    direction: a.facing,
                },
                spec: s,
                due: self.tick + (s["sacrifice_delay"].as_f64().unwrap() * 20.).ceil() as u64,
                stage: classic::casts::Stage::Sacrifice(target, damage, a.sound_origin()),
            });
            a.hp = 0;
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
        self.advance_waves();
        self.advance_sweeps();
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
