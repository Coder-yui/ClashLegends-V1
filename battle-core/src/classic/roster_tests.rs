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
        let cues: Vec<_> = events
            .iter()
            .filter_map(|e| match e.fact {
                Fact::Sound { source, phase, .. } if source.kind == card.key => {
                    Some((e.tick, phase))
                }
                _ => None,
            })
            .collect();
        let expected: &[&str] = match card.key {
            "mirror" | "void_summoning" | "corrosion" => &[],
            "airdrop_bear" => &["spell:cast", "spell:impact", "spell:enraged"],
            "convergent_pulse" => &["spell:cast", "spell:charge", "spell:hit"],
            "event_horizon" => &["spell:cast"],
            "explosive_cask" | "mega_inferno_bomb" | "stasis" => &["spell:cast", "spell:strike"],
            "final_spark" => &["spell:cast", "spell:middle", "spell:end"],
            "freeze" | "heal" => &["spell:cast"],
            "lightning" | "zap" => &["spell:strike"],
            "medium_lightning" => &[
                "spell:cast",
                "spell:warning",
                "spell:warning_enemy",
                "spell:strike",
                "spell:hit",
            ],
            "severing_bolt" => &["spell:launch", "spell:warning", "spell:impact"],
            "solar_flare" => &["spell:cast", "spell:impact"],
            "stellar_convergence" => &["spell:cast", "spell:hit", "spell:zone_end"],
            "tidal_wave" => &["spell:cast", "spell:launch"],
            "pool_of_reflection" => &["spell:cast", "spell:zone_end"],
            k => panic!("unclassified spell {k}"),
        };
        for &phase in expected {
            assert!(
                cues.iter().any(|(_, p)| *p == phase),
                "{} {} {cues:?}",
                card.key,
                phase
            );
        }
        if card.key == "medium_lightning" {
            let time = |phase| cues.iter().find(|(_, p)| *p == phase).unwrap().0;
            assert_eq!(time("spell:strike") - time("spell:warning_enemy"), 20);
        }
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
fn samira_blades_and_bullets_keep_their_animation_segment_and_contact_source() {
    for (distance, first_segment) in [(55., 2), (160., 0)] {
        let mut g = game("samira", 0);
        play(&mut g, "samira", Point::new(360., 980.)).unwrap();
        let caster = g.players[0].active[0].unwrap().caster;
        let a = g.battle.actors.get_mut(&caster).unwrap();
        a.ready_tick = 0;
        a.def.speed = 0.;
        let p = a.pos + a.facing * distance;
        let target = g.battle.spawn(Team::Red, p, target_dummy(10000)).unwrap();
        let mut swings = Vec::new();
        let mut blades = Vec::new();
        let mut bullets = std::collections::BTreeSet::new();
        let mut impacts = 0;
        for _ in 0..110 {
            g.step(&[]);
            for event in g.drain_events().collect::<Vec<_>>() {
                match event.fact {
                    Fact::AttackStarted(id, victim) if id == caster && victim == target => {
                        swings.push(g.battle.actors[&caster].attack.unwrap().segment);
                    }
                    Fact::Damage {
                        source,
                        target: victim,
                        contact: Some(sound),
                        ..
                    } if source == caster && victim == target => blades.push(sound.segment),
                    Fact::Fired(id, victim, shot) if id == caster && victim == target => {
                        bullets.insert(shot);
                    }
                    Fact::ProjectileHit {
                        projectile,
                        target: victim,
                        ..
                    } if victim == target && bullets.contains(&projectile) => {
                        impacts += 1;
                    }
                    _ => (),
                }
            }
        }
        assert_eq!(&swings[..2], &[first_segment, first_segment + 1]);
        if first_segment == 2 {
            assert_eq!(&blades[..2], &swings[..2]);
            assert!(bullets.is_empty());
        } else {
            assert!(blades.is_empty());
            assert!(impacts >= 2);
        }
    }
}

