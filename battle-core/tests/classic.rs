use clash_battle_core::{classic::*, *};
fn game() -> ClassicMatch {
    let d = representative_deck();
    ClassicMatch::new(55, [d, d]).unwrap()
}
#[test]
fn invalid_and_replayed_inputs_do_not_spend_or_rotate() {
    let mut g = game();
    let s = g.view(Team::Blue);
    let red = g.view(Team::Red);
    let slot = s.own.hand.iter().position(|&c| c != "freeze").unwrap() as u8;
    let play = |sequence, version, point| Input {
        team: Team::Blue,
        sequence,
        intent: Intent::Play {
            slot,
            version,
            point,
        },
    };
    let point = Point::new(180., 860.);
    let cmds = [
        play(1, 0, Point::new(140., 260.)),
        play(1, 0, point),
        play(2, 0, point),
        play(3, 0, point),
    ];
    let result = g.step(&cmds);
    assert_eq!(
        result,
        [
            Err(MatchError::Placement),
            Err(MatchError::Sequence),
            Ok(()),
            Err(MatchError::StaleHand)
        ]
    );
    let state = g.view(Team::Blue);
    assert_eq!(state.own.version, 1);
    assert_eq!(state.own.acknowledged, 3);
    assert_eq!(state.own.hand[slot as usize], s.own.next);
    assert!(state.own.gold < s.own.gold);
    assert_eq!(g.view(Team::Red).own, red.own);
}
#[test]
fn duplicate_cards_rejected_and_seed_replays() {
    let mut d = representative_deck();
    d[1] = d[0];
    assert!(matches!(
        ClassicMatch::new(0, [d, d]),
        Err(MatchError::Loadout)
    ));
    let mut a = game();
    let mut b = game();
    for _ in 0..250 {
        let inputs: Vec<_> = [Team::Blue, Team::Red]
            .into_iter()
            .filter_map(|t| bot_input(t, &a.view(t)))
            .collect();
        assert_eq!(a.step(&inputs), b.step(&inputs));
        assert_eq!(a.view(Team::Blue), b.view(Team::Blue));
        assert!(a.drain_events().eq(b.drain_events()));
    }
}
#[test]
fn production_is_bounded_and_stasis_pauses_decay() {
    let mut b = Battle::new(Arena::classic()).unwrap();
    let t = b
        .spawn(Team::Blue, Point::new(300., 840.), UnitDef::tombstone())
        .unwrap();
    let count = |s: Snapshot| s.units.iter().filter(|u| u.kind == "imp").count();
    b.step(&[]);
    assert_eq!(count(b.snapshot()), 2);
    b.control(t, Control::Stasis, 202).unwrap();
    for _ in 0..202 {
        b.step(&[])
    }
    assert_eq!(count(b.snapshot()), 2);
    assert_eq!(
        b.snapshot().units.iter().find(|u| u.id == t).unwrap().hp,
        399
    );
    b.step(&[]);
    assert_eq!(count(b.snapshot()), 4);
    for _ in 0..398 {
        b.step(&[])
    }
    assert!(b.snapshot().units.iter().all(|u| u.id != t));
    assert_eq!(count(b.snapshot()), 12);
}
#[test]
fn first_wave_and_half_second_reinforcements_follow_tick_boundary() {
    let mut g = game();
    for _ in 0..99 {
        g.step(&[]);
    }
    assert_eq!(g.view(Team::Blue).field.units.len(), 6);
    assert_eq!(g.view(Team::Blue).own.gold, 6);
    g.step(&[]);
    assert_eq!(
        g.view(Team::Blue)
            .field
            .units
            .iter()
            .filter(|u| u.kind == "melee_minion")
            .count(),
        4
    );
    for _ in 0..10 {
        g.step(&[]);
    }
    assert_eq!(
        g.view(Team::Blue)
            .field
            .units
            .iter()
            .filter(|u| u.kind == "ranged_minion")
            .count(),
        4
    );
}
#[test]
fn active_consumes_once_after_deployment_and_uses_caster_from_slot() {
    let mut g = (0..20)
        .map(|seed| {
            let d = representative_deck();
            ClassicMatch::new(seed, [d, d]).unwrap()
        })
        .find(|g| g.view(Team::Blue).own.hand.contains(&"tombstone"))
        .unwrap();
    let s = g.view(Team::Blue);
    let slot = s.own.hand.iter().position(|c| *c == "tombstone").unwrap() as u8;
    let cmd = |sequence, intent| Input {
        team: Team::Blue,
        sequence,
        intent,
    };
    let active = Intent::Activate {
        slot: 1,
        aim: Aim::Instant,
    };
    assert_eq!(
        g.step(&[
            cmd(
                1,
                Intent::Play {
                    slot,
                    version: 0,
                    point: Point::new(220., 820.)
                }
            ),
            cmd(2, active)
        ]),
        [Ok(()), Err(MatchError::Rule(Error::Controlled))]
    );
    for _ in 0..19 {
        g.step(&[]);
    }
    assert_eq!(
        g.step(&[cmd(3, active), cmd(4, active)]),
        [Ok(()), Err(MatchError::NoAbility)]
    );
    let s = g.view(Team::Blue);
    assert_eq!(s.own.gold, 1);
    assert_eq!(s.field.units.iter().filter(|u| u.kind == "imp").count(), 6);
}
#[test]
fn full_match_records_rejections_and_replays_both_private_seats() {
    let d = representative_deck();
    let mut g = ClassicMatch::new(2026, [d, d]).unwrap();
    let mut record = replay::Record::new(&g, "core-test").unwrap();
    while g.result().is_none() {
        let cmds: Vec<_> = [Team::Blue, Team::Red]
            .into_iter()
            .filter_map(|team| bot_input(team, &g.view(team)))
            .collect();
        record.step(&mut g, &cmds).unwrap();
        g.drain_events().for_each(drop);
    }
    assert!(record.commands.len() > 30);
    let replay = record.replay([d, d], "core-test").unwrap();
    for team in [Team::Blue, Team::Red] {
        assert_eq!(replay.view(team), g.view(team));
    }
    assert!(record.replay([d, d], "foreign-version").is_err());
    let mut stale = [d, d];
    stale[0].swap(0, 1);
    assert!(record.replay(stale, "core-test").is_err());
    let tick = g.tick();
    g.step(&[]);
    assert_eq!(g.tick(), tick);
}

