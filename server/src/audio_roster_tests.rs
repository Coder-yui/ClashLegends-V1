use super::*;
use clash_battle_core::{
    classic::{battle_cards, workbench::Workbench},
    Point, Team,
};

type Evidence = BTreeMap<String, Value>;

fn observe(world: &mut Workbench, stream: &mut Stream, team: Team, witnessed: &mut Evidence) {
    let facts = world.facts();
    let view = world.game().view(team);
    let before = stream.cursor;
    stream.advance(&view.field, &facts, &[]);
    let layers = stream.layers();
    let from_events = stream
        .events
        .iter()
        .rev()
        .take_while(|(_, seq, _)| *seq > before)
        .filter_map(|(_, _, v)| v["sounds"].as_array())
        .flatten();
    for sound in from_events.chain(layers.iter()) {
        let mut sig = sound.clone();
        let obj = sig.as_object_mut().unwrap();
        for key in ["position", "key", "owner", "group", "projectile", "release"] {
            obj.remove(key);
        }
        if let Some(c) = obj.get_mut("cycle") {
            *c = json!(c.as_u64().unwrap_or(1).min(12));
        }
        witnessed.entry(sig.to_string()).or_insert(sig);
    }
    for shot in view
        .field
        .projectiles
        .into_iter()
        .filter(|shot| shot.volley.is_none())
    {
        let sig = json!({"kind":shot.source_kind,"team":shot.team.index(),"form":shot.attack_sound.form,"cycle":shot.attack_sound.cycle,"phase":"projectileFlight"});
        witnessed.entry(sig.to_string()).or_insert(sig);
    }
    for area in view.field.areas {
        if let Some((s, phase, _)) = area.audio {
            let sig = json!({"kind":s.kind,"team":s.team.index(),"form":s.form,"phase":phase});
            witnessed.entry(sig.to_string()).or_insert(sig);
        }
    }
    for v in world.game().spell_views() {
        let tick = world.game().tick();
        if tick < v["end"].as_u64().unwrap() {
            let phase = if tick < v["impact"].as_u64().unwrap() {
                "spell:flight"
            } else {
                "spell:zone_sustain"
            };
            if v["key"] == "medium_lightning" {
                continue;
            }
            let sig = json!({"kind":v["key"],"team":v["team"],"phase":phase});
            witnessed.entry(sig.to_string()).or_insert(sig);
        }
    }
}

fn specialist_encounters(witnessed: &mut Evidence) -> usize {
    let cases = [
        ("gnar", 160.),
        ("blitzcrank", 120.),
        ("hecarim", 400.),
        ("corki", 160.),
        ("jayce", 120.),
        ("evolution_turret", 280.),
        ("kayn", 120.),
        ("kayn_assassin", 120.),
        ("kayn_slayer", 120.),
        ("scarecrow", 160.),
        ("rift_herald", 360.),
        ("aatrox", 80.),
        ("event_horizon", 120.),
        ("gwen", 120.),
        ("aurelionsol", 120.),
        ("void_scuttle_crab", 80.),
        ("jinx", 180.),
        ("target_dummy", 100.),
    ];
    for (key, distance) in cases {
        let mut world = Workbench::new();
        let mut stream = Stream::default();
        let skill = battle_cards()
            .iter()
            .find(|c| c.key == key)
            .and_then(|c| c.skill_key.map(str::to_owned))
            .or_else(|| {
                clash_battle_core::classic::workbench::objects()
                    .into_iter()
                    .find(|o| o["id"] == key)
                    .and_then(|o| o["skills"][0]["id"].as_str().map(str::to_owned))
            });
        let center = Point::new(140., 820.);
        let target = Point::new(center.x, center.y - distance);
        let actor = world
            .deploy(key, skill.as_deref(), Team::Blue, center)
            .unwrap();
        if key == "event_horizon" {
            world
                .deploy("melee_minion", None, Team::Red, target)
                .unwrap();
        } else if key != "evolution_turret" && key != "aurelionsol" {
            world
                .deploy("training_dummy", None, Team::Red, target)
                .unwrap();
        }
        observe(&mut world, &mut stream, Team::Blue, witnessed);
        for i in 0..860 {
            if key == "evolution_turret" && i == 150 {
                world
                    .deploy(
                        "training_dummy",
                        None,
                        Team::Red,
                        center - Point::new(0., 120.),
                    )
                    .unwrap();
            }
            if key == "aurelionsol" && i % 44 == 8 {
                let _ = world.deploy(
                    "melee_minion",
                    None,
                    Team::Red,
                    center - Point::new(0., 80.),
                );
            }
            if key == "hecarim" && i == 165 {
                let pos = world
                    .game()
                    .view(Team::Blue)
                    .field
                    .units
                    .into_iter()
                    .find(|u| Some(u.id) == actor)
                    .map(|u| u.position)
                    .unwrap_or(center);
                let _ = world.deploy("melee_minion", None, Team::Red, pos - Point::new(0., 100.));
            }
            if let Some(id) = actor {
                let attempt = match key {
                    "gnar" => i == 255,
                    "aurelionsol" => i == 700,
                    "jayce" => [192, 410, 630].contains(&i),
                    "corki" => i % 60 == 30,
                    "gwen" => i == 24,
                    _ => i % 60 == 31,
                };
                if attempt {
                    let _ = world.cast(id);
                }
            }
            world.step();
            observe(&mut world, &mut stream, Team::Blue, witnessed);
        }
    }
    cases.len()
}

