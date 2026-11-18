use crate::{Actor, Arena, Control, Error, Id, Point, Team};
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AimKind {
    Instant,
    Point,
    Direction,
    PointAndDirection,
}
#[derive(Clone, Copy, Debug)]
pub enum Aim {
    Instant,
    Point(Point),
    Direction(Point),
    PointAndDirection { origin: Point, direction: Point },
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Shape {
    Circle { radius: f64 },
    Ring { inner: f64, outer: f64 },
    Fan { radius: f64, half_angle: f64 },
    Strip { length: f64, half_width: f64 },
}
impl Shape {
    pub(crate) fn hits(self, offset: Point, dir: Point, body: f64) -> bool {
        match self {
            Self::Circle { radius } => offset.length() <= radius + body,
            Self::Ring { inner, outer } => {
                offset.length() + body >= inner && offset.length() <= outer + body
            }
            Self::Fan { radius, half_angle } => {
                let len = offset.length();
                if len <= body {
                    return true;
                }
                let along = offset.dot(dir);
                let side = (offset.x * dir.y - offset.y * dir.x).abs();
                if side.atan2(along) <= half_angle {
                    return len <= radius + body;
                }
                let (y, x) = half_angle.sin_cos();
                let t = (along * x + side * y).clamp(0., radius);
                (along - t * x).hypot(side - t * y) <= body
            }
            Self::Strip { length, half_width } => {
                let along = offset.dot(dir);
                let across = offset.x * dir.y - offset.y * dir.x;
                let dx = along - along.clamp(0., length);
                let dy = across - across.clamp(-half_width, half_width);
                dx.hypot(dy) <= body
            }
        }
    }
}
#[derive(Clone, Copy, Debug)]
pub enum Effect {
    Area(crate::TimedArea),
    Summon(crate::SpawnBatch),
    Transform(crate::Transform),
    RegenTroops {
        per_second: u32,
    },
    HealTroops(i32),
    Empower {
        movement: u16,
        attack: u16,
        damage: u16,
        ticks: u32,
    },
    Motion(crate::Motion),
    Damage(i32),
    Slow {
        movement: u16,
        attack: u16,
        ticks: u32,
    },
    Heal(i32),
    Stealth {
        ticks: u32,
    },
    Sanctuary {
        radius: f64,
        ticks: u32,
    },
    EffectShield {
        ticks: u32,
    },
    Blind {
        charges: u8,
    },
    Shield {
        amount: i32,
        ticks: u32,
    },
    Control {
        kind: Control,
        ticks: u32,
    },
    Push {
        distance: f64,
        speed: f64,
        extension: f64,
    },
}
impl Effect {
    pub(crate) fn valid(self) -> bool {
        match self {
            Self::Transform(t) => t.revert_after != Some(0),
            Self::RegenTroops { per_second } => per_second > 0,
            Self::HealTroops(n) => n >= 0,
            Self::Empower {
                movement,
                attack,
                damage,
                ticks,
            } => [movement, attack, damage].iter().all(|&r| r >= 1000) && ticks > 0,
            Self::Area(area) => area.valid(),
            Self::Stealth { ticks } | Self::EffectShield { ticks } => ticks > 0,
            Self::Sanctuary { radius, ticks } => radius.is_finite() && radius > 0. && ticks > 0,
            Self::Blind { charges } => charges > 0,
            Self::Shield { amount, ticks } => amount > 0 && ticks > 0,
            Self::Motion(m) => m.valid(),
            Self::Summon(b) => b.count > 0,
            Self::Damage(n) | Self::Heal(n) => n > 0,
            Self::Control { ticks, .. } => ticks > 0,
            Self::Slow {
                movement,
                attack,
                ticks,
            } => ticks > 0 && (1..=1000).contains(&movement) && (1..=1000).contains(&attack),
            Self::Push {
                distance,
                speed,
                extension,
            } => {
                distance.is_finite()
                    && distance > 0.
                    && speed.is_finite()
                    && speed > 0.
                    && extension.is_finite()
                    && extension >= 0.
            }
        }
    }
    pub(crate) fn ally(self) -> bool {
        matches!(
            self,
            Self::Heal(_) | Self::HealTroops(_) | Self::Shield { .. }
        )
    }
}
#[derive(Clone, Debug)]
pub struct Skill {
    pub aim: AimKind,
    pub cast_range: f64,
    pub shape: Shape,
    pub effects: Vec<Effect>,
    pub cooldown: u32,
}
impl Skill {
    pub(crate) fn valid(&self) -> bool {
        let ok = |v: f64| v.is_finite() && v >= 0.;
        !self.effects.is_empty()
            && self
                .effects
                .iter()
                .all(|effect| effect.valid() && !matches!(effect, Effect::RegenTroops { .. }))
            && self.effects.iter().skip(1).all(|e| {
                !matches!(e,Effect::Motion(m) if m.autonomous())
                    && !matches!(e, Effect::Transform(_))
            })
            && self.cooldown > 0
            && ok(self.cast_range)
            && self.shape.valid()
    }
}
#[derive(Clone, Copy, Debug)]
pub struct Cast {
    pub caster: Id,
    pub aim: Aim,
}
pub(crate) fn resolve(
    map: &Arena,
    a: &Actor,
    team: Team,
    tick: u64,
    aim: Aim,
) -> Result<(Skill, Point, Point), Error> {
    if a.team != team {
        return Err(Error::Ownership);
    }
    let skill = a.def.skill.as_ref().ok_or(Error::NoSkill)?;
    if tick < a.ready_tick || a.disabled() || a.has(Control::Taunt) || a.has(Control::Silence) {
        return Err(Error::Controlled);
    }
    if tick < a.next_skill {
        return Err(Error::Cooldown);
    }
    let (origin, heading) = match (skill.aim, aim) {
        (AimKind::Instant, Aim::Instant) => (a.pos, a.facing),
        (AimKind::Point, Aim::Point(p)) => (p, a.facing),
        (AimKind::Direction, Aim::Direction(d)) => (a.pos, d),
        (AimKind::PointAndDirection, Aim::PointAndDirection { origin, direction }) => {
            (origin, direction)
        }
        _ => return Err(Error::WrongAim),
    };
    if !map.contains(origin) || (origin - a.pos).length() > skill.cast_range {
        return Err(Error::InvalidPoint);
    }
    Ok((
        skill.clone(),
        origin,
        heading.unit().ok_or(Error::InvalidDirection)?,
    ))
}

impl Shape {
    pub(crate) fn valid(self) -> bool {
        let ok = |v: f64| v.is_finite() && v >= 0.;
        match self {
            Self::Circle { radius } => ok(radius),
            Self::Ring { inner, outer } => ok(inner) && ok(outer) && inner <= outer,
            Self::Fan { radius, half_angle } => {
                ok(radius) && (0.0..=std::f64::consts::PI).contains(&half_angle)
            }
            Self::Strip { length, half_width } => ok(length) && ok(half_width),
        }
    }
}
