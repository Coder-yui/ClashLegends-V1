import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type { Card, Catalog } from "./api";
import { Battlefield, type Frame } from "./battle-field";
import membersData from "./model-members.json";
import { profileFor, alternateProfile, followupProfile } from "./battle-motion";
import { BattleEvents, type BattleEvent } from "./presentation";
import { CardDetails, CardInformation } from "./preparation";
import { Choice, ChoiceList, Modal } from "./controls";
import "./battle.css";
import "./workbench.css";

const ModelPreview = lazy(() => import("./workbench-model"));
type TestFrame = Frame & {
  lab: {
    epoch: number;
    paused: boolean;
    speed: number;
    selected: number | null;
    members: number[] | null;
    skill: string | null;
  };
};
const storage = "clash.workbench.slots.v1";
const defaults = ["ashe", "melee_minion"];
function savedSlots(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(storage) ?? "null");
    if (Array.isArray(raw))
      return [
        ...new Set(raw.filter((x): x is string => typeof x === "string")),
      ].slice(0, 8);
  } catch {}
  return defaults;
}
const types: Record<string, string> = {
  all: "全部",
  unit: "部队",
  building: "建筑",
  spell: "法术",
  system: "系统对象",
};
const facts: Record<string, string> = {
  spawned: "部署",
  actionChanged: "动作切换",
  attackStarted: "起手",
  attackReleased: "出手",
  attackCancelled: "取消出手",
  fired: "发射",
  projectileHit: "弹道命中",
  damage: "伤害",
  health: "生命变化",
  cast: "施法",
  died: "死亡",
  formChanged: "变形",
  controlled: "控制",
  spellImpact: "法术命中",
  spellPlayed: "释放法术",
};
const activities: Record<string, string> = {
  Idle: "待机",
  March: "行军",
  Chase: "追击",
  Windup: "前摇",
  Recover: "后摇",
  Channeling: "引导",
  Deploying: "部署",
  Displaced: "位移",
};
function useLaboratory(connection: number) {
  const ws = useRef<WebSocket | null>(null);
  const [frame, setFrame] = useState<TestFrame>(),
    [extras, setExtras] = useState<Card[]>([]),
    [events, setEvents] = useState<BattleEvent[]>([]);
  const [error, setError] = useState(""),
    [ended, setEnded] = useState(false);
  useEffect(() => {
    let history: BattleEvent[] = [];
    let active = true,
      epoch = -1,
      reader = new BattleEvents();
    const socket = new WebSocket(
      (location.protocol === "https:" ? "wss://" : "ws://") +
        location.host +
        "/api/workbench/live",
    );
    ws.current = socket;
    setFrame(undefined);
    setEvents([]);
    setError("");
    setEnded(false);
    socket.onmessage = (e) => {
      if (!active) return;
      const data = JSON.parse(e.data);
      if (data.type === "objects") {
        setExtras(data.cards);
        return;
      }
      if (data.type === "error") {
        setError(data.message);
        return;
      }
      if (data.type !== "frame") return;
      const f = data as TestFrame;
      if (epoch !== f.lab.epoch) {
        epoch = f.lab.epoch;
        reader = new BattleEvents();
        history = [];
        setEvents(f.presentation.events.slice(-80));
      }
      const incoming = reader.read(f.presentation);
      history = [...history.filter((e) => e.tick + 24 >= f.tick), ...incoming];
      f.cues = history;
      f.baseline = f.lab.epoch;
      if (incoming.length)
        setEvents((previous) => [...previous, ...incoming].slice(-80));
      setFrame(f);
    };
    socket.onclose = () => {
      if (active) {
        setEnded(true);
        setError("实验连接已断开，重新连接可打开新的实验场。");
      }
    };
    return () => {
      active = false;
      ws.current = null;
      socket.close();
    };
  }, [connection]);
  function send(command: object) {
    if (ws.current?.readyState === WebSocket.OPEN) {
      setError("");
      ws.current.send(JSON.stringify(command));
    }
  }
  return { frame, extras, events, error, ended, send };
}
function Stage({
  frame,
  point,
  zoom,
  setZoom,
  reset,
}: {
  frame: TestFrame;
  point: (x: number, y: number) => void;
  zoom: number;
  setZoom: (fn: (z: number) => number) => void;
  reset: number;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(
    null,
  );
  const [metrics, setMetrics] = useState("");
  const [action, setAction] = useState("");
  useEffect(() => {
    setPan({ x: 0, y: 0 });
  }, [reset]);
  useEffect(() => {
    const el = root.current!;
    function wheel(e: WheelEvent) {
      e.preventDefault();
      setZoom((v) =>
        Math.min(
          3,
          Math.max(1, Math.round((v - Math.sign(e.deltaY) * 0.1) * 10) / 10),
        ),
      );
    }
    el.addEventListener("wheel", wheel, { passive: false });
    let frames = 0,
      start = performance.now(),
      sum = 0;
    function sample(e: Event) {
      const d = (e as CustomEvent).detail;
      setAction(
        [d.action?.clip, ...(d.action?.layers ?? [])]
          .filter(Boolean)
          .join(" + "),
      );
      frames++;
      sum += d.ms;
      const now = performance.now();
      if (now - start < 650) return;
      setMetrics(
        Math.round((1000 * frames) / (now - start)) +
          " FPS · 绘制 " +
          (sum / frames).toFixed(1) +
          " ms · 模型 " +
          (d.actors ?? 0) +
          " · Draw " +
          (d.calls ?? 0),
      );
      frames = 0;
      sum = 0;
      start = now;
    }
    el.addEventListener("battle-render", sample, true);
    return () => {
      el.removeEventListener("battle-render", sample, true);
      el.removeEventListener("wheel", wheel);
    };
  }, []);
  const m = frame.map;
  return (
    <div
      className="wb-arena"
      ref={root}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        if (e.button === 1 || e.button === 2) {
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
        }
      }}
      onPointerMove={(e) => {
        if (drag.current) {
          const d = drag.current;
          setPan({ x: d.px + e.clientX - d.x, y: d.py + e.clientY - d.y });
        }
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onLostPointerCapture={() => {
        drag.current = null;
      }}
    >
      <div
        className="battle-stage"
        style={
          {
            "--terrain": m.terrain ? 'url("' + m.terrain + '")' : "none",
            "--map-width": m.width,
            "--map-height": m.height,
            "--projection": m.projection,
            "--backdrop-width": m.backdropWidth,
            transform:
              "translate(" + pan.x + "px," + pan.y + "px) scale(" + zoom + ")",
          } as CSSProperties
        }
      >
        <Battlefield
          frame={frame}
          me={0}
          playback={frame.lab.paused ? 0 : frame.lab.speed / 4}
          focusId={frame.lab.selected ?? undefined}
          diagnostics
          play={point}
        />
      </div>
      <output className="wb-stats">
        Tick {frame.tick}　{frame.lab.paused ? "暂停" : "运行"}　{metrics}
        {action && " · " + action}
      </output>
    </div>
  );
}
export default function Workbench({ catalog }: { catalog: Catalog }) {
  const [connection, reconnect] = useState(0);
  const { frame, extras, events, error, ended, send } =
    useLaboratory(connection);
  const cards = useMemo(
    () => [
      ...catalog.cards,
      ...extras.filter((c) => !catalog.cards.some((p) => p.id === c.id)),
    ],
    [catalog, extras],
  );
  const [slots, setSlots] = useState(savedSlots),
    [id, setId] = useState(() => savedSlots()[0] ?? "");
  const [team, setTeam] = useState(0),
    [mode, setMode] = useState("place"),
    [dummy, setDummy] = useState(false);
  const [tab, setTab] = useState(
      new URLSearchParams(location.search).get("view") === "models"
        ? "model"
        : "battle",
    ),
    [modelId, setModelId] = useState(
      new URLSearchParams(location.search).get("model") ?? "ashe",
    ),
    [alternateId, setAlternateId] = useState(""),
    [memberId, setMemberId] = useState(""),
    [deathId, setDeathId] = useState(""),
    [infoId, setInfoId] = useState("ashe"),
    [infoSearch, setInfoSearch] = useState(""),
    [library, setLibrary] = useState(false),
    [details, setDetails] = useState(false);
  const [query, setQuery] = useState(""),
    [category, setCategory] = useState("all");
  const [paused, setPaused] = useState(true),
    [speed, setSpeed] = useState(4),
    [hidden, setHidden] = useState(document.hidden);
  const [skills, setSkills] = useState<Record<string, string>>({}),
    [spellSkill, setSpellSkill] = useState(false);
  const [scene, setScene] = useState("dummy"),
    [effect, setEffect] = useState("freeze"),
    [zoom, setZoom] = useState(1),
    [reset, setReset] = useState(0);
  const card = cards.find((c) => c.id === id),
    skill = card && (skills[id] ?? card.skills[0]?.id);
  const mapObjects = [
    { id: "princess_tower", name: "防御塔" },
    { id: "nexus", name: "基地水晶" },
  ];
  const members = membersData as Record<string, string[]>;
  const modelCards = [
    ...mapObjects,
    ...cards.filter((c) => profileFor({ kind: c.id, team }) || members[c.id]),
  ];
  const modelCard = modelCards.find((c) => c.id === modelId) ?? modelCards[0];
  const group = members[modelCard.id];
  const kind = group
    ? group.includes(memberId)
      ? memberId
      : group[0]
    : modelCard.id;
  const body = profileFor({ kind, team, alternateForm: alternateId === kind });
  const death = body && followupProfile(body);
  const profile = deathId === body?.asset && death ? death : body;
  const detailCard =
    tab === "model" ? cards.find((c) => c.id === modelCard?.id) : card;
  const infoCards = cards.filter((c) =>
    (c.name + " " + c.id)
      .toLowerCase()
      .includes(infoSearch.trim().toLowerCase()),
  );
  const infoCard = infoCards.find((c) => c.id === infoId) ?? infoCards[0];
  const current = frame?.units.find((u) => u.id === frame.lab.selected);
  const focusedSkill = cards
    .flatMap((c) => c.skills)
    .find((s) => s.id === frame?.lab.skill);
  const blocked = tab !== "battle" || library || details || hidden;
  const ready = !!frame && !ended;
  const activeSkill =
    card?.type === "spell" && !spellSkill
      ? null
      : id === "mirror" && spellSkill
        ? "mirror"
        : skill || null;
  useEffect(() => {
    try {
      localStorage.setItem(storage, JSON.stringify(slots));
    } catch {}
  }, [slots]);
  useEffect(() => {
    const change = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, []);
  useEffect(() => {
    if (ready) send({ action: "clock", paused: paused || blocked, speed });
  }, [ready, paused, blocked, speed]);
  function pick(key: string) {
    setId(key);
    setDummy(false);
    setSpellSkill(false);
  }
  useEffect(() => {
    const keydown = (e: KeyboardEvent) => {
      if (
        blocked ||
        e.repeat ||
        e.ctrlKey ||
        e.metaKey ||
        e.altKey ||
        (e.target as HTMLElement).closest(
          'input,textarea,[role="combobox"],[role="listbox"]',
        )
      )
        return;
      if (/^[1-8]$/.test(e.key)) {
        const key = slots[Number(e.key) - 1];
        if (key) pick(key);
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [slots, blocked]);
  function toggleSlot(key: string) {
    if (slots.includes(key)) {
      const next = slots.filter((s) => s !== key);
      setSlots(next);
      if (id === key) pick(next[0] ?? "");
    } else if (slots.length < 8) {
      setSlots([...slots, key]);
      pick(key);
    }
  }
  function point(x: number, y: number) {
    if (!ready || blocked || !frame) return;
    if (mode === "select") {
      const near = frame.units
        .map((u) => ({ u, d: Math.hypot(u.x - x, u.y - y) }))
        .filter(({ u, d }) => d <= Math.max(23, u.radius + 8))
        .sort((a, b) => a.d - b.d)[0];
      send({ action: "select", id: near?.u.id ?? null });
    } else if (dummy || card) {
      send({
        action: "deploy",
        team: dummy ? 1 - team : team,
        card: dummy ? "training_dummy" : id,
        skill: dummy ? null : activeSkill,
        x,
        y,
      });
    }
  }
  const panel = (
    <div className="wb-row">
      <button aria-pressed={team === 0} onClick={() => setTeam(0)}>
        蓝方
      </button>
      <button aria-pressed={team === 1} onClick={() => setTeam(1)}>
        红方
      </button>
    </div>
  );
  return (
    <section className="wb">
      <div className="wb-head">
        <h1>卡牌开发工作台</h1>
        <div className="wb-row">
          <button
            aria-pressed={tab === "battle"}
            onClick={() => setTab("battle")}
          >
            实战观察
          </button>
          <button
            aria-pressed={tab === "model"}
            onClick={() => setTab("model")}
          >
            模型与动作
          </button>
          <button aria-pressed={tab === "info"} onClick={() => setTab("info")}>
            卡牌资料
          </button>
        </div>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}{" "}
          {ended && (
            <button onClick={() => reconnect((v) => v + 1)}>重新连接</button>
          )}
        </p>
      )}
      {tab === "battle" ? (
        <div className="wb-layout">
          <aside className="wb-tools">
            <section>
              <div className="wb-title">
                <h2>实验快捷槽</h2>
                <button
                  onClick={() => {
                    setQuery("");
                    setLibrary(true);
                  }}
                >
                  选择实验卡
                </button>
              </div>
              <div className="wb-slots">
                {slots.map((key, i) => {
                  const c = cards.find((v) => v.id === key);
                  return (
                    <button
                      key={key}
                      aria-pressed={id === key && !dummy}
                      onClick={() => pick(key)}
                      title={c?.name ?? key}
                    >
                      <small>{i + 1}</small>
                      {c?.name ?? key}
                    </button>
                  );
                })}
              </div>
              {!slots.length && <p>点击「选择实验卡」添加快捷槽。</p>}
              <div className="wb-title">
                <strong>
                  待放置 · {dummy ? "敌方木桩" : (card?.name ?? "未选卡")}
                </strong>
                {card && (
                  <button onClick={() => setDetails(true)}>卡牌信息</button>
                )}
              </div>
              {card &&
                !dummy &&
                (card.skills.length > 0 || id === "mirror") && (
                  <div className="wb-row">
                    {card.type === "spell" && (
                      <label>
                        <input
                          type="checkbox"
                          checked={spellSkill}
                          onChange={(e) => setSpellSkill(e.target.checked)}
                        />
                        启用法术技能
                      </label>
                    )}
                    {!!card.skills.length && (
                      <Choice
                        compact
                        label="预选技能"
                        value={skill ?? ""}
                        items={
                          card.type === "spell"
                            ? card.skills
                            : [{ id: "", name: "无主动技能" }, ...card.skills]
                        }
                        onChange={(v) => setSkills({ ...skills, [id]: v })}
                      />
                    )}
                  </div>
                )}
              {group && group.length > 1 && (
                <Choice
                  label="编队成员"
                  value={kind}
                  items={group.map((id) => ({
                    id,
                    name: cards.find((c) => c.id === id)?.name ?? id,
                  }))}
                  onChange={setMemberId}
                />
              )}
              {body && death && (
                <Choice
                  label="模型阶段"
                  value={deathId === body.asset ? "death" : "body"}
                  items={[
                    { id: "body", name: "本体" },
                    { id: "death", name: "死亡后续模型" },
                  ]}
                  onChange={(v) => setDeathId(v === "death" ? body.asset : "")}
                />
              )}
              {alternateProfile(kind) && (
                <Choice
                  label="形态"
                  value={alternateId === kind ? "alternate" : "base"}
                  items={[
                    { id: "base", name: "基础形态" },
                    { id: "alternate", name: "变身形态" },
                  ]}
                  onChange={(v) =>
                    setAlternateId(v === "alternate" ? kind : "")
                  }
                />
              )}
              {panel}
              <div className="wb-row">
                <button
                  aria-pressed={mode === "place"}
                  onClick={() => setMode("place")}
                >
                  放置
                </button>
                <button
                  aria-pressed={mode === "select"}
                  onClick={() => setMode("select")}
                >
                  选择单位
                </button>
                <button aria-pressed={dummy} onClick={() => setDummy(true)}>
                  敌方木桩
                </button>
              </div>
            </section>
            <section>
              <h2>实验场景</h2>
              <div className="wb-row">
                <Choice
                  compact
                  label="实验场景"
                  value={scene}
                  items={Object.entries({
                    dummy: "木桩练习",
                    duel: "单体对战",
                    surround: "敌人包围",
                    bridge: "拥挤过桥",
                    pincer: "远近夹击",
                  }).map(([id, name]) => ({ id, name }))}
                  onChange={setScene}
                />
                <button
                  disabled={!ready || !card}
                  onClick={() =>
                    send({
                      action: "scene",
                      scene,
                      card: id,
                      skill: activeSkill,
                      team,
                    })
                  }
                >
                  重建场景
                </button>
                <button
                  disabled={!ready}
                  onClick={() => send({ action: "clear" })}
                >
                  清场
                </button>
              </div>
              <div className="wb-row">
                <button disabled={!ready} onClick={() => setPaused(!paused)}>
                  {paused ? "继续战斗" : "暂停战斗"}
                </button>
                <button
                  disabled={!ready || !frame?.lab.paused}
                  onClick={() => send({ action: "step" })}
                >
                  单步 1 Tick
                </button>
                <Choice
                  compact
                  label="战斗速度"
                  value={String(speed)}
                  items={[1, 2, 4].map((n) => ({
                    id: String(n),
                    name: String(n / 4) + "×",
                  }))}
                  onChange={(v) => setSpeed(Number(v))}
                />
              </div>
            </section>
            <section>
              <h2>操作单位</h2>
              {current ? (
                <>
                  <strong>
                    {current.name ??
                      cards.find((c) => c.id === current.kind)?.name ??
                      (current.kind === "training_dummy"
                        ? "木桩"
                        : current.kind)}{" "}
                    #{current.id}
                  </strong>
                  <p>
                    {current.team ? "红方" : "蓝方"} · 生命 {current.hp}/
                    {current.maxHp} ·{" "}
                    {activities[current.activity] ?? current.activity}
                  </p>
                  {current.attack && (
                    <p>
                      起手 {current.attack.start} · 出手{" "}
                      {current.attack.release} · 收招 {current.attack.end}
                    </p>
                  )}
                  <p>
                    编队{" "}
                    {frame!.lab.members?.map((v) => "#" + v).join("、") ??
                      "独立单位"}
                    　{current.controls.join(" · ")}
                  </p>
                  <div className="wb-row">
                    <button
                      disabled={!frame?.lab.skill || !ready}
                      onClick={() => send({ action: "cast" })}
                    >
                      {focusedSkill?.name ?? frame?.lab.skill ?? "无主动技能"}
                    </button>
                    {["gnar", "aatrox"].includes(current.kind) && (
                      <button
                        disabled={!ready}
                        onClick={() => send({ action: "transform" })}
                      >
                        切换形态
                      </button>
                    )}
                    <Choice
                      compact
                      label="控制效果"
                      value={effect}
                      items={Object.entries({
                        freeze: "冻结",
                        stun: "眩晕",
                        root: "禁锢",
                        silence: "沉默",
                        stasis: "凝滞",
                      }).map(([id, name]) => ({ id, name }))}
                      onChange={setEffect}
                    />
                    <button
                      disabled={!ready}
                      onClick={() => send({ action: "control", kind: effect })}
                    >
                      施加 1 秒
                    </button>
                  </div>
                </>
              ) : (
                <p>部署一个单位，或在选择模式下点击场上单位。</p>
              )}
            </section>
            <section>
              <details>
                <summary>战斗事件 · 最近 {events.length} 条</summary>
                <ol className="wb-log">
                  {events
                    .slice()
                    .reverse()
                    .map((e) => (
                      <li key={e.seq}>
                        <b>
                          {e.tick}　{facts[e.fact.kind] ?? e.fact.kind}
                        </b>{" "}
                        <code>{JSON.stringify(e.fact.data)}</code>
                      </li>
                    ))}
                </ol>
              </details>
            </section>
          </aside>
          <section className="wb-display">
            {frame ? (
              <Stage
                frame={frame}
                point={point}
                zoom={zoom}
                setZoom={setZoom}
                reset={reset}
              />
            ) : (
              <p>正在连接实验场…</p>
            )}
            <div className="wb-row wb-zoom">
              <label>
                战场缩放{" "}
                <input
                  aria-label="战场缩放"
                  type="range"
                  min="1"
                  max="3"
                  step=".1"
                  value={zoom}
                  onChange={(e) => setZoom(Number(e.target.value))}
                />
              </label>
              <button
                onClick={() => {
                  setZoom(1);
                  setReset((v) => v + 1);
                }}
              >
                复位视角
              </button>
            </div>
          </section>
        </div>
      ) : tab === "info" ? (
        <div className="wb-layout">
          <aside className="wb-tools">
            <section>
              <h2>查找对象</h2>
              <input
                aria-label="查找资料"
                placeholder="搜索名称或 ID"
                value={infoSearch}
                onChange={(e) => setInfoSearch(e.target.value)}
              />
              <ChoiceList
                label="资料对象"
                value={infoCard?.id ?? ""}
                items={infoCards.map((c) => ({
                  id: c.id,
                  name: c.name + " · " + types[c.type],
                }))}
                onChange={setInfoId}
              />
            </section>
          </aside>
          <section className="wb-display wb-info">
            {infoCard ? (
              <CardInformation
                card={infoCard}
                selected={skills[infoCard.id] ?? ""}
                choose={(s) => setSkills({ ...skills, [infoCard.id]: s })}
              />
            ) : (
              <p>没有匹配对象。</p>
            )}
          </section>
        </div>
      ) : profile ? (
        <Suspense fallback={<p>正在加载模型…</p>}>
          <ModelPreview
            key={modelCard.id + "/" + profile.asset}
            profile={profile}
          >
            <section>
              <h2>观察模型</h2>
              <Choice
                label="对象"
                value={modelCard?.id ?? ""}
                items={modelCards}
                onChange={setModelId}
              />
              {group && group.length > 1 && (
                <Choice
                  label="编队成员"
                  value={kind}
                  items={group.map((id) => ({
                    id,
                    name: cards.find((c) => c.id === id)?.name ?? id,
                  }))}
                  onChange={setMemberId}
                />
              )}
              {body && death && (
                <Choice
                  label="模型阶段"
                  value={deathId === body.asset ? "death" : "body"}
                  items={[
                    { id: "body", name: "本体" },
                    { id: "death", name: "死亡后续模型" },
                  ]}
                  onChange={(v) => setDeathId(v === "death" ? body.asset : "")}
                />
              )}
              {alternateProfile(kind) && (
                <Choice
                  label="形态"
                  value={alternateId === kind ? "alternate" : "base"}
                  items={[
                    { id: "base", name: "基础形态" },
                    { id: "alternate", name: "变身形态" },
                  ]}
                  onChange={(v) =>
                    setAlternateId(v === "alternate" ? kind : "")
                  }
                />
              )}
              {panel}
              <div className="wb-row">
                {[-1, 1].map((step) => (
                  <button
                    key={step}
                    onClick={() =>
                      setModelId(
                        modelCards[
                          (modelCards.indexOf(modelCard) +
                            step +
                            modelCards.length) %
                            modelCards.length
                        ].id,
                      )
                    }
                  >
                    {step < 0 ? "上一个" : "下一个"}
                  </button>
                ))}
              </div>
              {detailCard && (
                <button onClick={() => setDetails(true)}>卡牌信息</button>
              )}
            </section>
          </ModelPreview>
        </Suspense>
      ) : (
        <p>尚无已接入模型。</p>
      )}
      {library && (
        <Modal title="选择实验卡" onClose={() => setLibrary(false)}>
          <div className="wb-picker">
            <div className="wb-row">
              <input
                autoFocus
                aria-label="搜索卡牌"
                placeholder="搜索名称或 ID"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <Choice
                compact
                label="卡牌分类"
                value={category}
                items={Object.entries(types).map(([id, name]) => ({
                  id,
                  name,
                }))}
                onChange={setCategory}
              />
            </div>
            <div className="wb-grid">
              {cards
                .filter(
                  (c) =>
                    (category === "all" || c.type === category) &&
                    (c.name + " " + c.id)
                      .toLowerCase()
                      .includes(query.trim().toLowerCase()),
                )
                .map((c) => (
                  <button
                    key={c.id}
                    aria-pressed={slots.includes(c.id)}
                    disabled={slots.length >= 8 && !slots.includes(c.id)}
                    onClick={() => toggleSlot(c.id)}
                  >
                    {c.image && <img loading="lazy" src={c.image} alt="" />}
                    {c.name}
                  </button>
                ))}
            </div>
            <div className="wb-slots">
              {slots.map((s, i) => (
                <button
                  key={s}
                  onClick={() => toggleSlot(s)}
                  aria-label={"移除 " + s}
                >
                  {i + 1} · {cards.find((c) => c.id === s)?.name ?? s} ×
                </button>
              ))}
            </div>
            <button onClick={() => setLibrary(false)}>
              完成 · {slots.length}/8
            </button>
          </div>
        </Modal>
      )}
      {details && detailCard && (
        <CardDetails
          card={detailCard}
          selected={skills[detailCard.id] ?? ""}
          choose={(s) => setSkills({ ...skills, [detailCard.id]: s })}
          close={() => setDetails(false)}
          backLabel="返回工作台"
        />
      )}
    </section>
  );
}
