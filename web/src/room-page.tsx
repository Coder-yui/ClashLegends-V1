import { useConfirmation } from "./controls";
import { href } from "./api";
import type { Catalog, Room } from "./api";
import { DeckStrip } from "./deck-strip";
export function RoomPage({
  compact = false,
  catalog,
  room,
  online,
  busy,
  setup,
  run,
  action,
  notify,
}: {
  compact?: boolean;
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
  const map = catalog.maps.find((item) => item.id === room.map);
  const doubles = room.mode === "2v2";
  const editable = doubles && room.status === "open";
  return (
    <>
      {confirmation}
      {!compact && (
        <div className="page-title">
          <div>
            <span className="eyebrow">
              第 {room.round} 轮 ·{" "}
              {doubles ? "2v2" : room.kind === "ai" ? "训练场" : "双人对战"}
            </span>
            <h1>
              {doubles
                ? "2v2 组队房"
                : room.kind === "ai"
                  ? "电脑玩家备战室"
                  : "好友房间"}
            </h1>
          </div>
          <a className="outline" href={href()}>
            返回大厅
          </a>
        </div>
      )}
      <div className={compact ? "prep-room-tools" : "room-layout"}>
        <article className="panel">
          <div className="section-title">
            <h2>对战席位</h2>
            <small>
              {room.seats.length} / {room.capacity}
            </small>
          </div>
          {(doubles ? [0, 2, 1, 3] : [0, 1]).map((slot) => {
            const index = room.seats.findIndex((s) => s.slot === slot);
            const seat = room.seats[index];
            const team = slot % 2 === 0 ? "蓝方" : "红方";
            const label = team + (slot < 2 ? "一号位" : "二号位");
            const control = (command: string, text: string) => (
              <button
                disabled={busy || !online}
                aria-label={label + " · " + text}
                onClick={(event) => {
                  event.currentTarget
                    .closest<HTMLElement>(".seat")
                    ?.focus({ preventScroll: true });
                  run(() => action(command, { slot }));
                }}
              >
                {text}
              </button>
            );
            return (
              <div
                key={slot}
                className="seat"
                role="group"
                aria-label={label}
                tabIndex={-1}
              >
                <div className={"sigil team" + (slot % 2)}>{team[0]}</div>
                <div className="seat-info">
                  <b>{seat?.name ?? "空席"}</b>
                  <small>
                    {label}
                    {index === 0 ? " · 房主" : ""}
                    {room.me === index ? " · 你" : ""}
                  </small>
                </div>
                <strong>
                  {seat
                    ? seat.online
                      ? seat.ready
                        ? "已准备"
                        : "备战中"
                      : "重连中"
                    : "等待加入"}
                </strong>
                {editable && (
                  <div className="seat-actions">
                    {!seat &&
                      room.me === 0 &&
                      control("addComputer", "添加电脑玩家")}
                    {!seat && control("move", "入座")}
                    {seat?.ai &&
                      room.me === 0 &&
                      control("removeComputer", "移除电脑玩家")}
                    {seat &&
                      room.me === 0 &&
                      index !== room.me &&
                      control("swap", "与我换位")}
                  </div>
                )}
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
              map?.image +
              ")",
          }}
        >
          <small>{catalog.modes.find((x) => x.id === room.mode)?.name}</small>
          <h2>{map?.name}</h2>
          {room.me === 0 && room.status === "open" && (
            <button onClick={() => setup("settings")}>对战设置</button>
          )}
        </aside>
      </div>
      {!compact && (
        <>
          <div className="section-title">
            <h2>本局卡组</h2>
            {room.status === "open" && (
              <a
                className="text-button"
                href={href("rooms/" + room.id + "/deck")}
              >
                编辑卡组与技能 ↗
              </a>
            )}
          </div>
          <div className="panel">
            <DeckStrip deck={room.deck} catalog={catalog} />
          </div>
        </>
      )}
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
            {!compact && (
              <button
                className="gold"
                disabled={
                  busy ||
                  !online ||
                  room.seats.length !== room.capacity ||
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
            )}
          </>
        ) : ["locked", "playing"].includes(room.status) ? (
          <>
            {room.me === 0 && room.status === "locked" && (
              <button onClick={() => run(() => action("reopen"))}>
                结束本次备战，重新组局
              </button>
            )}
            <a className="gold" href={href("matches/" + room.matchId)}>
              进入战场
            </a>
          </>
        ) : (
          <p>房间已关闭</p>
        )}
      </div>
    </>
  );
}
