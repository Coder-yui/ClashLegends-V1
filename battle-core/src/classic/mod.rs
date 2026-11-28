//! Classic mode owns the economy, private seats, input ordering, deployment,
//! lane schedule and terminal result. The underlying Battle has no mode rules.
pub(crate) mod abilities;
mod bot;
pub(crate) mod casts;
mod forms;
pub(crate) mod maneuvers;
pub(crate) mod marks;
pub(crate) mod production;
mod resources;
pub(crate) mod specialists;
pub(crate) mod units;
pub(crate) mod zones;
pub use bot::{bot_input, roster_bot_input};
pub use zones::WaveView;
pub(crate) mod hits;
pub use hits::Attack;
mod player;
pub mod replay;
mod rift;
mod roster;
mod spell_kind;
mod spells;
pub mod workbench;
use crate::{
    Activity, Aim, Battle, Control, Error, Event, Id, Point, Role, Snapshot, Team, UnitDef,
};
use player::Player;
pub use player::{Active, HandView};
pub use rift::{maps, modes, MatchMap, ModeRules, SideLayout, Tiles};
pub use roster::battle_cards;
pub use spells::CardSpell;

#[derive(Clone, Copy, Debug)]
pub enum Spell {
    Freeze { radius: f64, ticks: u32 },
    HealTroops { radius: f64, amount: i32 },
}
#[derive(Clone, Copy, Debug)]
pub enum Play {
    Unit(fn() -> UnitDef),
    Formation(&'static str),
    CardSpell(CardSpell, usize),
    RosterUnit(usize),
    Spell(Spell),
    Mirror,
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
    pub fn home_deployment(self) -> bool {
        let s = &roster::rules()[self.key];
        if matches!(
            self.play,
            Play::Spell(_) | Play::CardSpell(..) | Play::Mirror
        ) {
            s["deploy_half_only"] == true
        } else {
            s["deploy_zone"] != "global"
        }
    }
    fn active_spec(self) -> &'static serde_json::Value {
        match self.play {
            Play::RosterUnit(i) | Play::CardSpell(_, i) => {
                &roster::rules()[self.key]["active_skills"][i]
            }
            _ => &serde_json::Value::Null,
        }
    }
    fn price(self, uses: u32) -> u8 {
        self.active_spec()["cost_by_use"]
            .as_array()
            .and_then(|v| v.get((uses as usize).min(v.len().saturating_sub(1))))
            .and_then(|v| v.as_u64())
            .map_or(self.skill_cost, |n| n as u8)
    }
    fn caster_price(self, a: &crate::Actor) -> u8 {
        if let Some(crate::Effect::CardAbility(s)) =
            a.def.skill.as_ref().and_then(|skill| skill.effects.first())
        {
            if s.get("cost_by_use").is_none() {
                return s["cost"].as_u64().unwrap_or(u64::from(self.skill_cost)) as u8;
            }
        }
        self.price(a.card_state.use_number)
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
            Play::RosterUnit(_) => units::unit(self.key).valid(),
            Play::Mirror => self.key == "mirror",
            Play::CardSpell(kind, _) => CardSpell::for_key(self.key) == Some(kind),
            Play::Formation(key) => key == self.key && roster::valid(key),
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
            .filter(|c| c.key == key && c.skill_key == selected);
        let mut card = *candidates.next().ok_or(MatchError::Loadout)?;
        if candidates.next().is_some() {
            return Err(MatchError::Loadout);
        }
        if slot < 2 && matches!(card.play, Play::CardSpell(..)) {
            card.cost += roster::rules()[card.key]["active_cost_bonus"]
                .as_u64()
                .unwrap_or(0) as u8;
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
    Timing,
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
pub struct ActiveButtonState {
    pub locked: bool,
    pub cooldown_left: u64,
    pub cooldown_total: u32,
    pub free_recast: bool,
}
#[derive(Clone, Debug, PartialEq)]
pub struct MatchView {
    pub lane_front: [Point; 2],
    pub building_front: [Point; 2],
    pub arena_width: f64,
    pub tile_size: f64,
    pub home_zones: Vec<Tiles>,
    pub field: Snapshot,
    pub own: HandView,
    /// Remaining deployment or cooldown ticks for this seat’s two casters.
    pub active_wait: [u64; 2],
    pub buttons: [Option<ActiveButtonState>; 2],
    pub skill_resource: [Option<(f64, f64, bool)>; 2],
    pub active_cost: [u8; 2],
    pub remaining_ticks: u64,
    pub overtime: bool,
    pub result: Option<Outcome>,
}
#[derive(Clone, Copy)]
enum Reserved {
    Deploy {
        team: Team,
        index: usize,
        card: Card,
        form: &'static str,
        point: Point,
    },
    Skill {
        team: Team,
        n: usize,
        caster: Id,
        aim: Aim,
        cost: u8,
    },
}
struct Scheduled {
    due: u64,
    team: Team,
    sequence: u64,
    command: Reserved,
}
pub const COMMAND_DELAY: u64 = 10;
pub struct ClassicMatch {
    laboratory: bool,
    pending: Vec<Scheduled>,
    completed: Vec<(Team, u64, Result<(), MatchError>)>,
    mode: &'static ModeRules,
    seed: u64,
    map: MatchMap,
    battle: Battle,
    players: [Player; 2],
    nexus: [Id; 2],
    towers: [[Id; 2]; 2],
    result: Option<Outcome>,
    overtime: bool,
    spells: Vec<spells::SpellCast>,
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
        Self::with_rules(seed, decks, map, &modes()[0])
    }
    pub fn with_rules(
        seed: u64,
        decks: [[Card; 8]; 2],
        map: MatchMap,
        mode: &'static ModeRules,
    ) -> Result<Self, MatchError> {
        if !map.tile_size.is_finite() || map.tile_size <= 0. || map.id.is_empty() {
            return Err(MatchError::Placement);
        }
        let players = [
            Player::new(decks[0], seed)?,
            Player::new(decks[1], seed ^ 0x76b15da90c378ff1)?,
        ];
        let mut battle = Battle::new(map.arena.clone())?;
        battle.classic_attack_nodes = true;
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
            laboratory: false,
            pending: Vec::new(),
            completed: Vec::new(),
            mode,
            seed,
            map,
            battle,
            players,
            towers,
            nexus,
            result: None,
            overtime: false,
            spells: Vec::new(),
        })
    }
    pub fn tick(&self) -> u64 {
        self.battle.tick
    }
    pub fn result(&self) -> Option<Outcome> {
        self.result
    }
    fn play_form(&self, player: &Player, card: Card, team: Team, mirror: bool) -> &'static str {
        if mirror {
            player.last_form.unwrap_or(card.key)
        } else {
            self.battle.deployment_form(card.key, team, player.gold)
        }
    }

    pub fn hand_forms(&self, team: Team) -> [Option<&'static str>; 4] {
        let player = &self.players[team.index()];
        std::array::from_fn(|slot| {
            let card = player.deck[player.lookup(slot as u8, player.version).ok()?];
            let mirror = matches!(card.play, Play::Mirror);
            let source = if mirror { player.last_card? } else { card };
            Some(self.play_form(player, source, team, mirror))
        })
    }

    pub fn view(&self, team: Team) -> MatchView {
        let player = &self.players[team.index()];
        let sources = player
            .active
            .map(|active| active.and_then(|a| self.battle.actors.get(&a.caster)));
        let mut own = player.view();
        for (carried, source) in own.active.iter_mut().zip(sources) {
            if let (Some(carried), Some(a)) = (carried, source) {
                if a.card_state.free_execute {
                    carried.uses = carried.uses.saturating_add(1);
                }
            }
        }
        let active_cost = [0, 1].map(|i| {
            let card = player.active_cards[i].unwrap_or(player.deck[i]);
            match sources[i] {
                Some(a) if a.card_state.free_execute => 0,
                Some(a) => card.caster_price(a),
                None => card.price(0),
            }
        });
        let skill_resource = sources.map(|source| {
            let a = source?;
            let max = a.def.rules?["skill_resource_max"].as_f64()?;
            let spec = a.def.skill.as_ref()?.effects.first()?;
            let needs_full =
                matches!(spec,crate::Effect::CardAbility(s) if s["requires_full_resource"]==true);
            Some((a.card_state.resource, max, needs_full))
        });
        let buttons = sources.map(|source| {
            let a = source?;
            let skill = a.def.skill.as_ref()?;
            Some(ActiveButtonState {
                locked: crate::skills::activation_locked(a, skill, self.tick()),
                cooldown_left: if a.card_state.free_execute {
                    0
                } else {
                    a.next_skill.saturating_sub(self.tick())
                },
                cooldown_total: skill.cooldown,
                free_recast: a.card_state.free_execute,
            })
        });
        let active_wait = sources.map(|a| {
            a.map_or(0, |a| {
                let cooldown = if a.card_state.free_execute {
                    0
                } else {
                    a.next_skill
                };
                a.ready_tick
                    .max(a.card_state.cast_end)
                    .max(cooldown)
                    .saturating_sub(self.tick())
            })
        });
        let side = &self.map.sides[team.index()];
        let front = |offset: f64| {
            side.towers.map(|p| {
                Point::new(
                    p.x,
                    (self.map.arena.height / 2.)
                        + if team == Team::Blue { offset } else { -offset },
                )
            })
        };
        MatchView {
            lane_front: front(self.map.tile_size * 2.5),
            building_front: front(self.map.tile_size * 4.5),
            tile_size: self.map.tile_size,
            arena_width: self.map.arena.width,
            home_zones: side.home.clone(),
            field: if self.laboratory {
                self.battle.snapshot()
            } else {
                self.battle.snapshot_for(team)
            },
            own,
            active_cost,
            skill_resource,
            active_wait,
            buttons,
            remaining_ticks: (if self.overtime {
                self.mode.end
            } else {
                self.mode.regulation
            })
            .saturating_sub(self.tick()),
            overtime: self.overtime,
            result: self.result,
        }
    }
    pub fn drain_events(&mut self) -> impl Iterator<Item = Event> + '_ {
        self.battle.drain_events()
    }
    pub fn schedule(&mut self, input_tick: u64, input: Input) -> Result<u64, MatchError> {
        if self.result.is_some() {
            return Err(MatchError::Finished);
        }
        let due = input_tick
            .checked_add(COMMAND_DELAY)
            .ok_or(MatchError::Timing)?;
        if due <= self.tick() || input_tick > self.tick() + 2 {
            return Err(MatchError::Timing);
        }
        let command = self.reserve(input)?;
        self.pending.push(Scheduled {
            due,
            team: input.team,
            sequence: input.sequence,
            command,
        });
        Ok(due)
    }
    pub fn pending(&self, team: Team) -> impl Iterator<Item = (u64, u64, Option<usize>)> + '_ {
        self.pending
            .iter()
            .filter(move |p| p.team == team)
            .map(|p| {
                (
                    p.sequence,
                    p.due,
                    match p.command {
                        Reserved::Skill { n, .. } => Some(n),
                        _ => None,
                    },
                )
            })
    }
    pub fn take_completions(&mut self) -> Vec<(Team, u64, Result<(), MatchError>)> {
        std::mem::take(&mut self.completed)
    }
    /// Admit commands against the current seat, then advance one authority tick.
    pub fn step(&mut self, inputs: &[Input]) -> Vec<Result<u64, MatchError>> {
        let tick = self.tick();
        self.step_stamped(inputs.iter().map(|input| (tick, *input)))
    }
    /// Network and replay callers retain the original tick observed by the sender.
    pub fn step_stamped(
        &mut self,
        inputs: impl IntoIterator<Item = (u64, Input)>,
    ) -> Vec<Result<u64, MatchError>> {
        let receipts = inputs
            .into_iter()
            .map(|(tick, input)| self.schedule(tick, input))
            .collect();
        self.advance_tick(&[]);
        receipts
    }
    // Mechanism fixtures can start a cast at an exact tick without advancing through admission.
    #[cfg(test)]
    fn step_immediate(&mut self, inputs: &[Input]) -> Vec<Result<(), MatchError>> {
        self.advance_tick(inputs)
    }
    fn advance_tick(&mut self, inputs: &[Input]) -> Vec<Result<(), MatchError>> {
        if self.result.is_some() {
            return vec![Err(MatchError::Finished); inputs.len()];
        }
        let rate = if self.tick() >= self.mode.triple_gold {
            3
        } else if self.tick() >= self.mode.double_gold {
            2
        } else {
            1
        };
        self.battle.begin_step();
        for player in &mut self.players {
            player.advance(rate)
        }
        let mut changes = vec![];
        self.completed.clear();
        for entry in std::mem::take(&mut self.pending) {
            if entry.due <= self.tick() {
                let result = self.execute(entry.command, &mut changes);
                if result.is_err() {
                    if let Reserved::Deploy { team, card, .. } = entry.command {
                        let p = &mut self.players[team.index()];
                        p.gold = (p.gold + card.cost).min(10);
                    }
                }
                self.completed.push((entry.team, entry.sequence, result));
            } else {
                self.pending.push(entry)
            }
        }
        let receipts = inputs
            .iter()
            .map(|i| self.accept(*i, &mut changes))
            .collect();
        self.tick_spells(&mut changes);
        self.battle.commit(changes);
        if !self.laboratory {
            self.wave();
        }
        self.battle.finish_step();
        self.spell_deaths();
        for (seat, extra) in std::mem::take(&mut self.battle.gold_rewards)
            .into_iter()
            .enumerate()
        {
            self.players[seat].gold = self.players[seat].gold.saturating_add(extra).min(10);
        }
        self.collect_income();
        for p in &mut self.players {
            for (members, active) in p.groups.iter_mut().zip(&mut p.active) {
                members.retain(|id| self.battle.actors.contains_key(id));
                if active.is_some_and(|a| !self.battle.actors.contains_key(&a.caster)) {
                    *active =
                        active.and_then(|a| members.first().map(|&caster| Active { caster, ..a }));
                }
            }
        }
        if !self.laboratory {
            self.finish_rules();
        }
        if self.result.is_some() {
            self.completed.extend(
                self.pending
                    .drain(..)
                    .map(|p| (p.team, p.sequence, Err(MatchError::Finished))),
            )
        }
        receipts
    }
    fn accept(
        &mut self,
        i: Input,
        changes: &mut Vec<crate::vitals::Change>,
    ) -> Result<(), MatchError> {
        let cmd = self.reserve(i)?;
        self.execute(cmd, changes)
    }
    /// Validate against the current private seat, settle the payment and bind the
    /// deployment form or caster once. The returned command owns that payment.
    fn reserve(&mut self, i: Input) -> Result<Reserved, MatchError> {
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
                let mirror = matches!(p.deck[index].play, Play::Mirror);
                let mut card = if mirror {
                    p.last_card.ok_or(MatchError::NoAbility)?
                } else {
                    p.deck[index]
                };
                let original = card;
                let p = &self.players[seat];
                let form = self.play_form(p, card, i.team, mirror);
                if !mirror {
                    card.cost = p.deploy_cost(card);
                }
                if index >= 2 {
                    card.skill_uses = 0;
                }
                if p.gold < card.cost {
                    return Err(MatchError::Gold);
                }
                match card.play {
                    Play::RosterUnit(_) | Play::Formation(_) => {
                        self.formation_placements(card, form, i.team, point)?;
                    }
                    Play::Unit(def) => {
                        self.cell(point, i.team, Some(&def()))?;
                    }
                    _ => {
                        let pos = self.cell(point, i.team, None)?;
                        if card.home_deployment() && !self.home_tile(pos, i.team) {
                            return Err(MatchError::Placement);
                        }
                    }
                }
                let player = &mut self.players[seat];
                if !mirror {
                    player.last_form = Some(form);
                    let base = roster::rules()[form]["cost"]
                        .as_u64()
                        .map(|c| c as u8)
                        .unwrap_or_else(|| {
                            battle_cards()
                                .iter()
                                .find(|c| c.key == original.key)
                                .map_or(original.cost, |c| c.cost)
                        });
                    player.last_card = Some(Card {
                        cost: base,
                        ..original
                    });
                }
                player.rotate(slot, card.cost);
                Ok(Reserved::Deploy {
                    team: i.team,
                    index,
                    card,
                    form,
                    point,
                })
            }
            Intent::Activate { slot, aim } => {
                let n = usize::from(slot);
                let active = p
                    .active
                    .get(n)
                    .ok_or(MatchError::Slot)?
                    .ok_or(MatchError::NoAbility)?;

                let carried = p.active_cards[n].unwrap_or(p.deck[n]);
                let source = self
                    .battle
                    .actors
                    .get(&active.caster)
                    .ok_or(MatchError::NoAbility)?;
                if source.def.skill.is_none() {
                    return Err(MatchError::NoAbility);
                }
                let free = source.card_state.free_execute;
                if !free && active.uses == 0 {
                    return Err(MatchError::NoAbility);
                }
                let cost = if free {
                    0
                } else {
                    carried.caster_price(source)
                };

                if p.gold < cost {
                    return Err(MatchError::Gold);
                }
                if crate::skills::activation_locked(
                    source,
                    source.def.skill.as_ref().unwrap(),
                    self.battle.tick,
                ) {
                    return Err(MatchError::Rule(Error::Controlled));
                }
                if !free && source.next_skill > self.battle.tick {
                    return Err(MatchError::Rule(Error::Cooldown));
                }
                if self.pending.iter().any(
                    |cmd| matches!(cmd.command,Reserved::Skill{caster,..} if caster==active.caster),
                ) {
                    return Err(MatchError::NoAbility);
                }
                p.gold -= cost;
                Ok(Reserved::Skill {
                    team: i.team,
                    n,
                    caster: active.caster,
                    aim,
                    cost,
                })
            }
        }
    }
    fn release_card(
        &mut self,
        card: Card,
        form: &'static str,
        team: Team,
        point: Point,
        equipped: bool,
        changes: &mut Vec<crate::vitals::Change>,
    ) -> Result<Vec<Id>, MatchError> {
        match card.play {
            Play::Mirror => unreachable!("mirror must resolve its source before deployment"),
            Play::Formation(_) | Play::RosterUnit(_) => {
                self.deploy_formation(card, form, team, point)
            }
            Play::Unit(make) => {
                let mut def = make();
                if !equipped || card.skill_uses == 0 {
                    def.skill = None;
                }
                let pos = self.cell(point, team, Some(&def))?;
                let id = self.battle.spawn(team, pos, def)?;
                let actor = self.battle.actors.get_mut(&id).unwrap();
                actor.card_state.equipped_skill =
                    card.skill_key.filter(|_| actor.def.skill.is_some());
                actor.ready_tick = self.battle.tick + u64::from(card.deploy_ticks);
                if card.deploy_ticks > 0 {
                    actor.activity = Activity::Deploying;
                }
                Ok(vec![id])
            }
            Play::CardSpell(kind, choice) => {
                let pos = self.cell(point, team, None)?;
                if !self.laboratory
                    && roster::rules()[card.key]["deploy_half_only"] == true
                    && !self.home_tile(pos, team)
                {
                    return Err(MatchError::Placement);
                }
                let cast = spells::SpellCast::new(
                    self,
                    card.key,
                    (equipped && card.skill_key.is_some()).then_some(choice),
                    kind,
                    team,
                    pos,
                );
                self.spells.push(cast);
                Ok(vec![])
            }
            Play::Spell(spell) => {
                let pos = self.cell(point, team, None)?;
                self.spell(team, pos, spell, changes);
                Ok(vec![])
            }
        }
    }
    fn execute(
        &mut self,
        command: Reserved,
        changes: &mut Vec<crate::vitals::Change>,
    ) -> Result<(), MatchError> {
        match command {
            Reserved::Deploy {
                team,
                index,
                card,
                form,
                point,
            } => {
                let ids = self.release_card(card, form, team, point, index < 2, changes)?;
                if index < 2 {
                    let player = &mut self.players[team.index()];
                    player.active_cards[index] = Some(card);
                    player.active[index] =
                        ids.first()
                            .filter(|_| card.skill_uses > 0)
                            .map(|&caster| Active {
                                caster,
                                uses: card.skill_uses,
                            });
                    player.groups[index] = if matches!(card.play, Play::Unit(_)) {
                        vec![]
                    } else {
                        ids
                    };
                }
                Ok(())
            }
            Reserved::Skill {
                team,
                n,
                caster,
                aim,
                cost,
            } => {
                let p = &mut self.players[team.index()];
                let Some(source) = self.battle.actors.get(&caster) else {
                    return Err(MatchError::NoAbility);
                };
                let Some(active) = p.active[n].filter(|a| a.caster == caster) else {
                    return Err(MatchError::NoAbility);
                };
                let carried = p.active_cards[n].unwrap_or(p.deck[n]);
                let free = source.card_state.free_execute;
                let cooldown = source.next_skill;
                if let Err(error) = roster::cast_group(
                    &mut self.battle,
                    team,
                    active.caster,
                    aim,
                    &p.groups[n],
                    changes,
                ) {
                    p.gold = (p.gold + cost).min(10);
                    return Err(error.into());
                }
                if free {
                    let a = self.battle.actors.get_mut(&active.caster).unwrap();
                    a.next_skill = cooldown;
                    a.card_state.free_execute = false;
                }

                p.active[n] = Some(Active {
                    uses: if free {
                        active.uses
                    } else if carried.active_spec()["unlimited_uses"] == true {
                        u8::MAX
                    } else {
                        active.uses - 1
                    },
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
        if self.tick() >= self.mode.regulation && counts[0] != counts[1] {
            self.result = Some(Outcome {
                winner: winner(counts[0] > counts[1], counts[1] > counts[0]),
                reason: EndReason::Towers,
            });
        } else if self.tick() == self.mode.regulation {
            self.overtime = true;
            self.spawn_wave(true, true);
        } else if self.tick() == self.mode.end {
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
        assert_eq!(g.ruined_towers().count(), 0);
        g.battle.actors.remove(&g.towers[1][0]);
        assert_eq!(
            g.ruined_towers().collect::<Vec<_>>(),
            vec![(g.towers[1][0], Team::Red, g.map.sides[1].towers[0])]
        );
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

#[cfg(test)]
mod roster_tests;
