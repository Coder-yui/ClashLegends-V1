//! Native cue families are indexed once. Snapshots expose only active audible phases.
use crate::{Activity, Actor, Control, Point, Team};
use std::collections::BTreeMap;
use std::sync::LazyLock;

#[derive(Debug, Default, PartialEq)]
pub struct Family {
    pub start: Vec<&'static str>,
    pub end: Vec<&'static str>,
    pub sustain: Option<&'static str>,
    pub timed: Vec<(u64, &'static str)>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AudioState {
    pub kind: &'static str,
    pub name: &'static str,
    pub family: &'static Family,
    pub serial: u64,
    pub position: Point,
    pub looping: bool,
    pub action: bool,
}

#[derive(serde::Deserialize)]
struct Index<'a> {
    #[serde(borrow)]
    variants: BTreeMap<&'a str, BTreeMap<&'a str, BTreeMap<&'a str, usize>>>,
    #[serde(borrow)]
    profiles: Vec<BTreeMap<&'a str, Option<f64>>>,
}
type Families = BTreeMap<&'static str, Family>;
static INDEX: LazyLock<(Index<'static>, Vec<Families>)> = LazyLock::new(|| {
    let index: Index =
        serde_json::from_str(include_str!("../../content/audio_events.json")).unwrap();
    let families = index
        .profiles
        .iter()
        .map(|events| {
            let mut families = Families::new();
            for (&cue, &time) in events {
                let (name, phase) = match cue {
                    "rebirth:ready" => ("rebirth_ready", "start"),
                    "resource_full" => ("resource", "start"),
                    "empowered_ready" => ("empowered_buff", "start"),
                    "spell:zone_sustain" => ("tower_disable", "sustain"),
                    "spell:shield_end" => ("pool_shield", "end"),
                    _ => match cue.split_once(':') {
                        Some(v) => v,
                        None => continue,
                    },
                };
                let group = families.entry(name).or_default();
                if let Some(time) = time {
                    group
                        .timed
                        .push(((time * 20. - 1e-8).ceil().max(0.) as u64, cue));
                    continue;
                }
                match phase {
                    "start" | "voice" => group.start.push(cue),
                    "enter" if matches!(name, "terrain" | "stealth" | "dormant") => {
                        group.start.push(cue)
                    }
                    "release" if name == "continuous_attack" => group.start.push(cue),
                    "end" | "exit" => group.end.push(cue),
                    "sustain" => group.sustain = Some(cue),
                    _ => (),
                }
            }
            families
        })
        .collect();
    (index, families)
});
fn families(kind: &str, form: bool, team: Team) -> Option<&'static Families> {
    let forms = INDEX.0.variants.get(kind)?;
    let pair = forms
        .get(if form { "1" } else { "0" })
        .or_else(|| forms.get("0"))?;
    INDEX
        .1
        .get(*pair.get(if team == Team::Blue { "0" } else { "1" })?)
}

pub(crate) fn cue(origin: crate::SoundOrigin, name: &str) -> Option<&'static str> {
    let forms = INDEX.0.variants.get(origin.kind)?;
    let pair = forms
        .get(if origin.form { "1" } else { "0" })
        .or_else(|| forms.get("0"))?;
    let map = &INDEX.0.profiles[*pair.get(if origin.team == Team::Blue { "0" } else { "1" })?];
    if let Some(suffix) = name.strip_prefix('@') {
        return map
            .get_key_value(format!("{}:{}", origin.action, suffix).as_str())
            .map(|(name, _)| *name);
    }
    map.get_key_value(name).map(|(name, _)| *name)
}

