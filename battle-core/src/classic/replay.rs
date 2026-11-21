//! Compact input log. Deck order and selected content are supplied at replay
//! time and must match the header; spectators never receive this private log.
use super::{Card, ClassicMatch, Input, MatchError};
pub const CONTENT_VERSION: &str = env!("BATTLE_CONTENT");
/// Bump the engine revision for changes to authority ordering, AI or simulation semantics.
pub const RULESET: &str = concat!("classic-4/", env!("BATTLE_CONTENT"));
#[derive(Clone, Copy, Debug)]
pub struct RecordedInput {
    pub received_at: u64,
    pub input_tick: u64,
    pub input: Input,
}
#[derive(Clone, Debug)]
pub struct Record {
    pub rules: &'static str,
    pub content: String,
    pub seed: u64,
    pub map: String,
    pub mode: String,
    pub skills: [[Option<String>; 8]; 2],
    pub decks: [[String; 8]; 2],
    pub steps: u64,
    pub commands: Vec<RecordedInput>,
}
impl Record {
    pub fn new(game: &ClassicMatch, content: &str) -> Result<Self, MatchError> {
        if game.tick() != 0 {
            return Err(MatchError::Finished);
        }
        let decks = game.players.each_ref().map(|p| p.deck);
        Ok(Self {
            rules: RULESET,
            content: content.to_owned(),
            seed: game.seed,
            mode: game.mode.id.clone(),
            map: game.map.id.to_owned(),
            skills: decks.map(|d| d.map(|card| card.skill_key.map(str::to_owned))),
            decks: decks.map(|cards| cards.map(|c| c.key.to_owned())),
            steps: 0,
            commands: vec![],
        })
    }
    /// Record the exact ordered batch, including gameplay rejections.
    pub fn step(
        &mut self,
        game: &mut ClassicMatch,
        inputs: &[Input],
    ) -> Result<Vec<Result<u64, MatchError>>, MatchError> {
        let tick = game.tick();
        self.step_stamped(game, inputs.iter().map(|i| (tick, *i)))
    }
    pub fn step_stamped(
        &mut self,
        game: &mut ClassicMatch,
        inputs: impl IntoIterator<Item = (u64, Input)>,
    ) -> Result<Vec<Result<u64, MatchError>>, MatchError> {
        if game.tick() != self.steps || game.result().is_some() {
            return Err(MatchError::Finished);
        }
        let received_at = self.steps;
        let r = game.step_stamped(inputs.into_iter().inspect(|&(input_tick, input)| {
            self.commands.push(RecordedInput {
                received_at,
                input_tick,
                input,
            });
        }));
        self.steps = game.tick();
        Ok(r)
    }
    pub fn replay(&self, decks: [[Card; 8]; 2], content: &str) -> Result<ClassicMatch, MatchError> {
        self.replay_on(decks, content, super::MatchMap::rift())
    }
    pub fn replay_on(
        &self,
        decks: [[Card; 8]; 2],
        content: &str,
        map: super::MatchMap,
    ) -> Result<ClassicMatch, MatchError> {
        if self.rules != RULESET
            || self.map != map.id
            || decks
                .iter()
                .enumerate()
                .any(|(s, d)| (0..8).any(|i| d[i].skill_key != self.skills[s][i].as_deref()))
            || self.content != content
            || !super::modes()
                .iter()
                .any(|m| m.id == self.mode && self.steps <= m.end)
            || self
                .commands
                .windows(2)
                .any(|w| w[0].received_at > w[1].received_at)
            || self.commands.iter().any(|c| c.received_at >= self.steps)
            || !decks
                .iter()
                .zip(&self.decks)
                .all(|(d, keys)| d.iter().zip(keys).all(|(c, k)| c.key == k))
        {
            return Err(MatchError::Loadout);
        }
        let mode = super::modes()
            .iter()
            .find(|m| m.id == self.mode)
            .ok_or(MatchError::Loadout)?;
        let mut game = ClassicMatch::with_rules(self.seed, decks, map, mode)?;
        let mut inputs = self.commands.iter().peekable();
        for tick in 0..self.steps {
            if game.result().is_some() {
                return Err(MatchError::Finished);
            }
            let mut batch = vec![];
            while let Some(cmd) = inputs.next_if(|c| c.received_at == tick) {
                batch.push((cmd.input_tick, cmd.input));
            }
            game.step_stamped(batch);
            game.drain_events().for_each(drop);
        }
        Ok(game)
    }
}
