//! Repeatable single-world bridge load, including navigation and combat.
//! Record wall-clock timings in release mode; never use them as simulation input.
use clash_battle_core::classic::{bot_input, representative_deck, ClassicMatch};
use clash_battle_core::*;
use std::time::Instant;
fn main() {
    for count in [32, 64, 128] {
        let mut times = Vec::new();
        for _ in 0..5 {
            let mut battle = Battle::new(Arena::classic()).unwrap();
            for i in 0..count {
                let row = i / 2;
                let x = 80. + (row % 8) as f64 * 23.;
                let offset = (row / 8) as f64 * 25.;
                let (team, y) = if i % 2 == 0 {
                    (Team::Blue, 800. + offset)
                } else {
                    (Team::Red, 480. - offset)
                };
                let def = UnitDef {
                    hp: 10000,
                    sight: 600.,
                    ..if row % 4 == 0 {
                        UnitDef::ranged()
                    } else {
                        UnitDef::melee()
                    }
                };
                battle.spawn(team, Point::new(x, y), def).unwrap();
            }
            for _ in 0..240 {
                let start = Instant::now();
                battle.step(&[]);
                times.push(start.elapsed().as_secs_f64() * 1000.);
                battle.drain_events().for_each(drop);
            }
        }
        report(&format!("{count} units"), times);
    }
    let deck = representative_deck();
    let mut classic = ClassicMatch::new(20261118, [deck, deck]).unwrap();
    let mut times = vec![];
    while classic.result().is_none() {
        let commands: Vec<_> = [Team::Blue, Team::Red]
            .into_iter()
            .filter_map(|t| bot_input(t, &classic.view(t)))
            .collect();
        let start = Instant::now();
        classic.step(&commands);
        times.push(start.elapsed().as_secs_f64() * 1000.);
        classic.drain_events().for_each(drop);
    }
    report("classic", times);
    let mut times = vec![];
    for _ in 0..5 {
        let mut world = Battle::new(Arena::classic()).unwrap();
        let mut commands = vec![];
        for row in 0..4 {
            for col in 0..6 {
                let team = if row % 2 == 0 { Team::Blue } else { Team::Red };
                let def = if col % 2 == 0 {
                    UnitDef::tombstone()
                } else {
                    UnitDef::scarecrow()
                };
                let pos = Point::new(70. + col as f64 * 110., 100. + row as f64 * 135.);
                let id = world.spawn(team, pos, def).unwrap();
                commands.push((
                    team,
                    Cast {
                        caster: id,
                        aim: Aim::Instant,
                    },
                ));
            }
        }
        for tick in 0..240 {
            let start = Instant::now();
            world.step(if tick == 0 { &commands } else { &[] });
            times.push(start.elapsed().as_secs_f64() * 1000.);
            let events: Vec<_> = world.drain_events().collect();
            if tick == 0 {
                assert_eq!(
                    events
                        .iter()
                        .filter(|e| matches!(e.fact, Fact::FormChanged { .. }))
                        .count(),
                    12
                );
                assert_eq!(
                    events
                        .iter()
                        .filter(|e| matches!(e.fact, Fact::Summoned { .. }))
                        .count(),
                    72
                );
            }
        }
    }
    report("summon and transform", times);
}
fn report(label: &str, mut times: Vec<f64>) {
    times.sort_by(f64::total_cmp);
    println!(
        "{label}, {} ticks: p50 {:.3} ms, p95 {:.3} ms, p99 {:.3} ms, max {:.3} ms, over 50 ms {}",
        times.len(),
        times[times.len() / 2],
        times[times.len() * 95 / 100],
        times[times.len() * 99 / 100],
        times.last().unwrap(),
        times.iter().filter(|&&v| v > 50.).count()
    );
}
