use super::*;
use crate::{movement, status::Empowerment, Activity};

// A fixed sequence local to each void field. Farthest-of-64 sampling keeps
// the cloud separated, clips candidates at the arena edge and consumes no
// game RNG, including when a simultaneous death triggers another fish.
pub(super) fn summon_offsets(game: &ClassicMatch, center: Point, s: &Value) -> Vec<Point> {
    // The original uses a card-local Godot PCG32 stream, including its
    // two-draw floating-point conversion. It never consumes the match seed.
    const MULTIPLIER: u64 = 6364136223846793005;
    const INCREMENT: u64 = 2885390081777926815;
    let mut state = (223069u64 + INCREMENT)
        .wrapping_mul(MULTIPLIER)
        .wrapping_add(INCREMENT);
    let mut next = || {
        let old = state;
        state = old.wrapping_mul(MULTIPLIER).wrapping_add(INCREMENT);
        let word = (((old >> 18) ^ old) >> 27) as u32;
        word.rotate_right((old >> 59) as u32)
    };
    let mut uniform = || {
        let exponent = next();
        if exponent == 0 {
            return 0.;
        }
        let significand = (next() | 0x80000001) as f32;
        f64::from(significand * 2f32.powi(-32 - exponent.leading_zeros() as i32))
    };
    let mut offsets = Vec::<Point>::new();
    let radius = number(s, "radius", 0.);
    let body = super::super::units::unit("voidfish").radius;
    for _ in 0..number(s, "spawn_count", 0.) as usize {
        let mut best = Point::default();
        let mut score = -1.;
        for _ in 0..64 {
            let angle = uniform() * std::f64::consts::TAU;
            let p = Point::new(angle.cos(), angle.sin()) * (uniform().sqrt() * radius * 0.9);
            let at = center + p;
            if at.x < body
                || at.x > game.battle.map.width - body
                || at.y < body
                || at.y > game.battle.map.height - body
            {
                continue;
            }
            let spacing = offsets
                .iter()
                .map(|o| (p - *o).length())
                .fold(f64::INFINITY, f64::min);
            if spacing > score {
                score = spacing;
                best = p;
            }
        }
        offsets.push(best);
    }
    offsets
}
impl SpellCast {
    fn spawn_fish(&self, game: &mut ClassicMatch, pos: Point) {
        let def = super::super::units::unit("voidfish");
        let blocks = movement::blockers(&game.battle.actors);
        let q = crate::space::Query {
            cross_river: def
                .rules
                .is_some_and(|s| s["river_traversal"] == true || s["terrain_traversal"] == true),
            map: &game.battle.map,
            blocks: &blocks,
            id: game.battle.next_id,
            layer: def.layer,
            radius: def.radius,
        };
        if let Some(p) = q
            .nearest(pos, if self.team == Team::Blue { -1. } else { 1. })
            .filter(|p| (*p - self.pos).length() <= number(self.spec, "radius", 0.))
        {
            if let Ok(id) = game.battle.spawn(self.team, p, def) {
                let a = game.battle.actors.get_mut(&id).unwrap();
                a.ready_tick = game.battle.tick + ticks(number(self.spec, "spawn_deploy_time", 0.));
                a.activity = Activity::Deploying;
            }
        }
    }
    pub(super) fn field_step(&mut self, game: &mut ClassicMatch, changes: &mut Vec<Change>) {
        let tick = game.tick();
        let s = self.spec;
        let sk = self.skill;
        let radius = number(s, "radius", 0.);
        let elapsed = tick - self.impact;
        if self.kind == CardSpell::Summoning {
            let first = ticks(number(s, "spawn_initial_delay", 0.));
            if elapsed >= first && (elapsed - first).is_multiple_of(self.interval) {
                if let Some(&offset) = self
                    .offsets
                    .get(((elapsed - first) / self.interval) as usize)
                {
                    self.spawn_fish(game, self.pos + offset);
                }
            }
            return;
        }
        let mut origin = game.map.sides[self.team.index()].nexus;
        let mut center = self.pos;
        let mut source = game.nexus[self.team.index()];
        let battle = &mut game.battle;
        if self.kind == CardSpell::Bear && elapsed > 0 {
            let Some(a) = self.bear.and_then(|id| battle.actors.get(&id)) else {
                self.bear = None;
                return;
            };
            if a.has(Control::Stasis)
                || !elapsed.is_multiple_of(ticks(number(sk, "tick_interval", 0.5)))
            {
                return;
            }
            source = a.id;
            origin = a.pos;
            center = a.pos;
        }
        let ids: Vec<_> = battle.actors.keys().copied().collect();
        for id in ids {
            let a = &battle.actors[&id];
            if a.team == self.team || a.hp <= 0 {
                continue;
            }
            let pos = a.pos;
            let edge = (pos - center).length() - a.def.radius;
            let is_tower = matches!(a.def.role, Role::LaneTower | Role::Nexus);
            let tower_rate = if is_tower {
                number(s, "tower_damage_multiplier", 1.)
            } else {
                1.
            };
            let allowed = Body::from(a).allows(self.team, origin);
            if self.kind == CardSpell::Horizon {
                if !allowed {
                    continue;
                }
                if let Some((due, at)) = self.matter {
                    if tick == due && (pos - at).length() <= number(sk, "radius", 0.) + a.def.radius
                    {
                        let dmg = number(sk, "damage", 0.)
                            * if is_tower {
                                number(sk, "tower_damage_multiplier", 1.)
                            } else {
                                1.
                            };
                        changes.push(Change::new(source, id, -dmg.round() as i32));
                    }
                }
                if tick >= self.last || a.def.role != Role::Troop || self.struck.contains(&id) {
                    continue;
                }
                let prev = self.previous.insert(id, pos).unwrap_or(pos);
                let delta = pos - prev;
                let t = if delta.dot(delta) > 0. {
                    ((center - prev).dot(delta) / delta.dot(delta)).clamp(0., 1.)
                } else {
                    0.
                };
                if (prev + delta * t - center).length() > radius + a.def.radius
                    || (prev - center).length().max((pos - center).length()) < radius - a.def.radius
                {
                    continue;
                }
                self.struck.insert(id);
                if battle.consume_effect_shield(id) {
                    continue;
                }
                if battle
                    .apply_control(
                        id,
                        Control::Stun,
                        self.id,
                        ticks(number(s, "stun_duration", 0.)) as u32,
                        tick,
                    )
                    .is_ok()
                    && !sk.is_null()
                    && self.matter.is_none()
                    && self.contacted.is_empty()
                {
                    self.contacted.insert(id);
                    self.matter = Some((tick + ticks(number(sk, "dark_matter_delay", 0.)), pos));
                }
                continue;
            }
            if !allowed || edge > radius {
                continue;
            }
            if self.kind == CardSpell::Bear && elapsed > 0 {
                changes.push(Change::new(source, id, -number(sk, "damage", 0.) as i32));
                continue;
            }
            if self.contacted.insert(id) && battle.consume_effect_shield(id) {
                self.blocked.insert(id);
            }
            if self.blocked.contains(&id) {
                continue;
            }
            let a = battle.actors.get_mut(&id).unwrap();
            if self.kind == CardSpell::Stellar {
                if elapsed > 0 && elapsed.is_multiple_of(ticks(number(s, "damage_interval", 0.25)))
                {
                    let carry = self.damage_remainder.entry(id).or_default();
                    *carry += number(s, "damage", 0.) * tower_rate;
                    let damage = carry.round();
                    *carry -= damage;
                    if damage > 0. {
                        changes.push(Change::delivered(source, id, -(damage as i32)));
                    }
                }
                if !sk.is_null()
                    && edge <= number(s, "inner_radius", 0.)
                    && (a.def.role == Role::Troop || sk["execute_buildings"] == true)
                {
                    changes.push(Change::execute(
                        source,
                        id,
                        number(sk, "execute_health_ratio", 0.),
                    ));
                }
                if tick < self.last && a.def.role == Role::Troop && a.flight.is_none() {
                    let delta = center - pos;
                    let step = delta.unit().unwrap_or_default()
                        * delta.length().min(number(s, "pull_speed", 0.) / 20.);
                    a.field_shift = a.field_shift + step;
                }
            } else {
                changes.push(Change::delivered(
                    source,
                    id,
                    -(number(s, "damage", 0.) * tower_rate).round() as i32,
                ));
                if !sk.is_null() {
                    let _ = battle.apply_control(
                        id,
                        Control::Stun,
                        self.id,
                        ticks(number(sk, "stun_duration", 0.)) as u32,
                        tick,
                    );
                }
            }
        }
        if self.matter.is_some_and(|(due, _)| tick >= due) {
            self.matter = None;
        }
        if self.kind == CardSpell::Bear && elapsed == 0 {
            if let Ok(id) =
                battle.spawn_near(self.team, self.pos, super::super::units::unit("tibbers"))
            {
                if !sk.is_null() {
                    self.bear = Some(id);
                    battle.actors.get_mut(&id).unwrap().empowerment = Some(Empowerment {
                        movement: 1000,
                        attack: (1000. * number(sk, "attack_speed_multiplier", 1.)).round() as u16,
                        damage: 1000,
                        until: tick + ticks(number(sk, "duration", 0.)),
                    });
                }
            }
        }
    }
}
impl ClassicMatch {
    pub(in crate::classic) fn spell_deaths(&mut self) {
        if self.battle.deaths.is_empty() {
            return;
        }
        let casts = std::mem::take(&mut self.spells);
        let deaths = std::mem::take(&mut self.battle.deaths);
        for d in &deaths {
            let team = d.team;
            let s = &rules()[d.key];
            for (side, field) in [
                (team, "death_owner_elixir"),
                (team.enemy(), "death_enemy_elixir"),
            ] {
                if d.suppress_enemy && side != team {
                    continue;
                }
                if let Some(n) = s[field].as_f64() {
                    let p = &mut self.players[side.index()];
                    p.gold = (p.gold + n as u8).min(10);
                }
            }
        }
        for cast in &casts {
            if cast.kind != CardSpell::Summoning || cast.skill.is_null() || self.tick() >= cast.last
            {
                continue;
            }
            for d in &deaths {
                let (key, role, pos) = (d.key, d.role, d.pos);
                if key != "voidfish"
                    && role == Role::Troop
                    && (pos - cast.pos).length() <= number(cast.spec, "radius", 0.)
                {
                    cast.spawn_fish(self, pos);
                }
            }
        }
        self.spells = casts;
    }
}
