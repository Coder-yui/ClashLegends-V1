//! Representative gameplay definitions migrated from the legacy card catalog.
use crate::{Action, Layer, Role, UnitDef};

impl UnitDef {
    pub fn melee() -> Self {
        Self {
            key: "melee_minion",
            rules: None,
            role: Role::Troop,
            layer: Layer::Ground,
            radius: 12.,
            mass: 2.,
            hp: 210,
            sight: 180.,
            range: 32.,
            speed: 60.,
            buildings_only: false,
            hits_air: false,
            action: Action::Strike {
                damage: 42,
                windup: 7,
                interval: 20,
            },
            skill: None,
            lifecycle: Default::default(),
            weapon: Default::default(),
        }
    }
    pub fn ranged() -> Self {
        Self {
            key: "ranged_minion",
            hp: 135,
            mass: 1.8,
            sight: 210.,
            range: 150.,
            hits_air: true,
            action: Action::Shot {
                damage: 32,
                windup: 9,
                interval: 25,
                speed: 360.,
            },
            ..Self::melee()
        }
    }
    fn baron(self, movement: u16, attack: u16, ticks: u32) -> Self {
        Self {
            skill: Some(crate::Skill {
                aim: crate::AimKind::Instant,
                cast_range: 0.,
                shape: crate::Shape::Circle { radius: 0. },
                effects: vec![crate::Effect::Empower {
                    movement,
                    attack,
                    damage: 1250,
                    ticks,
                }],
                cooldown: 100,
            }),
            ..self
        }
    }
    pub fn baron_melee() -> Self {
        Self::melee().baron(1350, 1000, 80)
    }
    pub fn baron_ranged() -> Self {
        Self::ranged().baron(1000, 1250, 100)
    }
    pub fn crab() -> Self {
        Self {
            key: "scuttle_crab",
            hp: 550,
            radius: 18.,
            mass: 4.,
            sight: 200.,
            buildings_only: true,
            action: Action::Mend { per_second: 30 },
            lifecycle: crate::Lifecycle {
                death_area: Some(crate::TimedArea {
                    anchor: crate::AreaAnchor::Independent,
                    delay: 97,
                    period: 1,
                    pulses: 120,
                    shape: crate::Shape::Circle { radius: 110. },
                    pulse: crate::AreaPulse::RegenTroops { per_second: 25. },
                }),
                ..Default::default()
            },
            skill: Some(crate::Skill {
                aim: crate::AimKind::Instant,
                cast_range: 0.,
                shape: crate::Shape::Circle { radius: 130. },
                effects: vec![crate::Effect::Slow {
                    movement: 600,
                    attack: 700,
                    ticks: 60,
                }],
                cooldown: 160,
            }),
            ..Self::melee()
        }
    }
    pub fn dragon() -> Self {
        Self {
            key: "aurelionsol",
            hp: 580,
            layer: Layer::Air,
            radius: 18.,
            mass: 5.,
            speed: 36.,
            sight: 250.,
            range: 130.,
            hits_air: true,
            action: Action::Beam { per_second: 70 },
            ..Self::melee()
        }
    }
}
impl UnitDef {
    pub fn imp() -> Self {
        Self {
            key: "imp",
            hp: 55,
            mass: 1.,
            speed: 68.,
            action: Action::Strike {
                damage: 55,
                windup: 5,
                interval: 14,
            },
            ..Self::melee()
        }
    }
    pub fn super_minion() -> Self {
        Self {
            key: "super_minion",
            hp: 720,
            mass: 6.,
            radius: 21.,
            sight: 200.,
            action: Action::Strike {
                damage: 72,
                windup: 8,
                interval: 23,
            },
            ..Self::melee()
        }
    }
    pub fn siege() -> Self {
        Self {
            key: "siege_minion",
            hp: 390,
            mass: 4.5,
            radius: 18.,
            sight: 230.,
            range: 170.,
            hits_air: true,
            action: Action::Shot {
                damage: 58,
                windup: 11,
                interval: 33,
                speed: 310.,
            },
            ..Self::melee()
        }
    }
    pub fn tombstone() -> Self {
        let batch = crate::SpawnBatch {
            unit: Self::imp,
            count: 2,
        };
        Self {
            key: "tombstone",
            role: Role::Building,
            hp: 400,
            speed: 0.,
            radius: 40.,
            range: 0.,
            action: Action::Idle,
            skill: Some(crate::Skill {
                aim: crate::AimKind::Instant,
                cast_range: 0.,
                shape: crate::Shape::Circle { radius: 0. },
                effects: vec![crate::Effect::Summon(crate::SpawnBatch {
                    unit: Self::imp,
                    count: 4,
                })],
                cooldown: 200,
            }),
            lifecycle: crate::Lifecycle {
                footprint: 3,
                production: Some((100, batch)),
                decay_ticks: 400,
                on_death: Some(batch),
                ..Default::default()
            },
            ..Self::melee()
        }
    }
    pub fn tower() -> Self {
        Self {
            key: "princess_tower",
            role: Role::LaneTower,
            hp: 2100,
            speed: 0.,
            radius: 54.,
            range: 240.,
            sight: 240.,
            hits_air: true,
            weapon: crate::Weapon {
                radius: 7.,
                ..Default::default()
            },
            action: Action::Shot {
                damage: 55,
                windup: 4,
                interval: 16,
                speed: 420.,
            },
            lifecycle: crate::Lifecycle {
                footprint: 3,
                ..Default::default()
            },
            ..Self::melee()
        }
    }
    pub fn nexus() -> Self {
        Self {
            key: "nexus",
            role: Role::Nexus,
            hp: 3600,
            speed: 0.,
            radius: 72.,
            range: 0.,
            sight: 0.,
            action: Action::Idle,
            lifecycle: crate::Lifecycle {
                footprint: 4,
                ..Default::default()
            },
            ..Self::melee()
        }
    }
}
impl UnitDef {
    pub fn fiddlesticks() -> Self {
        Self {
            key: "fiddlesticks",
            hp: 1200,
            radius: 21.,
            mass: 6.,
            speed: 44.,
            range: 180.,
            sight: 250.,
            hits_air: true,
            action: Action::Drain {
                per_second: 60,
                active: 40,
                pause: 15,
                steal: 500,
            },
            ..Self::melee()
        }
    }
    pub fn scarecrow() -> Self {
        Self {
            key: "scarecrow",
            speed: 0.,
            role: Role::Building,
            lifecycle: crate::Lifecycle {
                footprint: 3,
                decay_ticks: 1000,
                ..Default::default()
            },
            skill: Some(crate::Skill {
                aim: crate::AimKind::Instant,
                shape: crate::Shape::Circle { radius: 0. },
                cast_range: 0.,
                cooldown: 400,
                effects: vec![crate::Effect::Transform(crate::Transform {
                    form: Self::fiddlesticks,
                    health: crate::HealthOnChange::Keep,
                    lock: 6,
                    revert_after: None,
                })],
            }),
            ..Self::fiddlesticks()
        }
    }
    pub fn phoenix() -> Self {
        Self {
            key: "anivia",
            hp: 620,
            radius: 18.,
            mass: 5.,
            speed: 36.,
            range: 190.,
            sight: 270.,
            layer: Layer::Air,
            hits_air: true,
            action: Action::Shot {
                damage: 78,
                windup: 14,
                interval: 34,
                speed: 420.,
            },
            lifecycle: crate::Lifecycle {
                rebirth: Some(crate::Rebirth {
                    form: Self::egg,
                    hatch_after: 60,
                    charges: 1,
                }),
                ..Default::default()
            },
            ..Self::melee()
        }
    }
    fn egg() -> Self {
        Self {
            key: "anivia_egg",
            hp: 165,
            speed: 0.,
            mass: 3.,
            range: 0.,
            sight: 0.,
            action: Action::Idle,
            ..Self::melee()
        }
    }
    pub fn gunslinger() -> Self {
        Self {
            key: "graves",
            hp: 760,
            radius: 21.,
            mass: 5.,
            speed: 52.,
            range: 120.,
            sight: 240.,
            hits_air: true,
            action: Action::Shot {
                damage: 28,
                windup: 3,
                interval: 18,
                speed: 900.,
            },
            weapon: crate::Weapon {
                radius: 3.,
                magazine: 2,
                reload: 40,
                delivery: crate::Delivery::Line {
                    count: 6,
                    degrees: 28. * 0.92,
                    distance: 220.,
                    pierce: false,
                    returns: false,
                },
            },
            ..Self::melee()
        }
    }
}
