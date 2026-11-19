//! Executable card choices and formation deployment from the evaluated reference rules.
use super::{Card, ClassicMatch, MatchError, Play};
use crate::{space::Query, Activity, Aim, Cast, Control, Effect, Id, Point, Skill, Team, UnitDef};
use serde_json::Value;
use std::sync::OnceLock;

pub(super) fn rules() -> &'static Value {
    static DATA: OnceLock<Value> = OnceLock::new();
    DATA.get_or_init(|| {
        serde_json::from_str(include_str!("../../../content/battle_rules.json")).unwrap()
    })
}

pub fn battle_cards() -> &'static [Card] {
    static CARDS: OnceLock<Vec<Card>> = OnceLock::new();
    CARDS.get_or_init(|| {
        let mut cards = super::representative_deck().to_vec();
        let public: &'static Value = {
            static CATALOG: OnceLock<Value> = OnceLock::new();
            CATALOG.get_or_init(|| {
                serde_json::from_str(include_str!("../../../content/catalog.json")).unwrap()
            })
        };
        for entry in public["cards"].as_array().unwrap() {
            let key = entry["id"].as_str().unwrap();
            let rule = &rules()[key];
            if key == "mirror" {
                cards.push(Card {
                    key,
                    cost: 0,
                    play: Play::Mirror,
                    deploy_ticks: 0,
                    skill_key: None,
                    skill_cost: 0,
                    skill_uses: 0,
                });
                continue;
            }
            let spell = super::CardSpell::for_key(key);
            if rule.get("spawn_plan").is_none() && !matches!(key, "super_minion" | "siege_minion") {
                cards.retain(|c| c.key != key);
                if entry["skills"].as_array().unwrap().is_empty() {
                    cards.push(Card {
                        key,
                        cost: rule["cost"].as_u64().unwrap() as u8,
                        play: spell.map_or(Play::RosterUnit(0), |kind| Play::CardSpell(kind, 0)),
                        deploy_ticks: super::units::ticks(super::units::stat(
                            rule,
                            "deploy_time",
                            1.,
                        )),
                        skill_key: None,
                        skill_cost: 0,
                        skill_uses: 0,
                    });
                }
                for skill in entry["skills"].as_array().unwrap() {
                    let choice = rule["active_skills"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .position(|s| s["id"] == skill["id"])
                        .expect("validated skill ID");
                    let active = &rule["active_skills"][choice];
                    cards.push(Card {
                        key,
                        cost: rule["cost"].as_u64().unwrap() as u8,
                        play: spell.map_or(Play::RosterUnit(choice), |kind| {
                            Play::CardSpell(kind, choice)
                        }),
                        deploy_ticks: if spell.is_some() {
                            0
                        } else {
                            super::units::ticks(super::units::stat(rule, "deploy_time", 1.))
                        },
                        skill_key: skill["id"].as_str(),
                        skill_cost: active["cost"].as_u64().unwrap() as u8,
                        skill_uses: active["max_uses"].as_u64().unwrap_or(1) as u8,
                    });
                }
                continue;
            }
            cards.retain(|c| c.key != key);
            let build = |skill: &Value| {
                let active = rule["active_skills"]
                    .as_array()
                    .and_then(|skills| skills.iter().find(|s| s["id"] == skill["id"]));
                Card {
                    key,
                    cost: rule["cost"].as_u64().unwrap() as u8,
                    play: Play::Formation(key),
                    deploy_ticks: super::units::ticks(super::units::stat(rule, "deploy_time", 1.)),
                    skill_key: active.and_then(|s| s["id"].as_str()),
                    skill_cost: active.and_then(|s| s["cost"].as_u64()).unwrap_or(0) as u8,
                    skill_uses: active.map_or(0, |s| s["max_uses"].as_u64().unwrap_or(1) as u8),
                }
            };
            let skills = entry["skills"].as_array().unwrap();
            if skills.is_empty() {
                cards.push(build(&Value::Null))
            } else {
                cards.extend(skills.iter().map(build));
            }
        }
        cards
    })
}

