//! Validate catalog presentation at the application boundary and version the served battle assets.
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{fs, path::Path};
fn read(path: &str) -> Value {
    println!("cargo:rerun-if-changed={path}");
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}
fn fingerprint(path: &Path, digest: &mut Sha256) {
    if path.is_dir() {
        let mut paths: Vec<_> = fs::read_dir(path)
            .unwrap()
            .map(|e| e.unwrap().path())
            .collect();
        paths.sort();
        for p in paths {
            fingerprint(&p, digest);
        }
    } else if !path.file_name().unwrap().to_string_lossy().starts_with('.') {
        let bytes = fs::read(path).unwrap();
        digest.update(path.to_str().unwrap().as_bytes());
        digest.update([0]);
        digest.update((bytes.len() as u64).to_le_bytes());
        digest.update(bytes);
    }
}
fn main() {
    let catalog = read("../content/catalog.json");
    let prep = read("../web/src/preparation-data.json");
    for card in catalog["cards"].as_array().unwrap() {
        let id = card["id"].as_str().unwrap();
        assert!(prep[id].is_object(), "missing preparation entry {id}");
        let skills = card["skills"].as_array().unwrap();
        for sk in skills {
            assert!(
                prep[id]["skills"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|option| option["id"] == sk["id"]),
                "missing skill details {id}/{}",
                sk["id"]
            );
        }
        for entry in std::iter::once(card).chain(skills) {
            let path = Path::new("../web/public").join(
                entry["image"]
                    .as_str()
                    .unwrap()
                    .strip_prefix("/play/")
                    .unwrap(),
            );
            assert!(path.is_file(), "missing {}", path.display());
        }
    }
    let mut digest = Sha256::new();
    for path in [
        "../web/public/media",
        "../web/src/roster-models.json",
        "../web/src/model-members.json",
        "../web/src/battle-audio-banks.json",
        "../web/src/battle-effect-assets.json",
        "../web/src/pantheon-arrival-assets.json",
        "../web/src/reksai-rock-assets.json",
        "../content/model_resources.json",
    ] {
        println!("cargo:rerun-if-changed={path}");
        fingerprint(Path::new(path), &mut digest);
    }
    println!(
        "cargo:rustc-env=BATTLE_ASSETS={}",
        digest
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    );
}
