import type { Unit } from "./battle-field";
import styles from "./unit-bar-styles.json";

const native: Record<
  string,
  { radius: number; alternate?: number; fullColor?: string; teamRing?: boolean }
> = styles;
export function showsTeamRing(u: Unit) {
  return (
    native[u.kind === "training_dummy" ? "target_dummy" : u.kind]?.teamRing !==
    false
  );
}
export function visualRadius(u: Unit) {
  const style = native[u.kind === "training_dummy" ? "target_dummy" : u.kind];
  return (
    (u.alternateForm ? style?.alternate : undefined) ??
    style?.radius ??
    u.radius
  );
}

export function barLayout(width: number, health: number, shield: number) {
  const scale = width / Math.max(1, (health + shield) / 1.5);
  return {
    normal: Math.min(health, 1) * scale,
    overflow: Math.max(0, health - 1) * scale,
    shieldStart: health * scale,
    shield: shield * scale,
    marker: scale,
    background: Math.max(1, health + shield) * scale,
  };
}

function objective(ctx: CanvasRenderingContext2D, u: Unit, friendly: boolean) {
  const nexus = u.kind === "nexus";
  const w = nexus ? 160 : 120;
  const center = nexus ? (friendly ? 84 : -80) : friendly ? -40 : -76;
  const x = -w / 2,
    y = center - 9;
  const shield = u.shield ?? 0;
  const perHp =
    w / (u.maxHp + (shield > 0 ? (u.bar?.shieldCapacity ?? shield) : 0));
  ctx.fillStyle = "#1a1a1a";
  ctx.fillRect(x, y, w, 18);
  ctx.fillStyle = friendly ? "#47e047" : "#f24742";
  ctx.fillRect(x, y, u.hp * perHp, 18);
  ctx.fillStyle = "white";
  if (shield > 0) ctx.fillRect(x + u.hp * perHp, y, shield * perHp, 18);
  const text = String(u.hp);
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.font = "13px system-ui";
  ctx.fillStyle = "rgba(0,0,0,.85)";
  ctx.fillText(text, 1, y + 15);
  ctx.fillStyle = "white";
  ctx.fillText(text, 0, y + 14);
}

let shell: HTMLImageElement | undefined;
function statuses(
  ctx: CanvasRenderingContext2D,
  u: Unit,
  left: number,
  right: number,
) {
  if (u.bar?.rounds != null && u.kind === "graves") {
    if (!shell) {
      shell = new Image();
      shell.src = "/play/media/battle/graves-shell.png";
    }
    if (shell.naturalWidth) {
      for (let i = 0; i < 2; i++) {
        ctx.filter = i < u.bar.rounds ? "none" : "brightness(.32)";
        ctx.drawImage(shell, left + i * 10, -12, 10, 10);
      }
      ctx.filter = "none";
    }
  }
  if (u.bar?.wounds) {
    ctx.save();
    ctx.translate(right + 10, 3);
    ctx.fillStyle = "#f22952";
    ctx.beginPath();
    ctx.moveTo(0, 7);
    ctx.bezierCurveTo(-12, -1, -5, -10, 0, -5);
    ctx.bezierCurveTo(5, -10, 12, -1, 0, 7);
    ctx.fill();
    ctx.fillStyle = "#292e30";
    for (const tilt of [-Math.PI / 4, Math.PI / 4]) {
      ctx.beginPath();
      ctx.ellipse(0, 0, 6.1, 1.65, tilt, 0, 2 * Math.PI);
      ctx.fill();
    }
    ctx.restore();
  }
  if (u.bar?.forged) {
    ctx.save();
    ctx.translate(left - 11, 3);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = "#4d2109";
    ctx.fillRect(-3, -2, 6, 10);
    ctx.fillRect(-7, -6, 14, 7);
    ctx.fillStyle = "#ff820f";
    ctx.fillRect(-2, -2, 4, 9);
    ctx.fillRect(-6, -5, 12, 5);
    ctx.restore();
  }
}

