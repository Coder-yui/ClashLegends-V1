import data from "../../content/battle_rules.json";
import type { Frame } from "./battle-field";
import type { Point } from "./presentation";

interface Rule {
  type: string;
  radius?: number;
  inner_radius?: number;
  range?: number;
  wave_width?: number;
  footprint_tiles?: number[];
  tower_ruin_foundation?: boolean;
  is_air?: boolean;
  river_traversal?: boolean;
  terrain_traversal?: boolean;
  deployment_count?: number;
  deployment_formation?: string;
  deployment_spacing?: number;
  deploy_formation_requires_in_bounds?: boolean;
  spawn_plan?: { members: string[]; formation: string; spacing: number };
  active_skills?: {
    kind?: string;
    id?: string;
    radius?: number;
    global_heal?: boolean;
  }[];
  deployment_upgrade_id?: string;
  cost?: number;
}
const rules: Record<string, Rule> = data;
const clamp = (n: number, min: number, max: number) =>
  Math.min(max, Math.max(min, n));

export const states = {
  legal: { color: "#70f4b1", label: "可以部署", dash: [] },
  invalid: { color: "#ff746b", label: "非法区域", dash: [10, 5] },
  poor: { color: "#ffca61", label: "金币不足", dash: [3, 4] },
};

function footprint(kind: string) {
  return (
    rules[kind]?.footprint_tiles?.[0] ??
    (kind === "nexus" ? 4 : kind === "princess_tower" ? 3 : 1)
  );
}

function formation(rule: Rule, form: string, me: number) {
  const plan = rule.spawn_plan;
  const kinds =
    plan?.members ?? Array<string>(rule.deployment_count ?? 1).fill(form);
  const layout = plan?.formation ?? rule.deployment_formation;
  const step = (plan?.spacing ?? rule.deployment_spacing ?? 0) * (me ? -1 : 1);
  const offsets = kinds.map((kind, i) => {
    const along = (i - (kinds.length - 1) / 2) * step;
    const angle =
      (layout === "square" ? -Math.PI / 4 : -Math.PI / 2) +
      (2 * Math.PI * i) / kinds.length;
    if (layout === "line") return { kind, x: along, y: 0 };
    if (layout === "depth_line") return { kind, x: 0, y: along };
    return { kind, x: step * Math.cos(angle), y: step * Math.sin(angle) };
  });
  const xs = offsets.map((p) => p.x),
    ys = offsets.map((p) => p.y);
  const midX = (Math.max(...xs) + Math.min(...xs)) / 2;
  const midY = (Math.max(...ys) + Math.min(...ys)) / 2;
  return offsets.map((p) => ({ kind: p.kind, x: p.x - midX, y: p.y - midY }));
}

