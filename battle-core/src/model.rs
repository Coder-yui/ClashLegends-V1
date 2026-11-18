use crate::{Layer, Point};
use std::collections::{BTreeMap, VecDeque};
pub type Id = u64;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Team {
    Blue,
    Red,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Troop,
    Building,
    LaneTower,
    Nexus,
}
impl Role {
    pub fn structure(self) -> bool {
        self != Self::Troop
    }
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Action {
    Idle,
    Strike {
        damage: i32,
        windup: u32,
        interval: u32,
    },
    Shot {
        damage: i32,
        windup: u32,
        interval: u32,
        speed: f64,
    },
    Drain {
        per_second: u32,
        active: u32,
        pause: u32,
        steal: u16,
    },
    Beam {
        per_second: u32,
    },
    Mend {
        per_second: u32,
    },
}
#[derive(Clone, Debug)]
pub struct UnitDef {
    pub key: &'static str,
    pub role: Role,
    pub layer: Layer,
    pub radius: f64,
    pub mass: f64,
    pub hp: i32,
    pub sight: f64,
    pub range: f64,
    pub speed: f64,
    pub buildings_only: bool,
    pub hits_air: bool,
    pub action: Action,
    pub skill: Option<crate::Skill>,
    pub lifecycle: crate::Lifecycle,
    pub weapon: crate::Weapon,
}
impl UnitDef {
    pub(crate) fn valid(&self) -> bool {
        let nonnegative = |v: f64| v.is_finite() && v >= 0.;
        self.radius.is_finite()
            && self.radius > 0.
            && self.mass.is_finite()
            && self.mass > 0.
            && self.hp > 0
            && nonnegative(self.range)
            && nonnegative(self.sight)
            && nonnegative(self.speed)
            && match self.action {
                Action::Strike {
                    damage, interval, ..
                } => damage > 0 && interval > 0,
                Action::Shot {
                    damage,
                    interval,
                    speed,
                    ..
                } => damage > 0 && interval > 0 && speed.is_finite() && speed > 0.,
                Action::Drain {
                    active, per_second, ..
                } => active > 0 && per_second > 0,
                Action::Beam { per_second } | Action::Mend { per_second } => per_second > 0,
                Action::Idle => true,
            }
            && self
                .lifecycle
                .production
                .is_none_or(|(n, b)| n > 0 && b.count > 0)
            && self
                .lifecycle
                .death_area
                .is_none_or(|a| a.valid() && a.anchor == crate::AreaAnchor::Independent)
            && self.weapon.valid()
            && self.skill.as_ref().is_none_or(|s| s.valid())
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub enum Control {
    Root,
    Stun,
    Freeze,
    Silence,
    Taunt,
    Stasis,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Activity {
    Idle,
    March,
    Chase,
    Windup,
    Recover,
    Mending,
    Channeling,
    Displaced,
    Deploying,
}
#[derive(Clone, Copy, Debug)]
pub(crate) struct Flight {
    pub kind: crate::motion::MotionKind,
    pub end: Point,
    pub step: f64,
    pub lock_until: u64,
}
#[derive(Clone, Debug)]
pub(crate) struct Actor {
    pub id: Id,
    pub def: UnitDef,
    pub team: Team,
    pub pos: Point,
    pub facing: Point,
    pub hp: i32,
    pub target: Option<Id>,
    pub activity: Activity,
    pub action_serial: u64,
    pub published_activity: Activity,
    pub avoidance_turn: f64,
    pub since: u64,
    pub route: VecDeque<Point>,
    pub route_goal: Option<Point>,
    pub replan: u64,
    pub release_at: Option<u64>,
    pub next_attack: u64,
    pub attack_clock: u64,
    pub empowerment: Option<crate::status::Empowerment>,
    pub slows: crate::status::Slows,
    pub beam_remainders: BTreeMap<Id, u64>,
    pub heal_remainder: u32,
    pub controls: crate::status::Controls,
    pub hidden_until: u64,
    pub sanctuary: Option<crate::status::Sanctuary>,
    pub flight: Option<Flight>,
    pub next_skill: u64,
    pub shields: crate::vitals::Shields,
    pub effect_shield_until: u64,
    pub steal_carry: u16,
    pub blind: u8,
    pub lives: u8,
    pub revert: Option<crate::forms::Revert>,
    pub rounds: u8,
    pub reload_left: u32,
    pub drain: crate::combat::DrainState,
    pub ready_tick: u64,
    pub decay_carry: i64,
    pub production_left: u32,
}
impl Actor {
    pub fn new(id: Id, team: Team, pos: Point, def: UnitDef) -> Self {
        Self {
            id,
            team,
            pos,
            hp: def.hp,
            rounds: def.weapon.magazine,
            lives: def.lifecycle.rebirth.map_or(0, |r| r.charges),
            revert: None,
            reload_left: 0,
            def,
            facing: Point::new(0., if team == Team::Blue { -1. } else { 1. }),
            target: None,
            activity: Activity::Idle,
            action_serial: 0,
            published_activity: Activity::Idle,
            avoidance_turn: 0.,
            since: 0,
            route: VecDeque::new(),
            route_goal: None,
            replan: 0,
            release_at: None,
            next_attack: 0,
            attack_clock: 0,
            empowerment: None,
            slows: Default::default(),
            beam_remainders: BTreeMap::new(),
            heal_remainder: 0,
            controls: Default::default(),
            hidden_until: 0,
            sanctuary: None,
            flight: None,
            next_skill: 0,
            shields: Default::default(),
            effect_shield_until: 0,
            steal_carry: 0,
            blind: 0,
            drain: Default::default(),
            ready_tick: 0,
            decay_carry: 0,
            production_left: 0,
        }
    }
    pub fn has(&self, c: Control) -> bool {
        self.controls.has(c)
    }
    pub fn disabled(&self) -> bool {
        self.has(Control::Stasis)
            || self.has(Control::Stun)
            || self.has(Control::Freeze)
            || self.flight.is_some()
    }
    pub fn reset_attack(&mut self) {
        self.drain = Default::default();
        self.release_at = None;
        self.next_attack = 0;
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Projectile {
    pub trajectory: crate::Trajectory,
    pub team: Team,
    pub origin: Point,
    pub radius: f64,
    pub hits_air: bool,
    pub id: Id,
    pub owner: Id,
    pub target: Id,
    pub position: Point,
    pub damage: i32,
    pub speed: f64,
}
#[derive(Clone, Debug, PartialEq)]
pub struct UnitView {
    pub sight: f64,
    pub range: f64,
    pub radius: f64,
    pub max_hp: i32,
    pub id: Id,
    pub kind: &'static str,
    pub team: Team,
    pub position: Point,
    pub facing: Point,
    pub hp: i32,
    pub target: Option<Id>,
    pub activity: Activity,
    pub action_serial: u64,
    pub since: u64,
    pub controls: Vec<Control>,
    pub shield: i32,
    pub effect_shield: bool,
    pub hidden: bool,
    pub rounds: u8,
    pub reload_left: u32,
    pub movement_rate: u16,
    pub attack_rate: u16,
    pub damage_rate: u16,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Snapshot {
    pub tick: u64,
    pub units: Vec<UnitView>,
    pub projectiles: Vec<Projectile>,
    pub areas: Vec<crate::AreaView>,
}
#[derive(Clone, Debug, PartialEq)]
pub enum Fact {
    EffectBlocked(Id),
    Spawned(Id),
    ActionChanged {
        id: Id,
        serial: u64,
        activity: Activity,
    },
    FormChanged {
        id: Id,
        from: &'static str,
        to: &'static str,
    },
    AreaStarted(Id),
    AreaEnded(Id),
    Missed {
        source: Id,
        target: Id,
    },
    Damage {
        source: Id,
        target: Id,
        requested: i32,
        absorbed: i32,
        lost: i32,
        killed: bool,
    },
    Summoned {
        source: Id,
        child: Id,
    },
    AttackStarted(Id, Id),
    Fired(Id, Id, Id),
    ProjectileHit {
        projectile: Id,
        target: Id,
    },
    Health {
        source: Id,
        target: Id,
        change: i32,
    },
    Died(Id),
    Cast {
        caster: Id,
        origin: Point,
        direction: Point,
    },
    Rejected {
        caster: Id,
        reason: crate::Error,
    },
    Controlled(Id, Control),
    Displaced(Id, Point),
    Landed(Id, Point),
    Blinked(Id, Point),
}
#[derive(Clone, Debug, PartialEq)]
pub struct Event {
    pub tick: u64,
    pub sequence: u64,
    pub fact: Fact,
}
