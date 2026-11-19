use crate::{Activity, Actor, Control, Id, Layer, Point, Role, Team};
use std::collections::{BTreeMap, HashMap};
#[derive(Clone, Copy)]
pub(crate) struct Body {
    pub id: Id,
    pub pos: Point,
    pub radius: f64,
    pub layer: Layer,
    pub role: Role,
    pub team: Team,
    pub isolated: bool,
    pub hidden: bool,
    pub dormant: bool,
    pub buildings_only: bool,
    pub transit: bool,
    pub sanctuary: Option<crate::status::Sanctuary>,
}
impl From<&Actor> for Body {
    fn from(a: &Actor) -> Self {
        Self {
            id: a.id,
            pos: a.pos,
            radius: a.def.radius,
            layer: a.def.layer,
            role: a.def.role,
            team: a.team,
            isolated: a.has(Control::Stasis) || a.card_state.untargetable > 0,
            hidden: a.hidden_until > 0,
            dormant: a.card_state.dormant,
            buildings_only: a.def.buildings_only,
            transit: a.flight.is_some(),
            sanctuary: a.sanctuary,
        }
    }
}
impl Body {
    pub fn allows(self, team: Team, source: Point) -> bool {
        !self.isolated
            && (self.team == team
                || self
                    .sanctuary
                    .is_none_or(|s| !s.contains(self.pos) || s.contains(source)))
    }
    pub fn eligible(self, a: &Actor) -> bool {
        self.team != a.team
            && !self.hidden
            && !self.dormant
            && self.allows(a.team, a.pos)
            && (a.def.hits_air || self.layer != Layer::Air)
            && (!a.def.buildings_only || self.role.structure())
    }
}
const CELL: f64 = 100.;
fn key(p: Point) -> (i32, i32) {
    ((p.x / CELL).floor() as i32, (p.y / CELL).floor() as i32)
}
pub(crate) struct Perception {
    pub bodies: BTreeMap<Id, Body>,
    cells: HashMap<(i32, i32), Vec<Id>>,
    pub towers: Vec<Body>,
    max_radius: f64,
}
impl Perception {
    pub fn new(actors: &BTreeMap<Id, Actor>) -> Self {
        let mut view = Self {
            bodies: BTreeMap::new(),
            cells: HashMap::new(),
            towers: Vec::new(),
            max_radius: 0.,
        };
        for a in actors.values() {
            let b = Body::from(a);
            view.cells.entry(key(b.pos)).or_default().push(b.id);
            if matches!(b.role, Role::LaneTower | Role::Nexus) {
                view.towers.push(b)
            }
            view.max_radius = view.max_radius.max(b.radius);
            view.bodies.insert(b.id, b);
        }
        view
    }
    pub fn nearby(&self, p: Point, r: f64, mut visit: impl FnMut(Body)) {
        let d = r + self.max_radius;
        let (x0, y0) = key(p - Point::new(d, d));
        let (x1, y1) = key(p + Point::new(d, d));
        // Very large ability ranges should cost at most one pass over the world.
        if (x1 as i64 - x0 as i64 + 1).saturating_mul(y1 as i64 - y0 as i64 + 1)
            > self.cells.len() as i64 * 4 + 16
        {
            self.bodies.values().copied().for_each(visit);
            return;
        }
        for x in x0..=x1 {
            for y in y0..=y1 {
                if let Some(ids) = self.cells.get(&(x, y)) {
                    for id in ids {
                        visit(self.bodies[id])
                    }
                }
            }
        }
    }
    pub fn choose(&self, a: &Actor, mid: f64) -> Option<(Body, bool)> {
        let eligible = |b: Body| b.eligible(a);
        if let Some(b) = a
            .controls
            .source(Control::Taunt)
            .and_then(|id| self.bodies.get(&id))
            .filter(|b| eligible(**b))
        {
            return Some((*b, false));
        }
        let old = a
            .target
            .and_then(|id| self.bodies.get(&id))
            .copied()
            .filter(|b| eligible(*b));
        let attacking = matches!(
            a.activity,
            Activity::Windup | Activity::Recover | Activity::Channeling
        );
        if attacking {
            if let Some(b) = old {
                if a.release_at.is_some() || gap(a, b) <= a.def.range {
                    return Some((b, false));
                }
            }
        }
        let nearest = |radius: f64| {
            let mut best: Option<(f64, Body)> = None;
            self.nearby(a.pos, a.def.radius + radius, |b| {
                let g = gap(a, b);
                if eligible(b)
                    && g <= radius
                    && best.is_none_or(|(dist, prior)| g < dist || (g == dist && b.id < prior.id))
                {
                    best = Some((g, b))
                }
            });
            best.map(|(_, b)| b)
        };
        if attacking {
            if let Some(b) = nearest(a.def.range) {
                return Some((b, false));
            }
        }
        if let Some(b) = nearest(a.def.sight) {
            let b = old
                .filter(|prev| gap(a, *prev) <= a.def.sight && gap(a, *prev) <= gap(a, b) + 0.01)
                .unwrap_or(b);
            return Some((b, false));
        }
        self.towers
            .iter()
            .copied()
            .filter(|b| eligible(*b))
            .min_by(|l, r| {
                let priority = |b: Body| {
                    if b.role == Role::LaneTower && (b.pos.x < mid) == (a.pos.x < mid) {
                        0
                    } else if b.role == Role::Nexus {
                        1
                    } else {
                        2
                    }
                };
                priority(*l)
                    .cmp(&priority(*r))
                    .then_with(|| gap(a, *l).total_cmp(&gap(a, *r)))
                    .then(l.id.cmp(&r.id))
            })
            .map(|b| (b, true))
    }
}
pub(crate) fn gap(a: &Actor, b: Body) -> f64 {
    ((a.pos - b.pos).length() - a.def.radius - b.radius).max(0.)
}
