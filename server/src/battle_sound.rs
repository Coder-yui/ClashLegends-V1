//! Audible context is captured from the same seat-visible facts as the models.
use clash_battle_core::{AttackSound, Fact, Id, Point, Snapshot, Team, UnitView};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Copy)]
pub(super) struct Pose {
    kind: &'static str,
    team: Team,
    point: Point,
    attack: AttackSound,
    action: &'static str,
    deploying: bool,
    deploy_at: u64,
    release: u64,
    group: Id,
    stage: u8,
}
impl Pose {
    fn cue(&self, owner: Id, phase: &str, point: Point, key: Id) -> Value {
        let mut data = json!(self.attack);
        let obj = data.as_object_mut().unwrap();
        obj.retain(|_, v| *v != false);
        obj.extend(json!({"kind":self.kind,"team":self.team.index(),"owner":owner,"phase":phase,"position":point,"key":key}).as_object().unwrap().clone());
        data
    }
    fn spawn(&self, id: Id) -> Value {
        let mut cue = self.cue(id, "spawn", self.point, id);
        cue["deploy"] = json!(self.deploying);
        if self.group > 0 {
            cue["group"] = json!(self.group);
        }
        cue
    }
    fn stage(&self, phase: &str) -> String {
        format!("{}:{}", self.action, phase)
    }
}
impl From<&UnitView> for Pose {
    fn from(u: &UnitView) -> Self {
        let hp = i64::from(u.hp) * 3;
        let max = i64::from(u.max_hp);
        Self {
            kind: u.audio_kind,
            team: u.team,
            point: u.position,
            action: u.cast_action,
            release: u.attack.map_or(0, |a| a.release),
            group: u.deployment_group,
            deploying: u.ready_tick > u.deploy_start,
            deploy_at: u.deploy_start,
            attack: u.attack_sound,
            stage: if hp <= max {
                2
            } else if hp <= 2 * max {
                1
            } else {
                0
            },
        }
    }
}
#[derive(Clone, Copy)]
pub(super) struct Shot {
    source: Pose,
    owner: Id,
    volley: bool,
}
#[derive(Default)]
pub(super) struct Scene {
    pub units: BTreeMap<Id, Pose>,
    pub shots: BTreeMap<Id, Shot>,
}
impl Scene {
    pub fn landings(&self, previous: &Scene, before: Option<u64>, tick: u64) -> Vec<Value> {
        let Some(before) = before else {
            return Vec::new();
        };
        self.units
            .iter()
            .filter(|(id, u)| {
                previous
                    .units
                    .get(id)
                    .is_some_and(|old| old.deploy_at == u.deploy_at)
                    && before < u.deploy_at
                    && u.deploy_at <= tick
            })
            .map(|(&id, u)| u.spawn(id))
            .collect()
    }

