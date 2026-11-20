import type { Point } from "./presentation";
export interface SummonFlight {
  source: number;
  origin: Point;
  destination: Point;
  start: number;
  arrival: number;
  sourceScale: number;
  sourceAirborne: boolean;
  airborne: boolean;
}

// Project the fixed endpoints and fade the trail using the reference summon_mote timing.
export function drawSummonFlight(
  ctx: CanvasRenderingContext2D,
  flight: SummonFlight,
  tick: number,
  projection: number,
  x: (value: number) => number,
  y: (value: number) => number,
) {
  const lift = (40 * Math.sqrt(1 - projection ** 2)) / projection;
  const from = {
    x: x(flight.origin.x),
    y:
      y(flight.origin.y) -
      lift * (0.7 * flight.sourceScale + (flight.sourceAirborne ? 2.3 : 0)),
  };
  const to = {
    x: x(flight.destination.x),
    y: y(flight.destination.y) - lift * (flight.airborne ? 2.55 : 0.3),
  };
  const progress = Math.max(
    0,
    Math.min(1, (tick - flight.start) / (flight.arrival - flight.start)),
  );
  const point = (t: number) => ({
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
  });
  const circle = (p: Point, r: number, color: string) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
  };
  let previous = point(Math.max(0, progress - 0.55));
  ctx.save();
  ctx.lineCap = "round";
  for (let index = 1; index <= 14; index++) {
    const fade = index / 14,
      t = Math.max(0, progress - 0.55 * (1 - fade)),
      p = point(t);
    ctx.beginPath();
    ctx.moveTo(previous.x, previous.y);
    ctx.lineTo(p.x, p.y);
    ctx.lineWidth = 13 * fade;
    ctx.strokeStyle = `rgba(148,31,255,${fade * 0.3})`;
    ctx.stroke();
    ctx.lineWidth = 4 * fade;
    ctx.strokeStyle = `rgba(214,112,255,${fade * 0.95})`;
    ctx.stroke();
    if (index % 3 === 0)
      circle(
        { x: p.x + Math.sin(t * 30) * 5, y: p.y + Math.cos(t * 24) * 5 },
        1.7,
        `rgba(235,166,255,${fade})`,
      );
    previous = p;
  }
  circle(previous, 9, "rgba(153,38,255,.25)");
  circle(previous, 4, "#f0bcff");
  ctx.restore();
}
