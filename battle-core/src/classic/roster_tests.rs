use super::*;
use crate::Fact;

fn game(key: &'static str, choice: usize) -> ClassicMatch {
    let mut deck = representative_deck();
    let carried = *battle_cards()
        .iter()
        .filter(|c| c.key == key)
        .nth(choice)
        .unwrap();
    if let Some(i) = deck.iter().position(|c| c.key == key) {
        deck.swap(0, i);
    }
    deck[0] = carried;
    let choices = deck.map(|c| {
        let live = battle_cards()
            .iter()
            .find(|c2| c2.key == c.key && (c.skill_key.is_none() || c2.skill_key == c.skill_key))
            .unwrap();
        (c.key, live.skill_key)
    });
    let deck = resolve_deck(choices, battle_cards()).unwrap();
    let mut g = ClassicMatch::new(0, [deck, deck]).unwrap();
    g.players[0].gold = 10;
    g
}
fn play(g: &mut ClassicMatch, key: &str, point: Point) -> Result<(), MatchError> {
    for _ in 0..5 {
        let view = g.players[0].view();
        if let Some(slot) = view.hand.iter().position(|&c| c == key) {
            return g.step_immediate(&[Input {
                team: Team::Blue,
                sequence: view.acknowledged + 1,
                intent: Intent::Play {
                    slot: slot as u8,
                    version: view.version,
                    point,
                },
            }])[0];
        }
        g.players[0].rotate(0, 0);
    }
    panic!("absent card {key}")
}
fn cast(g: &mut ClassicMatch) -> Result<(), MatchError> {
    let sequence = g.players[0].ack + 1;
    g.step_immediate(&[Input {
        team: Team::Blue,
        sequence,
        intent: Intent::Activate {
            slot: 0,
            aim: Aim::Instant,
        },
    }])[0]
}
#[test]
fn mixed_formation_costs_once_and_only_transfers_to_its_survivors() {
    let mut g = game("heavy_minion_squad", 0);
    let point = Point::new(260., 820.);
    play(&mut g, "heavy_minion_squad", point).unwrap();
    let ids = g.players[0].groups[0].clone();
    assert_eq!(ids.len(), 2);
    assert_eq!(g.battle.actors[&ids[0]].def.key, "super_minion");
    assert_eq!(g.battle.actors[&ids[1]].def.key, "siege_minion");
    assert_eq!(
        g.battle.actors[&ids[1]].pos - g.battle.actors[&ids[0]].pos,
        Point::new(0., 100.)
    );
    assert_eq!(cast(&mut g), Err(MatchError::Rule(Error::Controlled)));
    for _ in 0..20 {
        g.step(&[]);
    }
    let gold = g.players[0].gold;
    cast(&mut g).unwrap();
    assert_eq!(g.players[0].gold, gold - 2);
    assert_eq!(g.battle.actors[&ids[0]].rates(), (1350, 1000, 1350));
    assert_eq!(g.battle.actors[&ids[0]].shields.total(), 140);
    assert_eq!(g.battle.actors[&ids[1]].rates(), (1000, 1000, 1500));
    g.battle.actors.remove(&ids[0]);
    g.step(&[]);
    assert_eq!(
        g.players[0].active[0],
        Some(Active {
            caster: ids[1],
            uses: 0
        })
    );
    g.battle.actors.remove(&ids[1]);
    g.step(&[]);
    assert_eq!(g.players[0].active[0], None);
}
#[test]
fn carried_heal_uses_the_frozen_variant_and_actual_overflow() {
    let pos = Point::new(260., 820.);
    for choice in 0..2 {
        let mut g = game("heal", choice);
        let friend = g
            .battle
            .spawn(Team::Blue, pos, UnitDef::super_minion())
            .unwrap();
        let distant = g
            .battle
            .spawn(Team::Blue, Point::new(520., 920.), UnitDef::super_minion())
            .unwrap();
        for id in [friend, distant] {
            g.battle.actors.get_mut(&id).unwrap().hp = 620;
        }
        play(&mut g, "heal", pos).unwrap();
        assert_eq!(g.players[0].gold, 7);
        assert_eq!(g.battle.actors[&friend].hp, 720);
        assert_eq!(
            g.battle.actors[&friend].shields.total(),
            if choice == 1 { 100 } else { 0 }
        );
        assert_eq!(
            g.battle.actors[&distant].hp,
            if choice == 0 { 720 } else { 620 }
        );
        assert_eq!(g.players[0].active[0], None);
    }
}
#[test]
fn lightning_strikes_distinct_targets_on_fixed_ticks() {
    let mut g = game("lightning", 0);
    let pos = Point::new(350., 900.);
    let mut ids = vec![];
    for dx in [-50., 0., 50.] {
        let mut d = UnitDef::super_minion();
        d.speed = 0.;
        d.hp = 2000;
        ids.push(
            g.battle
                .spawn(Team::Red, pos + Point::new(dx, 0.), d)
                .unwrap(),
        );
    }
    play(&mut g, "lightning", pos).unwrap();
    for _ in 0..40 {
        g.step(&[]);
    }
    let strikes: Vec<_> = g
        .drain_events()
        .filter_map(|e| match e.fact {
            Fact::Damage {
                source,
                target,
                requested,
                ..
            } if source == 5 => Some((e.tick, target, requested)),
            _ => None,
        })
        .collect();
    assert_eq!(
        strikes,
        vec![(1, ids[0], 460), (21, ids[1], 552), (41, ids[2], 662)]
    );
}