export function drawHealthBar(
  ctx: CanvasRenderingContext2D,
  u: Unit,
  friendly: boolean,
  x: number,
  y: number,
  projection: number,
  head: number | undefined,
  tick: number,
) {
  const state = u.bar;
  if (
    u.controls.includes("Stasis") ||
    u.maxHp <= 0 ||
    (u.hp <= 0 && !state?.recoveryTicks)
  )
    return;
  if (u.kind === "nexus" || u.kind === "princess_tower") {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(1, 1 / projection);
    objective(ctx, u, friendly);
    ctx.restore();
    return;
  }
  const ghost = state?.untargetable || u.dormant;
  const showBar =
    u.hp !== u.maxHp ||
    !!(
      u.shield ||
      ghost ||
      state?.wounds ||
      state?.forged ||
      state?.rounds != null ||
      state?.resource ||
      state?.recoveryTicks
    );
  const bleed = state?.bleedStacks ?? 0;
  if (!showBar && !bleed) return;
  const radius = visualRadius(u);
  const w = radius * 2;
  const health = state?.recoveryTicks
    ? Math.max(
        0,
        Math.min(1, 1 - ((u.readyTick ?? tick) - tick) / state.recoveryTicks),
      )
    : Math.max(0, u.hp / u.maxHp);
  const layout = barLayout(
    w,
    health,
    state?.recoveryTicks ? 0 : (u.shield ?? 0) / u.maxHp,
  );
  const left = -radius;
  ctx.save();
  ctx.translate(x, y - (head ?? radius));
  ctx.scale(1, 1 / projection);
  ctx.translate(0, -10.5); // 4.5 head gap + 6 bar height, in undistorted HUD pixels.
  if (bleed > 0) {
    ctx.fillStyle = "#f21f2e";
    for (let i = 0; i < bleed; i++) {
      ctx.beginPath();
      ctx.arc((i - (bleed - 1) / 2) * 7, 14, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  if (!showBar) {
    ctx.restore();
    return;
  }
  if (ghost) ctx.globalAlpha *= 0.45 + 0.15 * Math.cos((tick * Math.PI) / 24);
  ctx.fillStyle = "#262626";
  ctx.fillRect(left, 0, layout.background, 6);
  ctx.fillStyle = friendly
    ? ghost
      ? "#6ae67b"
      : "#33e633"
    : ghost
      ? "#d98b8f"
      : "#f24040";
  ctx.fillRect(left, 0, layout.normal, 6);
  if (layout.overflow > 0) {
    ctx.fillStyle = "#d159ff";
    ctx.fillRect(left + layout.marker, 0, layout.overflow, 6);
  }
  if (layout.shield > 0) {
    ctx.fillStyle = "white";
    ctx.fillRect(left + layout.shieldStart, 0, layout.shield, 6);
  }
  ctx.fillStyle = "#14141a";
  ctx.fillRect(left + layout.marker - 1.5, -1, 3, 8);
  ctx.fillStyle = "#f5f5ff";
  ctx.fillRect(left + layout.marker - 0.5, -1, 1, 8);
  if (ghost) {
    ctx.globalAlpha = 1;
    ctx.font = "12px system-ui";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#0a1a1f";
    ctx.strokeText("不可选取", 0, -5);
    ctx.fillStyle = "#c2f5ff";
    ctx.fillText("不可选取", 0, -5);
  }
  statuses(ctx, u, left, left + layout.background);
  if (state?.resource) {
    const [value, max] = state.resource;
    const count = Number.isInteger(max) && max >= 2 && max <= 10 ? max : 1;
    const gap = 1.6875,
      width = (w - (count - 1) * gap) / count;
    const color =
      value >= max ? (native[u.kind]?.fullColor ?? "#f5f5fff5") : "#f5f5fff5";
    for (let i = 0; i < count; i++) {
      const start = left + i * (width + gap);
      ctx.fillStyle = "#1a1a1fe6";
      ctx.fillRect(start, 8.25, width, 3);
      ctx.fillStyle = color;
      ctx.fillRect(
        start,
        8.25,
        width *
          (count === 1
            ? Math.min(1, value / max)
            : Number(i < Math.round(value))),
        3,
      );
    }
  }
  ctx.restore();
}
