//! Compact input log. Deck order and selected content are supplied at replay
//! time and must match the header; spectators never receive this private log.
use super::{Card, ClassicMatch, Input, MatchError};
pub const RULESET: &str = env!("BATTLE_RULESET");
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
    pub commands: Vec<(u64, Input)>,
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
    ) -> Result<Vec<Result<(), MatchError>>, MatchError> {
        if game.tick() != self.steps || game.result().is_some() {
            return Err(MatchError::Finished);
        }
        let r = game.step(inputs);
        self.steps = game.tick();
        self.commands
            .extend(inputs.iter().map(|i| (self.steps, *i)));
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
            || self.commands.windows(2).any(|w| w[0].0 > w[1].0)
            || self
                .commands
                .iter()
                .any(|(t, _)| *t == 0 || *t > self.steps)
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
        for tick in 1..=self.steps {
            if game.result().is_some() {
                return Err(MatchError::Finished);
            }
            let mut batch = vec![];
            while inputs.peek().is_some_and(|(t, _)| *t == tick) {
                batch.push(inputs.next().unwrap().1)
            }
            game.step(&batch);
            game.drain_events().for_each(drop);
        }
        Ok(game)
    }
}
