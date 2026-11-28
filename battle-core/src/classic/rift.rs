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
    #[serde(default)]
    tower_columns: Vec<f64>,
    #[serde(default)]
    tower_depth: f64,
    #[serde(default)]
    nexus: [f64; 2],
    #[serde(default)]
    wave_columns: Vec<f64>,
    #[serde(default)]
    wave_depth: f64,
    home: Vec<[i32; 4]>,
    pockets: Vec<Vec<[i32; 4]>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub red_home: Option<Vec<[i32; 4]>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub red_pockets: Option<Vec<Vec<[i32; 4]>>>,
    #[serde(default)]
    pub tile_origin: [f64; 2],
    #[serde(default)]
    pub land_obstacles: Vec<[f64; 4]>,
    #[serde(default)]
    landmarks: Option<[Landmarks; 2]>,
    #[serde(default)]
    lanes: Vec<Vec<[f64; 2]>>,
    #[serde(default)]
    pub terrain_red: Option<String>,
    #[serde(default)]
    pub desktop_recommended: bool,
    pub terrain: Option<String>,
    pub backdrop_width: f64,
    pub back_margin: f64,
    pub projection: f64,
    pub image: String,
    #[serde(default)]
    pub test_only: bool,
}
#[derive(Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Landmarks {
    towers: Vec<[f64; 2]>,
    nexus: [f64; 2],
    spawn: [f64; 2],
    front: Vec<[f64; 2]>,
    building_front: Vec<[f64; 2]>,
    tower_radius: f64,
    nexus_radius: f64,
}
pub fn maps() -> &'static [MapDefinition] {
    static DATA: OnceLock<Vec<MapDefinition>> = OnceLock::new();
    DATA.get_or_init(|| serde_json::from_str(include_str!("../../../content/maps.json")).unwrap())
}
#[derive(Clone, Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
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
    DATA.get_or_init(|| {
        let mut modes: Vec<ModeRules> =
            serde_json::from_str(include_str!("../../../content/modes.json")).unwrap();
        let mut doubles = modes.iter().find(|m| m.id == "classic").unwrap().clone();
        doubles.id = "2v2".into();
        doubles.name = "经典 2v2".into();
        modes.push(doubles);
        modes
    })
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
    pub towers: Vec<Point>,
    pub tower_radius: f64,
    pub nexus_radius: f64,
    pub routes: Vec<Vec<Point>>,
    pub front: Vec<Point>,
    pub building_front: Vec<Point>,
    pub nexus: Point,
    pub wave: Vec<Point>,
    pub home: Vec<Tiles>,
    pub pockets: Vec<Vec<Tiles>>,
}
#[derive(Clone, Debug)]
pub struct MatchMap {
    pub id: &'static str,
    pub arena: crate::Arena,
    pub tile_size: f64,
    pub tile_origin: Point,
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
            let point = |[x, y]: [f64; 2]| Point::new(x, y);
            let tile = |[x, y, width, height]: [i32; 4]| Tiles {
                x,
                y,
                width,
                height,
            };
            if let Some(teams) = &def.landmarks {
                let side = &teams[team.index()];
                let (homes, pockets) = if team == Team::Red {
                    (
                        def.red_home.as_ref().unwrap(),
                        def.red_pockets.as_ref().unwrap(),
                    )
                } else {
                    (&def.home, &def.pockets)
                };
                let routes = def
                    .lanes
                    .iter()
                    .map(|lane| {
                        let mut points: Vec<_> = lane.iter().copied().map(point).collect();
                        if team == Team::Blue {
                            points.reverse();
                        }
                        points.push(point(teams[team.enemy().index()].nexus));
                        points
                    })
                    .collect();
                SideLayout {
                    towers: side.towers.iter().copied().map(point).collect(),
                    nexus: point(side.nexus),
                    wave: vec![point(side.spawn); side.towers.len()],
                    routes,
                    front: side.front.iter().copied().map(point).collect(),
                    building_front: side.building_front.iter().copied().map(point).collect(),
                    tower_radius: side.tower_radius,
                    nexus_radius: side.nexus_radius,
                    home: homes.iter().copied().map(tile).collect(),
                    pockets: pockets
                        .iter()
                        .map(|r| r.iter().copied().map(tile).collect())
                        .collect(),
                }
            } else {
                let front = |offset| {
                    def.tower_columns
                        .iter()
                        .map(|&x| home(x, def.height / 2. + def.tile * offset))
                        .collect()
                };
                SideLayout {
                    towers: def
                        .tower_columns
                        .iter()
                        .map(|&x| home(x, def.tower_depth))
                        .collect(),
                    nexus: home(def.nexus[0], def.nexus[1]),
                    wave: def
                        .wave_columns
                        .iter()
                        .map(|&x| home(x, def.wave_depth))
                        .collect(),
                    home: def.home.iter().copied().map(rect).collect(),
                    pockets: def
                        .pockets
                        .iter()
                        .map(|r| r.iter().copied().map(rect).collect())
                        .collect(),
                    routes: Vec::new(),
                    front: front(2.5),
                    building_front: front(4.5),
                    tower_radius: UnitDef::tower().radius,
                    nexus_radius: UnitDef::nexus().radius,
                }
            }
        });
        let rect = |&[x, y, r, b]: &[f64; 4]| crate::Rect {
            min: Point::new(x, y),
            max: Point::new(r, b),
        };
        Some(Self {
            id: &def.id,
            tile_origin: Point::new(def.tile_origin[0], def.tile_origin[1]),
            arena: crate::Arena {
                width: def.width,
                height: def.height,
                ground_obstacles: def.obstacles.iter().map(rect).collect(),
                land_obstacles: def.land_obstacles.iter().map(rect).collect(),
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
    pub fn open_pockets(&self, team: Team) -> Vec<bool> {
        self.towers[team.enemy().index()]
            .iter()
            .map(|id| !self.battle.actors.contains_key(id))
            .collect()
    }
    pub(super) fn home_tile(&self, point: Point, team: Team) -> bool {
        let tile = self.map.tile_size;
        let point = point - self.map.tile_origin;
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
        if half * 2.
            > (self.map.arena.width - 2. * self.map.tile_origin.x)
                .min(self.map.arena.height - 2. * self.map.tile_origin.y)
        {
            return Err(MatchError::Placement);
        }
        let snap = |v: f64, limit: f64, origin: f64| {
            let v = v - origin;
            let x = if size % 2 == 0 {
                (v / tile).round() * tile
            } else {
                ((v / tile).floor() + 0.5) * tile
            };
            origin + x.clamp(half, limit - 2. * origin - half)
        };
        let pos = Point::new(
            snap(point.x, self.map.arena.width, self.map.tile_origin.x),
            snap(point.y, self.map.arena.height, self.map.tile_origin.y),
        );
        if actor.is_none() {
            return Ok(pos);
        }
        let low = ((pos.x - self.map.tile_origin.x - half) / tile).round() as i32;
        let top = ((pos.y - self.map.tile_origin.y - half) / tile).round() as i32;
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
        // The survey provides the ordinary deployment banks (bridges are neutral).
        // Global placements can choose either field, but still need a physical site.
        if !side.routes.is_empty() && !self.laboratory {
            let overlaps = |r: &crate::Rect| {
                pos.x + half > r.min.x
                    && pos.x - half < r.max.x
                    && pos.y + half > r.min.y
                    && pos.y - half < r.max.y
            };
            if self.map.arena.land_obstacles.iter().any(overlaps)
                || self.map.arena.ground_obstacles.iter().any(overlaps)
            {
                return Err(MatchError::Placement);
            }
        }
        for a in self
            .battle
            .actors
            .values()
            .filter(|a| a.def.role != Role::Troop)
        {
            if !side.routes.is_empty() && matches!(a.def.role, Role::Nexus | Role::LaneTower) {
                let d = a.pos - pos;
                if (d.x.abs() - half).max(0.).powi(2) + (d.y.abs() - half).max(0.).powi(2)
                    < a.def.radius.powi(2)
                {
                    return Err(MatchError::Placement);
                }
                continue;
            }
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
        if self.mode.front_waves.first() == Some(&t) {
            self.battle.emit(crate::Fact::FirstWave);
        }
        if first || second {
            self.spawn_wave(first, t >= self.mode.double_gold)
        }
    }
    pub(super) fn spawn_wave(&mut self, front: bool, siege: bool) {
        for team in [Team::Blue, Team::Red] {
            for (lane, pos) in self.map.sides[team.index()]
                .wave
                .iter()
                .copied()
                .enumerate()
            {
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
                if let Ok(id) = self.battle.spawn_near(team, pos, def) {
                    if let Some(route) = self.battle.march_lanes[team.index()].get(lane) {
                        let a = self.battle.actors.get_mut(&id).unwrap();
                        a.lane = Some(route.clone());
                        a.lane_step = 1;
                    }
                }
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub enum DeploymentZone {
    Empty,
    Field,
    /// Own bank plus the unlocked enemy-side lane pockets, in world x order.
    Home(Vec<usize>),
}
impl ClassicMatch {
    /// Public map landmarks survive a disconnected spectator or player reconnecting.
    pub fn ruined_towers(&self) -> impl Iterator<Item = (crate::Id, Team, Point)> + '_ {
        [Team::Blue, Team::Red].into_iter().flat_map(move |team| {
            self.towers[team.index()]
                .iter()
                .copied()
                .zip(self.map.sides[team.index()].towers.iter().copied())
                .filter(move |(id, _)| !self.battle.actors.contains_key(id))
                .map(move |(id, point)| (id, team, point))
        })
    }

    pub fn deployment_regions(&self, team: Team) -> [Vec<Tiles>; 4] {
        self.deployment_regions_for(team.index())
    }
    pub fn deployment_regions_for(&self, seat: usize) -> [Vec<Tiles>; 4] {
        let side = &self.map.sides[super::seat_team(seat).index()];
        self.deployment_zones_for(seat).map(|zone| match zone {
            DeploymentZone::Empty => vec![],
            DeploymentZone::Field => vec![Tiles {
                x: 0,
                y: 0,
                width: ((self.map.arena.width - 2. * self.map.tile_origin.x) / self.map.tile_size)
                    as i32,
                height: ((self.map.arena.height - 2. * self.map.tile_origin.y) / self.map.tile_size)
                    as i32,
            }],
            DeploymentZone::Home(pockets) => {
                let mut regions = side.home.clone();
                for lane in pockets {
                    regions.extend_from_slice(&side.pockets[lane]);
                }
                regions
            }
        })
    }
    pub fn deployment_zones_for(&self, seat: usize) -> [DeploymentZone; 4] {
        let player = &self.players[seat];
        let open = self.open_pockets(super::seat_team(seat));
        std::array::from_fn(|slot| {
            let mut card = player.deck[player.lookup(slot as u8, player.version).unwrap()];
            if matches!(card.play, super::Play::Mirror) {
                let Some(last) = player.last_card else {
                    return DeploymentZone::Empty;
                };
                card = last;
            }
            if !card.home_deployment() {
                return DeploymentZone::Field;
            }
            let mut pockets = Vec::new();
            if !matches!(
                card.play,
                super::Play::Spell(_) | super::Play::CardSpell(..)
            ) && (super::roster::rules()[card.key]["deploy_pocket_requires_both_towers"] != true
                || open.iter().all(|v| *v))
            {
                for (lane, &unlocked) in open.iter().enumerate() {
                    if unlocked {
                        pockets.push(lane)
                    }
                }
            }
            DeploymentZone::Home(pockets)
        })
    }
}
