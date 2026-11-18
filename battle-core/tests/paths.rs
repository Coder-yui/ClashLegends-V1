use clash_battle_core::path_search::weighted_path;
use serde_json::Value;
#[test]
fn old_weighted_navigation_routes() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/native_path_search.json")).unwrap();
    let cell = |v: &Value| {
        (
            v[0].as_u64().unwrap() as usize,
            v[1].as_u64().unwrap() as usize,
        )
    };
    for case in fixture["cases"].as_array().unwrap() {
        let rows = case["grid"].as_array().unwrap();
        let size = (rows[0].as_array().unwrap().len(), rows.len());
        let costs = rows
            .iter()
            .flat_map(|r| {
                r.as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_i64().unwrap() as i32)
            })
            .collect::<Vec<_>>();
        let expected = case["path"]
            .as_array()
            .unwrap()
            .iter()
            .map(cell)
            .collect::<Vec<_>>();
        assert_eq!(
            weighted_path(size, &costs, cell(&case["start"]), cell(&case["goal"]), 5),
            expected,
            "{}",
            case["name"]
        )
    }
}
