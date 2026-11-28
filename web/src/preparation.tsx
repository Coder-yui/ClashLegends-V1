import { RecordingSettings } from "./recording-options";
import { cardArt } from "./card-art";
import { FullscreenButton } from "./fullscreen";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { usePreparationDrag } from "./use-preparation-drag";
import { Choice, Modal } from "./controls";
import type { Card, Catalog, Deck, Room } from "./api";
import metadata from "./preparation-data.json";
import "./preparation.css";

type Section = { title: string; attributes: { name: string; value: string }[] };
interface CardInfo {
  color: string;
  type: string;
  air: boolean;
  brief: string;
  portrait?: string;
  activeDescription?: string;
  sections: Section[];
  passives: { name: string; description: string; attackTiming?: string }[];
  skills: {
    id: string;
    cost: number;
    costByUse: number[];
    group: boolean;
    cooldown: number;
    uses: number;
    unlimited: boolean;
    description: string;
    attackTiming?: string;
  }[];
}
const info: Record<string, CardInfo> = metadata;
const filters = [
  ["all", "全部"],
  ["ground", "地面"],
  ["air", "空军"],
  ["building", "建筑"],
  ["spell", "法术"],
] as const;
function icon(id: string) {
  return (
    <img
      className="prep-icon"
      src={
        id === "coin"
          ? "/play/media/battle/coin.svg"
          : "/play/media/preparation/" + id + ".svg"
      }
      alt=""
    />
  );
}
export function Face({
  card,
  rune = false,
  empty,
  preview,
}: {
  card?: Card;
  rune?: boolean;
  empty?: number;
  preview?: string;
}) {
  return card ? (
    <>
      <img
        className="prep-art"
        src={preview || cardArt(card, true) || undefined}
        loading="lazy"
        alt=""
      />
      <span className="prep-coin">
        {card.id === "mirror" ? "?" : card.cost}
      </span>
      {rune && (
        <img className="prep-rune" src="/play/media/battle/rune.webp" alt="" />
      )}
      <b className="prep-card-name">{card.name}</b>
    </>
  ) : (
    <span className="prep-empty">
      {empty}
      <small>选择卡牌</small>
    </span>
  );
}
function style(card?: Card): CSSProperties {
  return { "--edge": card ? info[card.id]?.color : undefined } as CSSProperties;
}
type Context = { card: Card; slot: number | null; anchor: HTMLButtonElement };
function CardMenu({
  context,
  canAdd,
  close,
  detail,
  act,
}: {
  context: Context;
  canAdd: boolean;
  close: () => void;
  detail: () => void;
  act: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const menu = ref.current!,
      anchor = context.anchor;
    function position() {
      const box = anchor.getBoundingClientRect(),
        width = menu.offsetWidth,
        height = menu.offsetHeight;
      const panel = anchor.closest(".prep-pool")?.getBoundingClientRect();
      if (panel && (box.bottom <= panel.top || box.top >= panel.bottom)) {
        close();
        return;
      }
      menu.style.left =
        Math.min(
          innerWidth - width - 5,
          Math.max(5, box.left + (box.width - width) / 2),
        ) + "px";
      menu.style.top =
        (box.bottom + height + 6 <= innerHeight
          ? box.bottom + 3
          : box.top - height - 3) + "px";
    }
    position();
    menu.querySelector("button")?.focus({ preventScroll: true });
    function outside(e: PointerEvent) {
      if (
        !menu.contains(e.target as Node) &&
        !anchor.contains(e.target as Node)
      )
        close();
    }
    function esc(e: KeyboardEvent) {
      if (e.key === "Escape") {
        close();
        anchor.focus({ preventScroll: true });
      }
    }
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", esc);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", esc);
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [context]);
  return (
    <div
      ref={ref}
      className="prep-menu"
      role="group"
      aria-label={context.card.name + "操作"}
    >
      <button onClick={detail}>信息</button>
      <button disabled={context.slot === null && !canAdd} onClick={act}>
        {context.slot === null ? "添加" : "移除"}
      </button>
    </div>
  );
}
export function CardDetails({
  card,
  selected,
  choose,
  close,
  backLabel = "返回备战",
}: {
  card: Card;
  selected: string;
  choose: (s: string) => void;
  close: () => void;
  backLabel?: string;
}) {
  return (
    <Modal title={card.name} onClose={close}>
      <CardInformation card={card} selected={selected} choose={choose}>
        <button className="prep-tool" onClick={close}>
          {backLabel}
        </button>
      </CardInformation>
    </Modal>
  );
}

