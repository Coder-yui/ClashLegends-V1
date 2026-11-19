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
    let at = state.lane_front[lane];
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
            point = state.building_front[lane] + Point::new(2. * state.tile_size, 0.);
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

/// Battle-2 rooms can draw the entire roster. Keep the earlier decision stream
/// available for replaying rooms frozen with the eight-card rules.
pub fn roster_bot_input(team: Team, state: &MatchView) -> Option<Input> {
    let mut input = bot_input(team, state)?;
    let own = &state.own;
    let Intent::Play { slot, point, .. } = &mut input.intent else {
        if let Intent::Activate { slot, .. } = &mut input.intent {
            let available = (0..2).find(|&i| {
                own.active[i].is_some_and(|a| a.uses > 0)
                    && state.active_wait[i] == 0
                    && state.active_cost[i] <= own.gold
                    && state.skill_resource[i]
                        .is_none_or(|(value, max, requires)| !requires || value >= max)
            })?;
            *slot = available as u8;
        }
        return Some(input);
    };
    let index = (0..4)
        .map(|n| (usize::from(*slot) + n) % 4)
        .find(|&i| own.costs[i] <= own.gold)?;
    *slot = index as u8;
    let mut key = own.hand[index];
    if key == "mirror" {
        key = own.last?;
    }
    let s = &super::roster::rules()[key];
    if s["is_building"] == true || s["type"] == "building" {
        // Alternate legal foundations so a surviving first building does not
        // block redeployment of every subsequent structure in that lane.
        let side = if (state.field.tick / 23) % 2 == 0 {
            -1.
        } else {
            1.
        };
        let margin = 2. * state.tile_size;
        *point = Point::new(
            (point.x + side * margin).clamp(margin, state.arena_width - margin),
            state.building_front[0].y,
        );
    } else if let Some(spell) = super::CardSpell::for_key(key) {
        let support = matches!(spell, super::CardSpell::Heal | super::CardSpell::Pool);
        let home_only = s["deploy_half_only"] == true;
        let target = state
            .field
            .units
            .iter()
            .filter(|a| {
                (a.team == team) == support
                    && (!support || !a.structure)
                    && (!home_only
                        || state.home_zones.iter().any(|r| {
                            r.contains(
                                (a.position.x / state.tile_size) as i32,
                                (a.position.y / state.tile_size) as i32,
                            )
                        }))
            })
            .min_by(|a, b| {
                let priority = |a: &crate::UnitView| {
                    (
                        u8::from(a.structure),
                        if support {
                            1000 * i64::from(a.hp) / i64::from(a.max_hp.max(1))
                        } else {
                            0
                        },
                    )
                };
                priority(a)
                    .cmp(&priority(b))
                    .then_with(|| {
                        (a.position - *point)
                            .length()
                            .total_cmp(&(b.position - *point).length())
                    })
                    .then(a.id.cmp(&b.id))
            });
        if let Some(a) = target {
            *point = a.position;
        }
    }
    Some(input)
}
