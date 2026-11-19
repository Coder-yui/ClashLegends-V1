//! Repeated event windows allow a watch receiver to skip frames without
//! triggering an action twice. Cursors count only facts visible to this seat.
use clash_battle_core::{Event, Fact, Id, Snapshot};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, VecDeque};

#[derive(Default)]
pub(super) struct Stream {
    winding: BTreeMap<Id, u64>,
    previous_units: BTreeSet<Id>,
    previous_shots: BTreeSet<Id>,
    previous_areas: BTreeSet<Id>,
    events: VecDeque<(u64, u64, Value)>,
    cursor: u64,
}
impl Stream {
    pub fn advance(
        &mut self,
        field: &Snapshot,
        facts: &[Event],
        completed: &[(u64, Option<&str>)],
    ) {
        let units: BTreeSet<_> = field.units.iter().map(|u| u.id).collect();
        let shots: BTreeSet<_> = field.projectiles.iter().map(|p| p.id).collect();
        let areas: BTreeSet<_> = field.areas.iter().map(|a| a.id).collect();
        let dead: BTreeSet<_> = facts
            .iter()
            .filter_map(|e| match e.fact {
                Fact::Died(id) if self.previous_units.contains(&id) => Some(id),
                _ => None,
            })
            .collect();
        let unit = |id: &Id| units.contains(id) || dead.contains(id);
        let mut fired = BTreeSet::new();
        for event in facts {
            let visible = match &event.fact {
                Fact::EffectBlocked(id)
                | Fact::Spawned(id)
                | Fact::Died(id)
                | Fact::Controlled(id, _)
                | Fact::Displaced(id, _)
                | Fact::Landed(id, _)
                | Fact::Blinked(id, _)
                | Fact::ActionChanged { id, .. }
                | Fact::FormChanged { id, .. }
                | Fact::Cast { caster: id, .. } => unit(id),
                Fact::Rejected { .. } => false,
                Fact::AreaStarted(id) => areas.contains(id),
                Fact::AreaEnded(id) => self.previous_areas.contains(id),
                Fact::SpellPlayed { .. } | Fact::SpellImpact { .. } => true,
                Fact::Missed { source, target }
                | Fact::Damage { source, target, .. }
                | Fact::Summoned {
                    source,
                    child: target,
                }
                | Fact::Health { source, target, .. }
                | Fact::AttackStarted(source, target)
                | Fact::AttackReleased { source, target, .. } => unit(source) && unit(target),
                Fact::Fired(source, target, id) => {
                    unit(source) && (*target == 0 || unit(target)) && fired.insert(*id)
                }
                Fact::ProjectileHit { projectile, target } => {
                    unit(target)
                        && (shots.contains(projectile)
                            || fired.contains(projectile)
                            || self.previous_shots.contains(projectile))
                }
            };
            if let Fact::AttackReleased { source, .. } = event.fact {
                self.winding.remove(&source);
            }
            if visible {
                self.cursor += 1;
                self.events.push_back((
                    event.tick,
                    self.cursor,
                    json!({"tick":event.tick,"seq":self.cursor,"fact":event.fact}),
                ));
            }
        }
        let next = field
            .units
            .iter()
            .filter_map(|u| {
                u.attack
                    .filter(|attack| !attack.released)
                    .map(|attack| (u.id, attack.start))
            })
            .collect::<BTreeMap<_, _>>();
        for (&id, &start) in &self.winding {
            if unit(&id) && next.get(&id) != Some(&start) {
                self.cursor += 1;
                self.events.push_back((
                    field.tick,
                    self.cursor,
                    json!({"tick":field.tick,"seq":self.cursor,
                    "fact":{"kind":"attackCancelled","data":{"id":id,"start":start}}}),
                ));
            }
        }
        self.winding = next;
        for &(sequence, error) in completed {
            self.cursor += 1;
            self.events.push_back((field.tick,self.cursor,json!({"tick":field.tick,"seq":self.cursor,"fact":{"kind":"commandFinished","data":{"sequence":sequence,"error":error}}})));
        }
        while self
            .events
            .front()
            .is_some_and(|(t, _, _)| t + 24 < field.tick)
            || self.events.len() > 512
        {
            self.events.pop_front();
        }
        self.previous_units = units;
        self.previous_shots = shots;
        self.previous_areas = areas;
    }
    pub fn window(&self) -> Value {
        json!({"cursor":self.cursor,"after":self.events.front().map_or(self.cursor,|(_,seq,_)|seq-1),"events":self.events.iter().map(|(_,_,e)|e).collect::<Vec<_>>()})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clash_battle_core::{Arena, Battle, Control, Point, Team, UnitDef};
    #[test]
    fn invisible_source_leaves_no_trace_in_the_other_seats_cursor() {
        let mut b = Battle::new(Arena::classic()).unwrap();
        let source = b
            .spawn(Team::Blue, Point::new(200., 820.), UnitDef::melee())
            .unwrap();
        let mut seat = Stream::default();
        let mut field = b.snapshot_for(Team::Red);
        field.units.retain(|u| u.id != source);
        seat.advance(
            &field,
            &[Event {
                tick: 0,
                sequence: 701,
                fact: Fact::Controlled(source, Control::Freeze),
            }],
            &[],
        );
        assert_eq!(seat.window(), json!({"after":0,"cursor":0,"events":[]}));
    }
}

#[cfg(test)]
mod combat_contract {
    use super::*;
    use clash_battle_core::{
        Action, Aim, AimKind, Arena, Battle, Cast, Effect, Point, Shape, Skill, Team, UnitDef,
    };

