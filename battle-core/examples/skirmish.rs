//! Scripted opponents on one authoritative map. The fixture towers have reduced
//! health so this scenario exercises the complete route in a short replay.
use clash_battle_core::*;
fn main() {
    let mut battle = Battle::new(Arena::classic()).unwrap();
    let nexus = UnitDef {
        key: "fixture_nexus",
        role: Role::Nexus,
        hp: 420,
        radius: 30.,
        speed: 0.,
        action: Action::Idle,
        ..UnitDef::melee()
    };
    let blue = battle
        .spawn(Team::Blue, Point::new(360., 1170.), nexus.clone())
        .unwrap();
    let red = battle
        .spawn(Team::Red, Point::new(360., 110.), nexus)
        .unwrap();
    for tick in 1..=12000 {
        if tick % 160 == 1 {
            for (team, y, def) in [
                (Team::Blue, 820., UnitDef::ranged()),
                (Team::Red, 460., UnitDef::melee()),
            ] {
                battle.spawn(team, Point::new(200., y), def).unwrap();
            }
        }
        battle.step(&[]);
        for event in battle.drain_events() {
            if let Fact::Died(id) = event.fact {
                if id == blue || id == red {
                    println!(
                        "tick {tick}: {:?} wins",
                        if id == blue { Team::Red } else { Team::Blue }
                    );
                    return;
                }
            }
        }
    }
    panic!("neither scripted opponent destroyed the enemy nexus");
}
