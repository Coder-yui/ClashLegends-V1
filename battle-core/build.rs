use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, fs};
mod build_content;
#[path = "src/classic/kinds.rs"]
mod kinds;
#[path = "src/classic/spell_kind.rs"]
mod spell_kind;
fn read(p: &str) -> Value {
    serde_json::from_slice(&fs::read(p).unwrap()).unwrap()
}
fn main() {
    let public = read("../content/catalog.json");
    let rules = read("../content/battle_rules.json");
    let mut cards = BTreeSet::new();
    let mut skills = BTreeSet::new();
    for card in public["cards"].as_array().unwrap() {
        let id = card["id"].as_str().unwrap();
        assert!(cards.insert(id), "duplicate card {id}");
        let r = &rules[id];
        assert!(r.is_object(), "missing card {id}");
        assert!(
            id == "mirror" || r["cost"].as_u64().is_some_and(|v| v <= 10),
            "invalid cost for {id}"
        );
        if card["type"] == "spell" {
            let kind = r["spell_kind"].as_str().unwrap();
            assert!(
                kind == "mirror" || spell_kind::CardSpell::from_kind(kind).is_some(),
                "unknown spell {id}/{kind}"
            );
        }
        for key in ["spawn_id", "death_spawn_id", "deployment_upgrade_id"] {
            if let Some(target) = r[key].as_str() {
                assert!(rules[target].is_object(), "unresolved {id}/{key}: {target}");
            }
        }
        let options = r["active_skills"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let listed = card["skills"].as_array().unwrap();
        assert_eq!(listed.len(), options.len(), "{id} skill count");
        for sk in listed {
            let key = sk["id"].as_str().unwrap();
            assert!(skills.insert(key), "duplicate {key}");
            let spec = options
                .iter()
                .find(|v| v["id"] == key)
                .unwrap_or_else(|| panic!("missing rule {key}"));
            assert!(spec["cost"].as_u64().is_some_and(|v| v <= 10), "{key} cost");
            if let Some(overrides) = spec["member_skills"].as_object() {
                for (member, skill) in overrides {
                    assert!(
                        rules[member]["active_skills"]
                            .as_array()
                            .is_some_and(|options| options.iter().any(|opt| opt["id"] == *skill)),
                        "missing formation skill {id}/{member}/{skill}"
                    );
                }
            }
            if let Some(uses) = spec["max_uses"].as_u64() {
                assert!((1..=255).contains(&uses), "{key}: invalid uses");
            }
            if card["type"] != "spell" {
                assert!(
                    kinds::supported_kind(spec["kind"].as_str().unwrap_or("")),
                    "unknown skill mechanism {id}/{key}"
                );
            }
        }
        if let Some(members) = r["spawn_plan"]["members"].as_array() {
            for m in members {
                assert!(
                    m.as_str().is_some_and(|k| rules[k].is_object()),
                    "missing member {id}: {m}"
                );
            }
        }
    }
    for (id, r) in rules.as_object().unwrap() {
        for key in ["spawn_side", "death_spawn_side"] {
            if let Some(value) = r.get(key) {
                assert!(
                    matches!(
                        value.as_str(),
                        Some("map_side" | "bilateral" | "below" | "center" | "ring")
                    ),
                    "{id}/{key}"
                );
            }
        }
        for key in [
            "spawn_initial_delay",
            "spawn_deploy_time",
            "spawn_sequence_interval",
            "spawn_distance",
        ] {
            assert!(
                r.get(key)
                    .is_none_or(|v| v.as_f64().is_some_and(|n| n >= 0.)),
                "{id}/{key}"
            );
        }
        if r.get("elixir_interval").is_some() {
            assert!(
                r["elixir_interval"].as_f64().is_some_and(|n| n > 0.)
                    && r["elixir_amount"]
                        .as_f64()
                        .is_some_and(|n| n.fract() == 0. && (1.0..=10.0).contains(&n)),
                "{id} income"
            );
        }
        if r.get("death_heal_per_second").is_some() {
            assert!(
                r["death_heal_per_second"].as_f64().is_some_and(|n| n > 0.),
                "{id} shrine heal rate"
            );
        }
        if r.get("spawn_interval").is_some() {
            let valid_member = |m: &Value| {
                m["spawn_id"]
                    .as_str()
                    .is_some_and(|key| rules[key].is_object())
                    && m.get("spawn_count")
                        .is_none_or(|n| n.as_u64().is_some_and(|n| (1..=255).contains(&n)))
            };
            assert!(
                r["spawn_interval"].as_f64().is_some_and(|v| v > 0.),
                "{id} production interval"
            );
            if let Some(waves) = r.get("spawn_waves") {
                assert!(
                    waves.as_array().is_some_and(|ws| !ws.is_empty()
                        && ws.iter().all(|w| w
                            .as_array()
                            .is_some_and(|ms| !ms.is_empty() && ms.iter().all(valid_member)))),
                    "{id} spawn waves"
                );
            } else {
                assert!(valid_member(r), "{id} spawn member");
            }
            assert!(
                r.get("spawn_flight_duration")
                    .is_none_or(|n| n.as_f64().is_some_and(|v| v > 0.)),
                "{id} flight duration"
            );
        }
    }
    let maps = read("../content/maps.json");
    let modes = read("../content/modes.json");
    let mut map_ids = BTreeSet::new();
    for m in maps.as_array().unwrap() {
        let id = m["id"].as_str().unwrap();
        assert!(map_ids.insert(id), "duplicate map {id}");
        let (w, h, t) = (
            m["width"].as_f64().unwrap(),
            m["height"].as_f64().unwrap(),
            m["tile"].as_f64().unwrap(),
        );
        let origin = |i: usize| m["tileOrigin"][i].as_f64().unwrap_or(0.);
        assert!(
            t > 0.
                && origin(0) >= 0.
                && origin(1) >= 0.
                && (w - 2. * origin(0)) % t == 0.
                && (h - 2. * origin(1)) % t == 0.
                && m["projection"].as_f64().is_some_and(|v| v > 0. && v <= 1.),
            "invalid geometry {id}"
        );
        if let Some(teams) = m["landmarks"].as_array() {
            let lanes = m["lanes"].as_array().expect("surveyed map needs lanes");
            assert!(
                teams.len() == 2 && !lanes.is_empty(),
                "invalid sides for {id}"
            );
            for team in teams {
                for positions in ["towers", "front", "buildingFront"] {
                    assert_eq!(
                        team[positions].as_array().unwrap().len(),
                        lanes.len(),
                        "invalid {positions} for {id}"
                    );
                }
                for radius in ["towerRadius", "nexusRadius"] {
                    assert!(
                        team[radius].as_f64().is_some_and(|n| n > 0.),
                        "invalid {radius} for {id}"
                    );
                }
            }
            for route in lanes {
                let points = route.as_array().unwrap();
                assert!(
                    points.len() >= 2
                        && points.first() == Some(&teams[1]["spawn"])
                        && points.last() == Some(&teams[0]["spawn"])
                        && points.windows(2).all(|pair| pair[0] != pair[1]),
                    "invalid spawn path for {id}"
                );
            }
            assert!(
                m["redHome"].is_array()
                    && ["pockets", "redPockets"]
                        .iter()
                        .all(|key| m[*key].as_array().is_some_and(|v| v.len() == lanes.len())),
                "incomplete deployment zones for {id}"
            );
        }
        let homes = ["home", "redHome"]
            .into_iter()
            .filter_map(|f| m[f].as_array())
            .flatten();
        let pockets = ["pockets", "redPockets"]
            .into_iter()
            .filter_map(|f| m[f].as_array())
            .flatten()
            .flat_map(|lane| lane.as_array().unwrap());
        for rect in homes.chain(pockets) {
            let v: Vec<_> = rect
                .as_array()
                .unwrap()
                .iter()
                .map(|n| n.as_u64().unwrap() as f64)
                .collect();
            assert!(
                v.len() == 4
                    && v[2] > 0.
                    && v[3] > 0.
                    && (v[0] + v[2]) * t <= w - 2. * origin(0)
                    && (v[1] + v[3]) * t <= h - 2. * origin(1),
                "invalid deployment region {id}"
            );
        }
    }
    let mut mode_ids = BTreeSet::new();
    for mode in modes.as_array().unwrap() {
        assert!(mode_ids.insert(mode["id"].as_str().unwrap()));
        assert!(mode["mapIds"]
            .as_array()
            .is_some_and(|ids| !ids.is_empty()
                && ids.iter().all(|id| map_ids.contains(id.as_str().unwrap()))));
        assert!(
            mode["deckSize"] == 8
                && mode["regulation"].as_u64().unwrap() > 0
                && mode["regulation"].as_u64() < mode["end"].as_u64(),
            "invalid classic mode"
        );
    }
    for path in ["catalog", "battle_rules", "attack_timing", "maps", "modes"] {
        println!("cargo:rerun-if-changed=../content/{path}.json");
    }
    for path in [
        "build.rs",
        "build_content.rs",
        "src/classic/kinds.rs",
        "src/classic/spell_kind.rs",
    ] {
        println!("cargo:rerun-if-changed={path}");
    }
    let gameplay = build_content::gameplay(&public, rules, maps, modes);
    let attacks = read("../content/attack_timing.json");
    let digest = Sha256::digest(serde_json::to_vec(&(gameplay, attacks)).unwrap());
    println!(
        "cargo:rustc-env=BATTLE_CONTENT=roster-{}",
        digest
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    );
}