    pub fn from_field(field: &Snapshot) -> Self {
        Self {
            units: field.units.iter().map(|u| (u.id, Pose::from(u))).collect(),
            shots: field
                .projectiles
                .iter()
                .map(|p| {
                    (
                        p.id,
                        Shot {
                            owner: p.owner,
                            volley: p.volley.is_some(),
                            source: Pose {
                                kind: p.source_kind,
                                team: p.team,
                                point: p.origin,
                                attack: p.attack_sound,
                                action: p.cast_action,
                                deploying: false,
                                deploy_at: 0,
                                group: 0,
                                release: 0,
                                stage: 0,
                            },
                        },
                    )
                })
                .collect(),
        }
    }
}
#[derive(Default)]
pub(super) struct Step {
    fired: BTreeMap<Id, Shot>,
    released: BTreeSet<Id>,
    damaged_towers: BTreeSet<Id>,
}
impl Step {
    pub fn sounds(&mut self, current: &Scene, last: &Scene, fact: &Fact, tick: u64) -> Vec<Value> {
        let unit = |id: &Id| current.units.get(id).or_else(|| last.units.get(id));
        let mut sounds = Vec::new();
        let mut local = |id: Id, phase: &str, key: u64| {
            if let Some(u) = unit(&id) {
                sounds.push(u.cue(id, phase, u.point, key));
            }
        };
        match *fact {
            Fact::FirstWave => {
                sounds.push(json!({
                    "kind":"match", "team":0, "owner":0, "phase":"minions_spawn",
                    "position":{"x":0,"y":0}, "key":tick
                }));
            }
            Fact::Sound {
                source,
                phase,
                position,
                ..
            } => {
                sounds.push(json!({
                    "released":true, "kind":source.kind, "team":source.team.index(),
                    "form":source.form, "owner":source.owner, "phase":phase,
                    "position":position, "key":tick
                }));
            }
            Fact::Spawned(id) => {
                if let Some(u) = unit(&id).filter(|u| u.deploy_at <= tick) {
                    sounds.push(u.spawn(id));
                }
            }
            Fact::Died(id) => local(id, "death", tick),
            Fact::AttackStarted(id, _) => {
                if let Some(u) = unit(&id) {
                    let mut cue = u.cue(id, "windup", u.point, tick);
                    cue["release"] = json!(u.release);
                    sounds.push(cue);
                }
            }
            Fact::AttackReleased { source, start, .. } => {
                local(source, "release", start);
                if unit(&source).is_some_and(|u| u.kind == "soul_tentacle") {
                    local(source, "attack:ground", tick);
                }
            }
            Fact::Cast { caster, .. } => {
                if let Some(u) = unit(&caster) {
                    local(caster, "active:cast", tick);
                    if !u.action.is_empty() {
                        let start = if u.kind == "ashe" {
                            "volleyStart".into()
                        } else {
                            u.stage("start")
                        };
                        local(caster, &start, tick);
                        local(caster, &u.stage("voice"), tick);
                    }
                }
            }
            Fact::Fired(owner, target, id) => {
                if let Some(u) = unit(&owner) {
                    self.fired.insert(
                        id,
                        Shot {
                            source: *u,
                            owner,
                            volley: target == 0,
                        },
                    );
                    if target == 0 && self.released.insert(owner) && !u.action.is_empty() {
                        let release = if u.kind == "ashe" {
                            "volleyRelease".into()
                        } else {
                            u.stage("release")
                        };
                        local(owner, &release, tick);
                    }
                }
            }
            Fact::ProjectileHit {
                projectile, target, ..
            } => {
                let shot = current
                    .shots
                    .get(&projectile)
                    .or_else(|| self.fired.get(&projectile))
                    .or_else(|| last.shots.get(&projectile));
                if let (Some(s), Some(t)) = (shot, unit(&target)) {
                    let phase = if !s.volley {
                        "hit".to_owned()
                    } else if s.source.kind == "ashe" {
                        "volleyHit".to_owned()
                    } else {
                        s.source.stage("hit")
                    };
                    let mut cue = s.source.cue(s.owner, &phase, t.point, projectile);
                    cue["projectile"] = json!(projectile);
                    sounds.push(cue);
                }
            }
            Fact::Damage {
                source,
                target,
                contact,
                ..
            } => {
                if let Some(t) = unit(&target) {
                    local(target, "hurt", tick);
                    if let (Some(attack), Some(u)) = (contact, unit(&source)) {
                        let origin = Pose { attack, ..*u };
                        sounds.push(origin.cue(source, "hit", t.point, tick));
                    }
                    if t.kind == "princess_tower"
                        && current.units.contains_key(&target)
                        && last.units.get(&target).is_some_and(|p| p.stage < t.stage)
                        && self.damaged_towers.insert(target)
                    {
                        sounds.push(t.cue(
                            target,
                            if t.stage == 2 { "damage2" } else { "damage1" },
                            t.point,
                            tick,
                        ));
                    }
                }
            }
            Fact::EffectBlocked(id) => local(id, "effect_shield:block", tick),
            _ => (),
        }
        sounds
    }
}
