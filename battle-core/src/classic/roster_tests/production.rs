use super::*;

#[test]
fn scheduled_lulu_releases_two_fixed_flights_before_pix_are_born() {
    for interrupt in [
        None,
        Some(Control::Stun),
        Some(Control::Freeze),
        Some(Control::Stasis),
    ] {
        let mut g = game("lulu", 0);
        while !g.players[0].view().hand.contains(&"lulu") {
            g.players[0].rotate(0, 0);
        }
        let hand = g.players[0].view();
        let slot = hand.hand.iter().position(|k| *k == "lulu").unwrap() as u8;
        let receipt = g.step(&[Input {
            team: Team::Blue,
            sequence: 1,
            intent: Intent::Play {
                slot,
                version: hand.version,
                point: Point::new(220., 860.),
            },
        }]);
        assert_eq!(receipt, [Ok(10)]);
        while g.tick() < 10 {
            g.step(&[]);
        }
        let owner = g.players[0].active[0].unwrap().caster;
        assert_eq!(g.battle.actors[&owner].ready_tick, 30);
        while g.tick() < 29 {
            g.step(&[]);
        }
        let pix = |g: &ClassicMatch| {
            g.battle
                .actors
                .values()
                .filter(|a| a.def.key == "pix")
                .count()
        };
        assert!(g.battle.summon_flights.is_empty());
        assert_eq!(pix(&g), 0);
        if let Some(control) = interrupt {
            g.battle.control(owner, control, 320).unwrap();
            for _ in 0..290 {
                g.step(&[]);
            }
            assert!(g.battle.summon_flights.is_empty());
            // Only the single overdue batch is retained even after two missed periods.
            g.battle.remove_control(owner, control, 0).unwrap();
        } else {
            g.battle
                .displace(owner, Point::new(1., 0.), 40., 80., 0.)
                .unwrap();
        }
        g.step(&[]);
        let launch = g.tick();
        let flights = g.view(Team::Blue).field.summons;
        assert_eq!(flights.len(), 2);
        assert_eq!(pix(&g), 0);
        for (f, dx) in flights.iter().zip([-60., 60.]) {
            assert_eq!(f.start, launch);
            assert_eq!(f.arrival, launch + 5);
            assert_eq!(f.destination, f.origin + Point::new(dx, 0.));
        }
        if let Some(control) = interrupt {
            g.battle.control(owner, control, 15).unwrap();
        } else {
            g.battle.actors.get_mut(&owner).unwrap().hp = 0;
        }
        for _ in 0..4 {
            g.step(&[]);
            assert_eq!(pix(&g), 0);
        }
        g.step(&[]);
        assert_eq!(pix(&g), 2);
        assert!(g.view(Team::Blue).field.summons.is_empty());
        for (child, flight) in g
            .battle
            .actors
            .values()
            .filter(|a| a.def.key == "pix")
            .zip(flights)
        {
            assert_eq!(child.ready_tick, flight.arrival);
            // Children can take their first movement step on the arrival tick.
            assert!((child.pos - flight.destination).length() <= child.def.speed / 20. + 0.01);
        }
        if interrupt.is_some() {
            while g.tick() < launch + 139 {
                g.step(&[]);
            }
            assert!(g.battle.summon_flights.is_empty());
            g.step(&[]);
            assert_eq!(g.view(Team::Blue).field.summons.len(), 2);
        }
    }
}

#[test]
fn crab_death_shrine_uses_the_imported_heal_rate_on_every_pulse() {
    for rate in [17.5_f64, 25., 39.] {
        let mut stats = roster::rules()["scuttle_crab"].clone();
        stats["death_heal_per_second"] = rate.into();
        let def = units::from_stats("scuttle_crab", Box::leak(Box::new(stats)));
        let mut b = Battle::new(crate::Arena::classic()).unwrap();
        let owner = b.spawn(Team::Blue, Point::new(300., 820.), def).unwrap();
        let patient = b
            .spawn(Team::Blue, Point::new(340., 820.), target_dummy(1000))
            .unwrap();
        b.actors.get_mut(&patient).unwrap().hp = 500;
        b.actors.get_mut(&owner).unwrap().hp = 0;
        b.step(&[]);
        let first = b.snapshot().areas[0].next_tick;
        while b.tick < first + 19 {
            b.step(&[]);
        }
        assert_eq!(b.actors[&patient].hp, 500 + rate.floor() as i32);
        for _ in 0..20 {
            b.step(&[]);
        }
        assert_eq!(b.actors[&patient].hp, 500 + (rate * 2.).floor() as i32);
    }
}

#[test]
fn form_change_keeps_released_flights_and_discards_unreleased_wave_members() {
    let mut battle = Battle::new(crate::Arena::classic()).unwrap();
    let source = battle
        .spawn(Team::Blue, Point::new(22., 860.), units::unit("lulu"))
        .unwrap();
    battle.step(&[]);
    let released = battle.snapshot().summons;
    assert_eq!(released[0].destination.x, 9.);
    battle
        .replace_form(source, target_dummy(1000), crate::HealthOnChange::Full, 0)
        .unwrap();
    for _ in 0..5 {
        battle.step(&[]);
    }
    assert_eq!(
        battle
            .snapshot()
            .units
            .iter()
            .filter(|u| u.kind == "pix")
            .count(),
        2
    );

    let source = battle
        .spawn(Team::Blue, Point::new(320., 840.), units::unit("malzahar"))
        .unwrap();
    while !battle.snapshot().units.iter().any(|u| u.kind == "voidling") {
        battle.step(&[]);
        assert!(battle.tick < 60);
    }
    battle
        .replace_form(source, target_dummy(1000), crate::HealthOnChange::Full, 0)
        .unwrap();
    for _ in 0..30 {
        battle.step(&[]);
    }
    assert_eq!(
        battle
            .snapshot()
            .units
            .iter()
            .filter(|u| u.kind == "voidling")
            .count(),
        1
    );
}
