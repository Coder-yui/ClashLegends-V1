use clash_battle_core::*;
fn p(x: f64, y: f64) -> Point {
    Point::new(x, y)
}
fn world() -> Battle {
    Battle::new(Arena::classic()).unwrap()
}
fn idle() -> UnitDef {
    UnitDef {
        action: Action::Idle,
        speed: 0.,
        ..UnitDef::melee()
    }
}
fn caster(effects: Vec<Effect>) -> UnitDef {
    UnitDef {
        skill: Some(Skill {
            aim: AimKind::Point,
            cast_range: 600.,
            shape: Shape::Circle { radius: 35. },
            effects,
            cooldown: 1,
        }),
        ..idle()
    }
}
fn cmd(team: Team, id: Id, pos: Point) -> (Team, Cast) {
    (
        team,
        Cast {
            caster: id,
            aim: Aim::Point(pos),
        },
    )
}
fn unit(b: &Battle, id: Id) -> UnitView {
    b.snapshot().units.into_iter().find(|u| u.id == id).unwrap()
}
fn wait(b: &mut Battle, ticks: u32) {
    for _ in 0..ticks {
        b.step(&[])
    }
}
#[test]
fn knockback_mass_continuous_collision_and_wall_lock() {
    let mut b = world();
    let light = b.spawn(Team::Blue, p(180., 400.), idle()).unwrap();
    let heavy = b
        .spawn(Team::Blue, p(180., 480.), UnitDef { mass: 8., ..idle() })
        .unwrap();
    let knock = Motion::Knockback {
        distance: 100.,
        ticks: 4,
        mass_cap: 1.4,
    };
    for (id, y) in [(light, 400.), (heavy, 480.)] {
        b.motion(id, p(100., y), p(1., 0.), knock).unwrap();
    }
    wait(&mut b, 4);
    assert_eq!(unit(&b, light).position.x, 320.);
    assert_eq!(unit(&b, heavy).position.x, 230.);
    let other = b.spawn(Team::Blue, p(380., 400.), idle()).unwrap();
    b.motion(
        light,
        p(100., 400.),
        p(1., 0.),
        Motion::Knockback {
            distance: 360.,
            ticks: 1,
            mass_cap: 1.4,
        },
    )
    .unwrap();
    wait(&mut b, 1);
    assert!(unit(&b, light).position.x <= unit(&b, other).position.x - 23.);
    let wall = b.spawn(Team::Red, p(290., 575.), idle()).unwrap();
    b.motion(wall, p(290., 520.), p(0., 1.), knock).unwrap();
    wait(&mut b, 2);
    let u = unit(&b, wall);
    assert!(u.position.y <= 588.);
    assert_eq!(u.activity, Activity::Displaced);
    wait(&mut b, 2);
    assert_eq!(unit(&b, wall).activity, Activity::Idle);
}
#[test]
fn dash_freeze_blink_root_and_pull_preference() {
    let mut b = world();
    let id = b.spawn(Team::Blue, p(300., 560.), idle()).unwrap();
    b.motion(
        id,
        p(300., 560.),
        p(0., 1.),
        Motion::Dash {
            distance: 180.,
            speed: 500.,
            extension: 0.,
        },
    )
    .unwrap();
    wait(&mut b, 3);
    assert!((600.0..680.).contains(&unit(&b, id).position.y));
    b.control(id, Control::Root, 4).unwrap();
    let stopped = unit(&b, id).position;
    assert!(stopped.y < 588. || stopped.y > 692.);
    assert_eq!(
        b.motion(
            id,
            stopped,
            p(0., 1.),
            Motion::Blink {
                distance: 180.,
                extension: 0.
            }
        ),
        Err(Error::Controlled)
    );
    let end = b
        .motion(
            id,
            p(170., 300.),
            p(1., 0.),
            Motion::Pull {
                offset: 40.,
                search_radius: 60.,
                speed: 2000.,
            },
        )
        .unwrap();
    assert!((end - p(210., 300.)).length() < 1e-9);
    wait(&mut b, 10);
    assert_eq!(unit(&b, id).position, end);
    assert_eq!(
        b.motion(
            id,
            end,
            p(1., 0.),
            Motion::Blink {
                distance: 100.,
                extension: 0.
            }
        )
        .unwrap(),
        end + p(100., 0.)
    );
}
#[test]
fn effects_have_independent_and_owned_lifetimes() {
    for (anchor, control, expected) in [
        (AreaAnchor::Independent, Control::Freeze, 150),
        (AreaAnchor::CastPoint, Control::Freeze, 210),
        (AreaAnchor::Caster, Control::Stun, 150),
    ] {
        let mut b = world();
        let area = TimedArea {
            delay: 2,
            period: 2,
            pulses: 2,
            anchor,
            shape: Shape::Circle { radius: 70. },
            effects: &[Effect::Damage(30)],
        };
        let a = b
            .spawn(Team::Blue, p(100., 200.), caster(vec![Effect::Area(area)]))
            .unwrap();
        let t = b.spawn(Team::Red, p(140., 200.), idle()).unwrap();
        b.step(&[cmd(Team::Blue, a, p(140., 200.))]);
        b.control(a, control, 7).unwrap();
        wait(&mut b, 5);
        assert_eq!(unit(&b, t).hp, expected);
        assert!(b.snapshot().areas.is_empty());
    }
}
#[test]
fn shield_absorbs_before_drain_and_drain_does_not_add_late_targets() {
    let mut b = world();
    let f = b
        .spawn(Team::Blue, p(200., 200.), UnitDef::fiddlesticks())
        .unwrap();
    let t = b
        .spawn(
            Team::Red,
            p(290., 200.),
            caster(vec![Effect::Shield {
                amount: 6,
                ticks: 40,
            }]),
        )
        .unwrap();
    let mage = b
        .spawn(Team::Red, p(600., 400.), caster(vec![Effect::Damage(100)]))
        .unwrap();
    b.step(&[
        cmd(Team::Red, t, p(290., 200.)),
        cmd(Team::Red, mage, p(200., 200.)),
    ]);
    assert_eq!(unit(&b, f).hp, 1100);
    let late = b.spawn(Team::Red, p(300., 270.), idle()).unwrap();
    wait(&mut b, 3);
    assert_eq!(
        (unit(&b, t).hp, unit(&b, f).hp, unit(&b, late).hp),
        (204, 1103, 210)
    );
    assert!(b.drain_events().any(|e| matches!(
        e.fact,
        Fact::Damage {
            absorbed: 3,
            lost: 0,
            ..
        }
    )));
    wait(&mut b, 51);
    assert_eq!(unit(&b, late).hp, 210);
    wait(&mut b, 1);
    assert!(unit(&b, late).hp < 210);
}
#[test]
fn egg_can_be_killed_or_hatch_once() {
    for hatch in [false, true] {
        let mut b = world();
        let bird = b
            .spawn(Team::Blue, p(120., 200.), UnitDef::phoenix())
            .unwrap();
        let killer = b
            .spawn(Team::Red, p(300., 200.), caster(vec![Effect::Damage(9999)]))
            .unwrap();
        b.step(&[cmd(Team::Red, killer, p(120., 200.))]);
        assert_eq!(unit(&b, bird).kind, "anivia_egg");
        if hatch {
            wait(&mut b, 60);
            assert_eq!((unit(&b, bird).kind, unit(&b, bird).hp), ("anivia", 620));
        }
        b.step(&[cmd(Team::Red, killer, unit(&b, bird).position)]);
        assert!(b.snapshot().units.iter().all(|u| u.id != bird));
        wait(&mut b, 65);
        assert!(b.snapshot().units.iter().all(|u| u.id != bird));
    }
}
#[test]
fn gun_consumes_one_round_per_spread_and_blind_suppresses_whole_shot() {
    let mut b = world();
    let gun = b
        .spawn(Team::Blue, p(100., 200.), UnitDef::gunslinger())
        .unwrap();
    let enemy = b
        .spawn(
            Team::Red,
            p(250., 200.),
            caster(vec![Effect::Blind { charges: 1 }]),
        )
        .unwrap();
    b.step(&[cmd(Team::Red, enemy, p(100., 200.))]);
    wait(&mut b, 2);
    assert_eq!(unit(&b, gun).rounds, 1);
    assert!(b.snapshot().projectiles.is_empty());
    wait(&mut b, 18);
    assert_eq!(unit(&b, gun).rounds, 0);
    assert_eq!(b.snapshot().projectiles.len(), 6);
    b.control(gun, Control::Freeze, 4).unwrap();
    wait(&mut b, 4);
    assert_eq!(unit(&b, gun).reload_left, 40);
    wait(&mut b, 40);
    assert_eq!(unit(&b, gun).rounds, 2);
}
#[test]
fn sourced_control_taunt_and_hidden_projection() {
    let mut b = world();
    let a = b
        .spawn(Team::Blue, p(120., 200.), UnitDef::melee())
        .unwrap();
    let near = b.spawn(Team::Red, p(165., 200.), idle()).unwrap();
    let far = b
        .spawn(
            Team::Red,
            p(350., 200.),
            caster(vec![Effect::Stealth { ticks: 4 }]),
        )
        .unwrap();
    b.control_from(a, Control::Root, near, 10).unwrap();
    b.control_from(a, Control::Root, far, 20).unwrap();
    b.remove_control(a, Control::Root, far).unwrap();
    b.control_from(a, Control::Taunt, far, 20).unwrap();
    b.step(&[]);
    assert_eq!(unit(&b, a).target, Some(far));
    assert!(unit(&b, a).controls.contains(&Control::Root));
    b.step(&[cmd(Team::Red, far, p(350., 200.))]);
    assert!(b.snapshot_for(Team::Blue).units.iter().all(|u| u.id != far));
    assert_eq!(unit(&b, a).target, Some(near));
}

