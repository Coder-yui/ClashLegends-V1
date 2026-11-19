use clash_battle_core::*;
fn p(x: f64, y: f64) -> Point {
    Point::new(x, y)
}
fn world() -> Battle {
    Battle::new(Arena::classic()).unwrap()
}
fn inert() -> UnitDef {
    UnitDef {
        action: Action::Idle,
        speed: 0.,
        ..UnitDef::melee()
    }
}
fn building(role: Role) -> UnitDef {
    UnitDef { role, ..inert() }
}
fn view(b: &Battle, id: Id) -> UnitView {
    b.snapshot().units.into_iter().find(|u| u.id == id).unwrap()
}
fn steps(b: &mut Battle, n: usize) {
    for _ in 0..n {
        b.step(&[])
    }
}
fn aimed(aim: AimKind, effect: Effect) -> UnitDef {
    UnitDef {
        skill: Some(Skill {
            aim,
            cast_range: 200.,
            shape: Shape::Strip {
                length: 80.,
                half_width: 8.,
            },
            effects: vec![effect],
            cooldown: 10,
        }),
        ..inert()
    }
}
fn input(id: Id, aim: Aim) -> (Team, Cast) {
    (Team::Blue, Cast { caster: id, aim })
}
#[test]
fn sight_is_independent_and_surface_inclusive() {
    for (gap, expected) in [(179.9, true), (180., true), (180.01, false)] {
        let mut b = world();
        let actor = b
            .spawn(Team::Blue, p(150., 900.), UnitDef::melee())
            .unwrap();
        let troop = b
            .spawn(Team::Red, p(150. + 24. + gap, 900.), inert())
            .unwrap();
        let lane = b
            .spawn(Team::Red, p(140., 120.), building(Role::LaneTower))
            .unwrap();
        b.spawn(Team::Red, p(580., 145.), building(Role::LaneTower))
            .unwrap();
        b.step(&[]);
        let u = view(&b, actor);
        assert_eq!(
            (u.target, u.activity),
            if expected {
                (Some(troop), Activity::Chase)
            } else {
                (Some(lane), Activity::March)
            }
        );
    }
}
#[test]
fn eligibility_and_ties_are_stable() {
    let mut b = world();
    let a = b
        .spawn(Team::Blue, p(160., 300.), UnitDef::melee())
        .unwrap();
    b.spawn(
        Team::Red,
        p(160., 330.),
        UnitDef {
            layer: Layer::Air,
            ..inert()
        },
    )
    .unwrap();
    let first = b.spawn(Team::Red, p(100., 300.), inert()).unwrap();
    b.spawn(Team::Red, p(220., 300.), inert()).unwrap();
    b.step(&[]);
    assert_eq!(view(&b, a).target, Some(first));
    let mut b = world();
    let a = b
        .spawn(Team::Blue, p(160., 300.), UnitDef::ranged())
        .unwrap();
    let air = b
        .spawn(
            Team::Red,
            p(160., 330.),
            UnitDef {
                layer: Layer::Air,
                ..inert()
            },
        )
        .unwrap();
    b.step(&[]);
    assert_eq!(view(&b, a).target, Some(air));
}
#[test]
fn crossing_river_requires_a_usable_bridge() {
    let mut b = world();
    let id = b
        .spawn(Team::Blue, p(260., 770.), UnitDef::melee())
        .unwrap();
    let tower = b
        .spawn(Team::Red, p(260., 480.), building(Role::LaneTower))
        .unwrap();
    let mut crossed = false;
    for _ in 0..220 {
        b.step(&[]);
        let u = view(&b, id);
        if u.position.y >= 600. && u.position.y <= 680. {
            assert!((92.0..188.0).contains(&u.position.x));
            crossed = true;
        }
        if b.snapshot().units.iter().all(|u| u.id != tower) {
            break;
        }
    }
    assert!(crossed);
    assert!(b.snapshot().units.iter().all(|u| u.id != tower));
    assert_eq!(
        b.spawn(Team::Blue, p(300., 640.), inert()),
        Err(Error::InvalidPoint)
    );
    assert!(b
        .spawn(
            Team::Blue,
            p(300., 640.),
            UnitDef {
                layer: Layer::Air,
                ..inert()
            }
        )
        .is_ok());
}
#[test]
fn custom_map_routes_around_its_own_obstacles() {
    let map = Arena {
        width: 320.,
        height: 240.,
        ground_obstacles: vec![Rect {
            min: p(120., 60.),
            max: p(155., 180.),
        }],
    };
    let mut b = Battle::new(map).unwrap();
    let a = b.spawn(Team::Blue, p(50., 120.), UnitDef::melee()).unwrap();
    let target = b
        .spawn(Team::Red, p(240., 120.), building(Role::Nexus))
        .unwrap();
    steps(&mut b, 160);
    assert!(view(&b, a).position.x > 155.);
    assert!(b
        .snapshot()
        .units
        .iter()
        .all(|u| u.id != target || u.hp < 210));
}
#[test]
fn river_crab_ignores_troops_and_mends_30_per_second() {
    let mut b = world();
    let crab = b.spawn(Team::Blue, p(150., 300.), UnitDef::crab()).unwrap();
    let mut enemy = aimed(AimKind::Instant, Effect::Damage(100));
    enemy.skill.as_mut().unwrap().shape = Shape::Circle { radius: 100. };
    let mage = b.spawn(Team::Red, p(150., 340.), enemy).unwrap();
    let structure = b
        .spawn(Team::Red, p(205., 300.), building(Role::Building))
        .unwrap();
    b.step(&[(
        Team::Red,
        Cast {
            caster: mage,
            aim: Aim::Instant,
        },
    )]);
    steps(&mut b, 19);
    assert_eq!(
        (
            view(&b, crab).hp,
            view(&b, crab).target,
            view(&b, crab).activity
        ),
        (480, Some(structure), Activity::Mending)
    );
    assert_eq!(view(&b, structure).hp, 210);
    b.control(crab, Control::Stun, 3).unwrap();
    steps(&mut b, 3);
    assert_eq!(view(&b, crab).hp, 480);
    b.step(&[]);
    assert_eq!(view(&b, crab).hp, 481);
}
#[test]
fn cast_validates_point_and_direction_before_spending() {
    let mut b = world();
    let mage = b
        .spawn(
            Team::Blue,
            p(100., 200.),
            aimed(AimKind::PointAndDirection, Effect::Damage(50)),
        )
        .unwrap();
    let front = b.spawn(Team::Red, p(255., 200.), inert()).unwrap();
    let behind = b.spawn(Team::Red, p(167., 200.), inert()).unwrap();
    let cmd = |origin, direction| input(mage, Aim::PointAndDirection { origin, direction });
    let good = cmd(p(200., 200.), p(8., 0.));
    let mut foreign = good;
    foreign.0 = Team::Red;
    b.step(&[
        foreign,
        input(mage, Aim::Instant),
        cmd(p(400., 200.), p(1., 0.)),
        cmd(p(f64::NAN, 200.), p(1., 0.)),
        cmd(p(200., 200.), p(0., 0.)),
        good,
        good,
    ]);
    let rejected: Vec<_> = b
        .drain_events()
        .filter_map(|e| {
            if let Fact::Rejected { reason, .. } = e.fact {
                Some(reason)
            } else {
                None
            }
        })
        .collect();
    assert_eq!(
        rejected,
        [
            Error::Ownership,
            Error::WrongAim,
            Error::InvalidPoint,
            Error::InvalidPoint,
            Error::InvalidDirection,
            Error::Cooldown
        ]
    );
    assert_eq!(view(&b, front).hp, 160);
    assert_eq!(view(&b, behind).hp, 210);
}
#[test]
fn direction_cast_applies_force_and_invalid_replacement_is_atomic() {
    let mut b = world();
    let mage = b
        .spawn(
            Team::Blue,
            p(300., 510.),
            aimed(
                AimKind::Direction,
                Effect::Push {
                    distance: 120.,
                    speed: 400.,
                    extension: 80.,
                },
            ),
        )
        .unwrap();
    let troop = b.spawn(Team::Red, p(300., 540.), inert()).unwrap();
    b.control(troop, Control::Root, 30).unwrap();
    b.step(&[input(mage, Aim::Direction(p(0., 2.)))]);
    assert!(view(&b, troop).position.y > 540.);
    assert_eq!(
        b.displace(troop, p(0., 0.), 100., 200., 0.),
        Err(Error::InvalidDirection)
    );
    steps(&mut b, 9);
    let dest = view(&b, troop);
    assert!(dest.position.y > 692. && dest.position.y < 693.);
    assert_ne!(dest.activity, Activity::Displaced);
}
#[test]
fn interrupted_flight_recovers_to_legal_bank_without_completing() {
    let mut b = world();
    let id = b.spawn(Team::Blue, p(300., 540.), inert()).unwrap();
    b.displace(id, p(0., 1.), 180., 400., 0.).unwrap();
    steps(&mut b, 5);
    assert_eq!(view(&b, id).position, p(300., 640.));
    b.control(id, Control::Stasis, 3).unwrap();
    let restored = view(&b, id).position;
    assert!(restored.y < 588. && restored.y > 587.);
    steps(&mut b, 20);
    assert_eq!(view(&b, id).position, restored);
    assert!(!b.drain_events().any(|e| matches!(e.fact, Fact::Landed(..))));
}
#[test]
fn landing_is_revalidated_when_new_building_appears() {
    let mut b = world();
    let id = b.spawn(Team::Blue, p(100., 200.), inert()).unwrap();
    b.displace(id, p(1., 0.), 120., 240., 0.).unwrap();
    steps(&mut b, 3);
    b.spawn(Team::Red, p(220., 200.), building(Role::Building))
        .unwrap();
    steps(&mut b, 12);
    let landed = view(&b, id);
    assert!((landed.position - p(220., 200.)).length() >= 25.5);
    assert!(b
        .drain_events()
        .any(|e| matches!(e.fact,Fact::Landed(i,_) if i==id)));
}
#[test]
fn shortening_preserves_lock_and_immobile_cannot_be_pushed() {
    let mut b = world();
    let a = b.spawn(Team::Blue, p(300., 580.), inert()).unwrap();
    let end = b.displace(a, p(0., 1.), 40., 200., 0.).unwrap();
    assert!(end.y > 587. && end.y < 588.);
    steps(&mut b, 3);
    assert_eq!(view(&b, a).activity, Activity::Displaced);
    b.step(&[]);
    assert_eq!(view(&b, a).activity, Activity::Idle);
    b.control(a, Control::Stasis, 2).unwrap();
    assert_eq!(
        b.displace(a, p(1., 0.), 10., 20., 0.),
        Err(Error::Controlled)
    );
    assert!(b.spawn(Team::Blue, end, inert()).is_err());
}
#[test]
fn contact_respects_mass_and_layer() {
    let mut b = world();
    let a = b.spawn(Team::Blue, p(100., 200.), inert()).unwrap();
    let heavy = b
        .spawn(
            Team::Blue,
            p(110., 200.),
            UnitDef {
                mass: 8.,
                ..inert()
            },
        )
        .unwrap();
    let air = b
        .spawn(
            Team::Blue,
            p(100., 200.),
            UnitDef {
                layer: Layer::Air,
                ..inert()
            },
        )
        .unwrap();
    b.step(&[]);
    assert!(100. - view(&b, a).position.x > view(&b, heavy).position.x - 110.);
    assert_eq!(view(&b, air).position, p(100., 200.));
}
#[test]
fn spells_and_attacks_obey_distinct_permissions() {
    let mut b = world();
    let mut def = UnitDef::melee();
    def.skill = aimed(
        AimKind::Point,
        Effect::Control {
            kind: Control::Freeze,
            ticks: 2,
        },
    )
    .skill;
    let a = b.spawn(Team::Blue, p(140., 200.), def).unwrap();
    let t = b.spawn(Team::Red, p(180., 200.), inert()).unwrap();
    b.control(a, Control::Silence, 1).unwrap();
    b.control(a, Control::Root, 10).unwrap();
    let cast = input(a, Aim::Point(p(180., 200.)));
    b.step(&[cast]);
    assert_eq!(view(&b, a).activity, Activity::Windup);
    assert!(b.drain_events().any(|e| matches!(
        e.fact,
        Fact::Rejected {
            reason: Error::Controlled,
            ..
        }
    )));
    b.step(&[cast]);
    assert!(view(&b, t).controls.contains(&Control::Freeze));
    steps(&mut b, 2);
    assert!(view(&b, t).controls.is_empty());
    steps(&mut b, 3);
    assert_eq!(view(&b, t).hp, 168);
}
#[test]
fn windup_release_has_twenty_units_of_grace() {
    for (extra, damage) in [(20., 42), (20.1, 0)] {
        let mut b = world();
        let a = b
            .spawn(Team::Blue, p(100., 200.), UnitDef::melee())
            .unwrap();
        let t = b.spawn(Team::Red, p(156., 200.), inert()).unwrap();
        b.step(&[]);
        b.displace(t, p(1., 0.), extra, 500., 0.).unwrap();
        steps(&mut b, 6);
        assert_eq!(view(&b, t).hp, 210 - damage);
        if damage == 0 {
            assert_eq!(view(&b, a).activity, Activity::Chase)
        }
    }
}
#[test]
fn projectile_outlives_shooter_and_units_can_trade_kills() {
    let mut b = world();
    let shooter = b
        .spawn(Team::Blue, p(100., 200.), UnitDef::ranged())
        .unwrap();
    let t = b
        .spawn(
            Team::Red,
            p(256., 200.),
            aimed(AimKind::Point, Effect::Damage(500)),
        )
        .unwrap();
    steps(&mut b, 9);
    assert_eq!(b.snapshot().projectiles.len(), 1);
    assert_eq!(view(&b, t).hp, 210);
    b.step(&[(
        Team::Red,
        Cast {
            caster: t,
            aim: Aim::Point(p(100., 200.)),
        },
    )]);
    assert!(b.snapshot().units.iter().all(|u| u.id != shooter));
    steps(&mut b, 12);
    assert_eq!(view(&b, t).hp, 178);
    let mut b = world();
    for (team, x) in [(Team::Blue, 100.), (Team::Red, 140.)] {
        b.spawn(
            team,
            p(x, 200.),
            UnitDef {
                hp: 42,
                ..UnitDef::melee()
            },
        )
        .unwrap();
    }
    steps(&mut b, 7);
    assert!(b.snapshot().units.is_empty());
}
#[test]
fn independent_worlds_replay_each_tick_and_event() {
    let create = || {
        let mut b = world();
        b.spawn(Team::Blue, p(360., 740.), UnitDef::ranged())
            .unwrap();
        b.spawn(Team::Red, p(340., 540.), UnitDef::melee()).unwrap();
        b
    };
    let mut first = create();
    let mut second = create();
    for _ in 0..220 {
        first.step(&[]);
        second.step(&[]);
        assert_eq!(first.snapshot(), second.snapshot());
        assert!(first.drain_events().eq(second.drain_events()));
    }
}
#[test]
fn crab_slow_scales_beam_damage_and_expires_independently() {
    let mut b = world();
    let crab = b.spawn(Team::Blue, p(180., 200.), UnitDef::crab()).unwrap();
    let dragon = b
        .spawn(Team::Red, p(260., 200.), UnitDef::dragon())
        .unwrap();
    b.step(&[input(crab, Aim::Instant)]);
    steps(&mut b, 19);
    assert_eq!(view(&b, crab).hp, 550 - 49);
    assert_eq!(view(&b, dragon).attack_rate, 700);
    b.control(dragon, Control::Freeze, 3).unwrap();
    steps(&mut b, 3);
    assert_eq!(view(&b, crab).hp, 501);
    steps(&mut b, 38);
    assert_eq!(view(&b, dragon).attack_rate, 1000);
}
#[test]
fn slow_changes_walking_and_attack_clock_but_not_force() {
    let mut b = world();
    let crab = b.spawn(Team::Blue, p(100., 200.), UnitDef::crab()).unwrap();
    let melee = b.spawn(Team::Red, p(220., 200.), UnitDef::melee()).unwrap();
    b.step(&[input(crab, Aim::Instant)]);
    assert!((view(&b, melee).position.x - 218.2).abs() < 1e-8);
    b.displace(melee, p(0., 1.), 40., 200., 0.).unwrap();
    b.step(&[]);
    assert_eq!(view(&b, melee).position.y, 210.);
    let mut b = world();
    let crab = b.spawn(Team::Blue, p(100., 200.), UnitDef::crab()).unwrap();
    b.spawn(Team::Red, p(150., 200.), UnitDef::melee()).unwrap();
    b.step(&[input(crab, Aim::Instant)]);
    steps(&mut b, 8);
    assert_eq!(view(&b, crab).hp, 550);
    b.step(&[]);
    assert_eq!(view(&b, crab).hp, 508);
}
#[test]
fn one_cast_composes_damage_and_control_in_declared_order() {
    let mut b = world();
    let mut mage = aimed(AimKind::Point, Effect::Damage(35));
    mage.skill.as_mut().unwrap().effects.push(Effect::Control {
        kind: Control::Stasis,
        ticks: 5,
    });
    let id = b.spawn(Team::Blue, p(100., 200.), mage).unwrap();
    let target = b.spawn(Team::Red, p(160., 200.), inert()).unwrap();
    b.step(&[input(id, Aim::Point(p(160., 200.)))]);
    assert_eq!(view(&b, target).hp, 175);
    assert!(view(&b, target).controls.contains(&Control::Stasis));
}
#[test]
fn losing_sight_returns_to_the_surviving_lane_objective() {
    let mut b = world();
    let a = b
        .spawn(Team::Blue, p(120., 900.), UnitDef::melee())
        .unwrap();
    let t = b.spawn(Team::Red, p(260., 900.), inert()).unwrap();
    let same = b
        .spawn(Team::Red, p(140., 110.), building(Role::LaneTower))
        .unwrap();
    b.spawn(Team::Red, p(580., 110.), building(Role::LaneTower))
        .unwrap();
    b.spawn(Team::Red, p(360., 60.), building(Role::Nexus))
        .unwrap();
    b.step(&[]);
    assert_eq!(view(&b, a).target, Some(t));
    b.displace(t, p(1., 0.), 150., 3000., 0.).unwrap();
    steps(&mut b, 2);
    assert_eq!(view(&b, a).target, Some(same));
    assert_eq!(view(&b, a).activity, Activity::March);
}
#[test]
fn lock_survives_closer_enemy_and_windup_transfers_on_invalid_target() {
    let mut b = world();
    let a = b
        .spawn(Team::Blue, p(110., 200.), UnitDef::melee())
        .unwrap();
    let first = b.spawn(Team::Red, p(160., 200.), inert()).unwrap();
    b.step(&[]);
    let closer = b.spawn(Team::Red, p(110., 230.), inert()).unwrap();
    b.step(&[]);
    assert_eq!(view(&b, a).target, Some(first));
    b.control(first, Control::Stasis, 10).unwrap();
    steps(&mut b, 5);
    assert_eq!(view(&b, a).target, Some(closer));
    assert_eq!(view(&b, closer).hp, 168);
}

