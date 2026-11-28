use crate::space::{Block, Query};
use crate::targeting::{Body, Perception};
use crate::{Activity, Actor, Arena, Control, Fact, Id, Point, Team, TICKS_PER_SECOND};
use std::collections::BTreeMap;

pub(crate) fn blockers(actors: &BTreeMap<Id, Actor>) -> Vec<Block> {
    actors
        .values()
        .filter(|a| a.def.role.structure() || a.has(Control::Stasis))
        .map(|a| Block {
            id: a.id,
            center: a.pos,
            radius: a.def.radius + if a.def.role.structure() { 1.5 } else { 0. },
            layer: a.def.layer,
        })
        .collect()
}
pub(crate) fn query<'a>(map: &'a Arena, blocks: &'a [Block], a: &Actor) -> Query<'a> {
    Query {
        cross_river: a
            .def
            .rules
            .is_some_and(|s| s["river_traversal"] == true || s["terrain_traversal"] == true),
        map,
        blocks: if a.def.rules.is_some_and(|s| s["terrain_traversal"] == true) {
            &[]
        } else {
            blocks
        },
        id: a.id,
        layer: a.def.layer,
        radius: a.def.radius,
    }
}
/// ContactA lateral steering uses only peers already touching the actor.
fn steer(a: &mut Actor, dir: Point, view: &Perception, intents: &BTreeMap<Id, Point>) -> Point {
    let side = Point::new(-dir.y, dir.x);
    if a.avoidance_turn == 0. {
        let mut first: Option<(Id, f64)> = None;
        view.nearby(a.pos, a.def.radius, |b| {
            if b.id == a.id || a.def.layer != b.layer || b.transit {
                return;
            }
            let relative = b.pos - a.pos;
            if relative.length() > a.def.radius + b.radius || relative.dot(dir) <= 0. {
                return;
            }
            let along = intents.get(&b.id).map_or(0., |d| d.dot(dir));
            if !b.isolated
                && (along > 0.
                    || (a.team != b.team
                        && !(a.def.buildings_only && b.buildings_only && along < 0.)))
            {
                return;
            }
            let offset = relative.dot(side);
            let sign = if offset.abs() >= 0.001 {
                -offset.signum()
            } else if a.team != b.team || a.id > b.id {
                1.
            } else {
                -1.
            };
            if first.is_none_or(|(id, _)| b.id < id) {
                first = Some((b.id, sign));
            }
        });
        if let Some((_, sign)) = first {
            a.avoidance_turn = sign * 200. / 256.;
        }
    }
    a.avoidance_turn = a.avoidance_turn.signum() * (a.avoidance_turn.abs() - 10. / 256.).max(0.);
    (dir * (1. - a.avoidance_turn.abs()) + side * a.avoidance_turn)
        .unit()
        .unwrap_or(dir)
}
fn walk(
    q: &Query,
    a: &mut Actor,
    target: Body,
    tick: u64,
    view: &Perception,
    intents: &BTreeMap<Id, Point>,
) {
    let reach = a.def.range + a.def.radius + target.radius;
    if a.route_goal.is_none_or(|p| (p - target.pos).length() > 8.)
        || (a.route.is_empty() && tick >= a.replan)
    {
        a.route = crate::navigation::route(q, a.pos, target.pos, reach);
        a.route_goal = Some(target.pos);
        a.replan = tick + 10;
    }
    if let Some(&next) = a.route.front() {
        let delta = next - a.pos;
        let len = delta.length();
        if let Some(dir) = delta.unit() {
            let dir = if a
                .def
                .rules
                .is_some_and(|s| s["permanent_unit_phasing"] == true)
            {
                dir
            } else {
                steer(a, dir, view, intents)
            };
            let p = a.pos
                + dir
                    * len.min(
                        a.def.speed * f64::from(a.rates().0)
                            / f64::from(crate::status::NORMAL)
                            / TICKS_PER_SECOND as f64,
                    );
            if !q.clear(a.pos, p) {
                a.route_goal = None;
                return;
            }
            if p != a.pos {
                cancel_recovery_on_walk(a, target, tick);
                a.pos = p;
            }
            a.facing = dir;
        }
        if (next - a.pos).length() < 1e-8 {
            a.route.pop_front();
        }
    }
}
fn cancel_recovery_on_walk(a: &mut Actor, target: Body, tick: u64) {
    if a.next_attack <= a.attack_clock {
        return;
    }
    let Some(rules) = a.def.rules else { return };
    let Some(every) = rules["attack_recovery_cancel_every_hits"].as_u64() else {
        return;
    };
    let swing = u64::from(a.card_state.swing);
    if every == 0 || swing == 0 || swing % every != 0 {
        return;
    }
    if let Some(window) = rules["attack_recovery_cancel_window"]
        .as_f64()
        .filter(|w| *w > 0.)
    {
        let (windup, interval) = match a.def.action {
            crate::Action::Strike {
                windup, interval, ..
            }
            | crate::Action::Shot {
                windup, interval, ..
            } => (windup, interval),
            _ => return,
        };
        let cycle = a.card_state.swing + 1;
        let close = rules["close_attack_range"]
            .as_f64()
            .is_some_and(|r| crate::targeting::gap(a, target) <= r);
        let segment = crate::combat::attack_segment(a, rules, cycle, close);
        let scale = u64::from(crate::status::NORMAL);
        let node =
            crate::attack_nodes::select(a, tick, segment, target.role.structure(), cycle == 1);
        let windup = node.map_or(u64::from(windup) * scale, |(_, n)| n.windup(interval));
        let remaining = (a.next_attack - a.attack_clock).saturating_sub(windup);
        if remaining > (window * TICKS_PER_SECOND as f64 * scale as f64).round() as u64 {
            return;
        }
    }
    a.next_attack = 0;
}
fn fly(q: &Query, a: &mut Actor, tick: u64) -> Option<Fact> {
    let mut flight = a.flight?;
    let delta = flight.end - a.pos;
    let len = delta.length();
    if let Some(dir) = delta.unit() {
        a.pos = a.pos + dir * flight.step.min(len);
    }
    if len <= flight.step + 1e-8 {
        let Some(pos) = q.nearest(flight.end, forward(a.team)) else {
            a.flight = Some(flight);
            return None;
        };
        a.pos = pos;
        flight.end = a.pos;
        if tick >= flight.lock_until {
            a.flight = None;
            a.activity = Activity::Idle;
            return Some(Fact::Landed(a.id, a.pos));
        }
    }
    a.flight = Some(flight);
    None
}
fn forward(team: Team) -> f64 {
    if team == Team::Blue {
        -1.
    } else {
        1.
    }
}
pub(crate) fn advance(
    map: &Arena,
    actors: &mut BTreeMap<Id, Actor>,
    tick: u64,
    facts: &mut Vec<Fact>,
) {
    let blocks = blockers(actors);
    let destinations: BTreeMap<_, _> = actors
        .iter()
        .filter_map(|(&id, a)| Some((id, Body::from(actors.get(&a.target?)?))))
        .collect();
    let peers = Perception::new(actors);
    let intents = actors
        .values()
        .filter(|a| {
            matches!(a.activity, Activity::March | Activity::Chase)
                && !a.has(Control::Root)
                && !a.disabled()
        })
        .filter_map(|a| {
            let dest = a
                .route
                .front()
                .copied()
                .or_else(|| destinations.get(&a.id).map(|b| b.pos))?;
            Some((a.id, (dest - a.pos).unit()?))
        })
        .collect();
    let has_knocks = actors.values().any(|a| {
        a.flight
            .is_some_and(|f| f.kind == crate::motion::MotionKind::Knockback)
    });
    let starts = if has_knocks {
        actors.iter().map(|(&id, a)| (id, a.pos)).collect()
    } else {
        BTreeMap::new()
    };
    for a in actors.values_mut() {
        if a.flight
            .is_some_and(|f| f.kind == crate::motion::MotionKind::Knockback)
        {
            continue;
        }
        let q = query(map, &blocks, a);
        if a.flight.is_some() {
            if let Some(f) = fly(&q, a, tick) {
                facts.push(f)
            }
            continue;
        }
        if let Some((end, heading)) = a.card_state.cast_heading {
            if tick < end && !a.disabled() && !a.has(Control::Root) {
                let pos = a.pos + heading * (a.def.speed * f64::from(a.rates().0) / 20000.);
                if q.clear(a.pos, pos) {
                    a.pos = pos;
                }
                continue;
            }
            a.card_state.cast_heading = None;
        }
        if matches!(a.activity, Activity::March | Activity::Chase)
            && !a.disabled()
            && !a.has(Control::Root)
            && a.card_state.move_lock <= tick
            && a.def.speed > 0.
        {
            if let Some(b) = destinations.get(&a.id) {
                walk(&q, a, *b, tick, &peers, &intents)
            }
        }
    }
    for a in actors.values_mut() {
        let shift = std::mem::take(&mut a.field_shift);
        if shift != Point::default() && a.flight.is_none() && !a.has(Control::Stasis) {
            let q = query(map, &blocks, a);
            if q.clear(a.pos, a.pos + shift) {
                a.pos = a.pos + shift;
            }
        }
    }
    if has_knocks {
        knockbacks(map, &blocks, actors, &starts, tick, facts);
    }
    // Accumulate same-layer corrections against a common positional snapshot.
    let view = Perception::new(actors);
    let mut shifts: BTreeMap<Id, (Point, u32)> = BTreeMap::new();
    for a in actors.values().filter(|a| mobile(a)) {
        view.nearby(a.pos, a.def.radius, |b| {
            if b.id <= a.id || b.layer != a.def.layer || !mobile(&actors[&b.id]) {
                return;
            }
            let delta = b.pos - a.pos;
            let overlap = a.def.radius + b.radius - delta.length();
            if overlap <= 0. {
                return;
            }
            let dir = delta
                .unit()
                .unwrap_or(Point::new(if a.team == Team::Blue { 1. } else { -1. }, 0.));
            let mass_b = actors[&b.id].def.mass;
            let total = a.def.mass + mass_b;
            for (id, part) in [(a.id, -mass_b / total), (b.id, a.def.mass / total)] {
                let s = shifts.entry(id).or_default();
                s.0 = s.0 + dir * (overlap.min(12.) * part);
                s.1 += 1;
            }
        })
    }
    for (id, (delta, count)) in shifts {
        let a = actors.get_mut(&id).unwrap();
        let q = query(map, &blocks, a);
        let d = delta * (1. / count as f64);
        let p = a.pos + d.unit().unwrap_or_default() * d.length().min(6.);
        if q.clear(a.pos, p) {
            a.pos = p
        }
    }
}
fn mobile(a: &Actor) -> bool {
    !a.def.role.structure()
        && !a
            .def
            .rules
            .is_some_and(|s| s["permanent_unit_phasing"] == true)
        && !a.has(Control::Stasis)
        && a.flight
            .is_none_or(|f| f.kind == crate::motion::MotionKind::Knockback)
}
pub(crate) fn settle(map: &Arena, blocks: &[Block], a: &mut Actor) -> bool {
    let q = query(map, blocks, a);
    let Some(p) = q.nearest(a.pos, forward(a.team)) else {
        return false;
    };
    a.pos = p;
    a.flight = None;
    true
}

