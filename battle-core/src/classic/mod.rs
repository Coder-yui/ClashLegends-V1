//! Classic mode owns the economy, private seats, input ordering, deployment,
//! lane schedule and terminal result. The underlying Battle has no mode rules.
mod bot;
pub use bot::bot_input;
mod player;
pub mod replay;
mod rift;
use crate::{
    Activity, Aim, Battle, Cast, Control, Error, Event, Id, Point, Role, Snapshot, Team, UnitDef,
};
use player::Player;
pub use player::{Active, HandView};
pub use rift::{MatchMap, SideLayout, Tiles};

#[derive(Clone, Copy, Debug)]
pub enum Spell {
    Freeze { radius: f64, ticks: u32 },
    HealTroops { radius: f64, amount: i32 },
}
#[derive(Clone, Copy, Debug)]
pub enum Play {
    Unit(fn() -> UnitDef),
    Spell(Spell),
}
#[derive(Clone, Copy, Debug)]
pub struct Card {
    pub key: &'static str,
    pub cost: u8,
    pub play: Play,
    pub deploy_ticks: u32,
    pub skill_key: Option<&'static str>,
    pub skill_cost: u8,
    pub skill_uses: u8,
}
impl Card {
    pub fn unit(def: fn() -> UnitDef, cost: u8) -> Self {
        Self {
            key: def().key,
            cost,
            play: Play::Unit(def),
            deploy_ticks: 20,
            skill_key: None,
            skill_cost: 0,
            skill_uses: 0,
        }
    }
    fn valid(&self) -> bool {
        if self.cost > 10
            || self.skill_cost > 10
            || self.key.is_empty()
            || (self.skill_key.is_some() != (self.skill_uses > 0))
        {
            return false;
        }
        match self.play {
            Play::Unit(def) => {
                let d = def();
                d.valid()
                    && d.lifecycle.footprint <= 18
                    && (self.skill_uses == 0 || d.skill.is_some())
            }
            Play::Spell(Spell::Freeze { radius, ticks }) => {
                radius.is_finite() && radius >= 0. && ticks > 0
            }
            Play::Spell(Spell::HealTroops { radius, amount }) => {
                radius.is_finite() && radius >= 0. && amount > 0
            }
        }
    }
}
/// Executable migrated cards, with both active slots first as in a lobby deck.
pub fn representative_deck() -> [Card; 8] {
    [
        Card {
            skill_key: Some("scuttle_crab.humility"),
            skill_cost: 1,
            skill_uses: 2,
            ..Card::unit(UnitDef::crab, 2)
        },
        Card {
            skill_key: Some("tombstone.gather-the-fallen"),
            skill_cost: 1,
            skill_uses: 1,
            ..Card::unit(UnitDef::tombstone, 3)
        },
        Card {
            skill_key: Some("ranged_minion.hand-of-baron"),
            skill_uses: 2,
            ..Card::unit(UnitDef::baron_ranged, 1)
        },
        Card {
            skill_key: Some("melee_minion.hand-of-baron"),
            skill_uses: 2,
            ..Card::unit(UnitDef::baron_melee, 1)
        },
        Card::unit(UnitDef::dragon, 4),
        Card::unit(UnitDef::super_minion, 4),
        Card::unit(UnitDef::siege, 3),
        Card {
            key: "freeze",
            cost: 3,
            play: Play::Spell(Spell::Freeze {
                radius: 110.,
                ticks: 60,
            }),
            deploy_ticks: 0,
            skill_key: None,
            skill_cost: 0,
            skill_uses: 0,
        },
    ]
}
/// Resolve ordered frozen slots against executable content. Multiple entries
/// can share a card key when their skill choice supplies a different UnitDef.
pub fn resolve_deck(
    choices: [(&str, Option<&str>); 8],
    catalog: &[Card],
) -> Result<[Card; 8], MatchError> {
    let mut result = Vec::with_capacity(8);
    for (slot, (key, selected)) in choices.into_iter().enumerate() {
        // The lobby records a preference on every card. Only the first two
        // preferences grant an ability in this mode.
        let mut candidates = catalog
            .iter()
            .filter(|c| c.key == key && (slot >= 2 || c.skill_key == selected));
        let mut card = *candidates.next().ok_or(MatchError::Loadout)?;
        if slot < 2 && candidates.next().is_some() {
            return Err(MatchError::Loadout);
        }
        if slot >= 2 {
            card.skill_key = None;
            card.skill_cost = 0;
            card.skill_uses = 0;
        }
        result.push(card);
    }
    let deck = result.try_into().map_err(|_| MatchError::Loadout)?;
    Player::validate(&deck)?;
    Ok(deck)
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MatchError {
    Loadout,
    Finished,
    Sequence,
    Slot,
    StaleHand,
    Gold,
    Placement,
    NoAbility,
    Rule(Error),
}
impl From<Error> for MatchError {
    fn from(e: Error) -> Self {
        Self::Rule(e)
    }
}
#[derive(Clone, Copy, Debug)]
pub enum Intent {
    Play {
        slot: u8,
        version: u64,
        point: Point,
    },
    Activate {
        slot: u8,
        aim: Aim,
    },
}
#[derive(Clone, Copy, Debug)]
pub struct Input {
    pub team: Team,
    pub sequence: u64,
    pub intent: Intent,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EndReason {
    Nexus,
    Towers,
    Draw,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Outcome {
    pub winner: Option<Team>,
    pub reason: EndReason,
}
#[derive(Clone, Debug, PartialEq)]
pub struct MatchView {
    pub field: Snapshot,
    pub own: HandView,
    pub remaining_ticks: u64,
    pub overtime: bool,
    pub result: Option<Outcome>,
}
pub struct ClassicMatch {
    seed: u64,
    map: MatchMap,
    battle: Battle,
    players: [Player; 2],
    nexus: [Id; 2],
    towers: [[Id; 2]; 2],
    result: Option<Outcome>,
    overtime: bool,
}
impl Team {
    pub fn index(self) -> usize {
        if self == Self::Blue {
            0
        } else {
            1
        }
    }
    pub fn enemy(self) -> Self {
        if self == Self::Blue {
            Self::Red
        } else {
            Self::Blue
        }
    }
}
impl ClassicMatch {
    pub fn new(seed: u64, decks: [[Card; 8]; 2]) -> Result<Self, MatchError> {
        Self::on_map(seed, decks, MatchMap::rift())
    }
    pub fn on_map(seed: u64, decks: [[Card; 8]; 2], map: MatchMap) -> Result<Self, MatchError> {
        if !map.tile_size.is_finite() || map.tile_size <= 0. || map.id.is_empty() {
            return Err(MatchError::Placement);
        }
        let players = [
            Player::new(decks[0], seed)?,
            Player::new(decks[1], seed ^ 0x76b15da90c378ff1)?,
        ];
        let mut battle = Battle::new(map.arena.clone())?;
        let mut towers = [[0; 2]; 2];
        let mut nexus = [0; 2];
        for team in [Team::Blue, Team::Red] {
            for (lane, pos) in map.sides[team.index()].towers.into_iter().enumerate() {
                towers[team.index()][lane] = battle.spawn(team, pos, UnitDef::tower())?;
            }
        }
        for team in [Team::Blue, Team::Red] {
            nexus[team.index()] =
                battle.spawn(team, map.sides[team.index()].nexus, UnitDef::nexus())?;
        }
        Ok(Self {
            seed,
            map,
            battle,
            players,
            towers,
            nexus,
            result: None,
            overtime: false,
        })
    }
    pub fn tick(&self) -> u64 {
        self.battle.tick
    }
    pub fn result(&self) -> Option<Outcome> {
        self.result
    }
    pub fn view(&self, team: Team) -> MatchView {
        MatchView {
            field: self.battle.snapshot_for(team),
            own: self.players[team.index()].view(),
            remaining_ticks: (if self.overtime { 6100 } else { 3700 }) - self.tick(),
            overtime: self.overtime,
            result: self.result,
        }
    }
    pub fn drain_events(&mut self) -> impl Iterator<Item = Event> + '_ {
        self.battle.drain_events()
    }
    pub fn step(&mut self, inputs: &[Input]) -> Vec<Result<(), MatchError>> {
        if self.result.is_some() {
            return vec![Err(MatchError::Finished); inputs.len()];
        }
        let rate = if self.tick() >= 4900 {
            3
        } else if self.tick() >= 2500 {
            2
        } else {
            1
        };
        self.battle.begin_step();
        for player in &mut self.players {
            player.advance(rate)
        }
        let mut changes = vec![];
        let receipts = inputs
            .iter()
            .map(|i| self.accept(*i, &mut changes))
            .collect();
        self.battle.commit(changes);
        self.wave();
        self.battle.finish_step();
        for p in &mut self.players {
            for active in &mut p.active {
                if active.is_some_and(|a| !self.battle.actors.contains_key(&a.caster)) {
                    *active = None
                }
            }
        }
        self.finish_rules();
        receipts
    }
    fn accept(
        &mut self,
        i: Input,
        changes: &mut Vec<crate::vitals::Change>,
    ) -> Result<(), MatchError> {
        let seat = i.team.index();
        let p = &mut self.players[seat];
        if p.ack.checked_add(1) != Some(i.sequence) {
            return Err(MatchError::Sequence);
        }
        p.ack = i.sequence;
        match i.intent {
            Intent::Play {
                slot,
                version,
                point,
            } => {
                let index = p.lookup(slot, version)?;
                let card = p.deck[index];
                if p.gold < card.cost {
                    return Err(MatchError::Gold);
                }
                match card.play {
                    Play::Unit(maker) => {
                        let mut d = maker();
                        if index >= 2 || card.skill_uses == 0 {
                            d.skill = None
                        }
                        let pos = self.cell(point, i.team, Some(&d))?;
                        let id = self.battle.spawn(i.team, pos, d)?;
                        let a = self.battle.actors.get_mut(&id).unwrap();
                        a.ready_tick = self.battle.tick + u64::from(card.deploy_ticks);
                        if card.deploy_ticks > 0 {
                            a.activity = Activity::Deploying
                        }
                        if index < 2 {
                            self.players[seat].active[index] =
                                (card.skill_uses > 0).then_some(Active {
                                    caster: id,
                                    uses: card.skill_uses,
                                })
                        }
                    }
                    Play::Spell(spell) => {
                        let pos = self.cell(point, i.team, None)?;
                        self.spell(i.team, pos, spell, changes);
                    }
                }
                self.players[seat].rotate(slot, card.cost);
                Ok(())
            }
            Intent::Activate { slot, aim } => {
                let n = usize::from(slot);
                let active = p
                    .active
                    .get(n)
                    .ok_or(MatchError::Slot)?
                    .ok_or(MatchError::NoAbility)?;
                if active.uses == 0 {
                    return Err(MatchError::NoAbility);
                }
                let cost = p.deck[n].skill_cost;
                if p.gold < cost {
                    return Err(MatchError::Gold);
                }
                self.battle.cast(
                    i.team,
                    Cast {
                        caster: active.caster,
                        aim,
                    },
                    changes,
                )?;
                p.gold -= cost;
                p.active[n] = Some(Active {
                    uses: active.uses - 1,
                    ..active
                });
                Ok(())
            }
        }
    }
    fn spell(
        &mut self,
        team: Team,
        pos: Point,
        spell: Spell,
        changes: &mut Vec<crate::vitals::Change>,
    ) {
        let radius = match spell {
            Spell::Freeze { radius, .. } | Spell::HealTroops { radius, .. } => radius,
        };
        let source = self.map.sides[team.index()].nexus;
        let ids: Vec<_> = self
            .battle
            .actors
            .values()
            .filter(|a| {
                crate::targeting::Body::from(*a).allows(team, source)
                    && (a.pos - pos).length() <= radius + a.def.radius
            })
            .map(|a| (a.id, a.team, a.def.role))
            .collect();
        for (id, side, role) in ids {
            match spell {
                Spell::Freeze { ticks, .. } if team != side => {
                    if self.battle.consume_effect_shield(id) {
                        continue;
                    }
                    let _ =
                        self.battle
                            .apply_control(id, Control::Freeze, 0, ticks, self.battle.tick);
                }
                Spell::HealTroops { amount, .. } if team == side && role == Role::Troop => {
                    changes.push(crate::vitals::Change::new(0, id, amount))
                }
                _ => {}
            }
        }
    }
    fn finish_rules(&mut self) {
        let live = |id: &Id| self.battle.actors.contains_key(id);
        let alive = self.nexus.map(|id| live(&id));
        let winner = |blue: bool, red: bool| {
            if blue && !red {
                Some(Team::Blue)
            } else if red && !blue {
                Some(Team::Red)
            } else {
                None
            }
        };
        if !alive[0] || !alive[1] {
            self.result = Some(Outcome {
                winner: winner(alive[0], alive[1]),
                reason: EndReason::Nexus,
            });
            return;
        }
        let counts = self
            .towers
            .map(|lane| lane.iter().filter(|id| live(id)).count());
        if self.tick() >= 3700 && counts[0] != counts[1] {
            self.result = Some(Outcome {
                winner: winner(counts[0] > counts[1], counts[1] > counts[0]),
                reason: EndReason::Towers,
            });
        } else if self.tick() == 3700 {
            self.overtime = true;
            self.spawn_wave(true, true);
        } else if self.tick() == 6100 {
            self.result = Some(Outcome {
                winner: None,
                reason: EndReason::Draw,
            })
        }
    }
}
#[cfg(test)]
mod end_rules {
    use super::*;
    fn at(t: u64) -> ClassicMatch {
        let d = representative_deck();
        let mut g = ClassicMatch::new(0, [d, d]).unwrap();
        g.battle.tick = t;
        g
    }
    #[test]
    fn regulation_sudden_death_draw_and_simultaneous_nexus() {
        let mut g = at(3699);
        g.battle.actors.remove(&g.towers[1][0]);
        g.finish_rules();
        assert_eq!(g.result, None);
        g.step(&[]);
        assert_eq!(
            g.result,
            Some(Outcome {
                winner: Some(Team::Blue),
                reason: EndReason::Towers
            })
        );
        let mut g = at(3699);
        g.step(&[]);
        assert!(g.overtime);
        assert_eq!(g.view(Team::Blue).remaining_ticks, 2400);
        g.battle.actors.remove(&g.towers[0][1]);
        g.step(&[]);
        assert_eq!(g.result.unwrap().winner, Some(Team::Red));
        let mut g = at(6099);
        g.overtime = true;
        g.step(&[]);
        assert_eq!(g.result.unwrap().reason, EndReason::Draw);
        let mut g = at(120);
        for id in g.nexus {
            g.battle.actors.remove(&id);
        }
        g.step(&[]);
        assert_eq!(
            g.result,
            Some(Outcome {
                winner: None,
                reason: EndReason::Nexus
            })
        );
    }
    #[test]
    fn pocket_and_footprint_are_team_and_lane_specific() {
        let mut g = at(12);
        let unit = UnitDef::melee();
        let tomb = UnitDef::tombstone();
        let point = Point::new(140., 500.);
        assert!(g.cell(point, Team::Blue, Some(&unit)).is_err());
        g.battle.actors.remove(&g.towers[1][0]);
        assert!(g.cell(point, Team::Blue, Some(&unit)).is_ok());
        assert!(g
            .cell(Point::new(580., 500.), Team::Blue, Some(&unit))
            .is_err());
        assert!(g
            .cell(Point::new(140., 1050.), Team::Blue, Some(&unit))
            .is_err());
        assert!(g
            .cell(Point::new(180., 700.), Team::Blue, Some(&tomb))
            .is_err());
    }
}