#[test]
fn frozen_loadout_and_map_are_replay_inputs() {
    let catalog = representative_deck();
    let choices = catalog.map(|c| (c.key, c.skill_key));
    let deck = resolve_deck(choices, &catalog).unwrap();
    let mut invalid = choices;
    invalid[0].1 = Some("tombstone.gather-the-fallen");
    assert!(resolve_deck(invalid, &catalog).is_err());
    invalid[0] = ("unknown", None);
    assert!(resolve_deck(invalid, &catalog).is_err());
    let mut map = MatchMap::rift();
    map.id = "alternate";
    map.sides[0].nexus = Point::new(400., 1160.);
    map.sides[0].wave[0] = Point::new(110., 1180.);
    let mut g = ClassicMatch::on_map(4, [deck, deck], map.clone()).unwrap();
    let mut record = replay::Record::new(&g, "v1").unwrap();
    for _ in 0..101 {
        record.step(&mut g, &[]).unwrap();
    }
    assert!(g
        .view(Team::Blue)
        .field
        .units
        .iter()
        .any(|u| u.team == Team::Blue
            && u.kind == "melee_minion"
            && (u.position - map.sides[0].wave[0]).length() < 10.));
    assert!(record.replay([deck, deck], "v1").is_err());
    assert_eq!(
        record
            .replay_on([deck, deck], "v1", map.clone())
            .unwrap()
            .view(Team::Red),
        g.view(Team::Red)
    );
    record.skills[0][0] = Some("different-ability".to_owned());
    assert!(record.replay_on([deck, deck], "v1", map).is_err());
}
