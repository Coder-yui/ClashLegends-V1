import type { CSSProperties } from "react";
import type { Card, Skill } from "./api";
import type { Frame } from "./battle-field";

function resourceRing(value: number, max: number, fullColor: string) {
  const fill = value >= max ? fullColor : "#f5f5fff5";
  const dark = "#171c29";
  if (Number.isInteger(max) && max >= 2 && max <= 10) {
    const step = 360 / max,
      gap = Math.min((0.1 * 180) / Math.PI, step * 0.24) / 2;
    const stops = Array.from({ length: max }, (_, i) => {
      const color = i < Math.round(value) ? fill : dark;
      return `transparent ${i * step}deg ${i * step + gap}deg, ${color} ${i * step + gap}deg ${(i + 1) * step - gap}deg, transparent ${(i + 1) * step - gap}deg ${(i + 1) * step}deg`;
    });
    return `conic-gradient(${stops.join(",")})`;
  }
  const charge = Math.min(100, Math.max(0, (100 * value) / max));
  return `conic-gradient(${fill} ${charge}%, ${dark} ${charge}%)`;
}

export function ActiveSkillButton({
  frame,
  slot,
  card,
  skill,
  ready,
  pending,
  onCast,
  fullColor = "#f5f5fff5",
}: {
  frame: Frame;
  slot: number;
  card: Card;
  skill?: Skill;
  ready: boolean;
  pending: boolean;
  onCast: () => void;
  fullColor?: string;
}) {
  const active = frame.active[slot],
    state = frame.buttons?.[slot];
  const cost = frame.activeCost?.[slot] ?? skill?.cost ?? card.skillCost ?? 0;
  const energy = frame.skillResource?.[slot];
  const charging = Boolean(energy?.[2] && energy[0] < energy[1]);
  const wait = frame.activeWait[slot];
  const locked = state?.locked ?? (charging || wait > 0);
  const remaining = state?.cooldownLeft ?? wait;
  const cooldown = (Math.ceil(remaining / 2) / 10).toFixed(1);
  const completed =
    1 - Math.min(1, remaining / Math.max(1, state?.cooldownTotal ?? 1));
  const poor = frame.gold < cost;
  const uses =
    active?.uses === 255 ? "∞" : state?.freeRecast ? 1 : (active?.uses ?? 0);
  const name = skill?.name ?? card.name;
  const status = !active?.uses
    ? "待部署"
    : pending
      ? "等待确认"
      : charging
        ? "技能资源不足"
        : locked
          ? "当前无法起手"
          : remaining
            ? "冷却 " + cooldown + " 秒"
            : poor
              ? "金币不足"
              : "可用";
  return (
    <button
      className={!active?.uses ? "skill-dormant" : ""}
      data-caster={card.name}
      data-awaiting={!active}
      aria-label={name + " · " + status}
      title={[
        name,
        skill?.description,
        `消耗 ${cost} 金币 · 剩余 ${uses} 次`,
        status,
      ]
        .filter(Boolean)
        .join("\n")}
      disabled={
        !ready || !active?.uses || locked || wait > 0 || poor || pending
      }
      onClick={onCast}
    >
      <span
        className="skill-icon"
        data-tint={locked ? "locked" : poor ? "poor" : undefined}
      >
        {skill?.image ? (
          <img src={skill.image} alt="" />
        ) : !remaining && !pending ? (
          name.slice(0, 1)
        ) : (
          ""
        )}
        {state && remaining > 0 && (
          <i
            className="skill-sweep"
            style={{ "--complete": completed * 100 + "%" } as CSSProperties}
          />
        )}
      </span>
      {remaining > 0 && <strong className="skill-cooldown">{cooldown}</strong>}
      <small className={"coin-cost" + (poor ? " poor" : "")}>{cost}</small>
      <b className="skill-uses">{uses}</b>
      {locked && (
        <span className="skill-lock" aria-hidden="true">
          <i />
        </span>
      )}
      {pending && <span className="skill-pending">…</span>}
      {energy && energy[1] > 0 && (
        <span
          className="battle-resource"
          aria-label={`技能资源 ${energy[0]} / ${energy[1]}`}
          style={{ background: resourceRing(energy[0], energy[1], fullColor) }}
        />
      )}
    </button>
  );
}
