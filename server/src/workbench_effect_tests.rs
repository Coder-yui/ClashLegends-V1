use super::*;
use std::{fs, io::Write};

/// Export genuine workbench frames for the WebGL stage regression.
#[test]
#[ignore]
fn export_effect_stages() {
    let out = std::env::var("CLASH_EFFECT_FRAMES").unwrap();
    fs::create_dir_all(&out).unwrap();
    let catalog: Value = serde_json::from_str(include_str!("../../content/catalog.json")).unwrap();
    for (name, team, skill_index) in [
        ("ekko", Team::Blue, 0),
        ("ekko", Team::Red, 0),
        ("blitzcrank", Team::Blue, 0),
        ("jayce", Team::Blue, 0),
        ("scarecrow", Team::Blue, 0),
        ("apex_turret", Team::Blue, 0),
        ("malzahar", Team::Blue, 1),
        ("pantheon", Team::Blue, 0),
        ("pantheon", Team::Red, 0),
        ("reksai", Team::Blue, 0),
        ("twisted_fate", Team::Blue, 0),
        ("twitch", Team::Blue, 0),
        ("malzahar", Team::Blue, 0),
        ("void_spawn", Team::Blue, 0),
        ("pix", Team::Blue, 0),
        ("gold_ward", Team::Blue, 0),
        ("void_gate", Team::Blue, 0),
        ("pillar_of_ice", Team::Blue, 0),
        ("tristana", Team::Blue, 0),
        ("sivir", Team::Blue, 0),
        ("voidfish_ranged", Team::Blue, 0),
        ("shurima_guard", Team::Blue, 0),
    ] {
        let c = catalog["cards"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["id"] == name)
            .unwrap();
        let skill = c["skills"][skill_index]["id"].as_str();
        let mut world = Workbench::new();
        let origin = Point::new(380., 820.);
        let opponent = if name == "blitzcrank" {
            "ashe"
        } else {
            "training_dummy"
        };
        let gap = if name == "blitzcrank" {
            164.
        } else if name == "scarecrow" {
            74.
        } else {
            90.
        };
        if name != "ekko" && name != "twitch" {
            world
                .deploy(
                    opponent,
                    None,
                    team.enemy(),
                    Point::new(origin.x, origin.y - gap),
                )
                .unwrap();
        }
        if name == "scarecrow" {
            world
                .deploy("melee_minion", None, team.enemy(), Point::new(410., 760.))
                .unwrap();
        }
        let selected = world.deploy(name, skill, team, origin).unwrap();
        let mut lab = Lab {
            world,
            selected,
            epoch: 0,
            paused: true,
            speed: 4,
            stream: Default::default(),
        };
        let mut file = std::io::BufWriter::new(
            fs::File::create(format!("{out}/{name}--{team:?}--{skill_index}.jsonl")).unwrap(),
        );
        let mut cursor = 0;
        let mut past = origin;
        for tick in 0..if name == "jayce" {
            470
        } else if name == "scarecrow" {
            300
        } else {
            145
        } {
            if tick == 96 && ["ekko", "twitch"].contains(&name) {
                lab.world
                    .deploy(
                        "training_dummy",
                        None,
                        team.enemy(),
                        Point::new(past.x + 35., past.y - 12.),
                    )
                    .unwrap();
            }
            if name == "jayce" && [45, 200, 345].contains(&tick) {
                let _ = lab.edit(Edit::Transform);
            }
            let cast_from = match name {
                "ekko" => 100,
                "jayce" => 200,
                _ => 55,
            };
            if name != "void_gate" && tick >= cast_from && tick % 5 == 0 {
                let _ = lab.edit(Edit::Cast);
            }
            lab.world.step();
            let mut v: Value = serde_json::from_str(&lab.snapshot()).unwrap();
            if tick == 20 {
                if let Some(u) = v["units"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|u| u["id"].as_u64() == selected.map(u64::from))
                {
                    past = Point::new(u["x"].as_f64().unwrap(), u["y"].as_f64().unwrap());
                }
            }
            let events: Vec<_> = v["presentation"]["events"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|e| e["seq"].as_u64().unwrap() > cursor)
                .cloned()
                .collect();
            cursor = v["presentation"]["cursor"].as_u64().unwrap();
            v["cues"] = json!(events);
            v["presentation"] = json!({"cursor":cursor});
            v.as_object_mut().unwrap().retain(|k, _| {
                matches!(
                    k.as_str(),
                    "units"
                        | "shots"
                        | "waves"
                        | "areas"
                        | "spells"
                        | "summons"
                        | "effectPaths"
                        | "tick"
                        | "map"
                        | "cues"
                        | "presentation"
                        | "hand"
                )
            });
            writeln!(file, "{v}").unwrap();
        }
    }
}
