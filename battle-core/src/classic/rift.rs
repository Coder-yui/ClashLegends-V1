use super::{ClassicMatch, MatchError};
use crate::{Point, Role, Team, UnitDef};
use serde::Deserialize;
use std::sync::OnceLock;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
#[derive(serde::Serialize)]
pub struct MapDefinition {
    pub id: String,
    pub name: String,
    pub width: f64,
    pub height: f64,
    pub tile: f64,
    pub obstacles: Vec<[f64; 4]>,
    tower_columns: [f64; 2],
    tower_depth: f64,
    nexus: [f64; 2],
    wave_columns: [f64; 2],
    wave_depth: f64,
    home: Vec<[i32; 4]>,
    pockets: [Vec<[i32; 4]>; 2],
    pub terrain: Option<String>,
    pub backdrop_width: f64,
    pub back_margin: f64,
    pub projection: f64,
    pub image: String,
    #[serde(default)]
    pub test_only: bool,
}
pub fn maps() -> &'static [MapDefinition] {
    static DATA: OnceLock<Vec<MapDefinition>> = OnceLock::new();
    DATA.get_or_init(|| serde_json::from_str(include_str!("../../../content/maps.json")).unwrap())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
#[derive(serde::Serialize)]
pub struct ModeRules {
    pub id: String,
    pub name: String,
    pub map_ids: Vec<String>,
    pub deck_size: usize,
    pub regulation: u64,
    pub end: u64,
    pub double_gold: u64,
    pub triple_gold: u64,
    front_waves: Vec<u64>,
    rear_waves: Vec<u64>,
}
pub fn modes() -> &'static [ModeRules] {
    static DATA: OnceLock<Vec<ModeRules>> = OnceLock::new();
    DATA.get_or_init(|| serde_json::from_str(include_str!("../../../content/modes.json")).unwrap())
}
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize)]
pub struct Tiles {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}
impl Tiles {
    pub(super) fn contains(&self, x: i32, y: i32) -> bool {
        (self.x..self.x.saturating_add(self.width)).contains(&x)
            && (self.y..self.y.saturating_add(self.height)).contains(&y)
    }
}
#[derive(Clone, Debug)]
pub struct SideLayout {
    pub towers: [Point; 2],
    pub nexus: Point,
    pub wave: [Point; 2],
    pub home: Vec<Tiles>,
    pub pockets: [Vec<Tiles>; 2],
}
#[derive(Clone, Debug)]
pub struct MatchMap {
    pub id: &'static str,
    pub arena: crate::Arena,
    pub tile_size: f64,
    pub sides: [SideLayout; 2],
}
impl MatchMap {
    pub fn rift() -> Self {
        Self::named("rift").unwrap()
    }
    pub fn named(id: &str) -> Option<Self> {
        let def = maps().iter().find(|m| m.id == id)?;
        let sides = [Team::Blue, Team::Red].map(|team| {
            let home = |x, y| {
                Point::new(
                    x,
                    if team == Team::Blue {
                        y
                    } else {
                        def.height - y
                    },
                )
            };
            let rect = |[x, y, width, height]: [i32; 4]| Tiles {
                x,
                y: if team == Team::Blue {
                    y
                } else {
                    (def.height / def.tile) as i32 - y - height
                },
                width,
                height,
            };
            SideLayout {
                towers: def.tower_columns.map(|x| home(x, def.tower_depth)),
                nexus: home(def.nexus[0], def.nexus[1]),
                wave: def.wave_columns.map(|x| home(x, def.wave_depth)),
                home: def.home.iter().copied().map(rect).collect(),
                pockets: std::array::from_fn(|i| {
                    def.pockets[i].iter().copied().map(rect).collect()
                }),
            }
        });
        Some(Self {
            id: &def.id,
            arena: crate::Arena {
                width: def.width,
                height: def.height,
                ground_obstacles: def
                    .obstacles
                    .iter()
                    .map(|&[x, y, r, b]| crate::Rect {
                        min: Point::new(x, y),
                        max: Point::new(r, b),
                    })
                    .collect(),
            },
            tile_size: def.tile,
            sides,
        })
    }
}
impl ClassicMatch {
    pub fn map(&self) -> &MatchMap {
        &self.map
    }
    pub fn rules(&self) -> &ModeRules {
        self.mode
    }
    pub fn open_pockets(&self, team: Team) -> [bool; 2] {
        self.towers[team.enemy().index()].map(|id| !self.battle.actors.contains_key(&id))
    }
    pub(super) fn home_tile(&self, point: Point, team: Team) -> bool {
        let tile = self.map.tile_size;
        self.map.sides[team.index()].home.iter().any(|r| {
            r.contains(
                (point.x / tile).floor() as i32,
                (point.y / tile).floor() as i32,
            )
        })
    }
    pub(super) fn cell(
        &self,
        point: Point,
        team: Team,
        actor: Option<&UnitDef>,
    ) -> Result<Point, MatchError> {
        self.cell_with_rules(point, team, actor, false, false)
    }
    pub(super) fn deployment_cell(
        &self,
        point: Point,
        team: Team,
        def: &UnitDef,
        rule: &serde_json::Value,
    ) -> Result<Point, MatchError> {
        self.cell_with_rules(
            point,
            team,
            Some(def),
            rule["deploy_zone"] == "global",
            rule["deploy_pocket_requires_both_towers"] == true,
        )
    }
    fn cell_with_rules(
        &self,
        point: Point,
        team: Team,
        actor: Option<&UnitDef>,
        global: bool,
        both: bool,
    ) -> Result<Point, MatchError> {
        if !self.battle.map.contains(point)
            || point.x >= self.map.arena.width
            || point.y >= self.map.arena.height
        {
            return Err(MatchError::Placement);
        }
        let size = actor.map_or(1, |d| d.lifecycle.footprint.max(1));
        let tile = self.map.tile_size;
        let half = f64::from(size) * tile / 2.;
        if half * 2. > self.map.arena.width.min(self.map.arena.height) {
            return Err(MatchError::Placement);
        }
        let snap = |v: f64, limit: f64| {
            let x = if size % 2 == 0 {
                (v / tile).round() * tile
            } else {
                ((v / tile).floor() + 0.5) * tile
            };
            x.clamp(half, limit - half)
        };
        let pos = Point::new(
            snap(point.x, self.map.arena.width),
            snap(point.y, self.map.arena.height),
        );
        if actor.is_none() {
            return Ok(pos);
        }
        let low = ((pos.x - half) / tile).round() as i32;
        let top = ((pos.y - half) / tile).round() as i32;
        let side = &self.map.sides[team.index()];
        for x in low..low + i32::from(size) {
            for y in top..top + i32::from(size) {
                let own = side.home.iter().any(|r| r.contains(x, y));
                let pocket = side.pockets.iter().enumerate().any(|(lane, regions)| {
                    !self
                        .battle
                        .actors
                        .contains_key(&self.towers[team.enemy().index()][lane])
                        && regions.iter().any(|r| r.contains(x, y))
                });
                let both_down = self.towers[team.enemy().index()]
                    .iter()
                    .all(|id| !self.battle.actors.contains_key(id));
                if !self.laboratory && !global && !own && !(pocket && (!both || both_down)) {
                    return Err(MatchError::Placement);
                }
            }
        }
        for a in self
            .battle
            .actors
            .values()
            .filter(|a| a.def.role != Role::Troop)
        {
            let radius =
                (tile / 2.) * (f64::from(size) + f64::from(a.def.lifecycle.footprint.max(1)));
            if (a.pos.x - pos.x).abs() < radius && (a.pos.y - pos.y).abs() < radius {
                return Err(MatchError::Placement);
            }
        }
        Ok(pos)
    }
    pub(super) fn wave(&mut self) {
        let t = self.battle.tick;
        let first = self.mode.front_waves.contains(&t);
        let second = self.mode.rear_waves.contains(&t);
        if first || second {
            self.spawn_wave(first, t >= self.mode.double_gold)
        }
    }
    pub(super) fn spawn_wave(&mut self, front: bool, siege: bool) {
        for team in [Team::Blue, Team::Red] {
            for (lane, pos) in self.map.sides[team.index()].wave.into_iter().enumerate() {
                let def = if front {
                    if self
                        .battle
                        .actors
                        .contains_key(&self.towers[team.enemy().index()][lane])
                    {
                        UnitDef::melee()
                    } else {
                        UnitDef::super_minion()
                    }
                } else if siege {
                    UnitDef::siege()
                } else {
                    UnitDef::ranged()
                };
                let _ = self.battle.spawn_near(team, pos, def);
            }
        }
    }
}

