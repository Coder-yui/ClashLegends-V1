import { cardArt } from "./card-art";
import type { ModelResources } from "./battle-models";
import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { href } from "./api";
import type { Card, Catalog, Match, Result, Session } from "./api";
import { ActiveSkillButton } from "./active-skill-button";
import { BattleEvents } from "./presentation";
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
  const [resources, setResources] = useState<ModelResources>();
  const ownedResources = useRef<ModelResources | undefined>(undefined);
  useEffect(
    () => () => {
      ownedResources.current?.dispose();
      ownedResources.current = undefined;
    },
    [match.id],
  );
  const [frame, setFrame] = useState<Frame>();
  const [ended, setEnded] = useState<Result | null>(match.result);
  const [connected, setConnected] = useState(false),
    [hint, setHint] = useState("");
  const [selection, select] = useState<Selection | null>(null);
  const [pendingSlot, setPendingSlot] = useState<number | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const inflight = useRef<"receipt" | "frame" | null>(null);
  const { bindings } = usePreferences();
  const result = match.result ?? ended;
  const live = match.playable && match.status !== "withdrawn" && !result;
  useEffect(() => {
    if (!live) return;
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
        if (message.type === "receipt") {
          inflight.current = "frame";
          setHint(message.error ?? "");
          if (!message.error) select(null);
          return;
        }
        if (message.type === "frame") {
          if (message.protocol !== 2) {
            done = true;
            setHint("对局协议已更新，请刷新页面");
            ws.close();
            return;
          }
          const cues = events.read(message.presentation);
          for (const { fact } of cues)
            if (fact.kind === "commandFinished") {
              const result = fact.data as { error?: string };
              if (result.error) setHint(result.error);
            }
          const baseline = events.baseline;
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
        setPendingSlot(null);
        select(null);
        inflight.current = null;
        if (!done) retry = window.setTimeout(connect, 650);
      };
    }
    let assets: ModelResources | undefined;
    async function prepare() {
      try {
        const { ModelResources } = await import("./battle-models");
        if (stopped) return;
        assets ??= new ModelResources();
        await assets.prepare(match.modelResources ?? []);
        if (stopped) return;
        ownedResources.current = assets;
        setResources(assets);
        setHint("");
        connect();
      } catch {
        if (!stopped) {
          setHint("模型资源加载失败，正在重试");
          retry = window.setTimeout(prepare, 1200);
        }
      }
    }
    void prepare();
    return () => {
      if (assets !== ownedResources.current) assets?.dispose();
      stopped = true;
      clearTimeout(retry);
      socket.current?.close();
    };
  }, [match.id, live]);
  const card = (id: string) => catalog.cards.find((c) => c.id === id);
  const selected =
    selection?.version === frame?.version ? selection?.slot : undefined;
  const ready = connected && frame?.started && !result;
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
  function pick(slot: number) {
    if (!ready || !frame || inflight.current) return;
    select(selected === slot ? null : { slot, version: frame.version });
    setHint("");
  }
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
          <p>对手 · {match.opponent}</p>
          <div className="footer-actions">
            <a className="outline" href={href()}>
              返回大厅
            </a>
            {roomLink}
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
      <div className="battle-top">
        <div className="battle-tools">
          {roomLink}
          <button aria-label="游戏设置" onClick={settings}>
            ⚙
          </button>
        </div>
        <div className="battle-title">
          <h1>
            {catalog.maps.find((m) => m.id === match.map)?.name ?? match.map}
          </h1>
          <small>
            {match.me === 0 ? "蓝方" : "红方"} · 对手 {match.opponent}
          </small>
        </div>
        <strong className="battle-time">
          {frame?.overtime ? "加时 " : ""}
          {duration(frame?.remaining ?? 3700)}
        </strong>
      </div>
      <div key="battlefield" className="battle-stage">
        {frame ? (
          <Battlefield
            resources={resources}
            frame={frame}
            me={match.me}
            selection={selected}
            play={(x, y) => {
              if (selected !== undefined)
                send({
                  action: "play",
                  slot: selected,
                  version: selection!.version,
                  x,
                  y,
                });
            }}
          />
        ) : (
          <div className="battle-loading">
            {hint || (resources ? "正在连接战场…" : "正在准备本局模型与动作…")}
          </div>
        )}
      </div>
      <aside className="battle-controls">
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
                    onClick={() => pick(i)}
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
          {!connected
            ? hint || "正在连接战场…"
            : !ready
              ? "等待另一位玩家进入战场"
              : hint ||
                (placement
                  ? placement.type === "spell"
                    ? "点击战场选择法术落点"
                    : "点击战场部署"
                  : "")}
        </p>
      </aside>
    </section>
  );
}
