import { href, defaultDeck } from "./api";
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
            经典模式 <em>／</em> 1 对 1 <em>／</em> 晴昼峡谷
          </p>
        </div>
      </div>
      {room && session.roomId && (
        <div className="resume">
          <strong>
            {room.matchId ? "比赛配置已锁定" : "你有一个活动房间"}
          </strong>
          <a
            href={href(
              room.matchId ? "matches/" + room.matchId : "rooms/" + room.id,
            )}
          >
            {room.matchId ? "查看开局" : "返回房间"} →
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
        <h3>{session.presets[0]?.name ?? "经典初始卡组"}</h3>
        <DeckStrip
          catalog={catalog}
          deck={session.presets[0]?.deck ?? defaultDeck(catalog)}
        />
      </div>
    </>
  );
}