    fn step(b: &mut Battle, stream: &mut Stream, inputs: &[(Team, Cast)]) -> Vec<Value> {
        b.step(inputs);
        let facts: Vec<_> = b.drain_events().collect();
        let field = b.snapshot_for(Team::Blue);
        stream.advance(&field, &facts, &[]);
        stream.window()["events"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| e["tick"] == field.tick)
            .map(|e| e["fact"].clone())
            .collect()
    }
    #[test]
    fn melee_ranged_and_rebirth_have_observable_action_boundaries() {
        let mut b = Battle::new(Arena::classic()).unwrap();
        let mut stream = Stream::default();
        let melee = b
            .spawn(Team::Blue, Point::new(130., 220.), UnitDef::melee())
            .unwrap();
        let ranged = b
            .spawn(Team::Blue, Point::new(70., 220.), UnitDef::ranged())
            .unwrap();
        b.spawn(
            Team::Red,
            Point::new(166., 220.),
            UnitDef {
                hp: 20000,
                action: Action::Idle,
                speed: 0.,
                ..UnitDef::melee()
            },
        )
        .unwrap();
        let mut seen = BTreeSet::new();
        for _ in 0..100 {
            for fact in step(&mut b, &mut stream, &[]) {
                let d = &fact["data"];
                match fact["kind"].as_str() {
                    Some("attackStarted") if d[0] == melee => {
                        seen.insert("melee");
                    }
                    Some("fired") if d[0] == ranged => {
                        seen.insert("ranged");
                    }
                    Some("projectileHit") => {
                        seen.insert("hit");
                    }
                    _ => (),
                }
            }
        }
        assert_eq!(seen, BTreeSet::from(["melee", "ranged", "hit"]));
        let bird = b
            .spawn(Team::Blue, Point::new(350., 380.), UnitDef::phoenix())
            .unwrap();
        let enemy = b
            .spawn(
                Team::Red,
                Point::new(500., 380.),
                UnitDef {
                    skill: Some(Skill {
                        aim: AimKind::Point,
                        cast_range: 600.,
                        shape: Shape::Circle { radius: 35. },
                        effects: vec![Effect::Damage(5000)],
                        cooldown: 1,
                    }),
                    action: Action::Idle,
                    ..UnitDef::melee()
                },
            )
            .unwrap();
        let mut events = step(
            &mut b,
            &mut stream,
            &[(
                Team::Red,
                Cast {
                    caster: enemy,
                    aim: Aim::Point(Point::new(350., 380.)),
                },
            )],
        );
        assert!(events.iter().any(|e| e["kind"] == "formChanged"
            && e["data"]["id"] == bird
            && e["data"]["to"] == "anivia_egg"));
        for _ in 0..60 {
            events.extend(step(&mut b, &mut stream, &[]));
        }
        assert!(events.iter().any(|e| e["kind"] == "formChanged"
            && e["data"]["id"] == bird
            && e["data"]["to"] == "anivia"));
    }
}
