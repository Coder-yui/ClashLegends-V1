//! A bounded history allows each socket to skip frames without
//! triggering an action twice. Cursors count only facts visible to this seat.
use clash_battle_core::{Event, Fact, Id, Snapshot};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::Arc;

#[path = "battle_layers.rs"]
mod layers;
#[path = "battle_sound.rs"]
mod sound;

#[derive(Default)]
pub(super) struct Stream {
    layers: layers::Layers,
    seat: usize,
    winding: BTreeMap<Id, u64>,
    previous: sound::Scene,
    previous_areas: BTreeSet<Id>,
    events: VecDeque<(u64, u64, Arc<Value>)>,
    cursor: u64,
    last_tick: Option<u64>,
}
impl Stream {
    pub fn for_seat(seat: usize) -> Self {
        Self {
            seat,
            ..Self::default()
        }
    }
    pub fn advance(
        &mut self,
        field: &Snapshot,
        facts: &[Event],
        completed: &[(u64, Option<&str>)],
    ) {
        let current = sound::Scene::from_field(field);
        let mut sound_step = sound::Step::default();
        let areas: BTreeSet<_> = field.areas.iter().map(|a| a.id).collect();
        let dead: BTreeSet<_> = facts
            .iter()
            .filter_map(|e| match e.fact {
                Fact::Died(id) if self.previous.units.contains_key(&id) => Some(id),
                _ => None,
            })
            .collect();
        let unit = |id: &Id| current.units.contains_key(id) || dead.contains(id);
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
                Fact::FirstWave => true,
                Fact::Sound {
                    source,
                    target,
                    phase,
                    ..
                } => {
                    let audible = if source.kind == "medium_lightning" {
                        match *phase {
                            "spell:warning" | "spell:cast" => self.seat == source.team.index(),
                            "spell:warning_enemy" => self.seat != source.team.index(),
                            _ => true,
                        }
                    } else {
                        true
                    };
                    (source.owner == 0
                        || unit(&source.owner)
                        || fired.contains(&source.owner)
                        || current.shots.contains_key(&source.owner)
                        || self.previous.shots.contains_key(&source.owner)
                        || areas.contains(&source.owner)
                        || self.previous_areas.contains(&source.owner)
                        || source.spell)
                        && target.as_ref().is_none_or(unit)
                        && audible
                }
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
                Fact::ProjectileHit {
                    projectile, target, ..
                } => {
                    unit(target)
                        && (current.shots.contains_key(projectile)
                            || fired.contains(projectile)
                            || self.previous.shots.contains_key(projectile))
                }
            };
            if let Fact::AttackReleased { source, .. } = event.fact {
                self.winding.remove(&source);
            }
            if visible {
                self.cursor += 1;
                let mut item = json!({"tick":event.tick,"seq":self.cursor,"fact":event.fact});
                let sounds = sound_step.sounds(&current, &self.previous, &event.fact, event.tick);
                if !sounds.is_empty() {
                    item["sounds"] = Value::Array(sounds);
                }
                self.events
                    .push_back((event.tick, self.cursor, Arc::new(item)));
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
                    Arc::new(json!({"tick":field.tick,"seq":self.cursor,
                    "fact":{"kind":"attackCancelled","data":{"id":id,"start":start}}})),
                ));
            }
        }
        self.winding = next;
        let mut edges = self.layers.advance(field, &self.previous, facts);
        edges.extend(current.landings(&self.previous, self.last_tick, field.tick));
        self.last_tick = Some(field.tick);
        if !edges.is_empty() {
            self.cursor += 1;
            self.events.push_back((field.tick,self.cursor,Arc::new(json!({"tick":field.tick,"seq":self.cursor,"fact":{"kind":"audioPhases"},"sounds":edges}))));
        }
        for &(sequence, error) in completed {
            self.cursor += 1;
            self.events.push_back((field.tick,self.cursor,Arc::new(json!({"tick":field.tick,"seq":self.cursor,"fact":{"kind":"commandFinished","data":{"sequence":sequence,"error":error}}}))));
        }
        while self
            .events
            .front()
            .is_some_and(|(t, _, _)| t + 24 < field.tick)
            || self.events.len() > 512
        {
            self.events.pop_front();
        }
        self.previous = current;
        self.previous_areas = areas;
    }
    pub fn layers(&self) -> Vec<Value> {
        self.layers.snapshot()
    }
    pub fn history(&self) -> History {
        History {
            cursor: self.cursor,
            events: self.events.iter().map(|(_, _, v)| Arc::clone(v)).collect(),
        }
    }
    pub fn window(&self) -> Value {
        let history = self.history();
        json!(history.since(Some(history.oldest_cursor())))
    }
}

