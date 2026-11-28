use super::*;
use crate::vitals::Change;

fn doubles(first: &'static str) -> ClassicMatch {
    let mut deck = representative_deck();
    if let Some(slot) = deck.iter().position(|c| c.key == first) {
        deck.swap(0, slot);
    }
    deck[0] = *battle_cards().iter().find(|c| c.key == first).unwrap();
    ClassicMatch::with_seats(
        901,
        &[deck; 4],
        MatchMap::rift(),
        modes().iter().find(|m| m.id == "2v2").unwrap(),
    )
    .unwrap()
}

fn deploy(game: &mut ClassicMatch, seat: usize, key: &str, point: Point) {
    let p = &mut game.players[seat];
    for _ in 0..5 {
        if p.view().hand.contains(&key) {
            break;
        }
        p.rotate(0, 0);
    }
    let view = p.view();
    let command = Input {
        team: seat_team(seat),
        sequence: view.acknowledged + 1,
        intent: Intent::Play {
            slot: view.hand.iter().position(|&card| card == key).unwrap() as u8,
            version: view.version,
            point,
        },
    };
    let tick = game.tick();
    assert_eq!(
        game.step_seats([(seat, tick, command)]),
        [Ok(tick + COMMAND_DELAY)]
    );
    while game.tick() < tick + COMMAND_DELAY {
        game.step(&[]);
    }
    assert_eq!(
        game.take_seat_completions(),
        [(seat, command.sequence, Ok(()))]
    );
}

fn gold(game: &ClassicMatch) -> Vec<u8> {
    game.players.iter().map(|p| p.gold).collect()
}

#[test]
fn teammates_have_independent_commands_skills_and_ward_income() {
    let mut game = doubles("gold_ward");
    game.players[2].gold = 10;
    let ally_hand = game.players[0].view();
    deploy(&mut game, 2, "gold_ward", Point::new(220., 860.));
    assert_eq!(game.players[0].view(), ally_hand);
    let ward = game.players[2].active[0].unwrap().caster;
    let ready = game.battle.actors[&ward].ready_tick;
    game.battle.tick = ready + 100;
    game.players.iter_mut().for_each(|p| p.gold = 0);
    game.collect_income();
    assert_eq!(gold(&game), [0, 0, 1, 0]);
    let invalid = Input {
        team: Team::Blue,
        sequence: 1,
        intent: Intent::Activate {
            slot: 0,
            aim: Aim::Instant,
        },
    };
    assert_eq!(
        game.schedule_for(0, game.tick(), invalid),
        Err(MatchError::NoAbility)
    );
    assert_eq!(
        game.schedule_for(3, game.tick(), invalid),
        Err(MatchError::Slot)
    );
    game.battle.actors.get_mut(&ward).unwrap().hp = 0;
    game.battle.remove_dead();
    game.spell_deaths();
    assert_eq!(gold(&game), [0, 0, 3, 0]);
}

#[test]
fn crab_bounty_tracks_spells_delayed_summons_and_shared_defenses() {
    let mut game = doubles("zap");
    let point = Point::new(420., 460.);
    let crab = |g: &mut ClassicMatch| {
        let id = g
            .battle
            .spawn_near(Team::Red, point, units::unit("void_scuttle_crab"))
            .unwrap();
        g.battle.actors.get_mut(&id).unwrap().hp = 1;
        id
    };
    let id = crab(&mut game);
    deploy(&mut game, 2, "zap", point);
    for _ in 0..10 {
        game.step(&[]);
    }
    assert!(!game.battle.actors.contains_key(&id));
    let cost = battle_cards().iter().find(|c| c.key == "zap").unwrap().cost;
    assert_eq!(gold(&game), [5, 5, 5 - cost + 2, 5]);

    let parent = game
        .battle
        .spawn_near(Team::Blue, Point::new(220., 800.), units::unit("lulu"))
        .unwrap();
    game.battle.owners.insert(parent, 2);
    game.battle.actors.remove(&parent);
    let child = game
        .battle
        .spawn_near(
            Team::Blue,
            Point::new(220., 800.),
            units::unit("pix_single"),
        )
        .unwrap();
    game.battle.summoned(parent, child);
    for (source, expected) in [(child, [0, 0, 2, 0]), (game.towers[0][0], [1, 0, 1, 0])] {
        let id = crab(&mut game);
        game.players.iter_mut().for_each(|p| p.gold = 0);
        game.battle
            .commit(vec![Change::delivered(source, id, -100)]);
        game.spell_deaths();
        assert_eq!(gold(&game), expected);
    }
}