#[test]
fn every_spell_and_choice_deploys_from_a_frozen_deck_and_advances() {
    let mut keys = std::collections::BTreeSet::new();
    for card in battle_cards() {
        let Play::CardSpell(_, choice) = card.play else {
            continue;
        };
        keys.insert(card.key);
        let mut g = game(card.key, choice);
        let pos = Point::new(340., 860.);
        let mut dummy = UnitDef::super_minion();
        dummy.hp = 5000;
        dummy.speed = 0.;
        dummy.action = crate::Action::Idle;
        let enemy = g
            .battle
            .spawn(Team::Red, pos + Point::new(70., 0.), dummy.clone())
            .unwrap();
        let friend = g.battle.spawn(Team::Blue, pos, dummy).unwrap();
        g.battle.actors.get_mut(&friend).unwrap().hp = 3000;
        play(&mut g, card.key, pos).unwrap();
        for step in 1..=170 {
            g.step(&[]);
            if step == 18 && card.key == "solar_flare" {
                assert!(g.battle.actors[&enemy].sunlight.is_some());
            }
            if step == 1 && card.key == "pool_of_reflection" {
                assert_eq!(g.battle.actors[&friend].shields.total(), 123);
            }
        }
        let events: Vec<_> = g.drain_events().collect();
        match card.key {
            "void_summoning" => assert!(
                g.battle
                    .actors
                    .values()
                    .filter(|a| a.def.key == "voidfish")
                    .count()
                    >= 10
            ),
            "airdrop_bear" => assert!(g.battle.actors.values().any(|a| a.def.key == "tibbers")),
            "freeze" | "stasis" => assert!(events
                .iter()
                .any(|e| matches!(e.fact,Fact::Controlled(id,_) if id==enemy))),
            "heal" => assert_eq!(g.battle.actors[&friend].hp, 3300),
            "solar_flare" => (),
            "pool_of_reflection" | "event_horizon" | "tidal_wave" | "final_spark" => (),
            _ => assert!(
                events
                    .iter()
                    .any(|e| matches!(e.fact,Fact::Damage{target,..} if target==enemy)),
                "{}",
                card.key
            ),
        }
    }
    assert_eq!(keys.len(), 19);
}

#[test]
fn all_registered_units_deploy_and_cast_through_the_seat() {
    for card in battle_cards() {
        let i = match card.play {
            Play::RosterUnit(i) => i,
            Play::Formation(_) => 0,
            _ => continue,
        };
        let mut g = game(card.key, i);
        let center = Point::new(360., 820.);
        play(&mut g, card.key, center).unwrap_or_else(|err| panic!("deploy {}: {err:?}", card.key));
        let due = g.battle.actors[&g.players[0].active[0].unwrap().caster].ready_tick;
        for _ in g.tick()..due + 2 {
            g.step(&[]);
        }
        g.players[0].gold = 10;
        let caster = g.players[0].active[0].unwrap().caster;
        let a = &g.battle.actors[&caster];
        let origin = a.pos;
        let facing = a.facing;
        for distance in [55., 110.] {
            g.battle
                .spawn_near(Team::Red, origin + facing * distance, target_dummy(2500))
                .unwrap();
        }
        let mut flying = target_dummy(1500);
        flying.layer = crate::Layer::Air;
        g.battle
            .spawn_near(Team::Red, origin + facing * 65., flying)
            .unwrap();
        if card.active_spec()["requires_full_resource"] == true {
            let id = g.players[0].active[0].unwrap().caster;
            g.battle.actors.get_mut(&id).unwrap().card_state.resource = 5.;
        }
        cast(&mut g).unwrap_or_else(|err| panic!("cast {}: {err:?}", card.key));
        for _ in 0..50 {
            g.step(&[]);
        }
    }
}