/// Frames in a watch channel share immutable event payloads across the retention period.
pub(super) struct History {
    pub cursor: u64,
    events: Vec<Arc<Value>>,
}
#[derive(serde::Serialize)]
pub(super) struct Window<'a> {
    after: u64,
    cursor: u64,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    baseline: bool,
    events: &'a [Arc<Value>],
}
impl History {
    fn oldest_cursor(&self) -> u64 {
        self.cursor - self.events.len() as u64
    }
    pub fn since(&self, delivered: Option<u64>) -> Window<'_> {
        let oldest = self.oldest_cursor();
        let valid = delivered.filter(|n| (oldest..=self.cursor).contains(n));
        let after = valid.unwrap_or(self.cursor);
        Window {
            after,
            cursor: self.cursor,
            baseline: valid.is_none(),
            events: &self.events[(after - oldest) as usize..],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clash_battle_core::{Arena, Battle, Control, Point, Team, UnitDef};
    #[test]
    fn each_socket_recovers_only_undelivered_events_and_overflow_resets() {
        let battle = Battle::new(Arena::classic()).unwrap();
        let mut field = battle.snapshot();
        let mut stream = Stream::default();
        let mut slow = None;
        for tick in 0..36 {
            field.tick = tick;
            stream.advance(
                &field,
                &[Event {
                    tick,
                    sequence: tick,
                    fact: Fact::FirstWave,
                }],
                &[],
            );
            let history = stream.history();
            let cursor = history.cursor;
            if tick == 0 {
                let first = json!(history.since(None));
                assert_eq!(first["baseline"], true);
                assert_eq!(first["events"], json!([]));
                slow = Some(cursor);
            } else {
                assert_eq!(
                    json!(history.since(Some(cursor - 1)))["events"][0]["seq"],
                    cursor
                );
                assert_eq!(json!(history.since(Some(cursor)))["events"], json!([]));
            }
            if tick == 8 {
                let skipped = json!(history.since(slow));
                assert_eq!(skipped["after"], 1);
                assert_eq!(
                    skipped["events"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|e| e["seq"].as_u64().unwrap())
                        .collect::<Vec<_>>(),
                    (2..=9).collect::<Vec<_>>()
                );
            }
            if tick == 35 {
                let expired = json!(history.since(slow));
                assert_eq!(expired["baseline"], true);
                assert_eq!(expired["after"], cursor);
                assert_eq!(expired["events"], json!([]));
            }
        }
    }
    #[test]
    fn predeployment_arrival_plays_once_on_the_landing_tick() {
        use clash_battle_core::classic::workbench::Workbench;
        let mut world = Workbench::new();
        let mut stream = Stream::default();
        let id = world
            .deploy("pantheon", None, Team::Blue, Point::new(365., 825.))
            .unwrap()
            .unwrap();
        let field = world.game().view(Team::Blue).field;
        let landing = field
            .units
            .iter()
            .find(|u| u.id == id)
            .unwrap()
            .deploy_start;
        assert!(landing > 0);
        let mut heard = Vec::new();
        for _ in 0..=landing + 2 {
            let facts = world.facts();
            let field = world.game().view(Team::Blue).field;
            let cursor = stream.cursor;
            stream.advance(&field, &facts, &[]);
            for (_, _, event) in stream.events.iter().rev().take_while(|e| e.1 > cursor) {
                if event["sounds"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|s| s["owner"] == id && s["phase"] == "spawn")
                {
                    heard.push(field.tick);
                }
            }
            world.step();
        }
        assert_eq!(heard, [landing]);
    }

    #[test]
    fn lightning_warning_enters_only_its_intended_seats_window() {
        let battle = Battle::new(Arena::classic()).unwrap();
        let source = clash_battle_core::SoundOrigin {
            spell: true,
            owner: 50,
            kind: "medium_lightning",
            team: Team::Red,
            form: false,
            action: "spell",
        };
        let phases = [
            "spell:cast",
            "spell:warning",
            "spell:warning_enemy",
            "spell:strike",
        ];
        let facts: Vec<_> = phases
            .iter()
            .enumerate()
            .map(|(i, phase)| Event {
                tick: 0,
                sequence: i as u64,
                fact: Fact::Sound {
                    source,
                    phase,
                    position: Point::default(),
                    target: None,
                },
            })
            .collect();
        for team in [Team::Blue, Team::Red] {
            let mut stream = Stream::for_seat(team.index());
            stream.advance(&battle.snapshot_for(team), &facts, &[]);
            let received: Vec<_> = stream
                .events
                .iter()
                .filter_map(|(_, _, e)| e["sounds"].get(0)?.get("phase")?.as_str())
                .collect();
            let expected = if team == Team::Blue {
                vec![phases[2], phases[3]]
            } else {
                vec![phases[0], phases[1], phases[3]]
            };
            assert_eq!(received, expected);
        }
    }
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
    fn a_baseline_with_an_arrow_in_flight_preserves_its_hit_after_the_archer_dies() {
        check_in_flight_death(false);
    }

    #[test]
    fn a_homing_arrow_losing_its_target_has_no_impact_sound() {
        check_in_flight_death(true);
    }

    fn check_in_flight_death(kill_target: bool) {
        let mut b = Battle::new(Arena::classic()).unwrap();
        let from = Point::new(100., 200.);
        let to = Point::new(256., 200.);
        let finisher = Skill {
            aim: AimKind::Point,
            cast_range: 200.,
            shape: Shape::Circle { radius: 20. },
            effects: vec![Effect::Damage(500)],
            cooldown: 10,
        };
        let archer = b
            .spawn(
                Team::Blue,
                from,
                UnitDef {
                    key: "ashe",
                    skill: Some(finisher.clone()),
                    ..UnitDef::ranged()
                },
            )
            .unwrap();
        let target = b
            .spawn(
                Team::Red,
                to,
                UnitDef {
                    action: Action::Idle,
                    speed: 0.,
                    skill: Some(finisher),
                    ..UnitDef::melee()
                },
            )
            .unwrap();
        while b.snapshot().projectiles.is_empty() && b.snapshot().tick < 30 {
            b.step(&[]);
        }
        let shot = b.snapshot().projectiles[0].id;
        b.drain_events().for_each(drop);
        let mut stream = Stream::default();
        stream.advance(&b.snapshot_for(Team::Red), &[], &[]);
        let baseline = stream.window()["cursor"].as_u64().unwrap();
        for i in 0..16 {
            let kill = [(
                if kill_target { Team::Blue } else { Team::Red },
                Cast {
                    caster: if kill_target { archer } else { target },
                    aim: Aim::Point(if kill_target { to } else { from }),
                },
            )];
            b.step(if i == 0 { &kill } else { &[] });
            let facts = b.drain_events().collect::<Vec<_>>();
            stream.advance(&b.snapshot_for(Team::Red), &facts, &[]);
        }
        let victim = if kill_target { target } else { archer };
        assert!(!b.snapshot().units.iter().any(|u| u.id == victim));
        assert!(!b.snapshot().projectiles.iter().any(|p| p.id == shot));
        let window = stream.window();
        let sounds: Vec<_> = window["events"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| e["seq"].as_u64().unwrap() > baseline)
            .filter_map(|e| e["sounds"].as_array())
            .flatten()
            .filter(|s| s["owner"] == archer)
            .collect();
        assert!(sounds.iter().all(|s| s["phase"] != "release"));
        let hits: Vec<_> = sounds.iter().filter(|s| s["phase"] == "hit").collect();
        if kill_target {
            assert!(hits.is_empty());
            return;
        }
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0]["kind"], "ashe");
        assert_eq!(hits[0]["position"], json!(to));
        assert_eq!(hits[0]["key"], shot);
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

#[cfg(test)]
#[path = "audio_roster_tests.rs"]
mod roster_audio;
