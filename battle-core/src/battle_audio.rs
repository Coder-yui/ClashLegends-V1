//! Read-only presentation identity captured when an action releases.
use crate::{Actor, Battle, Fact, Id, Point, Team};
use serde_json::Value;
use std::sync::LazyLock;

static ACTIONS: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../content/audio_actions.json")).unwrap()
});

#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize)]
pub struct SoundOrigin {
    pub spell: bool,
    pub owner: Id,
    pub kind: &'static str,
    pub team: Team,
    pub form: bool,
    pub action: &'static str,
}

impl Actor {
    pub(crate) fn audio_kind(&self) -> &'static str {
        self.card_state.base_key.unwrap_or(self.def.key)
    }

    pub(crate) fn sound_origin(&self) -> SoundOrigin {
        SoundOrigin {
            spell: false,
            owner: self.id,
            kind: self.audio_kind(),
            team: self.team,
            form: self.card_state.changed_form,
            action: self.card_state.cast_action,
        }
    }
    pub(crate) fn select_cast_action(
        &self,
        skill: &'static Value,
        full: bool,
        stacks: usize,
    ) -> &'static str {
        let id = skill["id"]
            .as_str()
            .or_else(|| skill["name"].as_str())
            .unwrap_or("");
        let lookup =
            |form: bool| ACTIONS.get(format!("{}/{}/{}", self.audio_kind(), u8::from(form), id));
        let data = lookup(self.card_state.changed_form)
            .or_else(|| lookup(false))
            .unwrap_or(&Value::Null);
        if self.def.key == "gnar"
            && self
                .card_state
                .last_visual_form
                .is_some_and(|(tick, _, active)| active && tick == self.card_state.cast_start)
        {
            return "transform_active";
        }
        if let Some(actions) = data["resource_visual_actions"].as_array() {
            if let Some(name) = actions
                .get(stacks.min(actions.len().saturating_sub(1)))
                .and_then(Value::as_str)
            {
                return name;
            }
        }
        if let Some(actions) = data["visual_actions_by_use"]
            .as_array()
            .filter(|a| !a.is_empty())
        {
            return actions[self.card_state.use_number.saturating_sub(1) as usize % actions.len()]
                .as_str()
                .unwrap_or("");
        }
        if full {
            if let Some(name) = data["full_resource_visual_action"].as_str() {
                return name;
            }
        }
        data["visual_action"].as_str().unwrap_or("")
    }
}
impl Battle {
    pub(crate) fn sound(
        &mut self,
        source: SoundOrigin,
        phase: &'static str,
        point: Point,
        target: Option<Id>,
    ) {
        let Some(phase) = crate::audio_layers::cue(source, phase) else {
            return;
        };
        self.emit(Fact::Sound {
            source,
            phase,
            position: point,
            target,
        });
    }
    pub(crate) fn unit_sound(&mut self, id: Id, phase: &'static str, target: Option<Id>) {
        if let Some(a) = self.actors.get(&id) {
            let pos = target
                .and_then(|t| self.actors.get(&t))
                .map_or(a.pos, |t| t.pos);
            self.sound(a.sound_origin(), phase, pos, target);
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, serde::Serialize)]
pub struct AttackSound {
    pub segment: u32,
    pub form: bool,
    pub cycle: u32,
    pub first: bool,
    pub empowered: bool,
    pub buff: bool,
    pub immune: bool,
}
impl Actor {
    pub(crate) fn attack_sound(&self, tick: u64) -> AttackSound {
        let a = self.attack;
        AttackSound {
            form: self.card_state.changed_form,
            segment: a.map_or(0, |t| t.segment),
            cycle: a.map_or(1, |t| t.cycle),
            first: a.is_some_and(|t| t.first),
            empowered: a.is_some_and(|t| t.empowered),
            buff: self.active_skill_buff(tick),
            immune: self.card_state.immunity > tick,
        }
    }
}