#[test]
fn swing_timeline_cancels_and_resumes_at_the_actual_release_tick() {
    let mut b = world();
    let source = b
        .spawn(Team::Blue, p(100., 200.), UnitDef::ranged())
        .unwrap();
    b.spawn(Team::Red, p(220., 200.), inert()).unwrap();
    b.step(&[]);
    let cancelled = view(&b, source).attack.unwrap();
    b.control(source, Control::Freeze, 2).unwrap();
    assert!(view(&b, source).attack.is_none());
    // First swing was interrupted. This new start owns the first real shot.
    let mut released = None;
    for _ in 0..40 {
        b.step(&[]);
        let timing = view(&b, source).attack;
        for e in b.drain_events() {
            if let Fact::AttackReleased {
                source: id, start, ..
            } = e.fact
            {
                if id != source {
                    continue;
                }
                let timing = timing.unwrap();
                assert!(timing.released);
                assert_eq!(e.tick, timing.release);
                assert_eq!(start, timing.start);
                assert_ne!(start, cancelled.start);
                released = Some(timing);
            }
        }
        if released.is_some() {
            break;
        }
    }
    let first = released.unwrap();
    while b.snapshot().tick < first.end {
        b.step(&[]);
    }
    let second = view(&b, source).attack.unwrap();
    assert_eq!((second.start, second.cycle), (first.end, first.cycle + 1));
}