impl Actor {
    pub(crate) fn audio_states(&self, tick: u64) -> Vec<AudioState> {
        let mut out = Vec::new();
        let key = self.audio_kind();
        let s = &self.card_state;
        let form = s.changed_form;
        let local = families(key, form, self.team);
        let mut add = |kind: &'static str,
                       name: &'static str,
                       serial: u64,
                       looping: bool,
                       position: Point,
                       action: bool| {
            let groups = if kind == key {
                local
            } else {
                families(kind, false, self.team)
            };
            if let Some(family) = groups.and_then(|p| p.get(name)) {
                if family.sustain.is_some()
                    || !family.start.is_empty()
                    || !family.end.is_empty()
                    || !family.timed.is_empty()
                {
                    out.push(AudioState {
                        kind,
                        name,
                        family,
                        serial,
                        position,
                        looping,
                        action,
                    });
                }
            }
        };
        let pos = self.pos;
        let stasis = self.has(Control::Stasis);
        if stasis {
            add(
                if key == "gold_ward" { key } else { "stasis" },
                "stasis_target",
                0,
                false,
                pos,
                false,
            );
        }
        if self.shields.pool_active() {
            add("pool_of_reflection", "pool_shield", 0, true, pos, false);
        }
        if s.tower_disable_audio_until > tick && self.has(Control::Stun) {
            add(
                "medium_lightning",
                "tower_disable",
                s.tower_disable_audio_until,
                true,
                pos,
                false,
            );
        }
        let mut state = |name, serial, looping| add(key, name, serial, looping, pos, false);
        if let Some((_, end)) = s.entry.filter(|v| v.1 > tick) {
            state("pre_deploy", end, true);
        }
        if s.persistent_audio_until > tick {
            state("persistent_area", 0, true);
        }
        if tick >= self.deploy_start
            && (self.activity == Activity::Deploying || tick < self.ready_tick)
        {
            state("deploy", self.deploy_start, false);
        }
        if self.activity == Activity::Channeling && !self.disabled() {
            state("continuous_attack", 0, false);
        }
        if tick >= self.ready_tick
            && (self.activity == Activity::Idle || key == "nexus")
            && tick >= s.cast_end
        {
            state("idle", 0, true);
        }
        if self.activity == Activity::Mending && !self.disabled() {
            state("mend", 0, true);
        }
        if s.in_terrain {
            state("terrain", 0, true);
        }
        if s.dormant {
            state("dormant", 0, false);
        }
        if self.hidden_until > tick {
            state("stealth", 0, false);
        }
        if self.reload_left > 0 {
            state("reload", 0, false);
        }
        if self.effect_shield_until > tick {
            state("effect_shield", 0, false);
        }
        if s.empowered.is_some() {
            state("empowered_buff", 0, true);
        }
        if s.rage_until > tick {
            state("blood_rage", 0, true);
        }
        if self.shields.explosive_active() {
            state("explosive_shield", 0, true);
        }
        if key == "sion" && form && tick >= self.ready_tick {
            state("berserk", self.ready_tick, true);
        }
        if key == "anivia_egg" {
            state("revival", self.deploy_start, false);
        }
        if s.burning_aura && !stasis {
            state("burning_aura", 0, true);
        }
        if s.immunity > tick && local.is_some_and(|f| f.contains_key("control_immunity")) {
            state("control_immunity", 0, false);
        } else if self.active_skill_buff(tick) {
            state("active_buff", 0, false);
        }
        if s.burst.is_some_and(|b| b.0 > tick && b.1 > 0) {
            state("burst", 0, false);
        }
        if key == "sion" && form && tick == self.ready_tick {
            state("rebirth_ready", 0, false);
        }
        if let Some((start, length, active)) = s
            .last_visual_form
            .filter(|(start, len, _)| tick < start + u64::from((*len).max(1)))
        {
            let _ = length;
            let name = if key == "gnar" || key == "aatrox" {
                if !form {
                    "revert"
                } else if active {
                    "transform_active"
                } else {
                    "transform"
                }
            } else {
                "transform"
            };
            state(name, start, false);
        }
        if let Some(rules) = self.def.rules {
            if rules["skill_resource_max"]
                .as_f64()
                .is_some_and(|max| max > 0. && s.resource >= max)
            {
                state("resource", 0, false);
            }
            if let Some(start) = s.heal_cycle {
                if !stasis
                    && tick >= start
                    && tick
                        < start
                            + (rules["heal_aura_duration"].as_f64().unwrap_or(0.) * 20.).round()
                                as u64
                {
                    state("heal_aura", start, true);
                }
            }
        }
        if let Some(v) = self.sanctuary.filter(|v| v.until > tick) {
            add(key, "sanctuary", v.until, false, v.center, false);
        }
        if !stasis && !self.has(Control::Freeze) {
            if let Some((name, start, _)) = s
                .visual_action
                .filter(|v| v.2 > tick && (v.0 != "channel" || s.channel.is_some()))
            {
                add(key, name, start, false, pos, true);
            }
            if s.cast_end > tick
                && !s.cast_action.is_empty()
                && !s
                    .visual_action
                    .is_some_and(|v| v.0 == s.cast_action && v.2 > tick)
            {
                add(key, s.cast_action, s.cast_start, false, pos, true);
            }
        }
        out
    }
}
