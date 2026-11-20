//! Decode production rules at spawn or form change. A producer retains at most one overdue batch.
use super::{rules, stat, ticks, Birth};
use serde_json::Value;

#[derive(Clone, Copy, Debug)]
pub(super) enum Side {
    MapSide,
    Bilateral,
    Below,
    Center,
    Ring,
}
impl Side {
    pub(super) fn from_rule(side: &str) -> Self {
        match side {
            "map_side" => Self::MapSide,
            "bilateral" => Self::Bilateral,
            "below" => Self::Below,
            "center" => Self::Center,
            _ => Self::Ring,
        }
    }
}
#[derive(Debug, Clone)]
pub(super) struct Period {
    initial: u64,
    interval: u64,
    next: Option<u64>,
}
impl Period {
    pub(super) fn take_due(&mut self, now: u64, ready: u64) -> bool {
        if now < *self.next.get_or_insert(ready + self.initial) {
            return false;
        }
        self.next = Some(now + self.interval);
        true
    }
}
#[derive(Clone, Debug)]
pub(super) struct Member {
    pub(super) key: &'static str,
    pub(super) radius: f64,
    pub(super) deploy: u32,
}
#[derive(Clone, Debug)]
pub(super) struct Summoner {
    pub(super) clock: Period,
    pub(super) waves: Vec<Vec<Member>>,
    pub(super) wave: usize,
    pub(super) side: Side,
    pub(super) distance: f64,
    pub(super) stagger: u64,
    pub(super) flight: u64,
    pub(super) waiting: Vec<Birth>,
}
#[derive(Clone, Debug)]
pub(crate) struct Production {
    pub(super) summons: Option<Summoner>,
    pub(super) income: Option<(Period, u8)>,
    pub(super) basic: Option<(Period, crate::SpawnBatch)>,
}
impl Production {
    pub fn from_def(def: &crate::UnitDef) -> Option<Box<Self>> {
        let basic = def.lifecycle.production.map(|(interval, batch)| {
            (
                Period {
                    initial: 0,
                    interval: u64::from(interval),
                    next: None,
                },
                batch,
            )
        });
        if basic.is_none() && def.rules.is_none() {
            return None;
        }
        let s = def.rules.unwrap_or(&Value::Null);
        let duration = |key| u64::from(ticks(stat(s, key, 0.)));
        let income = s["elixir_interval"].as_f64().map(|seconds| {
            let interval = u64::from(ticks(seconds));
            (
                Period {
                    initial: interval,
                    interval,
                    next: None,
                },
                stat(s, "elixir_amount", 0.) as u8,
            )
        });
        let summons = s["spawn_interval"].as_f64().map(|seconds| {
            let members = |v: &'static Value| {
                let key = v["spawn_id"].as_str().expect("validated spawn member");
                let child = &rules()[key];
                std::iter::repeat_n(
                    Member {
                        key,
                        radius: stat(child, "radius", 14.),
                        deploy: ticks(stat(s, "spawn_deploy_time", stat(child, "deploy_time", 1.))),
                    },
                    stat(v, "spawn_count", 1.) as usize,
                )
            };
            let waves = match s["spawn_waves"].as_array() {
                Some(waves) => waves
                    .iter()
                    .map(|w| w.as_array().unwrap().iter().flat_map(members).collect())
                    .collect(),
                None => vec![members(s).collect()],
            };
            Summoner {
                clock: Period {
                    initial: duration("spawn_initial_delay"),
                    interval: u64::from(ticks(seconds)),
                    next: None,
                },
                waves,
                wave: 0,
                side: Side::from_rule(s["spawn_side"].as_str().unwrap_or("center")),
                distance: stat(s, "spawn_distance", 0.),
                stagger: duration("spawn_sequence_interval"),
                flight: duration("spawn_flight_duration"),
                waiting: Vec::new(),
            }
        });
        (basic.is_some() || summons.is_some() || income.is_some()).then(|| {
            Box::new(Self {
                summons,
                income,
                basic,
            })
        })
    }
}
