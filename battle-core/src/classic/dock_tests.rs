use super::*;
use crate::{movement, targeting::Perception};

fn dock() -> ClassicMatch {
    let deck = representative_deck();
    ClassicMatch::on_map(51, [deck, deck], MatchMap::named("lowtide-dock").unwrap()).unwrap()
}

#[test]
fn dock_waves_share_the_muster_point_but_take_three_separate_roads() {
    let mut game = dock();
    game.spawn_wave(true, false);
    let mut ids = [[0; 3]; 2];
    for team in [Team::Blue, Team::Red] {
        let own = team.index();
        for a in game
            .battle
            .actors
            .values()
            .filter(|a| a.team == team && a.def.role == Role::Troop)
        {
            let route = a.lane.as_ref().unwrap();
            let lane = game.towers[team.enemy().index()]
                .iter()
                .position(|id| *id == route.tower)
                .unwrap();
            ids[own][lane] = a.id;
            assert_eq!(a.pos, game.map.sides[own].wave[lane]);
        }
        assert!(ids[own].iter().all(|&id| id != 0));
    }
    let mut first = [None; 3];
    for tick in 1_u64..=525 {
        game.battle.step(&[]);
        game.drain_events().for_each(drop);
        for (lane, &id) in ids[0].iter().enumerate() {
            if let Some(a) = game.battle.actors.get(&id) {
                if a.target.is_some_and(|t| ids[1].contains(&t)) && first[lane].is_none() {
                    first[lane] = Some(tick);
                }
            }
        }
        if tick == 65 {
            for side in ids {
                let xs = side.map(|id| game.battle.actors[&id].pos.x);
                assert!(xs[0] + 100. < xs[1] && xs[1] + 100. < xs[2], "{xs:?}");
            }
        }
    }
    let [left, mid, right] = first.map(Option::unwrap);
    assert!(mid + 45 < left && mid + 45 < right, "{first:?}");
    assert!(left.abs_diff(right) <= 4, "{first:?}");
}

#[test]
fn ground_river_and_air_crossings_and_deployment_match_the_survey() {
    let mut g = dock();
    let red = Team::Red;
    let home = Point::new(360., 430.);
    let off_bridge = Point::new(350., 872.);
    let object = g
        .map
        .arena
        .land_obstacles
        .iter()
        .find(|r| r.min.x > 100. && r.min.y > 350. && r.max.y < 790.)
        .unwrap();
    let prop = (object.min + object.max) * 0.5;
    assert!(g.cell(home, red, Some(&UnitDef::melee())).is_ok());
    assert!(g
        .cell(g.map.sides[red.index()].nexus, red, Some(&UnitDef::melee()))
        .is_err());
    assert!(g.cell(prop, red, Some(&UnitDef::melee())).is_err());
    for x in [158., 548., 938.] {
        assert!(g
            .cell(Point::new(x, 872.), red, Some(&UnitDef::melee()))
            .is_err());
    }
    for (def, water, land) in [
        (UnitDef::melee(), false, false),
        (units::unit("kassadin"), true, false),
        (units::unit("kayn"), true, true),
        (units::unit("corki"), true, true),
    ] {
        let id = g.battle.spawn(red, home, def).unwrap();
        let a = &g.battle.actors[&id];
        let q = movement::query(&g.map.arena, &[], a);
        assert_eq!(q.legal(off_bridge), water, "{} water", a.def.key);
        assert_eq!(q.legal(prop), land, "{} quay", a.def.key);
        for x in [158., 548., 938.] {
            assert!(
                q.clear(Point::new(x, 760.), Point::new(x, 990.)),
                "{} bridge {x}",
                a.def.key
            );
        }
    }
}

#[test]
fn destroying_one_lane_tower_unlocks_only_its_pocket_and_upgrades_its_wave() {
    let mut game = dock();
    let enemy = Team::Red.index();
    let tower = game.towers[enemy][1];
    game.battle.actors.remove(&tower);
    assert_eq!(game.open_pockets(Team::Blue), [false, true, false]);
    game.spawn_wave(true, false);
    let a = game
        .battle
        .actors
        .values()
        .find(|a| a.team == Team::Blue && a.def.key == "super_minion")
        .unwrap();
    let lane = a.lane.as_ref().unwrap();
    assert_eq!(lane.tower, tower);
    let view = Perception::new(&game.battle.actors);
    assert_eq!(
        view.choose(a, game.map.arena.width / 2.).unwrap().0.id,
        game.nexus[enemy]
    );
    let id = a.id;
    let minion = game.battle.actors.get_mut(&id).unwrap();
    minion.pos = Point::new(428., 1110.);
    let distractor = game
        .battle
        .spawn(Team::Red, Point::new(428., 1045.), UnitDef::melee())
        .unwrap();
    let a = &game.battle.actors[&id];
    let view = Perception::new(&game.battle.actors);
    assert_eq!(
        view.choose(a, game.map.arena.width / 2.).unwrap().0.id,
        distractor
    );
}

#[test]
fn dock_replay_reconstructs_its_named_field() {
    let mut game = dock();
    let mut record = replay::Record::new(&game, "dock-test").unwrap();
    for _ in 0..112 {
        record.step(&mut game, &[]).unwrap();
    }
    let deck = representative_deck();
    let rebuilt = record.replay([deck, deck], "dock-test").unwrap();
    assert_eq!(game.view(Team::Blue), rebuilt.view(Team::Blue));
}

#[test]
fn troops_deployed_between_lanes_cross_the_canal_according_to_their_movement() {
    let start = Point::new(340., 1048.);
    let middle_y = 872.;
    for key in ["ashe", "corki", "kassadin", "kayn"] {
        let mut game = dock();
        let card = battle_cards().iter().find(|card| card.key == key).unwrap();
        let id = game
            .deploy_formation(*card, key, Team::Blue, start)
            .unwrap()[0];
        let tower_id = game.towers[Team::Red.index()][0];
        let tower = game.battle.actors[&tower_id].pos;
        let direct_x = start.x + (tower.x - start.x) * (middle_y - start.y) / (tower.y - start.y);
        assert_eq!(
            game.battle.actors[&id].lane.as_ref().unwrap().tower,
            tower_id
        );
        let mut crossing = None;
        for _ in 0..350 {
            let from = game.battle.actors[&id].pos;
            game.battle.step(&[]);
            let a = &game.battle.actors[&id];
            if from.y > middle_y && a.pos.y <= middle_y {
                assert_eq!(a.target, Some(tower_id));
                crossing =
                    Some(from.x + (a.pos.x - from.x) * (middle_y - from.y) / (a.pos.y - from.y));
                break;
            }
        }
        let x = crossing.unwrap_or_else(|| panic!("{key} never crossed the canal"));
        if key == "ashe" {
            assert!(
                (110.0..206.).contains(&x),
                "{key} crossed at ({x}, {middle_y}); expected west bridge"
            );
        } else {
            assert!(
                (x - direct_x).abs() < 1.,
                "{key} crossed at ({x}, {middle_y}); expected open water at x={direct_x}"
            );
        }
        println!("{key} crossed at ({x:.2}, {middle_y:.2})");
    }
}
