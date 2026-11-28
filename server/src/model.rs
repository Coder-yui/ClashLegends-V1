use rand::seq::{IndexedRandom, SliceRandom};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};

use crate::{fail, id, Result};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub version: String,
    pub cards: Vec<Card>,
    pub default_deck: Vec<String>,
    pub modes: Vec<Mode>,
}
#[derive(Clone, Deserialize)]
pub struct Card {
    #[serde(rename = "type")]
    pub kind: String,
    pub id: String,
    pub skills: Vec<Skill>,
}
#[derive(Clone, Deserialize)]
pub struct Skill {
    pub id: String,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mode {
    pub id: String,
    pub map_ids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Deck {
    pub cards: Vec<String>,
    pub skills: BTreeMap<String, String>,
}
pub fn collection_catalog() -> Value {
    let mut catalog: Value =
        serde_json::from_str(include_str!("../../content/catalog.json")).unwrap();
    let art: BTreeMap<String, Value> =
        serde_json::from_str(include_str!("../../content/card_art.json")).unwrap();
    for card in catalog["cards"].as_array_mut().unwrap() {
        if let Some(entry) = card["id"].as_str().and_then(|id| art.get(id)) {
            card["image"] = entry["image"].clone();
        }
    }
    catalog
}

pub fn battle_catalog() -> Value {
    let mut catalog = collection_catalog();
    let test_maps = std::env::var("LOBBY_TEST_MAP").as_deref() == Ok("1");
    let maps: Vec<_> = clash_battle_core::classic::maps()
        .iter()
        .filter(|m| test_maps || !m.test_only)
        .collect();
    catalog["modes"] = json!(clash_battle_core::classic::modes()
        .iter()
        .map(|mode| {
            let ids: Vec<_> = mode
                .map_ids
                .iter()
                .filter(|id| maps.iter().any(|m| &&m.id == id))
                .collect();
            json!({"id":mode.id,"name":mode.name,"mapIds":ids})
        })
        .collect::<Vec<_>>());
    catalog["maps"] = json!(maps);
    let deck = clash_battle_core::classic::battle_cards();
    let cards = catalog["cards"].as_array_mut().unwrap();
    cards.retain(|entry| deck.iter().any(|card| entry["id"] == card.key));
    for entry in cards {
        let card = deck.iter().find(|card| entry["id"] == card.key).unwrap();
        entry["cost"] = json!(card.cost);
        entry["skillCost"] = json!(card.skill_cost);
        entry["homeDeployment"] = json!(card.home_deployment());
        entry["skills"].as_array_mut().unwrap().retain_mut(|skill| {
            let Some(choice) = deck
                .iter()
                .find(|c| c.key == card.key && skill["id"].as_str() == c.skill_key)
            else {
                return false;
            };
            skill["cost"] = json!(choice.skill_cost);
            true
        });
    }
    catalog["defaultDeck"] =
        json!(clash_battle_core::classic::representative_deck().map(|card| card.key));
    catalog["version"] = json!(clash_battle_core::classic::replay::CONTENT_VERSION);
    catalog
}

impl Catalog {
    pub fn room_deck(&self, mut deck: Deck) -> Option<Deck> {
        deck.skills.retain(|id, _| {
            self.cards
                .iter()
                .any(|c| &c.id == id && !c.skills.is_empty())
        });
        for key in &deck.cards {
            if !deck.skills.contains_key(key) {
                if let Some(first) = self
                    .cards
                    .iter()
                    .find(|c| &c.id == key)
                    .and_then(|c| c.skills.first())
                {
                    deck.skills.insert(key.clone(), first.id.clone());
                }
            }
        }
        self.check(&deck).ok().map(|_| deck)
    }
    pub fn default_loadout(&self) -> Deck {
        let mut result = Deck {
            cards: self.default_deck.clone(),
            skills: BTreeMap::new(),
        };
        for card in &self.cards {
            if result.cards.contains(&card.id) {
                if let Some(first) = card.skills.first() {
                    result.skills.insert(card.id.clone(), first.id.clone());
                }
            }
        }
        result
    }
    pub fn ai_loadout(&self) -> Result<Deck> {
        let mut rng = rand::rng();
        let mut picks = Vec::new();
        for (kind, count) in [("unit", 6), ("building", 1), ("spell", 1)] {
            let mut group: Vec<_> = self.cards.iter().filter(|card| card.kind == kind).collect();
            group.shuffle(&mut rng);
            picks.extend(group.into_iter().take(count));
        }
        picks.shuffle(&mut rng);
        picks.sort_by_key(|card| card.skills.is_empty());
        let skills = picks
            .iter()
            .filter_map(|card| {
                card.skills
                    .choose(&mut rng)
                    .map(|skill| (card.id.clone(), skill.id.clone()))
            })
            .collect();
        let result = Deck {
            cards: picks.into_iter().map(|card| card.id.clone()).collect(),
            skills,
        };
        self.check(&result)?;
        Ok(result)
    }
    pub fn check(&self, deck: &Deck) -> Result<()> {
        self.check_slots(deck, false)
    }
    pub fn check_preset(&self, deck: &Deck) -> Result<()> {
        self.check_slots(deck, true)
    }
    fn check_slots(&self, deck: &Deck, allow_empty: bool) -> Result<()> {
        let deck_size = clash_battle_core::classic::modes()
            .iter()
            .find(|m| m.id == "classic")
            .expect("classic mode")
            .deck_size;
        if deck.cards.len() != deck_size {
            return Err(fail("经典模式需要八张卡牌"));
        }
        let mut seen = HashSet::new();
        for (pos, key) in deck.cards.iter().enumerate() {
            if allow_empty && key.is_empty() {
                continue;
            }
            let reason = || fail(format!("请检查第 {} 个卡位的卡牌或技能", pos + 1));
            let card = self
                .cards
                .iter()
                .find(|c| c.id == *key)
                .ok_or_else(reason)?;
            if !seen.insert(key) {
                return Err(fail(format!("第 {} 个卡位与前面重复", pos + 1)));
            }
            match deck.skills.get(key) {
                Some(choice) if card.skills.iter().any(|s| s.id == *choice) => (),
                None if card.skills.is_empty() => (),
                _ => return Err(reason()),
            }
        }
        if deck.skills.keys().any(|k| !seen.contains(k)) {
            return Err(fail("技能必须属于本局卡组"));
        }
        Ok(())
    }
    pub fn settings(&self, mode: &str, map: &str) -> Result<()> {
        if self
            .modes
            .iter()
            .any(|m| m.id == mode && m.map_ids.iter().any(|x| x == map))
        {
            Ok(())
        } else {
            Err(fail("模式与地图不兼容"))
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Seat {
    #[serde(default)]
    pub slot: Option<usize>,
    pub player: String,
    pub name: String,
    pub deck: Deck,
    pub ready: bool,
    pub version: i64,
    pub ai: bool,
    pub online: bool,
}
impl Seat {
    fn display_name(&self) -> &str {
        if self.ai {
            "电脑玩家"
        } else {
            &self.name
        }
    }
    pub fn computer(catalog: &Catalog, slot: usize) -> Result<Self> {
        Ok(Self {
            slot: Some(slot),
            player: format!("computer/{}", id()),
            name: "电脑玩家".into(),
            deck: catalog.ai_loadout()?,
            ready: true,
            version: 1,
            ai: true,
            online: true,
        })
    }
}
pub fn opponent_names(seats: &[Value], seat: usize) -> String {
    seats
        .iter()
        .enumerate()
        .filter(|(i, _)| i % 2 != seat % 2)
        .filter_map(|(_, s)| {
            if s["ai"] == true {
                Some("电脑玩家")
            } else {
                s["name"].as_str()
            }
        })
        .collect::<Vec<_>>()
        .join("、")
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Room {
    pub id: String,
    pub code: String,
    pub kind: String,
    pub mode: String,
    pub map: String,
    pub round: i32,
    pub settings_version: i64,
    pub revision: i64,
    pub status: String,
    pub match_id: Option<String>,
    pub seats: Vec<Seat>,
}
impl Room {
    pub fn capacity(&self) -> usize {
        clash_battle_core::classic::seat_count(&self.mode)
    }
    pub fn slot(&self, index: usize) -> usize {
        self.seats[index].slot.unwrap_or(index)
    }
    pub fn occupant(&self, slot: usize) -> Option<usize> {
        (0..self.seats.len()).find(|&i| self.slot(i) == slot)
    }
    pub fn roster_changed(&mut self) {
        self.settings_version += 1;
        self.reset_ready();
    }
    pub fn place(
        &mut self,
        action: &str,
        actor: usize,
        slot: usize,
        catalog: &Catalog,
    ) -> Result<()> {
        if self.mode != "2v2" || slot >= self.capacity() {
            return Err(fail("对战席位无效"));
        }
        let occupant = self.occupant(slot);
        match (action, occupant) {
            ("addComputer", None) if actor == 0 => self.seats.push(Seat::computer(catalog, slot)?),
            ("removeComputer", Some(i)) if actor == 0 && self.seats[i].ai => {
                self.seats.remove(i);
            }
            ("swap", Some(i)) if actor == 0 && i != actor => {
                let previous = self.slot(actor);
                self.seats[i].slot = Some(previous);
                self.seats[actor].slot = Some(slot);
            }
            ("move", None) => self.seats[actor].slot = Some(slot),
            _ => return Err(fail("无法更改该席位")),
        }
        self.roster_changed();
        Ok(())
    }
    pub fn index(&self, player: &str) -> Result<usize> {
        self.seats
            .iter()
            .position(|s| s.player == player)
            .ok_or_else(|| fail("你没有这个房间的席位"))
    }
    pub fn view(&self, player: &str) -> Result<Value> {
        let i = self.index(player)?;
        let seats: Vec<_> = self
            .seats
            .iter()
            .enumerate()
            .map(|(i, s)| {
                json!({
                    "name": s.display_name(), "ready": s.ready, "online": s.online,
                    "ai": s.ai, "slot": self.slot(i)
                })
            })
            .collect();
        Ok(json!({
            "id": self.id, "code": self.code, "kind": self.kind,
            "mode": self.mode, "map": self.map, "round": self.round,
            "revision": self.revision, "settingsVersion": self.settings_version,
            "status": self.status, "matchId": self.match_id, "seats": seats, "capacity":self.capacity(),
            "me": i, "deck": self.seats[i].deck, "deckVersion": self.seats[i].version
        }))
    }
    pub fn reset_ready(&mut self) {
        for seat in &mut self.seats {
            seat.ready = seat.ai;
        }
    }
    pub fn change_settings(&mut self, catalog: &Catalog, mode: String, map: String) -> Result<()> {
        catalog.settings(&mode, &map)?;
        if self.mode != mode || self.map != map {
            if mode != self.mode {
                if mode != "2v2" {
                    if self.seats.len() > 2
                        || (self.seats.len() == 2 && self.slot(0) % 2 == self.slot(1) % 2)
                    {
                        return Err(fail("切回 1v1 前，请调整为每队最多一名玩家"));
                    }
                    for (i, seat) in self.seats.iter_mut().enumerate() {
                        seat.slot = Some(i);
                    }
                } else {
                    self.kind = "friend".into();
                }
            }
            self.mode = mode;
            self.map = map;
            self.settings_version += 1;
            self.reset_ready();
        }
        Ok(())
    }
    pub fn migrate_decks(&mut self, catalog: &Catalog) -> Result<bool> {
        let mut changed = false;
        for seat in &mut self.seats {
            if catalog.check(&seat.deck).is_ok() {
                continue;
            }
            seat.deck = match catalog.room_deck(seat.deck.clone()) {
                Some(deck) => deck,
                None if seat.ai => catalog.ai_loadout()?,
                None => catalog.default_loadout(),
            };
            seat.version += 1;
            changed = true;
        }
        if changed {
            self.reset_ready();
        }
        Ok(changed)
    }
    pub fn freeze(&mut self, catalog: &Catalog) -> Result<Value> {
        catalog.settings(&self.mode, &self.map)?;
        let mut seats = Vec::new();
        if self.seats.len() != self.capacity() {
            return Err(fail("请等待所有席位入座"));
        }
        for slot in 0..self.capacity() {
            let s = &self.seats[self.occupant(slot).ok_or_else(|| fail("席位配置无效"))?];
            let team = clash_battle_core::classic::seat_team(slot).index();
            catalog.check(&s.deck)?;
            seats
                .push(json!({"team":team,"player":s.player,"name":s.display_name(),"ai":s.ai,"deck":s.deck}));
        }
        let match_id = id();
        self.status = "locked".into();
        self.match_id = Some(match_id.clone());
        Ok(json!({
            "id":match_id, "roomId":self.id, "round":self.round, "kind":self.kind,
            "mode":self.mode, "map":self.map, "contentVersion":catalog.version,
            "rulesVersion":clash_battle_core::classic::replay::RULESET, "seed":id(), "seats":seats
        }))
    }
}

/// The private part of the manifest can only depend on this seat's frozen deck.
pub(crate) fn match_model_resources(
    deck: &Value,
    team: usize,
) -> std::collections::BTreeSet<&'static str> {
    static INDEX: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    let index = INDEX.get_or_init(|| {
        serde_json::from_str(include_str!("../../content/model_resources.json")).unwrap()
    });
    let mut files = std::collections::BTreeSet::new();
    let mut add = |paths: &'static Value| {
        if let Some(paths) = paths.as_array() {
            files.extend(paths.iter().filter_map(Value::as_str));
        }
    };
    for id in [
        "princess_tower",
        "nexus",
        "melee_minion",
        "ranged_minion",
        "super_minion",
        "siege_minion",
    ] {
        for side in [0, 1] {
            add(&index[id][side]["base"]);
        }
    }
    let cards = deck["cards"].as_array().unwrap();
    let active_mirror = cards.iter().take(2).any(|c| c == "mirror");
    for (slot, id) in cards.iter().filter_map(Value::as_str).enumerate() {
        let entry = &index[id][team];
        add(&entry["base"]);
        if slot < 2 || active_mirror {
            if let Some(skill) = deck["skills"][id].as_str() {
                add(&entry[skill]);
            }
        }
    }
    files
}

#[cfg(test)]
mod tests {
    use super::*;
    fn catalog() -> Catalog {
        serde_json::from_str(include_str!("../../content/catalog.json")).unwrap()
    }

    #[test]
    fn each_seat_prepares_public_armies_and_only_its_own_active_packs() {
        let plain = json!({"deck":{"cards":["heal","zap","ashe"],"skills":{"ashe":"ashe.volley"}}});
        let other = json!({"deck":{"cards":["gold_ward","void_gate"],"skills":{}}});
        let base = match_model_resources(&plain["deck"], 0);
        assert!(base.contains("ashe") && !base.contains("void_gate"));
        assert!(!base.contains("ashe-volley") && !base.contains("ashe-review"));
        for active in [
            json!(["ashe", "heal", "zap"]),
            json!(["mirror", "heal", "ashe"]),
        ] {
            let mut deck = plain.clone();
            deck["deck"]["cards"] = active;
            let full = match_model_resources(&deck["deck"], 1);
            assert!(full.contains("ashe-volley") && !full.contains("ashe-review"));
        }
        assert!(!match_model_resources(&other["deck"], 1).contains("ashe"));
    }

    #[test]
    fn classic_rejects_duplicate_cards_and_foreign_skills() {
        let c = catalog();
        let mut deck = c.default_loadout();
        deck.cards[7] = deck.cards[0].clone();
        assert!(c.check(&deck).is_err());
        let mut deck = c.default_loadout();
        deck.skills
            .insert(deck.cards[0].clone(), "other-skill".into());
        assert!(c.check(&deck).is_err());
        for _ in 0..32 {
            assert!(c.ai_loadout().is_ok());
        }
    }

    #[test]
    fn changing_to_another_compatible_map_invalidates_both_confirmations() {
        let mut c = catalog();
        c.modes[0].map_ids.push("fixture-map".into());
        let seat = Seat {
            slot: None,
            player: id(),
            name: "tester".into(),
            deck: c.default_loadout(),
            ready: true,
            version: 1,
            ai: false,
            online: true,
        };
        let mut room = Room {
            id: id(),
            code: id(),
            kind: "friend".into(),
            mode: "classic".into(),
            map: "rift".into(),
            round: 1,
            settings_version: 1,
            revision: 1,
            status: "open".into(),
            match_id: None,
            seats: vec![seat.clone(), seat],
        };
        assert!(room
            .change_settings(&c, "classic".into(), "missing".into())
            .is_err());
        assert!(room.seats.iter().all(|s| s.ready));
        assert!(room
            .change_settings(&c, "classic".into(), "fixture-map".into())
            .is_ok());
        assert!(room.seats.iter().all(|s| !s.ready));
        assert_eq!(room.settings_version, 2);
    }
}