// A troop that cannot stand at its formation offset lands at the closest
// legal center. Only visible structures and stasis bodies participate here.
function troopCenter(frame: Frame, kind: string, desired: Point, me: number) {
  const rule = rules[kind];
  const radius = rule?.radius ?? 14;
  const { width, height } = frame.map;
  const obstacles =
    rule?.is_air || rule?.river_traversal || rule?.terrain_traversal
      ? []
      : frame.map.obstacles;
  const blocks = frame.units.filter(
    (u) =>
      (u.structure || u.controls.includes("Stasis")) &&
      !!(u.air ?? rules[u.kind]?.is_air) === !!rule?.is_air,
  );
  const legal = (x: number, y: number) =>
    x >= radius &&
    x <= width - radius &&
    y >= radius &&
    y <= height - radius &&
    !obstacles.some(
      ([l, t, r, b]) =>
        x >= l - radius &&
        x <= r + radius &&
        y >= t - radius &&
        y <= b + radius,
    ) &&
    !blocks.some(
      (u) =>
        Math.hypot(x - u.x, y - u.y) <
        u.radius + radius + (u.structure ? 1.5 : 0),
    );
  if (legal(desired.x, desired.y)) return desired;

  const gap = 0.00001;
  const xs = [radius, width - radius],
    ys = [radius, height - radius];
  for (const [l, t, r, b] of obstacles) {
    xs.push(l - radius - gap, r + radius + gap);
    ys.push(t - radius - gap, b + radius + gap);
  }
  let best: Point | undefined,
    distance = Infinity;
  const forward = me ? 1 : -1;
  function consider(x: number, y: number) {
    const d = Math.hypot(x - desired.x, y - desired.y);
    if (d > distance + 1e-8 || !legal(x, y)) return;
    if (
      !best ||
      d < distance - 1e-8 ||
      forward * (y - best.y) > 0 ||
      (y === best.y && forward * (x - best.x) > 0)
    ) {
      best = { x, y };
      distance = d;
    }
  }
  for (const x of xs) {
    consider(x, desired.y);
    for (const y of ys) consider(x, y);
  }
  for (const y of ys) consider(desired.x, y);
  const circles = blocks.map((u) => ({
    x: u.x,
    y: u.y,
    r: u.radius + radius + (u.structure ? 1.5 : 0) + gap,
  }));
  for (const [index, c] of circles.entries()) {
    const dx = desired.x - c.x,
      dy = desired.y - c.y,
      length = Math.hypot(dx, dy);
    consider(
      c.x + (length ? dx / length : 0) * c.r,
      c.y + (length ? dy / length : forward) * c.r,
    );
    for (const x of xs) {
      const h = Math.sqrt(c.r ** 2 - (x - c.x) ** 2);
      if (Number.isFinite(h)) {
        consider(x, c.y + h);
        consider(x, c.y - h);
      }
    }
    for (const y of ys) {
      const h = Math.sqrt(c.r ** 2 - (y - c.y) ** 2);
      if (Number.isFinite(h)) {
        consider(c.x + h, y);
        consider(c.x - h, y);
      }
    }
    for (const other of circles.slice(index + 1)) {
      const dx = other.x - c.x,
        dy = other.y - c.y,
        d = Math.hypot(dx, dy);
      if (d < 1e-9 || d > c.r + other.r || d < Math.abs(c.r - other.r))
        continue;
      const along = (c.r ** 2 - other.r ** 2 + d ** 2) / (2 * d);
      const side = Math.sqrt(Math.max(0, c.r ** 2 - along ** 2));
      for (const sign of [-1, 1])
        consider(
          c.x + (dx * along - sign * dy * side) / d,
          c.y + (dy * along + sign * dx * side) / d,
        );
    }
  }
  return best;
}