export function CardInformation({
  card,
  selected,
  choose,
  children,
}: {
  card: Card;
  selected: string;
  choose: (s: string) => void;
  children?: ReactNode;
}) {
  const data = info[card.id];
  const sections = data?.sections ?? [];
  const index = Math.max(
    0,
    card.skills.findIndex((s) => s.id === selected),
  );
  const skill = card.skills[index],
    rule = data?.skills.find((s) => s.id === skill?.id);
  return (
    <div className="prep-detail">
      <div className="prep-identity">
        <div className="prep-card" style={style(card)}>
          <Face card={card} />
        </div>
        <div>
          <h3>{card.name}</h3>
          <span>
            {data?.type ?? card.type}　·　
            {card.costLabel ?? card.cost + " 费"}
          </span>
        </div>
        <button className="prep-skin" disabled aria-label="皮肤：原皮">
          原皮
        </button>
      </div>
      <p>{data?.brief || card.description}</p>
      {sections.map((s, i) => (
        <section key={i}>
          <h4>{s.title}</h4>
          <dl>
            {s.attributes.map((a, j) => (
              <div
                key={j}
                className={
                  a.name === "前摇 / 后摇" ? "prep-attack-timing" : undefined
                }
              >
                <dt>{a.name}</dt>
                <dd>{a.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
      {sections.some((s) =>
        s.attributes.some((a) => a.name === "前摇 / 后摇"),
      ) && (
        <p className="prep-timing-note">
          前摇从起手算到近战命中或远程发弹，后摇从出手算到下一击起手。表中为基础攻速下连续攻击的估算值，实战按
          0.05 秒一步结算。
        </p>
      )}
      {!!data?.passives.length && (
        <section>
          <h4>被动</h4>
          {data.passives.map((p, i) => (
            <p key={i}>
              <b>{p.name}</b>　{p.description}
              {p.attackTiming && (
                <span className="prep-skill-timing">{p.attackTiming}</span>
              )}
            </p>
          ))}
        </section>
      )}
      <section>
        <h4>主动</h4>
        {skill ? (
          <>
            <div className="prep-options">
              {skill.image && <img src={skill.image} alt="" />}
              <Choice
                label="主动技能"
                items={card.skills}
                value={skill.id}
                onChange={choose}
                compact
              />
            </div>
            {rule && (
              <small>
                金币消耗{" "}
                {rule.costByUse.length
                  ? rule.costByUse.join(" → ") +
                    (rule.unlimited ? "（封顶）" : "")
                  : rule.cost}
                　·　
                {rule.group ? "本次编队" : "单个单位"}
                {rule.unlimited ? "次数不限" : "最多 " + rule.uses + " 次"}
                　·　冷却 {rule.cooldown} 秒
              </small>
            )}
            <p>{rule?.description || skill.description}</p>
            {rule?.attackTiming && (
              <p className="prep-skill-timing">{rule.attackTiming}</p>
            )}
          </>
        ) : (
          <p>{data?.activeDescription ?? "无主动技能"}</p>
        )}
      </section>
      {children}
    </div>
  );
}

interface Props {
  catalog: Catalog;
  deck: Deck;
  change: (d: Deck) => void;
  room?: Room;
  busy: boolean;
  submit: () => void;
  caption: string;
  index: number;
  switchSlot: (i: number) => void;
  name: string;
  rename: (name: string) => void;
  save: () => void;
  apply: () => void;
  legacy?: ReactNode;
  management?: ReactNode;
  notice?: ReactNode;
  readyDisabled: boolean;
  footerMessage: string;
  back: string;
  collection: boolean;
}
export function Preparation(p: Props) {
  const { deck, catalog, room } = p;
  const [filter, setFilter] = useState("all"),
    [sort, setSort] = useState<"cost" | "name">("cost"),
    [desc, setDesc] = useState(false);
  const [search, setSearch] = useState(""),
    [context, setContext] = useState<Context | null>(null),
    [pending, setPending] = useState(-1);
  const [detail, setDetail] = useState<Card | null>(null),
    [panel, setPanel] = useState<"room" | "recording" | null>(null);
  const [preferences, setPreferences] = useState<Record<string, string>>({});
  const pool = useRef<HTMLDivElement>(null);
  const filled = deck.cards.filter(Boolean),
    byId = new Map(catalog.cards.map((c) => [c.id, c])),
    empty = deck.cards.indexOf("");
  const cards = catalog.cards
    .filter(
      (c) =>
        !filled.includes(c.id) &&
        (filter === "all" ||
          (c.type === "unit"
            ? info[c.id]?.air
              ? "air"
              : "ground"
            : c.type) === filter) &&
        (c.name.includes(search) || c.id.includes(search.toLowerCase())),
    )
    .sort((a, b) => {
      const cost = sort === "cost" ? (a.cost - b.cost) * (desc ? -1 : 1) : 0;
      return (
        cost ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) *
          (sort === "name" && desc ? -1 : 1) ||
        a.id.localeCompare(b.id)
      );
    });
  const average = filled.includes("mirror")
    ? "平均 · 动态"
    : "平均 " +
      (filled.length
        ? (
            filled.reduce((n, id) => n + (byId.get(id)?.cost ?? 0), 0) /
            filled.length
          ).toFixed(1)
        : "—");
  useEffect(() => {
    pool.current?.scrollTo({ top: 0 });
  }, [filter, sort, desc, search]);
  function setSlot(index: number, card?: Card) {
    if (
      p.busy ||
      index < 0 ||
      index >= deck.cards.length ||
      (card && filled.includes(card.id))
    )
      return;
    const next = structuredClone(deck);
    const previous = next.cards[index];
    if (previous) {
      const skill = next.skills[previous];
      if (skill) setPreferences((old) => ({ ...old, [previous]: skill }));
      delete next.skills[previous];
    }
    next.cards[index] = card?.id ?? "";
    if (card?.skills.length)
      next.skills[card.id] = preferences[card.id] ?? card.skills[0].id;
    p.change(next);
    setPending(-1);
    setContext(null);
  }
  const { drag, ghost, ghostStyle, boardProps } = usePreparationDrag(
    p.busy,
    p.index,
    empty,
    () => {
      setContext(null);
      setPending(-1);
    },
    (source, target) => {
      const from = source.slot;
      if (from !== null && deck.cards[from] !== source.id) return;
      if (target === "pool") {
        if (from !== null) setSlot(from);
      } else if (from === null) {
        const card = byId.get(source.id);
        if (card) setSlot(target, card);
      } else {
        const next = structuredClone(deck);
        [next.cards[from], next.cards[target]] = [
          next.cards[target],
          next.cards[from],
        ];
        p.change(next);
      }
    },
  );
  const draggedCard = drag && byId.get(drag.source.id);
  function randomize() {
    const choices = [...catalog.cards],
      next: Deck = { cards: [], skills: {} };
    for (let i = 0; i < 8; i++) {
      const j = i + Math.floor(Math.random() * (choices.length - i));
      [choices[i], choices[j]] = [choices[j], choices[i]];
      const c = choices[i];
      next.cards.push(c.id);
      if (c.skills.length)
        next.skills[c.id] =
          i < 2
            ? c.skills[Math.floor(Math.random() * c.skills.length)].id
            : (deck.skills[c.id] ?? preferences[c.id] ?? c.skills[0].id);
    }
    p.change(next);
    setPending(-1);
    setContext(null);
  }
  function show(c: Card, slot: number | null, anchor: HTMLButtonElement) {
    if (pending >= 0 && slot === null && !deck.cards[pending]) {
      setSlot(pending, c);
      return;
    }
    setPending(-1);
    setContext(context?.anchor === anchor ? null : { card: c, slot, anchor });
  }
  const doubles = room?.mode === "2v2";
  const other = room?.seats.find(
    (s) => s.slot % 2 !== room.seats[room.me].slot % 2,
  );
  return (
    <section className="prep-screen" aria-label="备战">
      {room && (
        <link rel="preload" as="image" href="/play/match-loading.webp" />
      )}
      <div className="prep-board" {...boardProps}>
        <div className="prep-header">
          <a className="prep-tool square" href={p.back} aria-label="返回大厅">
            {icon("back")}
          </a>
          <h1>{room ? "备战" : p.collection ? "收藏预设" : "我的卡组"}</h1>
          <FullscreenButton className="prep-tool square" />
          {room && (
            <button className="prep-tool" onClick={() => setPanel("room")}>
              房间
            </button>
          )}
          {room && (
            <button className="prep-tool" disabled={p.busy} onClick={p.save}>
              保存预设
            </button>
          )}
          <button
            className="prep-tool square prep-shuffle"
            aria-label="随机"
            onClick={randomize}
          >
            {icon("shuffle")}
            <span role="tooltip">随机</span>
          </button>
        </div>
        <div className="prep-loadout">
          <div className="prep-section-title prep-deck-heading">
            <input
              className="deck-name"
              aria-label="卡组名称"
              title="卡组名称，最多 8 个字"
              maxLength={8}
              placeholder={"卡组 " + (p.index + 1)}
              value={p.name}
              disabled={p.busy}
              onChange={(e) => p.rename(e.target.value)}
            />
            <span>{filled.length} / 8</span>
            <div className="prep-switch" role="group" aria-label="切换卡组">
              {[0, 1, 2, 3].map((i) => (
                <button
                  key={i}
                  className="prep-tool"
                  aria-label={"卡组 " + (i + 1)}
                  aria-pressed={p.index === i}
                  disabled={p.busy}
                  onClick={() => {
                    p.switchSlot(i);
                    setPending(-1);
                    setContext(null);
                    setDetail(null);
                    setPreferences({});
                  }}
                >
                  {i + 1}
                </button>
              ))}
            </div>
            <strong>
              {icon("coin")}
              {average}
            </strong>
          </div>
          <div className="prep-slots">
            {deck.cards.map((id, i) => {
              const c = byId.get(id);
              return (
                <div
                  key={i}
                  data-deck-slot={i}
                  data-drop-target={drag?.target === i || undefined}
                  className={"prep-cradle" + (i < 2 ? " runic" : "")}
                >
                  <button
                    data-card={id}
                    className={"prep-card" + (!c ? " empty" : "")}
                    aria-label={`${i < 2 ? "主动槽" : "卡位"} ${i + 1} · ${c?.name ?? "空位"}`}
                    aria-pressed={context?.slot === i || pending === i}
                    style={style(c)}
                    data-drag-source={drag?.source.slot === i || undefined}
                    onClick={(e) => {
                      if (c) show(c, i, e.currentTarget);
                      else {
                        setContext(null);
                        setPending(pending === i ? -1 : i);
                      }
                    }}
                  >
                    <Face card={c} rune={i < 2} empty={i + 1} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
        <div className="prep-library-heading prep-section-title">
          <h2>卡牌库</h2>
          <span>
            {cards.length} 张<small className="prep-touch-hint">长按拖动</small>
          </span>
          <input
            type="search"
            aria-label="搜索卡牌"
            placeholder="搜索"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setContext(null);
            }}
          />
          <button
            className="prep-tool"
            aria-label="切换排序方式"
            onClick={() => setSort(sort === "cost" ? "name" : "cost")}
          >
            {icon(sort === "cost" ? "coin" : "name")}
            {sort === "cost" ? "费用" : "名称"}
          </button>
          <button
            className="prep-tool square"
            aria-label={desc ? "降序，切换为升序" : "升序，切换为降序"}
            onClick={() => setDesc(!desc)}
          >
            {icon(desc ? "desc" : "asc")}
          </button>
        </div>
        <div className="prep-filters">
          {filters.map(([id, label]) => (
            <button
              key={id}
              className="prep-tool"
              aria-pressed={filter === id}
              onClick={() => {
                setFilter(id);
                setContext(null);
              }}
            >
              {icon(id)}
              {label}
            </button>
          ))}
        </div>
        <div
          className="prep-pool"
          data-drop-target={drag?.target === "pool" || undefined}
          ref={pool}
          aria-label="卡牌库"
        >
          <div className="prep-collection">
            {cards.map((c) => (
              <button
                className="prep-card"
                key={c.id}
                data-drag-source={drag?.source.id === c.id || undefined}
                style={style(c)}
                aria-label={c.name}
                data-card={c.id}
                aria-pressed={
                  context?.card.id === c.id && context.slot === null
                }
                onClick={(e) => show(c, null, e.currentTarget)}
              >
                <Face card={c} />
              </button>
            ))}
          </div>
          {!cards.length && <p>没有匹配的卡牌</p>}
        </div>
        {p.legacy}
        {p.notice}
        <footer className="prep-footer">
          {room && (
            <div className="prep-room-line">
              <span>
                {catalog.maps.find((m) => m.id === room.map)?.name} ·{" "}
                {doubles
                  ? `2v2 · ${room.seats.length}/4 人入座`
                  : room.kind === "ai"
                    ? "电脑玩家"
                    : (other?.name ?? "等待好友加入")}
              </span>
              <button
                disabled={p.busy || filled.length !== 8}
                onClick={p.apply}
              >
                应用到本局
              </button>
              <button onClick={() => setPanel("recording")}>录制设置</button>
              {room.kind === "friend" && (
                <>
                  <span>
                    {doubles
                      ? `已准备 ${room.seats.filter((s) => s.ready).length}/4`
                      : other
                        ? !other.online
                          ? "重连中"
                          : other.ready
                            ? "对方已准备"
                            : "对方备战中"
                        : ""}
                  </span>
                  <button onClick={() => setPanel("room")}>
                    邀请码 <b>{room.code}</b>
                  </button>
                </>
              )}
            </div>
          )}
          <button
            className="prep-start prep-tool"
            disabled={
              (!!room && filled.length !== 8) || p.readyDisabled || p.busy
            }
            onClick={p.submit}
          >
            {!room || filled.length === 8
              ? p.caption
              : `还需选择 ${8 - filled.length} 张卡`}
          </button>
          {p.footerMessage && <small role="status">{p.footerMessage}</small>}
        </footer>
      </div>
      {drag && draggedCard && (
        <div
          ref={ghost}
          aria-hidden="true"
          className="prep-card prep-drag-ghost"
          style={{ ...style(draggedCard), ...ghostStyle }}
        >
          <Face
            card={draggedCard}
            rune={drag.source.slot !== null && drag.source.slot < 2}
          />
        </div>
      )}
      {panel === "recording" && (
        <Modal title="录制设置" onClose={() => setPanel(null)}>
          <RecordingSettings />
        </Modal>
      )}
      {context && (
        <CardMenu
          context={context}
          canAdd={empty !== -1}
          close={() => setContext(null)}
          detail={() => {
            setDetail(context.card);
            setContext(null);
          }}
          act={() =>
            context.slot === null
              ? setSlot(empty, context.card)
              : setSlot(context.slot)
          }
        />
      )}
      {detail && (
        <CardDetails
          card={detail}
          selected={deck.skills[detail.id] ?? preferences[detail.id] ?? ""}
          close={() => setDetail(null)}
          choose={(s) => {
            setPreferences((old) => ({ ...old, [detail.id]: s }));
            if (filled.includes(detail.id))
              p.change({ ...deck, skills: { ...deck.skills, [detail.id]: s } });
          }}
        />
      )}
      {panel === "room" && (
        <Modal
          title={
            doubles
              ? "2v2 组队房"
              : room?.kind === "friend"
                ? "好友房间"
                : "电脑玩家备战室"
          }
          onClose={() => setPanel(null)}
        >
          {p.management}
        </Modal>
      )}
    </section>
  );
}
