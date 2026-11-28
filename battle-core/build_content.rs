//! The authoritative content fingerprint covers executable rules, choices and map geometry.
use serde_json::{json, Value};

fn omit(value: &mut Value, keys: &[&str]) {
    for key in keys {
        value.as_object_mut().unwrap().remove(*key);
    }
}
fn strip_copy(value: &mut Value) {
    match value {
        Value::Object(fields) => {
            fields.retain(|k, _| {
                k != "name"
                    && k != "description"
                    && !k.ends_with("_name")
                    && k != "charge_visual_duration"
            });
            fields.values_mut().for_each(strip_copy);
        }
        Value::Array(values) => values.iter_mut().for_each(strip_copy),
        _ => (),
    }
}
pub fn gameplay(catalog: &Value, mut rules: Value, mut maps: Value, mut modes: Value) -> Value {
    let choices: Vec<_> = catalog["cards"]
        .as_array()
        .unwrap()
        .iter()
        .map(|card| {
            json!([
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
        .collect();
    strip_copy(&mut rules);
    for map in maps.as_array_mut().unwrap() {
        omit(
            map,
            &[
                "name",
                "terrain",
                "terrainRed",
                "desktopRecommended",
                "image",
                "backdropWidth",
                "backMargin",
                "projection",
                "testOnly",
            ],
        );
    }
    for mode in modes.as_array_mut().unwrap() {
        omit(mode, &["name"]);
    }
    json!([choices, rules, maps, modes])
}
