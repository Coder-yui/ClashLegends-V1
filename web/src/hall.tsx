import { activeSlot, slotFor } from "./player-data";
import { href } from "./api";
import type { Catalog, Room, Session } from "./api";
import { DeckStrip } from "./deck-strip";
export function Hall({
  catalog,
  room,
  session,
  setup,
}: {
  catalog: Catalog;
  room?: Room;
  session: Session;
  setup: (kind: string) => void;
}) {
  const preset = slotFor(session, catalog, activeSlot(session));
  return (
    <>
      <div className="hero">
        <div className="hero-art" />
        <div className="hero-copy">
          <div className="eyebrow">
            <span className="line" />
            CLASH LEGENDS
          </div>
          <h1>对战大厅</h1>
          <p>
            {catalog.modes[0]?.name} <em>／</em> 1 对 1 <em>／</em>{" "}
            {
              catalog.maps.find((m) => m.id === catalog.modes[0]?.mapIds[0])
                ?.name
            }
          </p>
        </div>
      </div>
      <div className="recordings-link">
        <a href={href("recordings")} className="outline">
          我的录制
        </a>
      </div>
      {room && session.roomId && (
        <div className="resume">
          <strong>
            {room.matchId ? "你有一场待继续的对局" : "你有一个活动房间"}
          </strong>
          <a
            href={href(
              room.matchId ? "matches/" + room.matchId : "rooms/" + room.id,
            )}
          >
            {room.matchId ? "进入战场" : "返回房间"} →
          </a>
        </div>
      )}
      <div className="section-title">
        <h2>选择对手</h2>
        <button className="text-button" onClick={() => setup("join")}>
          输入邀请码 <span>↗</span>
        </button>
      </div>
      <div className="modes">
        <article className="mode ai">
          <div className="mode-art" />
          <div className="mode-copy">
            <small>单人训练</small>
            <h2>AI 对战</h2>
            <button
              className="gold"
              disabled={!!session.roomId}
              onClick={() => setup("ai")}
            >
              对战 AI <span>→</span>
            </button>
          </div>
        </article>
        <article className="mode friend">
          <div className="mode-art" />
          <div className="mode-copy">
            <small>双人房间</small>
            <h2>好友对战</h2>
            <button
              className="outline"
              disabled={!!session.roomId}
              onClick={() => setup("friend")}
            >
              创建房间 <span>→</span>
            </button>
          </div>
        </article>
      </div>
      <div className="section-title">
        <h2>备战卡组</h2>
        <a className="text-button" href={href("decks")}>
          管理卡组 ↗
        </a>
      </div>
      <div className="panel">
        <h3>{preset.name}</h3>
        {session.presets.length > 0 && (
          <a href={href("decks/collection")}>管理旧版预设</a>
        )}
        <DeckStrip catalog={catalog} deck={preset.deck} />
      </div>
    </>
  );
}