export function placementAt(
  frame: Frame,
  slot: number,
  pointer: Point,
  me: number,
  skill?: string,
) {
  const { width, height, tile } = frame.map;
  if (
    pointer.x < 0 ||
    pointer.y < 0 ||
    pointer.x >= width ||
    pointer.y >= height
  )
    return;
  const key = frame.hand[slot] === "mirror" ? frame.lastCard : frame.hand[slot];
  const rule = key && rules[key];
  if (!rule) return;
  const upgrade = rule.deployment_upgrade_id;
  const form =
    frame.handForms?.[slot] ??
    (upgrade && rules[upgrade].cost === frame.costs[slot] ? upgrade : key);
  const spell = rule.type === "spell";
  const size = footprint(form);
  const span = size * tile,
    half = span / 2;
  const snap = (v: number, max: number) =>
    clamp(
      (size % 2 ? Math.floor(v / tile) + 0.5 : Math.round(v / tile)) * tile,
      half,
      max - half,
    );
  const x = snap(pointer.x, width),
    y = snap(pointer.y, height);
  const left = Math.round((x - half) / tile),
    top = Math.round((y - half) / tile);
  const regions = frame.deployment[slot];
  let valid = true;
  for (let col = left; col < left + size; col++)
    for (let row = top; row < top + size; row++)
      if (
        !regions.some(
          (r) =>
            col >= r.x &&
            col < r.x + r.width &&
            row >= r.y &&
            row < r.y + r.height,
        )
      )
        valid = false;

  const ruin =
    !!rule.tower_ruin_foundation &&
    !!frame.ruinedTowers?.some((p) => p.x === x && p.y === y);
  let members: { kind: string; x: number; y: number }[] = [];
  if (!spell) {
    if (ruin) valid = true;
    else if (
      frame.units.some((u) => {
        if (!u.structure) return false;
        const reach = half + ((u.footprint ?? footprint(u.kind)) * tile) / 2;
        return Math.abs(x - u.x) < reach && Math.abs(y - u.y) < reach;
      })
    )
      valid = false;
    members = formation(rule, form, me).map((p) => {
      const r = rules[p.kind]?.radius ?? 14;
      const px = x + p.x,
        py = y + p.y;
      const mx = clamp(px, r, width - r),
        my = clamp(py, r, height - r);
      if (rule.deploy_formation_requires_in_bounds && (mx !== px || my !== py))
        valid = false;
      const pos =
        rule.type === "building" || !valid
          ? { x: mx, y: my }
          : troopCenter(frame, p.kind, { x: px, y: py }, me);
      if (!pos) valid = false;
      return { kind: p.kind, ...(pos ?? { x: mx, y: my }) };
    });
    if (rule.type === "building") {
      const radius = rule.radius ?? 14;
      if (
        frame.map.obstacles.some(
          ([l, t, r, b]) =>
            x >= l - radius &&
            x <= r + radius &&
            y >= t - radius &&
            y <= b + radius,
        ) ||
        frame.units.some(
          (u) =>
            !(u.air ?? rules[u.kind]?.is_air) &&
            !(u.inFlight ?? u.activity === "Displaced") &&
            Math.hypot(x - u.x, y - u.y) < radius + u.radius + 1.5,
        )
      )
        valid = false;
    }
  }
  const active = skill
    ? rule.active_skills?.find((s) => s.id === skill)
    : undefined;
  const state: keyof typeof states = !valid
    ? "invalid"
    : frame.gold < frame.costs[slot]
      ? "poor"
      : "legal";
  return {
    x,
    y,
    span,
    state,
    members,
    spell,
    ruin,
    radius: spell ? Math.max(rule.radius ?? 0, active?.radius ?? 0) : 0,
    inner:
      key === "stellar_convergence" && !active ? 0 : (rule.inner_radius ?? 0),
    global: !!active?.global_heal,
    range: spell ? (rule.range ?? 0) : 0,
    waveWidth: rule.wave_width ?? 0,
  };
}
export type Placement = NonNullable<ReturnType<typeof placementAt>>;

export function drawPlacement(
  ctx: CanvasRenderingContext2D,
  p: Placement,
  frame: Frame,
  me: number,
) {
  const { width, height, tile } = frame.map;
  const x = me ? width - p.x : p.x,
    y = me ? height - p.y : p.y;
  const style = states[p.state];
  ctx.save();
  ctx.strokeStyle = ctx.fillStyle = style.color;
  ctx.lineWidth = 3;
  ctx.setLineDash(style.dash);
  function paint(alpha: number) {
    ctx.globalAlpha = alpha;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.rect(0, 0, width, height);
  ctx.clip();
  if (p.global) {
    ctx.beginPath();
    ctx.rect(1, 1, width - 2, height - 2);
    paint(0.08);
  }
  ctx.translate(x, y);
  ctx.beginPath();
  if (p.range && p.waveWidth) {
    ctx.rect(-p.waveWidth / 2, -p.range, p.waveWidth, p.range);
  } else if (p.spell) {
    ctx.arc(0, 0, p.radius, 0, 2 * Math.PI);
  } else {
    ctx.rect(-p.span / 2, -p.span / 2, p.span, p.span);
  }
  paint(0.16);
  if (p.inner) {
    ctx.beginPath();
    ctx.arc(0, 0, p.inner, 0, 2 * Math.PI);
    paint(0.15);
  }
  ctx.setLineDash([]);
  ctx.beginPath();
  for (let i = tile; i < p.span; i += tile) {
    const v = i - p.span / 2;
    ctx.moveTo(v, -p.span / 2);
    ctx.lineTo(v, p.span / 2);
    ctx.moveTo(-p.span / 2, v);
    ctx.lineTo(p.span / 2, v);
  }
  ctx.moveTo(-7, 0);
  ctx.lineTo(7, 0);
  ctx.moveTo(0, 7);
  ctx.lineTo(0, p.range ? -p.range : -7);
  ctx.stroke();
  ctx.restore();
}
