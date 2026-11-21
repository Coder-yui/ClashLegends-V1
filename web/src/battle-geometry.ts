// Presentation margin in map coordinates. Input, simulation and terrain still
// use the original map rectangle, even when actors extend past its edge.
export const fieldMargin = 160;

export function fieldPoint(
  el: HTMLElement,
  map: { width: number; height: number },
  me: number,
  cx: number,
  cy: number,
) {
  const box = el.getBoundingClientRect();
  if (cx < box.left || cx >= box.right || cy < box.top || cy >= box.bottom)
    return;
  const { width, height } = map;
  const x = ((cx - box.left) * width) / box.width,
    y = ((cy - box.top) * height) / box.height;
  return {
    x: me ? Math.min(width - 1e-6, width - x) : x,
    y: me ? Math.min(height - 1e-6, height - y) : y,
  };
}