#[test]
fn gwen_snips_use_saved_stacks_and_confirmed_contact_on_each_slice() {
    for stacks in 0..=3 {
        for offset in [None, Some(52.), Some(0.)] {
            let mut g = game("gwen", 0);
            play(&mut g, "gwen", Point::new(360., 980.)).unwrap();
            let caster = g.players[0].active[0].unwrap().caster;
            let a = g.battle.actors.get_mut(&caster).unwrap();
            a.ready_tick = 0;
            a.def.speed = 0.;
            a.def.action = crate::Action::Idle;
            a.card_state.resource = stacks as f64;
            g.players[0].gold = 10;
            cast(&mut g).unwrap();
            let a = &g.battle.actors[&caster];
            let start = a.card_state.cast_start;
            let action = format!("active_{stacks}");
            assert_eq!(a.card_state.cast_action, action);
            assert!(a
                .audio_states(start)
                .iter()
                .any(
                    |layer| layer.family.sustain == Some(format!("{action}:sustain").as_str())
                        && !layer.looping
                ));
            if let Some(lateral) = offset {
                let right = Point::new(-a.facing.y, a.facing.x);
                let pos = a.pos + a.facing * (a.def.radius + 95.);
                let target = pos + right * lateral;
                g.battle
                    .spawn(Team::Red, target, target_dummy(3000))
                    .unwrap();
                if lateral == 0. {
                    g.battle
                        .spawn(Team::Red, pos + right * 52., target_dummy(3000))
                        .unwrap();
                }
            }
            for _ in 0..32 {
                g.step(&[]);
            }
            let hits: Vec<_> = g
                .drain_events()
                .filter_map(|e| match e.fact {
                    Fact::Sound { source, phase, .. }
                        if source.owner == caster && phase.contains(":hit_") =>
                    {
                        Some((e.tick - start, phase.to_owned()))
                    }
                    _ => None,
                })
                .collect();
            let delays: &[u64] = match stacks {
                0 => &[2, 21],
                1 => &[2, 19, 21],
                2 => &[2, 16, 19, 21],
                _ => &[2, 13, 16, 19, 21],
            };
            let expected: Vec<_> = offset
                .into_iter()
                .flat_map(|lateral| {
                    delays
                        .iter()
                        .enumerate()
                        .map(|(i, t)| {
                            let phase = if i == 0 {
                                "first"
                            } else if i + 1 == delays.len() {
                                "last"
                            } else {
                                "middle"
                            };
                            (
                                *t,
                                format!(
                                    "{action}:hit_{phase}{}",
                                    if lateral == 0. { "_center" } else { "" }
                                ),
                            )
                        })
                        .collect::<Vec<_>>()
                })
                .collect();
            assert_eq!(hits, expected, "stacks={stacks}, offset={offset:?}");
        }
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
fn walking_preserves_attack_intervals_except_on_configured_swings() {
    // Ticks from one release to the next, including the time spent chasing.
    for (key, swing, chase_ticks, expected) in [
        ("darius", 1, 1, 24),
        ("darius", 1, 25, 30), // The interval elapsed while walking. Only windup remains.
        ("ashe", 1, 1, 20),
        ("sett", 1, 1, 12),
        ("sett", 2, 0, 28),
        ("sett", 2, 1, 7),
        ("graves", 1, 1, 4),
        ("tryndamere", 1, 13, 34),
        ("tryndamere", 1, 14, 30),
    ] {
        let mut field = practice_field();
        let p = Point::new(300., 300.);
        let def = units::unit(key);
        let reach = def.radius + def.range + target_dummy(5000).radius;
        let source = field.spawn(Team::Blue, p, def).unwrap();
        let close = p + Point::new(50., 0.);
        let target = field.spawn(Team::Red, close, target_dummy(5000)).unwrap();
        while field.actors[&source].card_state.swing < swing {
            field.step(&[]);
            assert!(field.tick < 100, "{key} failed to attack");
        }
        let released = field.tick;
        for _ in 0..chase_ticks {
            let before = field.actors[&source].pos;
            field.actors.get_mut(&target).unwrap().pos = before + Point::new(reach + 20., 0.);
            field.step(&[]);
            assert_ne!(field.actors[&source].pos, before, "{key} failed to chase");
        }
        field.actors.get_mut(&target).unwrap().pos =
            field.actors[&source].pos + Point::new(50., 0.);
        while field.actors[&source].card_state.swing == swing {
            field.step(&[]);
            assert!(
                field.tick - released <= expected,
                "{key} swing {swing} was late"
            );
        }
        assert_eq!(
            field.tick - released,
            expected,
            "{key} swing {swing}, {chase_ticks} chase ticks"
        );
    }
}

#[test]
fn forced_movement_counts_toward_the_existing_attack_interval() {
    let mut field = practice_field();
    let p = Point::new(300., 300.);
    let source = field.spawn(Team::Blue, p, units::unit("darius")).unwrap();
    field
        .spawn(Team::Red, p + Point::new(50., 0.), target_dummy(5000))
        .unwrap();
    for _ in 0..7 {
        field.step(&[]);
    }
    assert_eq!(field.actors[&source].card_state.swing, 1);
    field
        .displace(source, Point::new(0., 1.), 10., 40., 0.)
        .unwrap();
    for _ in 0..23 {
        field.step(&[]);
    }
    assert_ne!(field.actors[&source].pos, p);
    assert_eq!(field.actors[&source].card_state.swing, 1);
    field.step(&[]);
    assert_eq!(field.actors[&source].card_state.swing, 2);
}

#[test]
fn losing_a_target_and_reacquiring_without_walking_preserves_setts_interval() {
    let mut field = practice_field();
    let p = Point::new(300., 300.);
    let source = field.spawn(Team::Blue, p, units::unit("sett")).unwrap();
    let close = p + Point::new(50., 0.);
    let target = field.spawn(Team::Red, close, target_dummy(5000)).unwrap();
    for _ in 0..18 {
        field.step(&[]);
    }
    assert_eq!(field.actors[&source].card_state.swing, 2);
    field.actors.get_mut(&target).unwrap().pos = Point::new(900., 900.);
    field.step(&[]);
    assert_eq!(field.actors[&source].activity, crate::Activity::Idle);
    field.actors.get_mut(&target).unwrap().pos = close;
    for _ in 0..26 {
        field.step(&[]);
    }
    assert_eq!(field.actors[&source].card_state.swing, 2);
    field.step(&[]);
    assert_eq!(field.actors[&source].card_state.swing, 3);
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

mod production;

#[test]
fn minion_attack_events_are_identical_for_both_teams() {
    for def in [
        UnitDef::melee(),
        UnitDef::ranged(),
        UnitDef::siege(),
        UnitDef::super_minion(),
    ] {
        let trace = |team: Team| {
            let mut field = practice_field();
            field.classic_attack_nodes = true;
            let p = Point::new(300., 300.);
            let attacker = field.spawn(team, p, def.clone()).unwrap();
            field
                .spawn(team.enemy(), p + Point::new(45., 0.), target_dummy(5000))
                .unwrap();
            let mut events = Vec::new();
            let mut windups = Vec::new();
            for tick in 1..=120 {
                if tick == 3 || tick == 40 {
                    field.actors.get_mut(&attacker).unwrap().empowerment =
                        Some(crate::status::Empowerment {
                            movement: 1000,
                            attack: if tick == 3 { 500 } else { 1800 },
                            damage: 1000,
                            until: 90,
                        });
                }
                field.step(&[]);
                for event in field.drain_events() {
                    let label = match event.fact {
                        Fact::AttackStarted(..) => "start",
                        Fact::AttackReleased { .. } => "release",
                        Fact::Fired(..) => "projectile",
                        Fact::Damage { .. } => "damage",
                        _ => continue,
                    };
                    events.push((tick, label));
                }
                if let Some(attack) = field.actors[&attacker].attack {
                    if attack.start == tick {
                        // Check the full precision clock as well as rounded tick events.
                        windups.push((attack.segment, attack.windup_units));
                    }
                }
            }
            (events, windups)
        };
        let blue = trace(Team::Blue);
        assert!(
            blue.0.iter().filter(|(_, e)| *e == "damage").count() >= 3,
            "{}",
            def.key
        );
        assert!(blue.1.len() >= 3, "{}", def.key);
        assert_eq!(
            blue.0.iter().any(|(_, e)| *e == "projectile"),
            matches!(def.action, crate::Action::Shot { .. })
        );
        assert_eq!(blue, trace(Team::Red), "{}", def.key);
    }
}

#[test]
fn sword_release_tracks_the_selected_clip_and_speed_changes_during_windup() {
    let mut field = practice_field();
    let p = Point::new(300., 300.);
    let sword = field.spawn(Team::Blue, p, units::unit("aatrox")).unwrap();
    field
        .spawn(Team::Red, p + Point::new(30., 0.), target_dummy(5000))
        .unwrap();
    let mut releases = Vec::new();
    while releases.len() < 4 {
        field.step(&[]);
        for event in field.drain_events().collect::<Vec<_>>() {
            if matches!(event.fact, crate::Fact::AttackReleased { source, .. } if source == sword) {
                let t = field.actors[&sword].attack.unwrap();
                releases.push((event.tick, t.segment, t.windup_units));
            }
        }
        assert!(field.tick < 90);
    }
    assert_eq!(
        releases.iter().map(|r| r.1).collect::<Vec<_>>(),
        [0, 1, 2, 3]
    );
    assert!(releases[0].2 > releases[1].2 && releases[1].2 > releases[2].2);
    assert!(releases[3].2 > releases[0].2);
    for pair in releases.windows(2) {
        assert_eq!(pair[1].0 - pair[0].0, 22);
    }

    for (rate, expected_delta) in [(500, 12), (2000, 3)] {
        let mut field = practice_field();
        let sword = field.spawn(Team::Blue, p, units::unit("aatrox")).unwrap();
        field.actors.get_mut(&sword).unwrap().card_state.swing = 3;
        field
            .spawn(Team::Red, p + Point::new(30., 0.), target_dummy(5000))
            .unwrap();
        for _ in 0..3 {
            field.step(&[]);
        }
        let before = field.actors[&sword].attack.unwrap();
        field.actors.get_mut(&sword).unwrap().empowerment = Some(crate::status::Empowerment {
            movement: 1000,
            attack: rate,
            damage: 1000,
            until: 100,
        });
        let mut progress = before.progress;
        let from = field.tick;
        loop {
            field.step(&[]);
            let t = field.actors[&sword].attack.unwrap();
            assert_eq!((t.start, t.segment), (before.start, 3));
            assert!(t.progress >= progress);
            progress = t.progress;
            if t.released {
                break;
            }
            assert!(field.tick - from <= expected_delta);
        }
        assert_eq!(field.tick - from, expected_delta);
        assert_eq!(progress, 1000);
    }
}
