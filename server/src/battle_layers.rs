//! Seat-local phase edges enter the reliable window. A reconnect receives the elapsed phase.
use clash_battle_core::{AudioState, Fact, Id, Point, Snapshot, Team};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Copy)]
struct Layer {
    state: AudioState,
    owner: Id,
    form: bool,
    team: Team,
    start: u64,
}

impl Layer {
    fn cue(self, phase: &str) -> Value {
        json!({"kind":self.state.kind,"owner":self.owner,"team":self.team.index(),"form":self.form,
            "phase":phase,"position":self.state.position,"key":self.start})
    }
}
#[derive(Default)]
pub(super) struct Layers {
    current: BTreeMap<(Id, &'static str, &'static str), Layer>,
    last_tick: Option<u64>,
}
impl Layers {
    pub fn snapshot(&self) -> Vec<Value> {
        self.current
            .values()
            .filter_map(|l| {
                let mut v = l.cue(l.state.family.sustain?);
                v["loop"] = json!(l.state.looping);
                Some(v)
            })
            .collect()
    }
    pub fn advance(
        &mut self,
        field: &Snapshot,
        last: &super::sound::Scene,
        facts: &[clash_battle_core::Event],
    ) -> Vec<Value> {
        let mut next = BTreeMap::new();
        let mut sounds = Vec::new();
        let casts: BTreeSet<_> = facts
            .iter()
            .filter_map(|e| match e.fact {
                Fact::Cast { caster, .. } => Some(caster),
                _ => None,
            })
            .collect();
        for u in &field.units {
            for &state in &u.audio_states {
                let key = (u.id, state.kind, state.name);
                let old = self.current.remove(&key);
                let form = u.form_changed && u.audio_kind == state.kind;
                let mut layer = Layer {
                    state,
                    owner: u.id,
                    form,
                    team: u.team,
                    start: field.tick,
                };
                let continuing = old.filter(|old| {
                    old.state.serial == state.serial && old.state.family == state.family
                });
                if let Some(old) = continuing {
                    layer.start = old.start;
                } else {
                    if let Some(old) = old {
                        sounds.extend(old.state.family.end.iter().map(|cue| old.cue(cue)));
                    }
                    if (state.action || state.name == "heal_aura") && state.serial <= field.tick {
                        layer.start = state.serial;
                    }
                    let just_cast =
                        state.action && casts.contains(&u.id) && state.name == u.cast_action;
                    if !just_cast && state.name != "deploy" && layer.start == field.tick {
                        sounds.extend(state.family.start.iter().map(|cue| layer.cue(cue)));
                    }
                }
                for (offset, phase) in &state.family.timed {
                    if layer.start + offset == field.tick
                        && (continuing.is_none() || self.last_tick != Some(field.tick))
                    {
                        let mut cue = layer.cue(phase);
                        cue["timed"] = json!(true);
                        sounds.push(cue);
                    }
                }
                next.insert(key, layer);
            }
        }
        let visible: BTreeMap<Id, Point> = field.units.iter().map(|u| (u.id, u.position)).collect();
        for (_, mut old) in std::mem::replace(&mut self.current, next) {
            if let Some(&pos) = visible.get(&old.owner) {
                if old.state.name != "sanctuary" {
                    old.state.position = pos;
                }
                sounds.extend(old.state.family.end.iter().map(|cue| old.cue(cue)));
            } else if old.state.name == "continuous_attack"
                && last.units.contains_key(&old.owner)
                && facts.iter().any(|e| e.fact == Fact::Died(old.owner))
            {
                sounds.extend(old.state.family.end.iter().map(|cue| old.cue(cue)));
            }
        }
        self.last_tick = Some(field.tick);
        sounds
    }
}