#[test]
fn every_public_deck_choice_resolves_and_mixed_rosters_reach_a_result() {
    let catalog: serde_json::Value =
        serde_json::from_str(include_str!("../../../content/catalog.json")).unwrap();
    let mut cards = vec![];
    let mut skills = 0;
    for item in catalog["cards"].as_array().unwrap() {
        let key = item["id"].as_str().unwrap();
        let choices: Vec<_> = battle_cards().iter().filter(|c| c.key == key).collect();
        let variants = item["skills"].as_array().unwrap();
        assert_eq!(choices.len(), variants.len().max(1), "{key}");
        for variant in variants {
            assert!(choices
                .iter()
                .any(|c| c.skill_key == variant["id"].as_str()));
            skills += 1;
        }
        cards.push(*choices[0]);
    }
    assert!(cards.len() >= 100 && skills >= 106);
    // Each pair uses disjoint pools, includes all card types and travels through
    // the same rules, costs and end-of-match detection as the service.
    for start in (0..cards.len()).step_by(16) {
        let decks = [0, 8].map(|offset| {
            let picks = std::array::from_fn(|n| {
                let card = cards[(start + offset + n) % cards.len()];
                (card.key, card.skill_key)
            });
            resolve_deck(picks, battle_cards()).unwrap()
        });
        let mut g = ClassicMatch::new(start as u64 + 11, decks).unwrap();
        while g.result().is_none() {
            let commands: Vec<_> = [Team::Blue, Team::Red]
                .into_iter()
                .filter_map(|t| roster_bot_input(t, &g.view(t)))
                .collect();
            g.step(&commands);
            g.drain_events().for_each(drop);
        }
        assert!(g.tick() <= 6100);
    }
}

#[test]
fn independent_star_survives_its_owner_but_unreleased_star_dies_with_owner() {
    for (age, expected) in [(4, false), (12, true)] {
        let mut g = game("aurelionsol", 0);
        let p = Point::new(360., 980.);
        play(&mut g, "aurelionsol", p).unwrap();
        let caster = g.players[0].active[0].unwrap().caster;
        let a = g.battle.actors.get_mut(&caster).unwrap();
        a.ready_tick = 0;
        a.def.speed = 0.;
        a.def.action = crate::Action::Idle;
        let center = a.pos + a.facing * 175.;
        let mut def = UnitDef::super_minion();
        def.action = crate::Action::Idle;
        def.speed = 0.;
        let target = g.battle.spawn(Team::Red, center, def).unwrap();
        g.players[0].gold = 10;
        cast(&mut g).unwrap();
        for _ in 0..age {
            g.step(&[]);
        }
        g.battle
            .commit(vec![crate::vitals::Change::new(target, caster, -9999)]);
        for _ in 0..45 {
            g.step(&[]);
        }
        let hits=g.drain_events().filter(|e|matches!(e.fact,Fact::Damage{source,target:other,requested:120,..} if source==caster && other==target)).count();
        assert_eq!(hits, usize::from(expected));
    }
}