#[test]
fn sanctuary_uses_attacker_position_and_one_shield_blocks_a_whole_delivery() {
    let mut b = world();
    let spot = p(330., 200.);
    let owner = b
        .spawn(
            Team::Red,
            spot,
            caster(vec![
                Effect::Sanctuary {
                    radius: 65.,
                    ticks: 20,
                },
                Effect::EffectShield { ticks: 20 },
            ]),
        )
        .unwrap();
    let blast = || {
        caster(vec![
            Effect::Damage(30),
            Effect::Control {
                kind: Control::Root,
                ticks: 5,
            },
        ])
    };
    let outside = b.spawn(Team::Blue, p(100., 200.), blast()).unwrap();
    let inside = b.spawn(Team::Blue, p(290., 200.), blast()).unwrap();
    b.step(&[cmd(Team::Red, owner, spot), cmd(Team::Blue, outside, spot)]);
    assert!(unit(&b, owner).effect_shield);
    b.step(&[cmd(Team::Blue, inside, spot)]);
    let u = unit(&b, owner);
    assert!(!u.effect_shield && !u.controls.contains(&Control::Root));
    assert_eq!(u.hp, 210);
    b.step(&[cmd(Team::Blue, inside, spot)]);
    assert_eq!(unit(&b, owner).hp, 180);
    assert!(unit(&b, owner).controls.contains(&Control::Root));
}

