use super::{Card, MatchError};
use crate::Id;
use std::collections::{BTreeSet, VecDeque};
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Active {
    pub caster: Id,
    pub uses: u8,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HandView {
    pub hand: [&'static str; 4],
    pub next: &'static str,
    pub gold: u8,
    pub version: u64,
    pub acknowledged: u64,
    pub active: [Option<Active>; 2],
}
pub(super) struct Player {
    pub deck: [Card; 8],
    hand: [usize; 4],
    queue: VecDeque<usize>,
    pub gold: u8,
    // A whole coin takes 168 units. Preserve elapsed normal-speed time
    // across rate transitions, as the legacy timer changes its threshold.
    regen_time: u32,
    pub version: u64,
    pub ack: u64,
    pub active: [Option<Active>; 2],
}
impl Player {
    pub fn validate(deck: &[Card; 8]) -> Result<(), MatchError> {
        if deck.iter().map(|c| c.key).collect::<BTreeSet<_>>().len() != 8
            || deck.iter().any(|c| !c.valid())
        {
            return Err(MatchError::Loadout);
        }
        Ok(())
    }
    pub fn new(deck: [Card; 8], mut seed: u64) -> Result<Self, MatchError> {
        Self::validate(&deck)?;
        let mut order = [0, 1, 2, 3, 4, 5, 6, 7];
        // SplitMix64 Fisher-Yates uses only the frozen match seed.
        let mut pick = |upper: u64| {
            let threshold = upper.wrapping_neg() % upper;
            loop {
                seed = seed.wrapping_add(0x9e3779b97f4a7c15);
                let mut v = seed;
                v = (v ^ (v >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
                v = (v ^ (v >> 27)).wrapping_mul(0x94d049bb133111eb);
                v ^= v >> 31;
                if v >= threshold {
                    break (v % upper) as usize;
                }
            }
        };
        for i in (1..8).rev() {
            let j = pick(i as u64 + 1);
            order.swap(i, j)
        }
        if let Some(i) = order[..4].iter().position(|&idx| deck[idx].key == "mirror") {
            order.swap(i, 4 + pick(4));
        }
        Ok(Self {
            deck,
            hand: order[..4].try_into().unwrap(),
            queue: order[4..].iter().copied().collect(),
            gold: 5,
            regen_time: 0,
            version: 0,
            ack: 0,
            active: [None; 2],
        })
    }
    pub fn view(&self) -> HandView {
        HandView {
            hand: self.hand.map(|i| self.deck[i].key),
            next: self.deck[self.queue[0]].key,
            gold: self.gold,
            version: self.version,
            acknowledged: self.ack,
            active: self.active,
        }
    }
    pub fn advance(&mut self, rate: u32) {
        if self.gold >= 10 {
            return;
        }
        self.regen_time += 3;
        let threshold = 168 / rate;
        while self.regen_time >= threshold && self.gold < 10 {
            self.regen_time -= threshold;
            self.gold += 1;
        }
    }
    pub fn lookup(&self, slot: u8, version: u64) -> Result<usize, MatchError> {
        if version != self.version {
            return Err(MatchError::StaleHand);
        }
        self.hand
            .get(slot as usize)
            .copied()
            .ok_or(MatchError::Slot)
    }
    pub fn rotate(&mut self, slot: u8, cost: u8) {
        self.gold -= cost;
        let next = self.queue.pop_front().unwrap();
        self.queue
            .push_back(std::mem::replace(&mut self.hand[usize::from(slot)], next));
        self.version += 1;
    }
}
