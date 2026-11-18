//! Minimal reproducible sparring opponent. All observations are seat projections.
use super::{Input, Intent, MatchView};
use crate::{Activity, Aim, Point, Team};
pub fn bot_input(team: Team, state: &MatchView) -> Option<Input> {
    let tick = state.field.tick;
    if state.result.is_some() || !(tick + team.index() as u64 * 9).is_multiple_of(23) {
        return None;
    }
    let own = &state.own;
    let cycle = tick / 23;
    let lane = if (cycle + team.index() as u64) % 4 < 2 {
        0
    } else {
        1
    };
    let x = super::rift::LANE_X[lane];
    let at = super::rift::home(team, x, 740.);
    let slot = (cycle % 4) as usize;
    let intent = if cycle.is_multiple_of(5) && own.active.iter().flatten().any(|a| a.uses > 0) {
        let slot = own
            .active
            .iter()
            .position(|a| a.is_some_and(|a| a.uses > 0))
            .unwrap();
        Intent::Activate {
            slot: slot as u8,
            aim: Aim::Instant,
        }
    } else {
        let mut point = at;
        if own.hand[slot] == "freeze" {
            point = state
                .field
                .units
                .iter()
                .filter(|u| u.team != team && !matches!(u.activity, Activity::Deploying))
                .min_by(|a, b| {
                    (a.position - at)
                        .length()
                        .total_cmp(&(b.position - at).length())
                })
                .map_or(at, |u| u.position);
        } else if own.hand[slot] == "tombstone" {
            point = super::rift::home(team, x + 80., 820.);
        }
        Intent::Play {
            slot: slot as u8,
            version: own.version,
            point: Point::new(point.x, point.y),
        }
    };
    Some(Input {
        team,
        sequence: own.acknowledged + 1,
        intent,
    })
}
