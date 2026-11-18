use crate::space::{Point, Query};
use std::collections::VecDeque;
const CELL: f64 = 20.;
pub(crate) fn route(q: &Query, start: Point, target: Point, reach: f64) -> VecDeque<Point> {
    let endpoint = |p: Point| target - (target - p).unit().unwrap_or_default() * reach;
    if q.clear(start, endpoint(start)) {
        return VecDeque::from([endpoint(start)]);
    }
    let size = (
        (q.map.width / CELL).ceil() as usize,
        (q.map.height / CELL).ceil() as usize,
    );
    let first = ((start.x / CELL) as usize, (start.y / CELL) as usize);
    let pos = |(x, y): (usize, usize)| {
        if (x, y) == first {
            start
        } else {
            Point::new((x as f64 + 0.5) * CELL, (y as f64 + 0.5) * CELL)
        }
    };
    let cells = crate::path_search::search(
        size,
        first,
        |c| {
            let p = pos(c);
            (p - target).length() <= reach || q.clear(p, endpoint(p))
        },
        |c| (((pos(c) - target).length() - reach).max(0.) / CELL * 9.) as i64,
        |a, b| q.clear(pos(a), pos(b)).then_some(1),
    );
    let Some(&last) = cells.last() else {
        return VecDeque::new();
    };
    let mut path: VecDeque<_> = cells.into_iter().skip(1).map(pos).collect();
    if (pos(last) - target).length() > reach {
        path.push_back(endpoint(pos(last)))
    }
    path
}
