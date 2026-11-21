use crate::{
    model::Flight, movement, Activity, Battle, Control, Error, Fact, Id, Point, Team,
    TICKS_PER_SECOND,
};
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum MotionKind {
    Forced,
    Knockback,
    Dash,
}
impl Battle {
    /// External forced motion. Direction, distance and speed come from a resolved
    /// server effect. Invalid replacements preserve the active trajectory.
    pub fn displace(
        &mut self,
        id: Id,
        direction: Point,
        distance: f64,
        speed: f64,
        extension: f64,
    ) -> Result<Point, Error> {
        self.begin_displacement(id, direction, distance, speed, extension, self.tick + 1)
    }
    pub(crate) fn begin_displacement(
        &mut self,
        id: Id,
        direction: Point,
        distance: f64,
        speed: f64,
        extension: f64,
        first_tick: u64,
    ) -> Result<Point, Error> {
        let dir = direction.unit().ok_or(Error::InvalidDirection)?;
        if ![
            distance,
            speed,
            extension,
            distance + extension,
            distance / speed,
        ]
        .iter()
        .all(|v| v.is_finite())
            || distance <= 0.
            || speed <= 0.
            || extension < 0.
        {
            return Err(Error::InvalidMotion);
        }
        let a = self.actors.get(&id).ok_or(Error::NoTarget)?;
        if a.has(Control::Stasis) || a.def.role.structure() {
            return Err(Error::Controlled);
        }
        let blocks = movement::blockers(&self.actors);
        let q = movement::query(&self.map, &blocks, a);
        let end = q
            .landing(a.pos, dir, distance, extension)
            .ok_or(Error::InvalidPoint)?;
        let duration = (distance / speed * TICKS_PER_SECOND as f64).ceil() as u64;
        let lock_until = first_tick.saturating_add(duration.saturating_sub(1));
        let a = self.actors.get_mut(&id).unwrap();
        a.flight = Some(Flight {
            kind: MotionKind::Forced,
            end,
            step: speed / TICKS_PER_SECOND as f64,
            lock_until,
        });
        a.cancel_attack();
        a.route_goal = None;
        a.activity = Activity::Displaced;
        self.emit(Fact::Displaced(id, end));
        Ok(end)
    }
}
#[derive(Clone, Copy, Debug)]
pub enum Motion {
    Dash {
        distance: f64,
        speed: f64,
        extension: f64,
    },
    Blink {
        distance: f64,
        extension: f64,
    },
    Knockback {
        distance: f64,
        ticks: u32,
        mass_cap: f64,
    },
    Pull {
        offset: f64,
        search_radius: f64,
        speed: f64,
    },
}
impl Motion {
    pub(crate) fn valid(self) -> bool {
        let pos = |v: f64| v.is_finite() && v > 0.;
        let nonneg = |v: f64| v.is_finite() && v >= 0.;
        match self {
            Self::Dash {
                distance,
                speed,
                extension,
            } => pos(distance) && pos(speed) && nonneg(extension),
            Self::Blink {
                distance,
                extension,
            } => pos(distance) && nonneg(extension),
            Self::Knockback {
                distance,
                ticks,
                mass_cap,
            } => pos(distance) && ticks > 0 && pos(mass_cap),
            Self::Pull {
                offset,
                search_radius,
                speed,
            } => nonneg(offset) && pos(search_radius) && pos(speed),
        }
    }
    pub(crate) fn autonomous(self) -> bool {
        matches!(self, Self::Dash { .. } | Self::Blink { .. })
    }
}
impl Battle {
    /// Resolve an authoritative effect. Origin is the cast point. Facing is
    /// the released aim, independent of the direction a pulled target faces.
    pub fn motion(
        &mut self,
        id: Id,
        origin: Point,
        facing: Point,
        spec: Motion,
    ) -> Result<Point, Error> {
        self.resolve_motion(id, origin, facing, spec, self.tick + 1)
    }
    pub(crate) fn resolve_motion(
        &mut self,
        id: Id,
        origin: Point,
        facing: Point,
        spec: Motion,
        first: u64,
    ) -> Result<Point, Error> {
        if !spec.valid() || !origin.finite() {
            return Err(Error::InvalidMotion);
        }
        let dir = facing.unit().ok_or(Error::InvalidDirection)?;
        let a = self.actors.get(&id).ok_or(Error::NoTarget)?;
        if a.def.role.structure()
            || a.has(Control::Stasis)
            || (spec.autonomous() && (a.has(Control::Root) || a.disabled()))
        {
            return Err(Error::Controlled);
        }
        let blocks = movement::blockers(&self.actors);
        let q = movement::query(&self.map, &blocks, a);
        let forward = if a.team == Team::Blue { -1. } else { 1. };
        match spec {
            Motion::Blink {
                distance,
                extension,
            } => {
                let end = q
                    .landing(a.pos, dir, distance, extension)
                    .ok_or(Error::InvalidPoint)?;
                let a = self.actors.get_mut(&id).unwrap();
                a.pos = end;
                a.flight = None;
                a.route_goal = None;
                a.cancel_attack();
                self.emit(Fact::Blinked(id, end));
                Ok(end)
            }
            Motion::Dash {
                distance,
                speed,
                extension,
            } => {
                let end = self.begin_displacement(id, dir, distance, speed, extension, first)?;
                let f = self.actors.get_mut(&id).unwrap().flight.as_mut().unwrap();
                f.kind = MotionKind::Dash;
                f.lock_until = first;
                Ok(end)
            }
            Motion::Pull {
                offset,
                search_radius,
                speed,
            } => {
                let preferred = origin + dir * offset;
                let end = if offset <= search_radius && q.legal(preferred) {
                    Some(preferred)
                } else {
                    q.nearest(origin, forward)
                        .filter(|p| (*p - origin).length() <= search_radius)
                };
                let delta = end.unwrap_or(preferred) - a.pos;
                let heading = delta.unit().ok_or(Error::InvalidMotion)?;
                self.begin_displacement(
                    id,
                    heading,
                    delta.length(),
                    speed,
                    if end.is_none() {
                        search_radius + a.def.radius + 2.
                    } else {
                        0.
                    },
                    first,
                )
            }
            Motion::Knockback {
                distance,
                ticks,
                mass_cap,
            } => {
                let pos = q.nearest(a.pos, forward).ok_or(Error::InvalidPoint)?;
                let direction = (pos - origin).unit().unwrap_or(Point::new(0., -forward));
                let length = distance * (4. / a.def.mass.max(1.)).clamp(0.35, mass_cap.max(0.35));
                let end = pos + direction * length;
                if !end.finite() {
                    return Err(Error::InvalidMotion);
                }
                let a = self.actors.get_mut(&id).unwrap();
                a.pos = pos;
                a.route_goal = None;
                a.cancel_attack();
                a.activity = Activity::Displaced;
                a.flight = Some(Flight {
                    kind: MotionKind::Knockback,
                    end,
                    step: length / f64::from(ticks),
                    lock_until: first + u64::from(ticks) - 1,
                });
                self.emit(Fact::Displaced(id, end));
                Ok(end)
            }
        }
    }
}
