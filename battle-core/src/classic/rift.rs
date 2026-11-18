use super::{ClassicMatch, MatchError};
use crate::{Point, Role, Team, UnitDef};
pub(super) const LANE_X: [f64; 2] = [140., 580.];
pub(super) const WAVE_X: [f64; 2] = [240., 480.];
pub(super) fn home(team: Team, x: f64, y: f64) -> Point {
    Point::new(x, if team == Team::Blue { y } else { 1280. - y })
}
#[derive(Clone, Copy, Debug)]
pub struct Tiles {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}
impl Tiles {
    fn contains(&self, x: i32, y: i32) -> bool {
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
        let sides = [Team::Blue, Team::Red].map(|team| {
            let rect = |x, y, w, h| Tiles {
                x,
                y: if team == Team::Blue { y } else { 32 - y - h },
                width: w,
                height: h,
            };
            SideLayout {
                towers: LANE_X.map(|x| home(team, x, 1020.)),
                nexus: home(team, 360., 1160.),
                wave: WAVE_X.map(|x| home(team, x, 1160.)),
                home: vec![rect(0, 17, 18, 14), rect(6, 31, 6, 1)],
                pockets: [
                    vec![rect(0, 9, 9, 5), rect(1, 14, 8, 1)],
                    vec![rect(9, 9, 9, 5), rect(9, 14, 8, 1)],
                ],
            }
        });
        Self {
            id: "rift",
            arena: crate::Arena::classic(),
            tile_size: 40.,
            sides,
        }
    }
}
impl ClassicMatch {
    pub(super) fn cell(
        &self,
        point: Point,
        team: Team,
        actor: Option<&UnitDef>,
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
                if !own && !pocket {
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
        let first = matches!(t, 100 | 1000 | 1900 | 2500 | 3100 | 4300 | 4900 | 5500);
        let second = t >= 10
            && matches!(
                t - 10,
                100 | 1000 | 1900 | 2500 | 3100 | 3700 | 4300 | 4900 | 5500
            );
        if first || second {
            self.spawn_wave(first, t >= 2500)
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
