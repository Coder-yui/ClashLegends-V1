use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, fs, path::Path};
#[path = "src/classic/kinds.rs"]
mod kinds;
#[path = "src/classic/spell_kind.rs"]
mod spell_kind;
fn read(p: &str) -> Value {
    serde_json::from_slice(&fs::read(p).unwrap()).unwrap()
}
fn fingerprint(p: &Path, h: &mut Sha256) {
    if p.is_dir() {
        let mut files: Vec<_> = fs::read_dir(p)
            .unwrap()
            .map(|f| f.unwrap().path())
            .collect();
        files.sort();
        for f in files {
            fingerprint(&f, h)
        }
    } else {
        if p.to_string_lossy().ends_with("_tests.rs") {
            return;
        }
        h.update(p.to_string_lossy().as_bytes());
        h.update([0]);
        h.update(fs::read(p).unwrap());
    }
}
fn main() {
    let public = read("../content/catalog.json");
    let rules = read("../content/battle_rules.json");
    let prep = read("../web/src/preparation-data.json");
    let mut cards = BTreeSet::new();
    let mut skills = BTreeSet::new();
    for card in public["cards"].as_array().unwrap() {
        let id = card["id"].as_str().unwrap();
        assert!(cards.insert(id), "duplicate card {id}");
        let r = &rules[id];
        assert!(r.is_object() && prep[id].is_object(), "missing card {id}");
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
            assert!(
                prep[id]["skills"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|v| v["id"] == key),
                "missing detail {key}"
            );
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
        for art in std::iter::once(card).chain(listed) {
            let path = art["image"]
                .as_str()
                .unwrap()
                .strip_prefix("/play/")
                .unwrap();
            let path = Path::new("../web/public").join(path);
            println!("cargo:rerun-if-changed={}", path.display());
            assert!(path.is_file(), "missing {}", path.display());
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
        assert!(
            t > 0.
                && w % t == 0.
                && h % t == 0.
                && m["projection"].as_f64().is_some_and(|v| v > 0. && v <= 1.),
            "invalid geometry {id}"
        );
        for rect in m["home"].as_array().unwrap().iter().chain(
            m["pockets"]
                .as_array()
                .unwrap()
                .iter()
                .flat_map(|side| side.as_array().unwrap()),
        ) {
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
                    && (v[0] + v[2]) * t <= w
                    && (v[1] + v[3]) * t <= h,
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
    let mut h = Sha256::new();
    for path in [
        "src",
        "../content/battle_rules.json",
        "../content/modes.json",
        "../server/src/battle.rs",
    ] {
        println!("cargo:rerun-if-changed={path}");
        fingerprint(Path::new(path), &mut h);
    }
    // Art and copy updates can deploy while a running battle is recovering.
    for filename in ["catalog", "maps"] {
        println!("cargo:rerun-if-changed=../content/{filename}.json");
    }
    let choices = public["cards"]
        .as_array()
        .unwrap()
        .iter()
        .map(|card| {
            serde_json::json!([
                card["id"],
                card["type"],
                card["skills"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|s| &s["id"])
                    .collect::<Vec<_>>()
            ])
        })
        .collect::<Vec<_>>();
    h.update(serde_json::to_vec(&choices).unwrap());
    let mut geometry = maps;
    for m in geometry.as_array_mut().unwrap() {
        for key in [
            "name",
            "terrain",
            "image",
            "backdropWidth",
            "backMargin",
            "projection",
            "testOnly",
        ] {
            m.as_object_mut().unwrap().remove(key);
        }
    }
    h.update(serde_json::to_vec(&geometry).unwrap());
    println!("cargo:rerun-if-changed=../web/src/preparation-data.json");
    println!(
        "cargo:rustc-env=BATTLE_RULESET=classic-{}",
        h.finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    );
}