#[test]
fn released_stage_outlives_interruption_but_windup_can_be_cancelled() {
    const RELEASE: Effect = Effect::Area(TimedArea {
        delay: 2,
        period: 0,
        pulses: 1,
        anchor: AreaAnchor::Independent,
        shape: Shape::Circle { radius: 50. },
        effects: &[Effect::Damage(19)],
    });
    for (wait_before_freeze, expected) in [(1, 210), (2, 191)] {
        let mut b = world();
        let a = b
            .spawn(
                Team::Blue,
                p(100., 200.),
                caster(vec![Effect::Area(TimedArea {
                    delay: 2,
                    period: 0,
                    pulses: 1,
                    anchor: AreaAnchor::CastPoint,
                    shape: Shape::Circle { radius: 0. },
                    effects: &[RELEASE],
                })]),
            )
            .unwrap();
        let target = b.spawn(Team::Red, p(300., 200.), idle()).unwrap();
        b.step(&[cmd(Team::Blue, a, p(300., 200.))]);
        wait(&mut b, wait_before_freeze);
        b.control(a, Control::Freeze, 10).unwrap();
        wait(&mut b, 5);
        assert_eq!(unit(&b, target).hp, expected);
    }
}

#[test]
fn building_seekers_can_pass_head_on_without_changing_goal() {
    let mut b = world();
    let tower = || UnitDef {
        role: Role::LaneTower,
        ..idle()
    };
    let red = b.spawn(Team::Red, p(140., 140.), tower()).unwrap();
    let blue = b.spawn(Team::Blue, p(140., 500.), tower()).unwrap();
    let start = Point::new(140., 320.);
    let a = b
        .spawn(Team::Blue, start + p(0., 18.), UnitDef::crab())
        .unwrap();
    let c = b
        .spawn(Team::Red, start - p(0., 18.), UnitDef::crab())
        .unwrap();
    wait(&mut b, 45);
    assert!(unit(&b, a).position.y < unit(&b, c).position.y);
    assert_eq!(
        (unit(&b, a).target, unit(&b, c).target),
        (Some(red), Some(blue))
    );
}

