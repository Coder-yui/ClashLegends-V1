import { bookmarkReplay } from "./player-data";
import { cardArt } from "./card-art";
import { FullscreenButton } from "./fullscreen";
import { useMatchAssets } from "./use-match-assets";
import { useCallback, useEffect, useRef, useState } from "react";
import { MatchLoading } from "./match-loading";
import type { CSSProperties } from "react";
import { api, href, go } from "./api";
import { Modal } from "./controls";
import { RecordingSettings } from "./recording-options";
import { useVideo, videoSupported } from "./video-recording";
import type { Card, Catalog, Match, Result, Session } from "./api";
import { ActiveSkillButton } from "./active-skill-button";
import { BATTLE_PROTOCOL, BattleEvents } from "./presentation";
import { useDeploymentInput } from "./use-deployment-input";
import { Battlefield, type Frame } from "./battle-field";
import { actions, boundAction, keyLabel, usePreferences } from "./preferences";
import metadata from "./preparation-data.json";
import "./battle.css";

function duration(ticks: number) {
  const s = Math.ceil(ticks / 20);
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}
type Selection = { slot: number; version: number };
const artwork: Record<
  string,
  { color: string; portrait?: string; resourceColor?: string }
> = metadata;
export function BattleCardFace({
  card,
  source,
  cost,
  preview,
}: {
  card: Card;
  source?: Card;
  cost?: number;
  preview?: string;
}) {
  const portrait = source ?? card;
  const title = source ? "镜·" + source.name : card.name;
  return (
    <>
      <img src={preview || cardArt(portrait, true)} alt="" />
      <span className="card-title">{title}</span>
      {cost !== undefined && (
        <small
          className="coin-cost"
          aria-label={cost === 99 ? "费用待定" : cost + " 金币"}
        >
          {cost === 99 ? "?" : cost}
        </small>
      )}
    </>
  );
}
function cardBorder(id: string): CSSProperties {
  return { "--card-edge": artwork[id]?.color } as CSSProperties;
}
export function MatchPage({
  catalog,
  match,
  session,
  settings,
}: {
  catalog: Catalog;
  match: Match;
  session: Session;
  settings: () => void;
}) {
  const [frame, setFrame] = useState<Frame>();
  const [ended, setEnded] = useState<Result | null>(match.result);
  const [connected, setConnected] = useState(false),
    [hint, setHint] = useState("");
  const [selection, select] = useState<Selection | null>(null);
  const [pendingSlot, setPendingSlot] = useState<number | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const inflight = useRef<"receipt" | "frame" | null>(null);
  const { bindings, recording: recordOptions } = usePreferences();
  const video = useVideo(match, catalog);
  const [recordMenu, showRecordMenu] = useState(false);
  const [saved, setSaved] = useState(false),
    [recordError, setRecordError] = useState("");
  const startedRecording = useRef(false);
  async function saveReplay(open = false) {
    try {
      if (session.role) await api("recordings/" + match.id, {});
      else bookmarkReplay(match.id);
      setSaved(true);
      setRecordError("");
      if (open) go("recordings/" + match.id);
    } catch (e) {
      setRecordError((e as Error).message);
    }
  }
  const result = match.result ?? ended;
  const joinedStream = useRef<string | undefined>(undefined);
  const live = match.playable && match.status !== "withdrawn" && !result;
  const receive =
    live ||
    (joinedStream.current === match.id &&
      !ended &&
      match.status !== "withdrawn");
  const {
    resources,
    failed,
    completed,
    total,
    retry: retryAssets,
  } = useMatchAssets(match, catalog, receive);
  const [online, setOnline] = useState(false);
  const [protocolError, setProtocolError] = useState("");
  const [greeted, setGreeted] = useState<{
    socket: WebSocket;
    preview: boolean;
  }>();
  const [prepared, setPrepared] = useState(false);
  const scenePrepared = useCallback(() => setPrepared(true), []);
  const baselineId = useRef(0);
  const readyForSocket = !!resources && (!greeted?.preview || prepared);
  useEffect(() => {
    if (readyForSocket && greeted?.socket.readyState === WebSocket.OPEN) {
      greeted.socket.send(
        JSON.stringify({ type: "ready", protocol: BATTLE_PROTOCOL }),
      );
    }
  }, [readyForSocket, greeted]);
  useEffect(() => {
    if (!receive) return;
    joinedStream.current = match.id;
    let stopped = false,
      done = false,
      retry: number;
    function connect() {
      const url = new URL("/api/matches/" + match.id + "/live", location.href);
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const events = new BattleEvents();
      const ws = new WebSocket(url);
      socket.current = ws;
      ws.onmessage = (e) => {
        if (stopped) return;
        const message = JSON.parse(e.data);
        if (message.type === "connected" || message.type === "frame") {
          if (message.protocol !== BATTLE_PROTOCOL) {
            done = true;
            setProtocolError(
              `网页使用对局协议 ${BATTLE_PROTOCOL}，服务端使用 ${message.protocol ?? "未知版本"}。请确认大厅服务与网页已更新到同一版本。`,
            );
            ws.close();
            return;
          }
        }
        if (message.type === "connected") {
          setOnline(true);
          setGreeted({ socket: ws, preview: message.preview === true });
          return;
        }
        if (message.type === "receipt") {
          inflight.current = "frame";
          setHint(message.error ?? "");
          if (!message.error) select(null);
          return;
        }
        if (message.type === "frame") {
          const cues = events.read(message.presentation);
          for (const { fact } of cues)
            if (fact.kind === "commandFinished") {
              const result = fact.data as { error?: string };
              if (result.error) setHint(result.error);
            }
          if (events.reset) baselineId.current++;
          const baseline = baselineId.current;
          setFrame((previous) => ({
            ...message,
            baseline,
            cues: [
              ...(previous?.baseline === baseline
                ? (previous.cues ?? [])
                : []
              ).filter((e) => e.tick + 24 >= message.tick),
              ...cues,
            ],
          }));
          setConnected(true);
          if (inflight.current === "frame") {
            inflight.current = null;
            setPendingSlot(null);
          }
        }
        if (message.result) {
          done = true;
          setEnded(message.result);
        }
      };
      ws.onclose = () => {
        if (stopped) return;
        setConnected(false);
        setOnline(false);
        setGreeted(undefined);
        setPendingSlot(null);
        select(null);
        inflight.current = null;
        if (!done) retry = window.setTimeout(connect, 650);
      };
    }
    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      socket.current?.close();
    };
  }, [match.id, receive]);
  const card = (id: string) => catalog.cards.find((c) => c.id === id);
  const selected =
    selection?.version === frame?.version ? selection?.slot : undefined;
  const entered = resources && prepared && frame?.started && !protocolError;
  const ready = entered && connected && !result;
  useEffect(() => {
    if (!entered || startedRecording.current || result) return;
    startedRecording.current = true;
    if (recordOptions.mode === "both" || recordOptions.mode === "replay")
      void saveReplay();
    if (recordOptions.mode === "both" || recordOptions.mode === "video")
      video.start();
  }, [entered, result, recordOptions.mode]);
  useEffect(() => {
    if (!result || !video.recording) return;
    const timer = window.setTimeout(video.stop, 8000);
    return () => clearTimeout(timer);
  }, [!!result, video.recording]);
  function send(command: object) {
    if (
      !ready ||
      !frame ||
      inflight.current ||
      socket.current?.readyState !== WebSocket.OPEN
    )
      return;
    inflight.current = "receipt";
    socket.current.send(
      JSON.stringify({
        ...command,
        inputTick: frame.tick,
        sequence: frame.ack + 1,
      }),
    );
  }
  function selectSlot(slot?: number) {
    if (!frame) return;
    select(slot === undefined ? null : { slot, version: frame.version });
    setHint("");
  }
  function pick(slot: number) {
    if (ready && !inflight.current)
      selectSlot(selected === slot ? undefined : slot);
  }
  const input = useDeploymentInput({
    frame,
    me: match.me,
    selected: ready ? selected : undefined,
    select: selectSlot,
    blocked: setHint,
    canPlay: () => !!ready && !inflight.current,
    skillFor(slot) {
      const id = frame?.hand[slot];
      if (!id || !match.deck.cards.slice(0, 2).includes(id)) return;
      const source = id === "mirror" ? frame?.lastCard : id;
      return source ? match.deck.skills[source] : undefined;
    },
    play(slot, { x, y }) {
      if (frame) send({ action: "play", slot, version: frame.version, x, y });
    },
  });
  function cast(slot: number) {
    if (!ready || !frame || inflight.current) return;
    const c = card(frame.activeCards?.[slot] ?? match.deck.cards[slot])!;
    const skill = c.skills.find((s) => s.id === match.deck.skills[c.id]);
    if (skill && c.type === "spell") {
      setHint("出牌时自动施放" + skill.name);
      return;
    }
    if (frame.pending.some(([, , n]) => n === slot)) return;
    if (!frame.active[slot]?.uses) {
      setHint(
        c.skills.length
          ? "先部署对应主动槽卡牌，或重新部署以补充次数"
          : "此卡没有已接入的主动技能",
      );
      return;
    }
    const energy = frame.skillResource?.[slot];
    if (energy?.[2] && energy[0] < energy[1]) {
      setHint("技能资源尚未蓄满");
      return;
    }
    if (frame.activeWait[slot]) {
      setHint("单位部署或技能冷却中");
      return;
    }
    if (
      frame.gold < (frame.activeCost?.[slot] ?? skill?.cost ?? c.skillCost ?? 0)
    ) {
      setHint("金币不足");
      return;
    }
    if (frame.buttons?.[slot]?.locked) {
      setHint("单位当前无法起手");
      return;
    }
    if (socket.current?.readyState === WebSocket.OPEN) {
      setPendingSlot(slot);
      send({ action: "activate", slot });
    }
  }
  useEffect(() => {
    function key(e: KeyboardEvent) {
      if (
        e.repeat ||
        e.ctrlKey ||
        e.metaKey ||
        e.altKey ||
        !ready ||
        document.querySelector("dialog[open]") ||
        (e.target instanceof Element &&
          e.target.closest(
            "input,textarea,[role=combobox],[role=listbox],[contenteditable=true]",
          ))
      )
        return;
      if (e.key === "Escape" && selected !== undefined) {
        e.preventDefault();
        pick(selected);
        return;
      }
      const action = boundAction(e.code);
      if (!action) return;
      e.preventDefault();
      const slot = Number(action.slice(-1)) - 1;
      if (action.startsWith("hand")) pick(slot);
      else cast(slot);
    }
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  const roomLink = session.roomId === match.roomId && (
    <a className="outline" href={href("rooms/" + match.roomId)}>
      返回房间
    </a>
  );
  const map = frame?.map;
  const stageStyle = map
    ? ({
        "--map-width": map.width,
        "--map-height": map.height,
        "--ground-depth": map.height + 2 * map.backMargin,
        "--projection": map.projection,
        "--backdrop-width": map.backdropWidth,
        "--terrain": map.terrain ? 'url("' + map.terrain + '")' : "none",
      } as CSSProperties)
    : undefined;
  if (result || !live) {
    const title = result
      ? result.winner === null
        ? "平局"
        : result.winner === match.me
          ? "胜利"
          : "战败"
      : match.status === "withdrawn"
        ? "本次备战已结束"
        : match.status === "claimed"
          ? "等待原版本对局恢复"
          : "旧版备战记录";
    return (
      <section className="battle-layout battle-ended" style={stageStyle}>
        <div key="battlefield" className="battle-stage" aria-hidden="true">
          {frame && (
            <Battlefield
              resources={resources}
              frame={frame}
              me={match.me}
              onPaint={video.paint}
              onPrepared={scenePrepared}
              play={() => {}}
            />
          )}
        </div>
        <div className="panel battle-result">
          <span className="eyebrow">
            第 {match.round} 轮 ·{" "}
            {catalog.maps.find((m) => m.id === match.map)?.name}
          </span>
          <h1>{title}</h1>
          {result && (
            <p>
              {
                {
                  Nexus: "水晶被摧毁",
                  Towers: "防御塔数量决胜",
                  Draw: "加时结束，双方平手",
                }[result.reason]
              }{" "}
              · 用时 {duration(result.tick)}
            </p>
          )}
          {match.teammate && <p>队友 · {match.teammate}</p>}
          <p>对手 · {match.opponent}</p>
          {(recordError || video.message) && (
            <p role="status">{recordError || video.message}</p>
          )}
          <div className="footer-actions">
            <a className="outline" href={href()}>
              返回大厅
            </a>
            {roomLink}
            {match.playable && result && (
              <button onClick={() => void saveReplay(true)}>观看回放</button>
            )}
            <a className="outline" href={href("recordings")}>
              我的录制
            </a>
            <FullscreenButton className="outline" showText />
          </div>
        </div>
      </section>
    );
  }
  const nextCard = frame && card(frame.next);
  const mirrorSource = frame?.lastCard ? card(frame.lastCard) : undefined;
  const selectedCard =
    frame && selected !== undefined ? card(frame.hand[selected]) : undefined;
  const placement = selectedCard?.id === "mirror" ? mirrorSource : selectedCard;
  return (
    <section className="battle-layout" style={stageStyle}>
      {!entered && (
        <MatchLoading
          back={roomLink}
          error={protocolError || (failed ? "本局资源加载失败" : "")}
          status={
            !resources
              ? "正在准备模型、动作和战场图片"
              : !online
                ? "正在连接战场…"
                : !frame
                  ? "正在同步战场…"
                  : !prepared
                    ? "正在准备战场画面、音效和特效…"
                    : "等待其他玩家进入战场"
          }
          progress={!resources && total ? { completed, total } : undefined}
        >
          {failed && !protocolError && (
            <button onClick={retryAssets}>重新加载资源</button>
          )}
          {protocolError && (
            <button onClick={() => location.reload()}>刷新页面</button>
          )}
        </MatchLoading>
      )}
      {recordMenu && (
        <Modal title="对局录制" onClose={() => showRecordMenu(false)}>
          <div className="footer-actions">
            <button disabled={saved} onClick={() => void saveReplay()}>
              {saved ? "回放已保存" : "保存对局回放"}
            </button>
            <button
              disabled={!videoSupported()}
              onClick={video.recording ? video.stop : video.start}
            >
              {video.recording ? "停止录制" : "录制视频"}
            </button>
          </div>
          {(video.message || recordError) && (
            <p role="status">{recordError || video.message}</p>
          )}
          <RecordingSettings />
        </Modal>
      )}
      <div className="battle-top" inert={!entered}>
        <div className="battle-tools">
          {roomLink}
          <button aria-label="游戏设置" onClick={settings}>
            ⚙
          </button>
          <FullscreenButton />
          <button aria-label="对局录制" onClick={() => showRecordMenu(true)}>
            {video.recording ? "● 录像中" : "录制"}
          </button>
        </div>
        <div className="battle-title">
          <h1>
            {catalog.maps.find((m) => m.id === match.map)?.name ?? match.map}
          </h1>
          <small>
            {match.me === 0 ? "蓝方" : "红方"}
            {match.teammate && ` · 队友 ${match.teammate}`} · 对手{" "}
            {match.opponent}
          </small>
        </div>
        <strong className="battle-time">
          {frame?.overtime ? "加时 " : ""}
          {duration(frame?.remaining ?? 3700)}
        </strong>
      </div>
      <div key="battlefield" className="battle-stage" inert={!entered}>
        {frame && resources && (
          <Battlefield
            resources={resources}
            frame={frame}
            me={match.me}
            connected={connected && frame.started}
            deck={match.deck.cards}
            onPaint={video.paint}
            onPrepared={scenePrepared}
            deployment={input.board}
          />
        )}
      </div>
      <aside className="battle-controls" inert={!entered}>
        {frame && (
          <>
            <div className="battle-next">
              <small>下一张</small>
              {nextCard && (
                <div className="battle-card" style={cardBorder(nextCard.id)}>
                  <BattleCardFace
                    card={nextCard}
                    source={nextCard.id === "mirror" ? mirrorSource : undefined}
                    cost={frame.nextCost}
                  />
                </div>
              )}
            </div>
            <div className="battle-hand">
              {frame.hand.map((id, i) => {
                const c = card(id)!;
                const cost = frame.costs?.[i] ?? c.cost;
                return (
                  <button
                    key={i}
                    data-card={id}
                    aria-pressed={selected === i}
                    disabled={!ready}
                    style={cardBorder(id)}
                    className={
                      "battle-card" + (frame.gold < cost ? " unaffordable" : "")
                    }
                    {...input.hand(i)}
                  >
                    <BattleCardFace
                      card={c}
                      source={id === "mirror" ? mirrorSource : undefined}
                      cost={cost}
                    />
                    <kbd>{keyLabel(bindings[actions[i][0]])}</kbd>
                    {match.deck.cards.slice(0, 2).includes(id) && (
                      <i className="active-rune" title="主动槽卡牌" />
                    )}
                  </button>
                );
              })}
            </div>
            <div className="battle-gold">
              <img src="/play/media/battle/coin.svg" alt="" />
              <b aria-hidden="true">{frame.gold} / 10</b>
              <div
                className="gold-track"
                role="meter"
                aria-label="金币"
                aria-valuemin={0}
                aria-valuemax={10}
                aria-valuenow={frame.gold}
              >
                <i style={{ width: frame.gold * 10 + "%" }} />
              </div>
            </div>
            <div className="battle-skills">
              {match.deck.cards.slice(0, 2).map((id, i) => {
                const c = card(frame.activeCards?.[i] ?? id)!,
                  skill = c.skills.find(
                    (s) => s.id === match.deck.skills[c.id],
                  );
                return (
                  <ActiveSkillButton
                    key={id}
                    card={c}
                    skill={skill}
                    frame={frame}
                    slot={i}
                    ready={Boolean(ready)}
                    pending={
                      pendingSlot === i ||
                      frame.pending.some(([, , slot]) => slot === i)
                    }
                    onCast={() => cast(i)}
                    fullColor={artwork[c.id]?.resourceColor}
                  />
                );
              })}
            </div>
          </>
        )}
        <p className="battle-hint" role="status">
          {!entered
            ? ""
            : !connected
              ? "正在重新连接战场…"
              : hint ||
                (placement ? "点击战场，或拖牌到落点松手" : "")}
        </p>
      </aside>
    </section>
  );
}