#[test]
fn bleed_stacks_are_per_source_and_execute_kill_banks_a_free_recast() {
    let mut g = game("darius", 0);
    let p = Point::new(360., 860.);
    play(&mut g, "darius", p).unwrap();
    let id = g.players[0].active[0].unwrap().caster;
    let s = &roster::rules()["darius"];
    let target = g
        .battle
        .spawn(Team::Red, p + Point::new(15., 0.), UnitDef::super_minion())
        .unwrap();
    let other = g
        .battle
        .spawn(Team::Blue, p + Point::new(24., 0.), units::unit("darius"))
        .unwrap();
    let hit = Attack {
        rules: Some(s),
        ..Default::default()
    };
    for source in [id, id, other, id, id] {
        g.battle
            .commit(vec![crate::vitals::Change::attack(source, target, 1, hit)]);
    }
    assert_eq!(g.battle.actors[&target].card_state.bleed[&id].stacks, 4);
    assert_eq!(g.battle.actors[&target].card_state.bleed[&other].stacks, 1);
    g.battle.actors.get_mut(&id).unwrap().ready_tick = 0;
    g.players[0].gold = 10;
    cast(&mut g).unwrap();
    let cooldown = g.battle.actors[&id].next_skill;
    g.battle.actors.get_mut(&target).unwrap().hp = 60;
    let attack = Attack::release(g.battle.actors.get_mut(&id).unwrap());
    g.battle
        .commit(vec![crate::vitals::Change::attack(id, target, 1, attack)]);
    assert_eq!(g.view(Team::Blue).active_cost[0], 0);
    let uses = g.players[0].active[0].unwrap().uses;
    let gold = g.players[0].gold;
    cast(&mut g).unwrap();
    assert_eq!(
        (
            g.players[0].gold,
            g.players[0].active[0].unwrap().uses,
            g.battle.actors[&id].next_skill
        ),
        (gold, uses, cooldown)
    );
}

#[test]
fn mirror_repeats_the_paid_kayle_form_even_with_a_different_balance() {
    let mut g = game("kayle", 0);
    let p = Point::new(340., 820.);
    play(&mut g, "kayle", p).unwrap();
    assert_eq!(g.players[0].gold, 4);
    assert_eq!(
        g.battle.actors[&g.players[0].active[0].unwrap().caster]
            .def
            .key,
        "kayle_ranged"
    );
    assert_eq!(g.players[0].last_card.unwrap().cost, 6);
    let mirror = *battle_cards().iter().find(|c| c.key == "mirror").unwrap();
    g.players[0].deck[1] = mirror;
    assert_eq!(play(&mut g, "mirror", p), Err(MatchError::Gold));
    g.players[0].gold = 6;
    play(&mut g, "mirror", p).unwrap();
    assert_eq!(
        g.battle.actors[&g.players[0].active[1].unwrap().caster]
            .def
            .key,
        "kayle_ranged"
    );
}

fn practice_field() -> Battle {
    Battle::new(crate::Arena {
        width: 1000.,
        height: 1000.,
        ground_obstacles: Vec::new(),
    })
    .unwrap()
}
fn target_dummy(hp: i32) -> UnitDef {
    let mut d = UnitDef::melee();
    d.hp = hp;
    d.action = crate::Action::Idle;
    d.speed = 0.;
    d
}

#[test]
fn conversion_mark_and_channel_zone_outlive_their_source() {
    let pos = Point::new(300., 300.);
    let mut field = practice_field();
    let azir = field.spawn(Team::Blue, pos, units::unit("azir")).unwrap();
    let foe = field
        .spawn(Team::Red, pos + Point::new(50., 0.), target_dummy(300))
        .unwrap();
    let hit = Attack {
        rules: Some(&roster::rules()["azir"]),
        ..Default::default()
    };
    field.commit(vec![crate::vitals::Change::attack(azir, foe, 1, hit)]);
    field.commit(vec![crate::vitals::Change::new(foe, azir, -9999)]);
    field.commit(vec![crate::vitals::Change::new(0, foe, -9999)]);
    assert!(field
        .actors
        .values()
        .any(|a| a.def.key == "sand_soldier" && a.team == Team::Blue));

    let mut field = practice_field();
    let source = field
        .spawn(Team::Blue, pos, units::unit("malzahar"))
        .unwrap();
    let foe = field
        .spawn(Team::Red, pos + Point::new(60., 0.), target_dummy(1000))
        .unwrap();
    let s = &roster::rules()["malzahar"]["active_skills"][0];
    let hit = Attack {
        rules: Some(&roster::rules()["malzahar"]),
        ability: Some(s),
        ..Default::default()
    };
    field.commit(vec![crate::vitals::Change::attack(source, foe, 10, hit)]);
    assert!(field.actors[&foe].has(Control::Stun));
    field.commit(vec![crate::vitals::Change::new(foe, source, -9999)]);
    assert!(!field.actors[&foe].has(Control::Stun));
    for _ in 0..100 {
        field.step(&[]);
    }
    assert_eq!(field.actors[&foe].hp, 690);
}