// A continuous sweep against terrain and every peer's proposed motion. Clip
// both knocked bodies at their first relative contact before resolving pushes.
fn knockbacks(
    map: &Arena,
    blocks: &[Block],
    actors: &mut BTreeMap<Id, Actor>,
    starts: &BTreeMap<Id, Point>,
    tick: u64,
    facts: &mut Vec<Fact>,
) {
    use crate::motion::MotionKind;
    let mut steps = BTreeMap::new();
    for a in actors.values() {
        let Some(f) = a.flight.filter(|f| f.kind == MotionKind::Knockback) else {
            continue;
        };
        let q = query(map, blocks, a);
        let delta = f.end - a.pos;
        let dx = delta.unit().unwrap_or_default() * delta.length().min(f.step);
        let mut fraction = 1.;
        if !q.clear(a.pos, a.pos + dx) {
            let mut hi = 1.;
            let mut lo = 0.;
            for _ in 0..30 {
                let m = (hi + lo) * 0.5;
                if q.clear(a.pos, a.pos + dx * m) {
                    lo = m
                } else {
                    hi = m
                }
            }
            fraction = lo;
        }
        steps.insert(a.id, (dx, fraction, fraction < 1.));
    }
    let mut clipped = BTreeMap::new();
    for (&id, &(dx, mut fraction, wall)) in &steps {
        let a = &actors[&id];
        for b in actors.values().filter(|b| {
            b.id != id
                && b.def.layer == a.def.layer
                && !b.def.role.structure()
                && b.flight.is_none_or(|f| f.kind == MotionKind::Knockback)
        }) {
            let other = steps
                .get(&b.id)
                .map_or(b.pos - starts[&b.id], |(v, t, _)| *v * *t);
            let rel = a.pos - starts[&b.id];
            let d = dx - other;
            let dd = d.dot(d);
            let approach = rel.dot(d);
            if dd == 0. || approach >= 0. {
                continue;
            }
            let radius = a.def.radius + b.def.radius;
            let c = rel.dot(rel) - radius * radius;
            let disc = approach * approach - dd * c;
            if disc >= 0. {
                let time = ((-approach - disc.sqrt()) / dd).max(0.);
                // Leave a small legal contact overlap for mass-based separation.
                fraction = fraction.min(time + 0.25 / dd.sqrt());
            }
        }
        clipped.insert(id, (dx * fraction, wall));
    }
    for (id, (dx, wall)) in clipped {
        let a = actors.get_mut(&id).unwrap();
        a.pos = a.pos + dx;
        let f = a.flight.as_mut().unwrap();
        if wall {
            f.end = a.pos;
            f.step = 0.
        }
        if f.lock_until <= tick {
            a.flight = None;
            a.activity = Activity::Idle;
            facts.push(Fact::Landed(id, a.pos))
        }
    }
}
