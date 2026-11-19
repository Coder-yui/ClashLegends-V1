import { Choice, Modal } from "./controls";
import { Settings } from "./settings";
import { installLobbySounds } from "./audio";
import { useLocation, installNavigation } from "./navigation";
import { Hall } from "./hall";
import { RoomPage } from "./room-page";
import { MatchPage } from "./match-page";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import { api, go, href, updateRoom } from "./api";
import type { Catalog, Room, Session, Match } from "./api";
import { Editor } from "./editor";
import "./style.css";

const Workbench = lazy(() => import("./workbench"));

function App({ url }: { url: string }) {
  const currentUrl = new URL(url);
  const [page = "", key = "", sub = ""] = currentUrl.pathname
    .replace(/^\/play\/?/, "")
    .split("/");
  const invite = currentUrl.searchParams.get("invite");
  const [settingsOpen, showSettings] = useState(false);
  const [session, setSession] = useState<Session>(),
    [catalog, setCatalog] = useState<Catalog>(),
    [room, setRoom] = useState<Room>(),
    [match, setMatch] = useState<Match>();
  const [dialog, setDialog] = useState(""),
    [mode, setMode] = useState(""),
    [map, setMapId] = useState(""),
    [code, setCode] = useState(invite ?? ""),
    [err, setError] = useState(""),
    [toast, setToast] = useState(""),
    [busy, setBusy] = useState(false);
  const [online, setOnline] = useState(false),
    sequence = useRef(0),
    lock = useRef(false),
    previous = useRef<Room | undefined>(undefined);
  const [boot, setBoot] = useState(false);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const refresh = useCallback(async () => {
    const n = ++sequence.current;
    const s = await api<Session>("session");
    const rid = page === "rooms" && key !== s.roomId ? undefined : s.roomId;
    const r = rid ? await api<Room>("rooms/" + rid) : undefined;
    const m =
      page === "matches" ? await api<Match>("matches/" + key) : undefined;
    if (!mounted.current || url !== location.href || n !== sequence.current)
      return;
    const old = previous.current;
    previous.current = r;
    if (
      r?.matchId &&
      page === "rooms" &&
      (r.status === "locked" || r.status === "playing") &&
      (sub === "deck" || old?.status === "open")
    ) {
      go("matches/" + r.matchId);
      return;
    }
    if (
      m?.status === "withdrawn" &&
      matchIsCurrentRoom(r, m) &&
      !new URLSearchParams(location.search).has("history")
    ) {
      go("rooms/" + r!.id);
      return;
    }
    setSession(s);
    setRoom(r);
    setMatch(m);
  }, []);
  useEffect(() => {
    let active = true;
    async function init() {
      try {
        const c = await api<Catalog>(
          page === "decks" && key === "collection"
            ? "catalog"
            : "battle/catalog",
        );
        if (!active) return;
        setCatalog(c);
        await refresh();
        if (active) {
          setBoot(true);
          if (invite) setDialog("join");
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      }
    }
    void init();
    return () => {
      active = false;
    };
  }, [refresh]);
  useEffect(() => {
    if (!boot) return;
    let stopped = false,
      ws: WebSocket | undefined,
      retry: number;
    function connect() {
      ws = new WebSocket(
        (location.protocol === "https:" ? "wss://" : "ws://") +
          location.host +
          "/api/live",
      );
      ws.onopen = () => {
        setOnline(true);
        refresh().catch((e) => setError(e.message));
      };
      ws.onmessage = () => refresh().catch((e) => setError(e.message));
      ws.onclose = () => {
        setOnline(false);
        if (!stopped) retry = window.setTimeout(connect, 1200);
      };
    }
    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, [boot, refresh]);
  async function run(fn: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setToast("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
      await refresh().catch(() => {});
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function enter() {
    if (dialog === "settings" && room) {
      await updateRoom(room, "settings", { mode, map });
      setDialog("");
      await refresh();
      return;
    }
    if (dialog === "join" && !/^[0-9a-f]{8}$/i.test(code.trim())) {
      setError("请输入 8 位房间邀请码");
      return;
    }
    const r =
      dialog === "join"
        ? await api<Room>("join", { code })
        : await api<Room>("rooms", { kind: dialog, mode, map });
    if (mounted.current && url === location.href)
      go(r.matchId ? "matches/" + r.matchId : "rooms/" + r.id);
  }
  async function action(a: string, data: object = {}) {
    if (!room) return;
    const r = await updateRoom(room, a, data);
    if (!mounted.current || url !== location.href) return;
    if (a === "leave") {
      go();
      return;
    }
    if (r.matchId) {
      go("matches/" + r.matchId);
      return;
    }
    await refresh();
  }
  function setup(kind: string) {
    setError("");
    setToast("");
    if (!catalog) return;
    setMode(kind === "settings" && room ? room.mode : catalog.modes[0].id);
    setMapId(
      kind === "settings" && room ? room.map : catalog.modes[0].mapIds[0],
    );
    setDialog(kind);
  }
  const errors = err && (
    <div role="alert" className="error">
      {err}{" "}
      <button onClick={() => setError("")} aria-label="关闭提示">
        ×
      </button>
    </div>
  );
  const hall = !page;
  return (
    <>
      <header>
        <div className="top">
          <a className="brand" href={href()}>
            <img src="/play/media/crest.webp" alt="" />
            <span>
              CLASH<b>LEGENDS</b>
            </span>
          </a>
          <nav>
            <a
              className={
                page !== "decks" && page !== "workbench" ? "active" : ""
              }
              href={href()}
            >
              对战大厅
            </a>
            <a
              className={page === "decks" ? "active" : ""}
              href={href("decks")}
            >
              我的卡组
            </a>
            {catalog?.workbench && (
              <a
                href={href("workbench")}
                className={page === "workbench" ? "active" : ""}
              >
                开发工作台
              </a>
            )}
          </nav>
          <button
            className="settings-trigger"
            onClick={() => showSettings(true)}
            aria-label="游戏设置"
          >
            <span aria-hidden="true">⚙</span> 设置
          </button>
          <div className="profile">
            <i className={online ? "online" : ""} />
            {session?.name ?? "连接中"}
          </div>
        </div>
      </header>
      <main>
        {!dialog && errors}
        {toast && (
          <p role="status" className="notice">
            {toast}
          </p>
        )}
        {!catalog || !session ? (
          <div className="panel">
            <h2>{err ? "暂时无法进入" : "正在连接大厅…"}</h2>
            {err && (
              <a className="outline" href={href()}>
                返回大厅
              </a>
            )}
          </div>
        ) : hall ? (
          <Hall catalog={catalog} room={room} session={session} setup={setup} />
        ) : page === "workbench" && catalog.workbench ? (
          <Suspense fallback={<p>正在打开工作台…</p>}>
            <Workbench catalog={catalog} />
          </Suspense>
        ) : page === "decks" ? (
          <Editor
            catalog={catalog}
            session={session}
            collection={key === "collection"}
            reload={refresh}
          />
        ) : page === "rooms" && room ? (
          room.status === "open" ? (
            <Editor
              catalog={catalog}
              session={session}
              room={room}
              online={online}
              management={
                <RoomPage
                  compact
                  catalog={catalog}
                  room={room}
                  online={online}
                  busy={busy}
                  setup={setup}
                  action={action}
                  run={run}
                  notify={setToast}
                />
              }
              reload={refresh}
            />
          ) : (
            <RoomPage
              catalog={catalog}
              room={room}
              online={online}
              busy={busy}
              setup={setup}
              action={action}
              run={run}
              notify={setToast}
            />
          )
        ) : page === "matches" && match ? (
          <MatchPage
            catalog={catalog}
            match={match}
            session={session}
            settings={() => showSettings(true)}
          />
        ) : (
          <div className="panel">
            <h2>页面不存在或已离房</h2>
            <a href={href()}>返回大厅</a>
          </div>
        )}
      </main>
      {settingsOpen && <Settings close={() => showSettings(false)} />}
      {dialog && catalog && (
        <Modal
          title={
            dialog === "join"
              ? "加入好友房间"
              : dialog === "ai"
                ? "AI 对战设置"
                : dialog === "settings"
                  ? "房间设置"
                  : "创建好友房间"
          }
          onClose={() => {
            if (!busy) setDialog("");
          }}
        >
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              run(enter);
            }}
          >
            {dialog === "join" ? (
              <label>
                房间邀请码
                <input
                  autoFocus
                  required
                  maxLength={8}
                  placeholder="输入 8 位邀请码"
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                />
              </label>
            ) : (
              <>
                <div
                  className="preview-map"
                  style={{
                    backgroundImage:
                      "url(" +
                      catalog.maps.find((x) => x.id === map)?.image +
                      ")",
                  }}
                />
                <Choice
                  label="对战模式"
                  value={mode}
                  items={catalog.modes}
                  onChange={(id) => {
                    setMode(id);
                    setMapId(catalog.modes.find((x) => x.id === id)!.mapIds[0]);
                  }}
                />
                <Choice
                  label="对战地图"
                  value={map}
                  items={catalog.maps.filter((x) =>
                    catalog.modes
                      .find((v) => v.id === mode)
                      ?.mapIds.includes(x.id),
                  )}
                  onChange={setMapId}
                />
              </>
            )}
            {errors}
            <button className="gold" disabled={busy}>
              {dialog === "join"
                ? "加入房间"
                : dialog === "friend"
                  ? "创建房间"
                  : dialog === "settings"
                    ? "保存设置"
                    : "进入备战"}{" "}
              →
            </button>
          </form>
        </Modal>
      )}
    </>
  );
}
function matchIsCurrentRoom(room: Room | undefined, match: Match) {
  return room?.id === match.roomId && room.status === "open";
}
function Lobby() {
  const url = useLocation();
  return <App key={url} url={url} />;
}
installLobbySounds();
installNavigation();
createRoot(document.getElementById("root")!).render(<Lobby />);