fn member(key: &'static str) -> Option<UnitDef> {
    Some(match key {
        "melee_minion" => UnitDef::melee(),
        "ranged_minion" => UnitDef::ranged(),
        "super_minion" => UnitDef::super_minion(),
        "siege_minion" => UnitDef::siege(),
        _ if rules()[key].is_object() => super::units::unit(key),
        _ => return None,
    })
}
fn members(key: &'static str) -> Option<Vec<UnitDef>> {
    match rules()[key]["spawn_plan"]["members"].as_array() {
        Some(entries) => entries.iter().map(|v| member(v.as_str()?)).collect(),
        None => Some(vec![member(key)?]),
    }
}
pub(super) fn valid(key: &'static str) -> bool {
    members(key).is_some_and(|v| !v.is_empty() && v.iter().all(UnitDef::valid))
}
fn offsets(n: usize, formation: &str, spacing: f64, team: Team) -> Vec<Point> {
    if n == 1 {
        return vec![Point::default()];
    }
    let sign = if team == Team::Blue { 1. } else { -1. };
    let mut points: Vec<_> = (0..n)
        .map(|i| {
            let along = i as f64 - (n - 1) as f64 / 2.;
            (match formation {
                "line" => Point::new(along, 0.),
                "depth_line" => Point::new(0., along),
                _ => {
                    let start = if formation == "square" {
                        -std::f64::consts::FRAC_PI_4
                    } else {
                        -std::f64::consts::FRAC_PI_2
                    };
                    let angle = start + std::f64::consts::TAU * i as f64 / n as f64;
                    Point::new(angle.cos(), angle.sin())
                }
            }) * (spacing * sign)
        })
        .collect();
    let mut min = points[0];
    let mut max = min;
    for p in &points {
        min.x = min.x.min(p.x);
        min.y = min.y.min(p.y);
        max.x = max.x.max(p.x);
        max.y = max.y.max(p.y);
    }
    for p in &mut points {
        *p = *p - (min + max) * 0.5;
    }
    points
}

