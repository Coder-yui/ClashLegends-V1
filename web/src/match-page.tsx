import { href } from "./api";
import type { Catalog, Match, Session } from "./api";
import { DeckStrip } from "./deck-strip";
export function MatchPage({
  catalog,
  match,
  session,
}: {
  catalog: Catalog;
  match: Match;
  session: Session;
}) {
  return (
    <>
      <div className="page-title">
        <div>
          <span className="eyebrow">第 {match.round} 轮 · 开局确认</span>
          <h1>
            {match.status === "withdrawn" ? "本次备战已结束" : "配置已锁定"}
          </h1>
        </div>
      </div>
      <div className="panel result">
        <img src="/play/media/crest.webp" alt="" />
        <h2>
          {catalog.modes.find((x) => x.id === match.mode)?.name} ·{" "}
          {catalog.maps.find((x) => x.id === match.map)?.name}
        </h2>
        <p>
          {match.me === 0 ? "蓝方" : "红方"} · 对手 {match.opponent}
        </p>
        <small>比赛 ID</small>
        <code>{match.id}</code>
      </div>
      <div className="section-title">
        <h2>已锁定卡组与技能</h2>
      </div>
      <div className="panel">
        <DeckStrip catalog={catalog} deck={match.deck} />
      </div>
      <div className="footer-actions">
        <a className="outline" href={href()}>
          返回大厅
        </a>
        {session.roomId === match.roomId && (
          <a className="gold" href={href("rooms/" + match.roomId)}>
            返回房间
          </a>
        )}
      </div>
    </>
  );
}
