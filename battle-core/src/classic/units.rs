//! Translate evaluated stat blocks to the same attack and physics primitives
//! used by the lane waves. Card-specific passives are attached by their owner.
use super::roster::rules;
use crate::{Action, Delivery, Layer, Lifecycle, Role, UnitDef, Weapon};
use serde_json::Value;

pub(super) fn stat(v: &Value, k: &str, default: f64) -> f64 {
    v[k].as_f64().unwrap_or(default)
}
pub(super) fn ticks(seconds: f64) -> u32 {
    (seconds * 20.).ceil() as u32
}
pub(crate) fn unit(key: &'static str) -> UnitDef {
    from_stats(key, &rules()[key])
}
pub(crate) fn from_stats(key: &'static str, s: &'static Value) -> UnitDef {
    let damage = stat(s, "damage", 0.).round() as i32;
    let speed = stat(s, "projectile_speed", 0.);
    let interval = ticks(stat(s, "interval", 1.)).max(1);
    let windup = ticks(stat(s, "first_hit", 0.));
    let action = if let Some(amount) = s["sacrifice_damage"].as_f64() {
        Action::Strike {
            damage: amount as i32,
            windup: 1,
            interval: 1,
        }
    } else if stat(s, "structure_mend_per_second", 0.) > 0. {
        Action::Mend {
            per_second: stat(s, "structure_mend_per_second", 0.) as u32,
        }
    } else if s["is_continuous_attack"] == true {
        if let Some(duration) = s["drain_duration"].as_f64() {
            Action::Drain {
                per_second: damage as u32,
                active: ticks(duration),
                pause: ticks(stat(s, "drain_pause", 0.)),
                steal: (stat(s, "innate_lifesteal_ratio", 0.) * 1000.).round() as u16,
            }
        } else {
            Action::Beam {
                per_second: damage as u32,
            }
        }
    } else if damage == 0 || s["can_attack"] == false {
        Action::Idle
    } else if speed > 0. {
        Action::Shot {
            damage,
            windup,
            interval,
            speed,
        }
    } else {
        Action::Strike {
            damage,
            windup,
            interval,
        }
    };
    let role = if s["is_building"] == true || s["type"] == "building" {
        Role::Building
    } else {
        Role::Troop
    };
    let delivery = if let Some(distance) = s["returning_attack_distance"].as_f64() {
        Delivery::Line {
            count: 1,
            degrees: 0.,
            distance,
            pierce: true,
            returns: true,
        }
    } else if let Some(count) = s["attack_pellets"].as_u64() {
        Delivery::Line {
            count: count as u8,
            degrees: stat(s, "attack_pellet_arc", 0.),
            distance: stat(s, "attack_pellet_distance", 0.),
            pierce: false,
            returns: false,
        }
    } else if s["ballistic_attack"] == true {
        Delivery::Ground {
            radius: stat(s, "splash_radius", 0.),
            bounces: 1,
            hop_distance: 0.,
        }
    } else {
        Delivery::Homing
    };
    let range = stat(s, "range", 32.);
    UnitDef {
        key,
        rules: Some(s),
        role,
        layer: if s["is_air"] == true {
            Layer::Air
        } else {
            Layer::Ground
        },
        radius: stat(s, "radius", 14.),
        mass: stat(s, "mass", 3.),
        hp: stat(s, "hp", 1.) as i32,
        sight: stat(s, "sight", range),
        range,
        speed: stat(s, "speed", 60.),
        buildings_only: s["building_only"] == true,
        hits_air: s["can_attack_air"] == true,
        action,
        skill: None,
        weapon: Weapon {
            delivery,
            radius: stat(s, "projectile_collision_radius", 4.),
            magazine: stat(s, "magazine_size", 0.) as u8,
            reload: ticks(stat(s, "reload_duration", 0.)),
        },
        lifecycle: Lifecycle {
            rebirth: if key == "anivia" {
                UnitDef::phoenix().lifecycle.rebirth
            } else {
                None
            },
            footprint: s["footprint_tiles"]
                .get(0)
                .and_then(Value::as_u64)
                .unwrap_or(1) as u8,
            decay_ticks: if s["lifespan_hp_decay"] == true {
                ticks(stat(s, "lifespan", 0.))
            } else {
                0
            },
            death_area: if s.get("death_heal_per_second").is_some() {
                Some(crate::TimedArea {
                    anchor: crate::AreaAnchor::Independent,
                    delay: ticks(stat(s, "death_heal_delay", 0.)) + 1,
                    period: 1,
                    pulses: ticks(stat(s, "death_heal_duration", 0.)),
                    shape: crate::Shape::Circle {
                        radius: stat(s, "death_heal_radius", 0.),
                    },
                    effects: &[crate::Effect::RegenTroops { per_second: 25 }],
                })
            } else {
                None
            },
            ..Default::default()
        },
    }
}