fn buff(spec: &Value, cooldown: u32) -> Skill {
    let rate = |k: &str| (spec[k].as_f64().unwrap_or(1.) * 1000.).round() as u16;
    let ticks = |k: &str| (spec[k].as_f64().unwrap() * 20.).round() as u32;
    let mut effects = vec![Effect::Empower {
        movement: rate("speed_multiplier"),
        attack: rate("attack_speed_multiplier"),
        damage: rate("damage_multiplier"),
        ticks: ticks("duration"),
    }];
    if let Some(shield) = spec["shield"].as_f64() {
        effects.push(Effect::SelfShield {
            amount: shield as i32,
            ticks: ticks("shield_duration"),
        });
    }
    Skill {
        aim: crate::AimKind::Instant,
        cast_range: 0.,
        shape: crate::Shape::Circle { radius: 0. },
        effects,
        cooldown,
    }
}
impl ClassicMatch {
    pub(super) fn deploy_formation(
        &mut self,
        card: Card,
        form: &'static str,
        team: Team,
        point: Point,
    ) -> Result<Vec<Id>, MatchError> {
        let placements = self.formation_placements(card, form, team, point)?;
        let rule = &rules()[card.key];
        let mut ids = Vec::with_capacity(placements.len());
        for (pos, def, pre) in placements {
            let id = self.battle.spawn(team, pos, def)?;
            let a = self.battle.actors.get_mut(&id).unwrap();
            a.card_state.equipped_skill = card.skill_key.filter(|_| a.def.skill.is_some());
            a.ready_tick = self.battle.tick + u64::from(card.deploy_ticks);
            if pre > 0. {
                let landed = self.battle.tick + u64::from(super::units::ticks(pre));
                a.card_state.entry = Some((
                    self.battle.tick
                        + u64::from(super::units::ticks(super::units::stat(
                            rule,
                            "pre_deploy_sweep_start",
                            0.,
                        ))),
                    landed,
                ));
                a.card_state.untargetable = landed;
                a.hidden_until = landed;
                a.deploy_start = landed;
                a.ready_tick += u64::from(super::units::ticks(pre));
            }
            if rule.get("deploy_sweep_radius").is_some() {
                a.card_state.landing_due = Some(if pre > 0. {
                    a.card_state.untargetable
                } else {
                    self.battle.tick + 1
                });
            }
            a.activity = Activity::Deploying;
            ids.push(id);
        }

        Ok(ids)
    }
    pub(super) fn formation_placements(
        &self,
        card: Card,
        form: &'static str,
        team: Team,
        point: Point,
    ) -> Result<Vec<(Point, UnitDef, f64)>, MatchError> {
        let rule = &rules()[card.key];
        let defs = if matches!(card.play, Play::RosterUnit(_)) {
            vec![super::units::unit(form); rule["deployment_count"].as_u64().unwrap_or(1) as usize]
        } else {
            members(card.key).ok_or(MatchError::Loadout)?
        };
        let clicked = self.cell(point, team, None)?;
        let ruin = rule["tower_ruin_foundation"] == true
            && [Team::Blue, Team::Red].iter().any(|t| {
                self.map.sides[t.index()]
                    .towers
                    .iter()
                    .enumerate()
                    .any(|(i, p)| {
                        *p == clicked
                            && !self.battle.actors.contains_key(&self.towers[t.index()][i])
                    })
            });
        let center = if ruin {
            clicked
        } else {
            self.deployment_cell(point, team, &defs[0], rule)?
        };
        let plan = &rules()[card.key]["spawn_plan"];
        let offsets = offsets(
            defs.len(),
            plan["formation"]
                .as_str()
                .or(rule["deployment_formation"].as_str())
                .unwrap_or("ring"),
            plan["spacing"]
                .as_f64()
                .or(rule["deployment_spacing"].as_f64())
                .unwrap_or(0.),
            team,
        );
        let blocks = crate::movement::blockers(&self.battle.actors);
        let mut placements = Vec::with_capacity(defs.len());
        for (mut def, offset) in defs.into_iter().zip(offsets) {
            if ruin {
                def.lifecycle.decay_ticks = 0;
            }
            if rule["deploy_formation_requires_in_bounds"] == true
                && !self.battle.map.bounds(def.radius).contains(center + offset)
            {
                return Err(MatchError::Placement);
            }
            let query = Query {
                cross_river: def.rules.is_some_and(|s| {
                    s["river_traversal"] == true || s["terrain_traversal"] == true
                }),
                map: &self.battle.map,
                blocks: &blocks,
                id: self.battle.next_id,
                layer: def.layer,
                radius: def.radius,
            };
            let pos = if def.role.structure() {
                center
            } else {
                query
                    .nearest(center + offset, if team == Team::Blue { -1. } else { 1. })
                    .ok_or(MatchError::Placement)?
            };
            if let Play::RosterUnit(choice) = card.play {
                if card.skill_uses > 0 {
                    def.skill = Some(super::abilities::carried(
                        def.rules
                            .and_then(|s| {
                                s["active_skills"]
                                    .as_array()?
                                    .iter()
                                    .find(|opt| opt["id"].as_str() == card.skill_key)
                            })
                            .unwrap_or(&rule["active_skills"][choice]),
                    ));
                }
            } else if card.skill_uses > 0 {
                let spec = rule["active_skills"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|s| s["id"].as_str() == card.skill_key)
                    .unwrap();
                def.skill = Some(
                    if spec["kind"] == "buff" && spec["target_scope"] == "deployment_group" {
                        // Each minion has its own Baron stat multipliers.
                        let member = rules()[def.key]["active_skills"]
                            .as_array()
                            .and_then(|skills| {
                                skills.iter().find(|s| {
                                    s["id"].is_string() && s["id"] == spec["member_skills"][def.key]
                                })
                            })
                            .unwrap_or(spec);
                        buff(
                            member,
                            super::units::ticks(super::units::stat(spec, "cooldown", 0.)),
                        )
                    } else {
                        super::abilities::carried(spec)
                    },
                );
            }
            let pre = if let Some(speed) = rule["pre_deploy_burrow_speed"].as_f64() {
                let nexus = self.map.sides[team.index()].nexus;
                let radius = self
                    .battle
                    .actors
                    .get(&self.nexus[team.index()])
                    .map_or(0., |a| a.def.radius);
                let reach = radius + def.radius + 5.5;
                let path = crate::navigation::route(&query, pos, nexus, reach);
                if path.is_empty() && (pos - nexus).length() > reach {
                    return Err(MatchError::Placement);
                }
                let mut prev = pos;
                let length = path
                    .iter()
                    .map(|point| {
                        let d = (*point - prev).length();
                        prev = *point;
                        d
                    })
                    .sum::<f64>();
                (length / speed).max(super::units::stat(rule, "pre_deploy_time", 0.))
            } else {
                super::units::stat(rule, "pre_deploy_time", 0.)
            };
            placements.push((pos, def, pre));
        }
        Ok(placements)
    }
}
pub(super) fn cast_group(
    battle: &mut crate::Battle,
    team: Team,
    caster: Id,
    aim: Aim,
    members: &[Id],
    changes: &mut Vec<crate::vitals::Change>,
) -> Result<(), crate::Error> {
    battle.cast(team, Cast { caster, aim }, changes)?;
    let next = battle.actors[&caster].next_skill;
    for &id in members.iter().filter(|&&id| id != caster) {
        let Some(a) = battle.actors.get_mut(&id) else {
            continue;
        };
        a.next_skill = next;
        if a.has(Control::Stasis) {
            continue;
        }
        let Some(skill) = a.def.skill.clone() else {
            continue;
        };
        let ctx = crate::timeline::Origin {
            caster: id,
            team,
            origin: a.pos,
            source_pos: a.pos,
            direction: a.facing,
        };
        battle.resolve_effects(ctx, skill.shape, &skill.effects, changes);
    }
    Ok(())
}
