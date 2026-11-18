//! Weighted grid search. Equal-cost nodes retain the legacy neighbour and
//! heap-child ordering so replacing a map query does not change a tie.
type Cell = (usize, usize);
const DIRECTIONS: [(isize, isize); 8] = [
    (0, -1),
    (0, 1),
    (-1, 0),
    (1, 0),
    (-1, -1),
    (-1, 1),
    (1, 1),
    (1, -1),
];
struct Open {
    heap: Vec<usize>,
    slot: Vec<usize>,
}
impl Open {
    fn swap(&mut self, a: usize, b: usize) {
        self.heap.swap(a, b);
        self.slot[self.heap[a]] = a;
        self.slot[self.heap[b]] = b;
    }
    fn update(&mut self, id: usize, f: &[i64]) {
        let mut i = self.slot[id];
        if i == usize::MAX {
            i = self.heap.len();
            self.heap.push(id);
            self.slot[id] = i
        }
        while i > 0 {
            let parent = (i - 1) / 2;
            if f[self.heap[parent]] <= f[id] {
                break;
            }
            self.swap(i, parent);
            i = parent;
        }
    }
    fn pop(&mut self, f: &[i64]) -> Option<usize> {
        let id = *self.heap.first()?;
        let last = self.heap.pop().unwrap();
        self.slot[id] = usize::MAX;
        if !self.heap.is_empty() {
            self.heap[0] = last;
            self.slot[last] = 0;
            let mut i = 0;
            loop {
                let mut best = i;
                for c in [2 * i + 2, 2 * i + 1] {
                    if c < self.heap.len() && f[self.heap[c]] < f[self.heap[best]] {
                        best = c
                    }
                }
                if best == i {
                    break;
                }
                self.swap(i, best);
                i = best;
            }
        }
        Some(id)
    }
}
pub(crate) fn search(
    size: Cell,
    start: Cell,
    goal: impl Fn(Cell) -> bool,
    estimate: impl Fn(Cell) -> i64,
    cost: impl Fn(Cell, Cell) -> Option<u32>,
) -> Vec<Cell> {
    let (w, h) = size;
    let Some(n) = w.checked_mul(h) else {
        return vec![];
    };
    if start.0 >= w || start.1 >= h {
        return vec![];
    }
    let source = start.1 * w + start.0;
    let mut open = Open {
        heap: vec![],
        slot: vec![usize::MAX; n],
    };
    let mut closed = vec![false; n];
    let mut parents = vec![usize::MAX; n];
    let mut g = vec![i64::MAX; n];
    let mut f = vec![0; n];
    g[source] = 0;
    open.update(source, &f);
    while let Some(id) = open.pop(&f) {
        let c = (id % w, id / w);
        closed[id] = true;
        if goal(c) {
            let mut path = vec![];
            let mut i = id;
            loop {
                path.push((i % w, i / w));
                i = parents[i];
                if i == usize::MAX {
                    break;
                }
            }
            path.reverse();
            return path;
        }
        for (dx, dy) in DIRECTIONS {
            let (Some(x), Some(y)) = (c.0.checked_add_signed(dx), c.1.checked_add_signed(dy))
            else {
                continue;
            };
            if x >= w || y >= h {
                continue;
            }
            let next = y * w + x;
            if closed[next] {
                continue;
            }
            let Some(weight) = cost(c, (x, y)) else {
                continue;
            };
            let score = g[id] + i64::from(weight) * if dx != 0 && dy != 0 { 14 } else { 10 };
            if score < g[next] {
                g[next] = score;
                parents[next] = id;
                f[next] = score + estimate((x, y));
                open.update(next, &f)
            }
        }
    }
    vec![]
}
pub fn weighted_path(
    size: Cell,
    costs: &[i32],
    start: Cell,
    goal: Cell,
    minimum: u32,
) -> Vec<Cell> {
    if size.0.checked_mul(size.1) != Some(costs.len())
        || [start, goal]
            .iter()
            .any(|&(x, y)| x >= size.0 || y >= size.1 || costs[y * size.0 + x] < 0)
    {
        return vec![];
    }
    search(
        size,
        start,
        |p| p == goal,
        |(x, y)| {
            let dx = x.abs_diff(goal.0) as i64;
            let dy = y.abs_diff(goal.1) as i64;
            i64::from(minimum) * (10 * (dx + dy) - 6 * dx.min(dy))
        },
        |_, (x, y)| costs[y * size.0 + x].try_into().ok(),
    )
}
