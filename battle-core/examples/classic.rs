use clash_battle_core::{classic::*, Fact, Team};
fn main() {
    let deck = representative_deck();
    let mut game = ClassicMatch::new(20261118, [deck, deck]).unwrap();
    let mut plays = 0;
    let mut children = 0;
    while game.result().is_none() {
        let commands: Vec<_> = [Team::Blue, Team::Red]
            .into_iter()
            .filter_map(|team| bot_input(team, &game.view(team)))
            .collect();
        for (input, result) in commands.iter().zip(game.step(&commands)) {
            if matches!(input.intent, Intent::Play { .. }) && result.is_ok() {
                plays += 1
            }
        }
        children += game
            .drain_events()
            .filter(|e| matches!(e.fact, Fact::Summoned { .. }))
            .count();
    }
    assert!(plays > 0 && children > 0);
    println!(
        "{} ticks, {} plays, {} children, {:?}",
        game.tick(),
        plays,
        children,
        game.result().unwrap()
    )
}