#[test]
fn hook_closes_the_gap_and_trap_reveals_once() {
    let mut field = practice_field();
    let p = Point::new(300., 300.);
    let source = field
        .spawn(Team::Blue, p, units::unit("blitzcrank"))
        .unwrap();
    let foe = field
        .spawn(Team::Red, p + Point::new(160., 0.), target_dummy(2000))
        .unwrap();
    for _ in 0..19 {
        field.step(&[]);
    }
    assert_eq!(field.actors[&foe].pos, p + Point::new(160., 0.));
    for _ in 0..18 {
        field.step(&[]);
    }
    assert!((field.actors[&foe].pos - field.actors[&source].pos).length() < 70.);

    let mut field = practice_field();
    let trap = field
        .spawn(Team::Blue, p, units::unit("jack_in_the_box"))
        .unwrap();
    assert!(!field
        .snapshot_for(Team::Red)
        .units
        .iter()
        .any(|u| u.id == trap));
    let foe = field
        .spawn(Team::Red, p + Point::new(80., 0.), target_dummy(1000))
        .unwrap();
    field.step(&[]);
    assert!(field.actors[&foe].has(Control::Stun));
    assert!(field
        .snapshot_for(Team::Red)
        .units
        .iter()
        .any(|u| u.id == trap));
    for _ in 0..22 {
        field.step(&[]);
    }
    assert!(!field.actors[&foe].has(Control::Stun));
    assert!(field.actors[&foe].hp < 1000);
}

#[test]
fn kayn_growth_is_locked_per_seat_and_excludes_already_deployed_units() {
    let mut g = game("kayn", 0);
    let p = Point::new(340., 820.);
    play(&mut g, "kayn", p).unwrap();
    let caster = g.players[0].active[0].unwrap().caster;
    let mut def = target_dummy(1000);
    def.range = 180.;
    let foe = g.battle.spawn(Team::Red, p, def).unwrap();
    let hit = Attack {
        rules: Some(&roster::rules()["kayn"]),
        ..Default::default()
    };
    for _ in 0..4 {
        g.battle
            .commit(vec![crate::vitals::Change::attack(caster, foe, 1, hit)]);
    }
    assert_eq!(g.battle.actors[&caster].def.key, "kayn");
    assert_eq!(
        g.battle.deployment_form("kayn", Team::Blue, 10),
        "kayn_assassin"
    );
    assert_eq!(g.battle.deployment_form("kayn", Team::Red, 10), "kayn");
    g.players[0].gold = 10;
    play(&mut g, "kayn", p).unwrap();
    let new = g.players[0].active[0].unwrap().caster;
    assert_eq!(g.battle.actors[&new].def.key, "kayn_assassin");
    assert_eq!(g.view(Team::Blue).active_cost[0], 1);
}

#[test]
fn twitch_breaks_stealth_on_attack_and_reenters_after_two_idle_seconds() {
    let mut field = practice_field();
    let p = Point::new(300., 300.);
    let source = field.spawn(Team::Blue, p, units::unit("twitch")).unwrap();
    field.commit(vec![crate::vitals::Change::new(0, source, -5)]);
    assert!(field.actors[&source].hidden_until > 0);
    let target = field
        .spawn(Team::Red, p + Point::new(60., 0.), target_dummy(1000))
        .unwrap();
    field.step(&[]);
    assert_eq!(field.actors[&source].hidden_until, 0);
    field.commit(vec![crate::vitals::Change::new(source, target, -9999)]);
    field.step(&[]); // The combat decision cancels the outstanding windup.
    assert_eq!(field.actors[&source].activity, crate::Activity::Idle);
    for _ in 0..39 {
        field.step(&[]);
    }
    assert_eq!(field.actors[&source].hidden_until, 0);
    field.step(&[]);
    assert!(field.actors[&source].hidden_until > 0);
}

