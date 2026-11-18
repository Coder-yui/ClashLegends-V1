use std::ops::{Add, Mul, Sub};

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}
impl Point {
    pub const fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }
    pub fn length(self) -> f64 {
        self.x.hypot(self.y)
    }
    pub fn dot(self, other: Self) -> f64 {
        self.x * other.x + self.y * other.y
    }
    pub fn unit(self) -> Option<Self> {
        let n = self.length();
        (n.is_finite() && n > 1e-9).then(|| self * (1.0 / n))
    }
    pub fn finite(self) -> bool {
        self.x.is_finite() && self.y.is_finite()
    }
}
impl Add for Point {
    type Output = Self;
    fn add(self, p: Self) -> Self {
        Self::new(self.x + p.x, self.y + p.y)
    }
}
impl Sub for Point {
    type Output = Self;
    fn sub(self, p: Self) -> Self {
        Self::new(self.x - p.x, self.y - p.y)
    }
}
impl Mul<f64> for Point {
    type Output = Self;
    fn mul(self, k: f64) -> Self {
        Self::new(self.x * k, self.y * k)
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Rect {
    pub min: Point,
    pub max: Point,
}
impl Rect {
    fn expand(self, r: f64) -> Self {
        let d = Point::new(r, r);
        Self {
            min: self.min - d,
            max: self.max + d,
        }
    }
    fn contains(self, p: Point) -> bool {
        p.x >= self.min.x && p.x <= self.max.x && p.y >= self.min.y && p.y <= self.max.y
    }
    // Slab intersection along a ray. A stationary axis must lie in its slab.
    fn interval(self, p: Point, d: Point) -> Option<(f64, f64)> {
        let (mut lo, mut hi) = (f64::NEG_INFINITY, f64::INFINITY);
        for (v, s, min, max) in [
            (p.x, d.x, self.min.x, self.max.x),
            (p.y, d.y, self.min.y, self.max.y),
        ] {
            if s.abs() < 1e-12 {
                if v < min || v > max {
                    return None;
                }
            } else {
                let (a, b) = ((min - v) / s, (max - v) / s);
                lo = lo.max(a.min(b));
                hi = hi.min(a.max(b));
            }
        }
        (lo <= hi).then_some((lo, hi))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Layer {
    Ground,
    Air,
}

#[derive(Clone, Debug)]
pub struct Arena {
    pub width: f64,
    pub height: f64,
    pub ground_obstacles: Vec<Rect>,
}
impl Arena {
    pub fn classic() -> Self {
        let ground_obstacles = [(0., 80.), (200., 520.), (640., 720.)]
            .into_iter()
            .map(|(a, b)| Rect {
                min: Point::new(a, 600.),
                max: Point::new(b, 680.),
            })
            .collect();
        Self {
            width: 720.,
            height: 1280.,
            ground_obstacles,
        }
    }
    pub(crate) fn bounds(&self, r: f64) -> Rect {
        Rect {
            min: Point::new(r, r),
            max: Point::new(self.width - r, self.height - r),
        }
    }
    pub fn contains(&self, p: Point) -> bool {
        p.finite() && self.bounds(0.).contains(p)
    }
}

#[derive(Clone, Copy)]
pub(crate) struct Block {
    pub id: u64,
    pub center: Point,
    pub radius: f64,
    pub layer: Layer,
}
pub(crate) struct Query<'a> {
    pub map: &'a Arena,
    pub blocks: &'a [Block],
    pub id: u64,
    pub layer: Layer,
    pub radius: f64,
}
impl Query<'_> {
    fn obstacles(&self) -> impl Iterator<Item = Rect> + '_ {
        self.map
            .ground_obstacles
            .iter()
            .filter(|_| self.layer == Layer::Ground)
            .map(|r| r.expand(self.radius))
    }
    fn circles(&self) -> impl Iterator<Item = &Block> {
        self.blocks
            .iter()
            .filter(|b| b.id != self.id && b.layer == self.layer)
    }
    pub fn legal(&self, p: Point) -> bool {
        p.finite()
            && self.map.bounds(self.radius).contains(p)
            && !self.obstacles().any(|r| r.contains(p))
            && !self
                .circles()
                .any(|b| (p - b.center).length() < self.radius + b.radius)
    }
    pub fn clear(&self, a: Point, b: Point) -> bool {
        if !self.legal(b) {
            return false;
        }
        let d = b - a;
        if self.obstacles().any(|r| {
            r.interval(a, d)
                .is_some_and(|(lo, hi)| hi >= 0. && lo <= 1.)
        }) {
            return false;
        }
        let len = d.dot(d);
        self.circles().all(|c| {
            let t = if len > 0. {
                ((c.center - a).dot(d) / len).clamp(0., 1.)
            } else {
                0.
            };
            (a + d * t - c.center).length() >= self.radius + c.radius
        })
    }
    // Obstacles can be crossed in flight. Pick the first legal boundary forward
    // within the one-time extension budget, then the nearest legal point back.
    pub fn landing(&self, start: Point, dir: Point, distance: f64, extra: f64) -> Option<Point> {
        let max = distance + extra;
        let mut edges = vec![distance, 0., max];
        for rect in self.obstacles().chain([self.map.bounds(self.radius)]) {
            if let Some((a, b)) = rect.interval(start, dir) {
                edges.extend([a, b]);
            }
        }
        for b in self.circles() {
            let v = b.center - start;
            let along = v.dot(dir);
            let disc = (self.radius + b.radius).powi(2) - (v.dot(v) - along * along);
            if disc >= 0. {
                edges.extend([along - disc.sqrt(), along + disc.sqrt()]);
            }
        }
        edges
            .into_iter()
            .flat_map(|t| [t, t + 0.00001, t - 0.00001])
            .filter(|t| t.is_finite() && *t >= 0. && *t <= max && self.legal(start + dir * *t))
            .min_by(|a, b| {
                (*a < distance)
                    .cmp(&(*b < distance))
                    .then_with(|| (a - distance).abs().total_cmp(&(b - distance).abs()))
            })
            .map(|t| start + dir * t)
    }
}

impl Query<'_> {
    /// Closest legal center after interruption or arrival. The nearest point
    /// outside the excluded shapes is either a projection or an intersection
    /// of two boundaries. Include a tiny separation at excluded boundaries.
    pub fn nearest(&self, desired: Point, forward: f64) -> Option<Point> {
        if self.legal(desired) {
            return Some(desired);
        }
        let field = self.map.bounds(self.radius);
        if field.min.x > field.max.x || field.min.y > field.max.y {
            return None;
        }
        let mut xs = vec![field.min.x, field.max.x];
        let mut ys = vec![field.min.y, field.max.y];
        for r in self.obstacles() {
            let r = r.expand(0.00001);
            xs.extend([r.min.x, r.max.x]);
            ys.extend([r.min.y, r.max.y]);
        }
        let circles: Vec<_> = self
            .circles()
            .map(|b| (b.center, self.radius + b.radius + 0.00001))
            .collect();
        let mut best: Option<(f64, Point)> = None;
        let mut consider = |p: Point| {
            if !self.legal(p) {
                return;
            }
            let d = (p - desired).length();
            let better = best.is_none_or(|(dist, prev)| {
                d < dist - 1e-8
                    || ((d - dist).abs() <= 1e-8
                        && (p.y * forward, p.x * forward) > (prev.y * forward, prev.x * forward))
            });
            if better {
                best = Some((d, p))
            }
        };
        for &x in &xs {
            consider(Point::new(x, desired.y));
            for &y in &ys {
                consider(Point::new(x, y));
            }
        }
        for &y in &ys {
            consider(Point::new(desired.x, y));
        }
        for (i, &(c, r)) in circles.iter().enumerate() {
            let dir = (desired - c).unit().unwrap_or(Point::new(0., forward));
            consider(c + dir * r);
            for &x in &xs {
                let h = r * r - (x - c.x).powi(2);
                if h >= 0. {
                    consider(Point::new(x, c.y + h.sqrt()));
                    consider(Point::new(x, c.y - h.sqrt()));
                }
            }
            for &y in &ys {
                let h = r * r - (y - c.y).powi(2);
                if h >= 0. {
                    consider(Point::new(c.x + h.sqrt(), y));
                    consider(Point::new(c.x - h.sqrt(), y));
                }
            }
            for &(other, r2) in &circles[i + 1..] {
                let v = other - c;
                let distance = v.length();
                if distance < 1e-9 || distance > r + r2 || distance < (r - r2).abs() {
                    continue;
                }
                let axis = v * (1. / distance);
                let along = (r * r - r2 * r2 + distance * distance) / (2. * distance);
                let foot = c + axis * along;
                let side = Point::new(-axis.y, axis.x) * (r * r - along * along).max(0.).sqrt();
                consider(foot + side);
                consider(foot - side);
            }
        }
        best.map(|(_, p)| p)
    }
}
