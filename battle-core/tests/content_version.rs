#[path = "../build_content.rs"]
mod build_content;
use build_content::gameplay;
use serde_json::{json, Value};

#[test]
fn copy_assets_and_camera_do_not_change_authoritative_content() {
    let catalog =
        json!({"version":"art-A","cards":[{"id":"lulu","type":"unit","skills":[{"id":"growth"}]}]});
    let r = json!({"lulu":{"name":"Lulu","spawn_flight_duration":0.25,"active_skills":[{"id":"growth","description":"old"}]}});
    let m = json!([{"id":"rift","tile":40,"projection":0.81,"image":"old.webp"}]);
    let modes = json!([{"id":"classic","name":"Classic","end":6100}]);
    let project = |r: Value, m: Value| gameplay(&catalog, r, m, modes.clone());
    let expected = project(r.clone(), m.clone());
    let mut copy = r.clone();
    copy["lulu"]["name"] = json!("璐璐");
    copy["lulu"]["active_skills"][0]["description"] = json!("new");
    let mut art = m.clone();
    art[0]["projection"] = json!(0.7);
    art[0]["image"] = json!("new.webp");
    assert_eq!(project(copy, art), expected);
    let mut timing = r.clone();
    timing["lulu"]["spawn_flight_duration"] = json!(0.5);
    assert_ne!(project(timing, m.clone()), expected);
    let mut map = m.clone();
    map[0]["tile"] = json!(20);
    assert_ne!(project(r.clone(), map), expected);
    let mut variant = catalog.clone();
    variant["cards"][0]["skills"][0]["id"] = json!("other");
    assert_ne!(gameplay(&variant, r, m, modes), expected);
}