impl ClassicMatch {
    /// Public map landmarks survive a disconnected spectator or player reconnecting.
    pub fn ruined_towers(&self) -> impl Iterator<Item = (crate::Id, Team, Point)> + '_ {
        [Team::Blue, Team::Red].into_iter().flat_map(move |team| {
            self.towers[team.index()]
                .into_iter()
                .zip(self.map.sides[team.index()].towers)
                .filter(move |(id, _)| !self.battle.actors.contains_key(id))
                .map(move |(id, point)| (id, team, point))
        })
    }

    pub fn deployment_regions(&self, team: Team) -> [Vec<Tiles>; 4] {
        let player = &self.players[team.index()];
        let side = &self.map.sides[team.index()];
        let open = self.open_pockets(team);
        std::array::from_fn(|slot| {
            let mut card = player.deck[player.lookup(slot as u8, player.version).unwrap()];
            if matches!(card.play, super::Play::Mirror) {
                let Some(last) = player.last_card else {
                    return vec![];
                };
                card = last;
            }
            if !card.home_deployment() {
                return vec![Tiles {
                    x: 0,
                    y: 0,
                    width: (self.map.arena.width / self.map.tile_size) as i32,
                    height: (self.map.arena.height / self.map.tile_size) as i32,
                }];
            }
            let mut zones = side.home.clone();
            if !matches!(
                card.play,
                super::Play::Spell(_) | super::Play::CardSpell(..)
            ) && (super::roster::rules()[card.key]["deploy_pocket_requires_both_towers"] != true
                || open.iter().all(|v| *v))
            {
                for (lane, unlocked) in open.into_iter().enumerate() {
                    if unlocked {
                        zones.extend_from_slice(&side.pockets[lane])
                    }
                }
            }
            zones
        })
    }
}