#[test]
fn baron_bonus_and_enemy_slow_expire_on_separate_clocks() {
    let mut b = world();
    let a = b
        .spawn(Team::Blue, p(150., 200.), UnitDef::baron_melee())
        .unwrap();
    let enemy = b
        .spawn(
            Team::Red,
            p(170., 200.),
            caster(vec![Effect::Slow {
                movement: 600,
                attack: 700,
                ticks: 12,
            }]),
        )
        .unwrap();
    b.step(&[
        (
            Team::Blue,
            Cast {
                caster: a,
                aim: Aim::Instant,
            },
        ),
        cmd(Team::Red, enemy, p(150., 200.)),
    ]);
    let u = unit(&b, a);
    assert_eq!(
        (u.damage_rate, u.movement_rate, u.attack_rate),
        (1250, 810, 700)
    );
    wait(&mut b, 12);
    assert_eq!(unit(&b, enemy).hp, 210 - 53);
    let u = unit(&b, a);
    assert_eq!((u.movement_rate, u.attack_rate), (1350, 1000));
    wait(&mut b, 68);
    assert_eq!(unit(&b, a).damage_rate, 1000);
}

#[test]
fn projectiles_apply_pierce_once_each_leg_and_bounce_at_defined_points() {
    for (delivery, hits) in [
        (
            Delivery::Line {
                count: 1,
                degrees: 0.,
                distance: 160.,
                pierce: true,
                returns: true,
            },
            [2, 2],
        ),
        (
            Delivery::Ground {
                radius: 18.,
                bounces: 2,
                hop_distance: 60.,
            },
            [1, 1],
        ),
    ] {
        let mut b = world();
        let shooter = b
            .spawn(
                Team::Blue,
                p(100., 200.),
                UnitDef {
                    action: Action::Shot {
                        damage: 20,
                        windup: 1,
                        interval: 300,
                        speed: 450.,
                    },
                    range: 200.,
                    sight: 300.,
                    weapon: Weapon {
                        delivery,
                        ..Default::default()
                    },
                    ..idle()
                },
            )
            .unwrap();
        let targets = [160., 220.].map(|x| b.spawn(Team::Red, p(x, 200.), idle()).unwrap());
        wait(&mut b, 20);
        for (id, h) in targets.into_iter().zip(hits) {
            assert_eq!(unit(&b, id).hp, 210 - h * 20);
        }
        assert!(unit(&b, shooter).hp == 210 && b.snapshot().projectiles.is_empty());
    }
}
