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
impl Catalog {
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
        if deck.cards.len() != 8 {
            return Err(fail("经典模式需要八张卡牌"));
        }
        let mut seen = HashSet::new();
        for (pos, key) in deck.cards.iter().enumerate() {
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
    pub player: String,
    pub name: String,
    pub deck: Deck,
    pub ready: bool,
    pub version: i64,
    pub ai: bool,
    pub online: bool,
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
            .map(|s| json!({"name":s.name,"ready":s.ready,"online":s.online,"ai":s.ai}))
            .collect();
        Ok(json!({
            "id": self.id, "code": self.code, "kind": self.kind,
            "mode": self.mode, "map": self.map, "round": self.round,
            "revision": self.revision, "settingsVersion": self.settings_version,
            "status": self.status, "matchId": self.match_id, "seats": seats,
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
            self.mode = mode;
            self.map = map;
            self.settings_version += 1;
            self.reset_ready();
        }
        Ok(())
    }
    pub fn freeze(&mut self, catalog: &Catalog) -> Result<Value> {
        catalog.settings(&self.mode, &self.map)?;
        let mut seats = Vec::new();
        for (team, s) in self.seats.iter().enumerate() {
            catalog.check(&s.deck)?;
            seats
                .push(json!({"team":team,"player":s.player,"name":s.name,"ai":s.ai,"deck":s.deck}));
        }
        let match_id = id();
        self.status = "locked".into();
        self.match_id = Some(match_id.clone());
        Ok(json!({
            "id":match_id, "roomId":self.id, "round":self.round, "kind":self.kind,
            "mode":self.mode, "map":self.map, "contentVersion":catalog.version,
            "rulesVersion":"classic-v1", "seed":id(), "seats":seats
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn catalog() -> Catalog {
        serde_json::from_str(include_str!("../../content/catalog.json")).unwrap()
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