// Exercise production mechanics much faster than the socket clock. The optional
// report retains witnesses, including conditions needed by the web cue selector.
#[test]
#[ignore = "full roster audio audit"]
fn exercise_audio_roster() {
    let mut witnessed: BTreeMap<String, Value> = BTreeMap::new();
    let mut loadouts = 0;
    let mut cases: Vec<_> = battle_cards()
        .iter()
        .map(|c| (c.key.to_owned(), c.skill_key.map(str::to_owned)))
        .collect();
    let catalog_count = cases.len();
    for obj in clash_battle_core::classic::workbench::objects() {
        let id = obj["id"].as_str().unwrap();
        if !cases.iter().any(|(key, _)| key == id) {
            cases.push((
                id.to_owned(),
                obj["skills"]
                    .get(0)
                    .and_then(|s| s["id"].as_str())
                    .map(str::to_owned),
            ));
        }
    }
    for (key, skill) in &cases {
        for siege in [false, true] {
            let mut world = Workbench::new();
            let mut stream = Stream::for_seat(usize::from(siege));
            let tower = world.game().map().sides[Team::Blue.index()].towers[0];
            let pos = if siege {
                tower - Point::new(0., 168.)
            } else {
                Point::new(365., 825.)
            };
            let team = if siege { Team::Red } else { Team::Blue };
            let enemy = if siege { Team::Blue } else { Team::Red };
            let forward = if siege { 1. } else { -1. };
            let place = |x, y| pos + Point::new(x, y * forward);
            for (who, side, x, y) in [
                ("training_dummy", enemy, 0., 65.),
                ("melee_minion", enemy, 40., 10.),
                ("super_minion", enemy, 35., 65.),
                ("melee_minion", team, -20., -30.),
                ("ashe", team, -10., -70.),
            ] {
                world.deploy(who, None, side, place(x, y)).unwrap();
            }
            let actor = [
                pos,
                place(-45., -95.),
                place(-85., 65.),
                place(-125., -75.),
                place(-85., -155.),
                Point::new(365., 420.),
                Point::new(340., 820.),
                Point::new(260., 340.),
            ]
            .into_iter()
            .find_map(|p| world.deploy(key, skill.as_deref(), team, p).ok())
            .unwrap_or_else(|| panic!("{} {:?}", key, skill.as_deref()));
            loadouts += 1;
            for i in 0..if siege { 800 } else { 360 } {
                if (!siege && [200, 255, 300].contains(&i)) || (siege && i >= 625 && i % 24 == 0) {
                    let aim = actor
                        .and_then(|id| {
                            world
                                .game()
                                .view(team)
                                .field
                                .units
                                .into_iter()
                                .find(|u| u.id == id)
                        })
                        .map_or(pos, |u| u.position);
                    for _ in 0..8 {
                        let _ = world.deploy("mega_inferno_bomb", None, enemy, aim);
                    }
                }
                if let Some(id) = actor {
                    if i == if siege { 450 } else { 100 } {
                        let _ = world.transform(id);
                    }
                    if (siege && i % 61 == 47) || (!siege && i % 27 == 19) {
                        let _ = world.cast(id);
                    }
                }
                if !siege && i == 55 {
                    world
                        .deploy("pool_of_reflection", None, Team::Blue, pos)
                        .unwrap();
                }
                if !siege && i == 80 {
                    world.deploy("stasis", None, Team::Red, pos).unwrap();
                }
                if siege && i % 100 == 39 {
                    let _ = world.deploy("melee_minion", None, enemy, place(0., 35.));
                }
                if siege && i == 525 {
                    let _ = world.deploy("medium_lightning", None, team, tower);
                    let _ = world.deploy("medium_lightning", None, enemy, place(0., 35.));
                }
                world.step();
                observe(&mut world, &mut stream, team, &mut witnessed);
            }
        }
    }
    loadouts += specialist_encounters(&mut witnessed);
    let mut detailed_stream = Stream::default();
    loadouts +=
        clash_battle_core::classic::workbench::fixtures::audio_encounters(|first, world| {
            if first {
                detailed_stream = Stream::default();
            }
            observe(world, &mut detailed_stream, Team::Blue, &mut witnessed);
        });
    assert!(loadouts >= 100 && witnessed.len() > 200);
    if let Ok(path) = std::env::var("CLASH_AUDIO_AUDIT") {
        std::fs::write(path,json!({"loadouts":catalog_count,"cases":loadouts,"sounds":witnessed.into_values().collect::<Vec<_>>()}).to_string()).unwrap();
    }
}
