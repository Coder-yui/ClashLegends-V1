import { useConfirmation } from "./controls";
import { href } from "./api";
import type { Catalog, Room } from "./api";
import { DeckStrip } from "./deck-strip";
export function RoomPage({
  catalog,
  room,
  online,
  busy,
  setup,
  run,
  action,
  notify,
}: {
  catalog: Catalog;
  room: Room;
  online: boolean;
  busy: boolean;
  setup: (kind: string) => void;
  run: (fn: () => Promise<void>) => Promise<void>;
  action: (a: string, data?: object) => Promise<void>;
  notify: (s: string) => void;
}) {
  const { ask, confirmation } = useConfirmation();
  return (
    <>
      {confirmation}
      <div className="page-title">
        <div>
          <span className="eyebrow">
            第 {room.round} 轮 · {room.kind === "ai" ? "训练场" : "双人对战"}
          </span>
          <h1>{room.kind === "ai" ? "AI 备战室" : "好友房间"}</h1>
        </div>
        <a className="outline" href={href()}>
          返回大厅
        </a>
      </div>
      <div className="room-layout">
        <article className="panel">
          <div className="section-title">
            <h2>对战席位</h2>
            <small>{room.seats.length} / 2</small>
          </div>
          {[0, 1].map((i) => {
            const seat = room.seats[i];
            return (
              <div key={i} className="seat">
                <div className={"sigil team" + i}>{i === 0 ? "Ⅰ" : "Ⅱ"}</div>
                <div>
                  <b>{seat?.name ?? "等待好友加入"}</b>
                  <small>
                    {i === 0 ? "房主" : seat?.ai ? "AI 对手" : "挑战者"}
                    {room.me === i ? " · 你" : ""}
                  </small>
                </div>
                <strong>
                  {seat
                    ? seat.online
                      ? seat.ready
                        ? "已准备"
                        : "备战中"
                      : "重连中"
                    : "空席"}
                </strong>
              </div>
            );
          })}
          {room.kind === "friend" && room.status === "open" && (
            <div className="invite">
              <div>
                <small>房间邀请码</small>
                <b data-testid="invite">{room.code}</b>
              </div>
              <button
                onClick={() =>
                  run(async () => {
                    const link = location.origin + href("?invite=" + room.code);
                    try {
                      await navigator.clipboard.writeText(link);
                      notify("邀请链接已复制");
                    } catch {
                      notify(link);
                    }
                  })
                }
              >
                复制邀请链接
              </button>
            </div>
          )}
        </article>
        <aside
          className="map-card"
          style={{
            backgroundImage:
              "linear-gradient(0deg,#0c181df5,transparent),url(" +
              catalog.maps.find((x) => x.id === room.map)?.image +
              ")",
          }}
        >
          <small>{catalog.modes.find((x) => x.id === room.mode)?.name}</small>
          <h2>{catalog.maps.find((x) => x.id === room.map)?.name}</h2>
          {room.me === 0 && room.status === "open" && (
            <button onClick={() => setup("settings")}>对战设置</button>
          )}
        </aside>
      </div>
      <div className="section-title">
        <h2>本局卡组</h2>
        {room.status === "open" && (
          <a className="text-button" href={href("rooms/" + room.id + "/deck")}>
            编辑卡组与技能 ↗
          </a>
        )}
      </div>
      <div className="panel">
        <DeckStrip deck={room.deck} catalog={catalog} />
      </div>
      <div className="footer-actions">
        {room.status === "open" ? (
          <>
            <button
              onClick={async () => {
                if (
                  await ask(
                    "离开房间",
                    room.me === 0
                      ? "离开后将关闭房间，当前邀请码随即失效。"
                      : "退出后，好友可以邀请其他玩家。",
                    "确认离开",
                  )
                )
                  run(() => action("leave"));
              }}
            >
              离开房间
            </button>
            <button
              className="gold"
              disabled={
                busy ||
                !online ||
                room.seats.length !== 2 ||
                room.seats.some((x) => !x.online)
              }
              onClick={() =>
                run(() =>
                  action("ready", { ready: !room.seats[room.me].ready }),
                )
              }
            >
              {room.kind === "ai"
                ? "开始对战"
                : room.seats[room.me].ready
                  ? "取消准备"
                  : "准备"}
            </button>
          </>
        ) : room.status === "locked" ? (
          <>
            {room.me === 0 && (
              <button onClick={() => run(() => action("reopen"))}>
                结束本次备战，重新组局
              </button>
            )}
            <a className="gold" href={href("matches/" + room.matchId)}>
              查看开局确认
            </a>
          </>
        ) : (
          <p>房间已关闭</p>
        )}
      </div>
    </>
  );
}