#[test]
fn jayce_consumes_his_three_fast_attacks_and_sett_shield_decays() {
    let mut field = practice_field();
    let p = Point::new(300., 300.);
    let mut jayce = units::unit("jayce");
    let s = &roster::rules()["jayce"]["active_skills"][0];
    jayce.skill = Some(abilities::carried(s));
    let source = field.spawn(Team::Blue, p, jayce).unwrap();
    field
        .spawn(Team::Red, p + Point::new(70., 0.), target_dummy(5000))
        .unwrap();
    field.step(&[(
        Team::Blue,
        crate::Cast {
            caster: source,
            aim: Aim::Instant,
        },
    )]);
    assert!(field.actors[&source].rates().1 > 1000);
    for _ in 0..80 {
        field.step(&[]);
    }
    assert!(field.actors[&source].card_state.swing >= 3);
    assert_eq!(field.actors[&source].rates().1, 1000);
    let mut sett = units::unit("sett");
    sett.skill = Some(abilities::carried(
        &roster::rules()["sett"]["active_skills"][0],
    ));
    let id = field
        .spawn(Team::Blue, p + Point::new(0., 90.), sett)
        .unwrap();
    let max = roster::rules()["sett"]["skill_resource_max"]
        .as_f64()
        .unwrap();
    field
        .actors
        .get_mut(&id)
        .unwrap()
        .gain_resource(max, field.tick);
    field.step(&[(
        Team::Blue,
        crate::Cast {
            caster: id,
            aim: Aim::Instant,
        },
    )]);
    assert_eq!(field.actors[&id].shields.total(), 300);
    for _ in 0..20 {
        field.step(&[]);
    }
    assert_eq!(field.actors[&id].shields.total(), 150);
}

#[test]
fn scheduled_deploy_binds_price_and_form_before_the_tenth_tick() {
    let mut game = game("kayle", 0);
    while !game.players[0].view().hand.contains(&"kayle") {
        game.players[0].rotate(0, 0)
    }
    let hand = game.players[0].view();
    let slot = hand.hand.iter().position(|k| *k == "kayle").unwrap();
    let input = Input {
        team: Team::Blue,
        sequence: 1,
        intent: Intent::Play {
            slot: slot as u8,
            version: hand.version,
            point: Point::new(220., 820.),
        },
    };
    assert_eq!(game.schedule(3, input), Err(MatchError::Timing));
    assert_eq!(game.schedule(0, input), Ok(10));
    assert_eq!(game.schedule(0, input), Err(MatchError::Sequence));
    assert_eq!(game.players[0].gold, 10 - hand.costs[slot]);
    assert_eq!(game.players[0].version, hand.version + 1);
    for _ in 1..10 {
        game.step(&[]);
    }
    assert!(game
        .battle
        .actors
        .values()
        .all(|a| a.def.key != "kayle_ranged"));
    game.step(&[]);
    assert!(game
        .battle
        .actors
        .values()
        .any(|a| a.def.key == "kayle_ranged"));
    assert_eq!(game.take_completions(), vec![(Team::Blue, 1, Ok(()))]);
    assert_eq!(game.schedule(0, input), Err(MatchError::Timing));
}
#[test]
fn queued_skill_cancels_on_control_and_refunds_only_a_living_owner() {
    for killed in [false, true] {
        let mut g = game("scuttle_crab", 0);
        play(&mut g, "scuttle_crab", Point::new(260., 820.)).unwrap();
        for _ in 0..24 {
            g.step(&[]);
        }
        let before = g.players[0].view();
        let active = before.active[0].unwrap();
        let input = Input {
            team: Team::Blue,
            sequence: before.acknowledged + 1,
            intent: Intent::Activate {
                slot: 0,
                aim: Aim::Instant,
            },
        };
        let due = g.schedule(g.tick(), input).unwrap();
        let charged = g.players[0].gold;
        assert!(charged < before.gold);
        if killed {
            g.battle.actors.remove(&active.caster);
        } else {
            g.battle
                .control(active.caster, Control::Freeze, 30)
                .unwrap();
        }
        while g.tick() < due {
            g.step(&[]);
        }
        let completion = g.take_completions();
        assert_eq!(completion.len(), 1);
        assert!(completion[0].2.is_err());
        assert_eq!(
            g.players[0].gold,
            if killed { charged } else { before.gold }
        );
    }
}
