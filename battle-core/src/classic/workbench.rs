//! A private practice field. Deployment, spells, animation facts and combat run
//! through the same implementations as a match, without seats or a lane clock.
use super::*;
use crate::{Action, Id};
use serde_json::{json, Value};

// The host's integration tests seed rare card states, then use ordinary battle ticks and inputs.
#[cfg(feature = "scenario-fixtures")]
#[doc(hidden)]
pub mod fixtures;

pub struct Workbench {
    game: ClassicMatch,
    groups: Vec<Vec<Id>>,
    last: [Option<(Card, &'static str)>; 2],
}

pub fn objects() -> Vec<Value> {
    roster::rules().as_object().unwrap().iter()
        .filter(|(_, rule)| rule["selectable"] == false && rule["hp"].is_number())
        .map(|(id, r)| {
            let skills: Vec<_> = r["active_skills"].as_array().into_iter().flatten()
                .map(|s| json!({"id":s["id"].as_str().or(s["name"].as_str()),"name":s["name"],"description":s["description"].as_str().unwrap_or("")})).collect();
            json!({"id":id,"name":r["name"],"type":"system","cost":0,"description":format!("生命 {} · 射程 {} · 移速 {}",r["hp"],r["range"].as_f64().unwrap_or(0.),r["speed"].as_f64().unwrap_or(0.)),"image":"","skills":skills})
        }).collect()
}

impl Workbench {
    pub fn new() -> Self {
        let mut game =
            ClassicMatch::new(1, [representative_deck(); 2]).expect("classic practice map");
        game.laboratory = true;
        Self {
            game,
            groups: vec![],
            last: [None; 2],
        }
    }

    /// Clear transient combat and card history while keeping the state of the map objectives.
    pub fn cleared(&self) -> Self {
        let mut fresh = Self::new();
        fresh.game.battle.actors.retain(|id, actor| {
            if let Some(old) = self.game.battle.actors.get(id) {
                actor.hp = old.hp;
                true
            } else {
                false
            }
        });
        fresh
    }

    pub fn transform(&mut self, id: Id) -> Result<(), MatchError> {
        let actor = self
            .game
            .battle
            .actors
            .get(&id)
            .ok_or(MatchError::NoAbility)?;
        if !matches!(actor.def.key, "aatrox" | "gnar")
            || !self.game.battle.switch_card_form(id, true)
        {
            return Err(MatchError::NoAbility);
        }
        Ok(())
    }

    pub fn game(&self) -> &ClassicMatch {
        &self.game
    }

    pub fn facts(&mut self) -> Vec<Event> {
        self.game.drain_events().collect()
    }

    pub fn step(&mut self) {
        self.game.step(&[]);
        self.groups.retain_mut(|members| {
            members.retain(|id| self.game.battle.actors.contains_key(id));
            !members.is_empty()
        });
    }

    pub fn batch(&self, id: Id) -> Option<&[Id]> {
        self.groups
            .iter()
            .find(|members| members.contains(&id))
            .map(Vec::as_slice)
    }

    pub fn equipped(&self, id: Id) -> Option<&'static str> {
        self.game.battle.actors.get(&id)?.card_state.equipped_skill
    }

    pub fn deploy(
        &mut self,
        key: &str,
        skill: Option<&str>,
        team: Team,
        point: Point,
    ) -> Result<Option<Id>, MatchError> {
        if self.game.battle.actors.len() >= 192 || self.game.spells.len() >= 128 {
            return Err(MatchError::Slot);
        }
        let pos = self.game.cell(point, team, None)?;
        if key == "training_dummy" {
            let def = UnitDef {
                key: "training_dummy",
                hp: 1_000_000,
                role: Role::Building,
                radius: 18.,
                mass: 1000.,
                speed: 0.,
                range: 0.,
                sight: 0.,
                action: Action::Idle,
                ..UnitDef::melee()
            };
            return Ok(Some(self.game.battle.spawn(team, pos, def)?));
        }
        let (mut card, form) = if key == "mirror" {
            self.last[team.index()].ok_or(MatchError::NoAbility)?
        } else {
            let mut choices = battle_cards().iter().filter(|c| c.key == key);
            let card = if let Some(first) = choices.next() {
                std::iter::once(first)
                    .chain(choices)
                    .find(|c| skill.is_none() || c.skill_key == skill)
                    .copied()
                    .ok_or(MatchError::Loadout)?
            } else {
                let (key, rule) = roster::rules()
                    .as_object()
                    .unwrap()
                    .get_key_value(key)
                    .filter(|(_, r)| r["hp"].is_number())
                    .ok_or(MatchError::Loadout)?;
                let choice = match skill {
                    Some(id) => rule["active_skills"]
                        .as_array()
                        .and_then(|a| {
                            a.iter()
                                .position(|s| s["id"].as_str().or(s["name"].as_str()) == Some(id))
                        })
                        .ok_or(MatchError::Loadout)?,
                    None => 0,
                };
                Card {
                    key,
                    play: Play::RosterUnit(choice),
                    cost: 0,
                    deploy_ticks: units::ticks(units::stat(rule, "deploy_time", 1.)),
                    skill_key: rule["active_skills"][choice]["id"]
                        .as_str()
                        .or(rule["active_skills"][choice]["name"].as_str()),
                    skill_cost: 0,
                    skill_uses: 1,
                }
            };
            (
                card,
                self.game.battle.deployment_form(card.key, team, card.cost),
            )
        };
        if skill.is_none() {
            card.skill_uses = 0;
            card.skill_key = None;
        }
        let mut changes = vec![];
        let ids = self.game.release_card(
            card,
            form,
            team,
            point,
            card.skill_key.is_some(),
            &mut changes,
        )?;
        // Lab edits can arrive between ticks. Resolve the new spell's initial tick
        // exactly once, including instantaneous fields and the first lightning strike.
        if matches!(card.play, Play::CardSpell(..)) {
            if let Some(mut spell) = self.game.spells.pop() {
                spell.run(&mut self.game, &mut changes, &mut Default::default());
                if spell.active_after(&self.game) {
                    self.game.spells.push(spell);
                }
            }
        }
        self.game.battle.commit(changes);
        self.game.spell_deaths();
        if key != "mirror" {
            self.last[team.index()] = Some((card, form));
        }
        let first = ids.first().copied();
        if first.is_some() {
            self.groups.push(ids);
        }
        Ok(first)
    }

    pub fn cast(&mut self, id: Id) -> Result<(), MatchError> {
        let actor = self
            .game
            .battle
            .actors
            .get(&id)
            .ok_or(MatchError::NoAbility)?;
        let team = actor.team;
        let free = actor.card_state.free_execute;
        let members = self.batch(id).unwrap_or(std::slice::from_ref(&id)).to_vec();
        let mut changes = vec![];
        roster::cast_group(
            &mut self.game.battle,
            team,
            id,
            Aim::Instant,
            &members,
            &mut changes,
        )?;
        // cast_group sets the cooldown on the whole formation. Lab casts can
        // be repeated once the ordinary action and control locks have ended.
        for member in &members {
            if let Some(actor) = self.game.battle.actors.get_mut(member) {
                actor.next_skill = 0;
            }
        }
        if free {
            self.game
                .battle
                .actors
                .get_mut(&id)
                .unwrap()
                .card_state
                .free_execute = false;
        }
        self.game.battle.commit(changes);
        self.game.spell_deaths();
        Ok(())
    }
    pub fn control(&mut self, id: Id, control: Control) -> Result<(), MatchError> {
        self.game.battle.control(id, control, 20)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_catalog_choice_and_system_object_can_enter_a_paused_field() {
        let pos = Point::new(340., 420.);
        for c in battle_cards() {
            if matches!(c.play, Play::Mirror) {
                continue;
            }
            let mut world = Workbench::new();
            world
                .deploy(c.key, c.skill_key, Team::Blue, pos)
                .unwrap_or_else(|e| panic!("{} {:?}: {e:?}", c.key, c.skill_key));
            assert_eq!(world.game().tick(), 0);
        }
        for entry in objects() {
            let key = entry["id"].as_str().unwrap();
            if battle_cards().iter().any(|c| c.key == key) {
                continue;
            }
            let skills = entry["skills"].as_array().unwrap();
            for choice in std::iter::once(None).chain(skills.iter().map(|s| s["id"].as_str())) {
                let mut world = Workbench::new();
                let id = world.deploy(key, choice, Team::Red, pos).unwrap().unwrap();
                assert_eq!(world.equipped(id), choice, "{key}");
                world.step();
            }
        }
    }

    #[test]
    fn selections_keep_their_group_and_mirror_history_is_per_team() {
        let mut w = Workbench::new();
        let pos = Point::new(340., 820.);
        let a = w
            .deploy(
                "melee_minion_squad",
                Some("melee_minion_squad.hand-of-baron"),
                Team::Blue,
                pos,
            )
            .unwrap()
            .unwrap();
        let squad = w.batch(a).unwrap().to_vec();
        assert!(squad.len() > 1);
        assert!(w.deploy("mirror", Some("mirror"), Team::Red, pos).is_err());
        let b = w
            .deploy("mirror", Some("mirror"), Team::Blue, Point::new(500., 820.))
            .unwrap()
            .unwrap();
        assert!(w.batch(b).unwrap().iter().all(|id| !squad.contains(id)));
        for _ in 0..21 {
            w.step();
        }
        w.cast(squad[1]).unwrap();
        w.cast(a).unwrap();
        w.cast(squad[1]).unwrap();
        w.control(squad[1], Control::Freeze).unwrap();
        assert!(w.game.battle.actors[&squad[1]].has(Control::Freeze));
        assert!(!w.game.battle.actors[&a].has(Control::Freeze));
    }

    #[test]
    fn sandbox_runs_past_regulation_without_waves_or_a_result() {
        let mut w = Workbench::new();
        for tick in [99, w.game.mode.regulation - 1, w.game.mode.end] {
            w.game.battle.tick = tick;
            w.step();
            assert_eq!(w.game().view(Team::Blue).field.units.len(), 6);
            assert!(w.game().result().is_none());
        }
    }
}
