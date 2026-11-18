import { Choice, useConfirmation } from "./controls";
import { internalLink, navigate } from "./navigation";
import { useEffect, useState } from "react";
import { api, defaultDeck, go, updateRoom } from "./api";
import type { Catalog, Deck, Room, Session } from "./api";
interface Draft {
  deck: Deck;
  name: string;
  preset: string;
  version?: number;
  settings?: number;
  presetRevision?: number;
}
function restoreDraft(key: string, catalog: Catalog): Draft | undefined {
  try {
    const d = JSON.parse(sessionStorage.getItem(key) ?? "null");
    if (
      d &&
      typeof d.name === "string" &&
      typeof d.preset === "string" &&
      Array.isArray(d.deck?.cards) &&
      d.deck.cards.length === 8 &&
      d.deck.cards.every(
        (key: unknown) => key === "" || catalog.cards.some((x) => x.id === key),
      ) &&
      d.deck.skills &&
      typeof d.deck.skills === "object"
    )
      return d;
  } catch {
    /* Storage may be unavailable. */
  }
}
function needsApply(deck: Deck, room?: Room) {
  return Boolean(
    room &&
    deck.cards.some(
      (id, index) =>
        id !== room.deck.cards[index] ||
        deck.skills[id] !== room.deck.skills[id],
    ),
  );
}
export function Editor({
  catalog: c,
  session,
  room,
  reload,
}: {
  catalog: Catalog;
  session: Session;
  room?: Room;
  reload: () => Promise<void>;
}) {
  const { ask, confirmation } = useConfirmation();
  const draftKey = [
    "clashlegends.draft",
    c.version,
    session.name,
    room?.id ?? "presets",
    room?.round ?? 0,
  ].join(":");
  const [draft] = useState(() => restoreDraft(draftKey, c));
  const [preset, setPreset] = useState(draft?.preset ?? ""),
    [name, setName] = useState(draft?.name ?? "我的卡组"),
    [deck, setDeck] = useState<Deck>(() =>
      structuredClone(draft?.deck ?? room?.deck ?? defaultDeck(c)),
    );
  const [slot, setSlot] = useState(0),
    [focus, setFocus] = useState(deck.cards.find(Boolean) ?? c.cards[0].id),
    [search, setSearch] = useState(""),
    [type, setType] = useState(""),
    [order, setOrder] = useState("default");
  const [dirty, setDirty] = useState(Boolean(draft)),
    [msg, setMsg] = useState(""),
    [busy, setBusy] = useState(false),
    [version, setVersion] = useState(draft?.version ?? room?.deckVersion),
    [settings, setSettings] = useState(
      draft?.settings ?? room?.settingsVersion,
    ),
    [presetRevision, setPresetRevision] = useState<number | undefined>(
      draft?.presetRevision,
    );
  const byId = new Map(c.cards.map((x) => [x.id, x])),
    card = byId.get(focus)!;
  const list = c.cards.filter(
    (x) =>
      (!type || x.type === type) &&
      (x.name.includes(search) || x.id.includes(search.toLowerCase())),
  );
  if (order !== "default")
    list.sort((a, b) => (order === "asc" ? a.cost - b.cost : b.cost - a.cost));
  useEffect(() => {
    try {
      if (dirty)
        sessionStorage.setItem(
          draftKey,
          JSON.stringify({
            deck,
            name,
            preset,
            version,
            settings,
            presetRevision,
          }),
        );
      else sessionStorage.removeItem(draftKey);
    } catch {
      /* Editing still works when tab storage is unavailable. */
    }
  }, [dirty, draftKey, deck, name, preset, version, settings, presetRevision]);
  useEffect(() => {
    if (!dirty) return;
    const guard = async (e: MouseEvent) => {
      const link = internalLink(e);
      if (!link || link.href === location.href) return;
      e.preventDefault();
      if (
        await ask(
          "离开备战编辑器",
          "离开后将放弃当前草稿，已保存的个人预设可以再次载入。",
          "放弃并离开",
        )
      ) {
        try {
          sessionStorage.removeItem(draftKey);
        } catch {}
        navigate(link.href);
      }
    };
    document.addEventListener("click", guard, true);
    return () => document.removeEventListener("click", guard, true);
  }, [dirty, draftKey, ask]);
  function change(d: Deck) {
    setDeck(d);
    setDirty(true);
    setMsg("");
  }
  async function choosePreset(key: string) {
    if (
      dirty &&
      !(await ask("载入卡组", "载入后将替换当前未保存的修改。", "载入卡组"))
    )
      return;
    const p = session.presets.find((x) => x.id === key);
    const d = structuredClone(p?.deck ?? room?.deck ?? defaultDeck(c));
    setPreset(key);
    setPresetRevision(p?.revision);
    setName(p?.name ?? "我的卡组");
    setDeck(d);
    setFocus(d.cards[0]);
    setSlot(0);
    setDirty(needsApply(d, room));
    setVersion(room?.deckVersion);
    setSettings(room?.settingsVersion);
    setMsg("");
  }
  function assign() {
    const d = structuredClone(deck),
      old = d.cards[slot],
      existing = d.cards.indexOf(focus);
    if (existing >= 0) {
      d.cards[existing] = old;
    } else {
      if (old) delete d.skills[old];
      if (card.skills[0]) d.skills[focus] = card.skills[0].id;
    }
    d.cards[slot] = focus;
    change(d);
  }
  async function submit(action: "apply" | "save" | "copy" | "delete") {
    if (busy) return;
    setBusy(true);
    setMsg("");
    try {
      if (action === "delete") {
        if (
          !(await ask("删除个人预设", "确定删除「" + name + "」？", "确认删除"))
        )
          return;
        await api("presets/" + preset, undefined, "DELETE");
        setPreset("");
        setPresetRevision(undefined);
        await reload();
        setMsg("预设已删除");
        return;
      }
      const empty = deck.cards.findIndex((x) => !x);
      if (empty >= 0) throw new Error("请先填满第 " + (empty + 1) + " 个卡位");
      if (action === "apply" && room) {
        const next = await updateRoom(
          { ...room, deckVersion: version!, settingsVersion: settings! },
          "deck",
          { deck, presetId: preset || undefined },
        );
        setDirty(false);
        setTimeout(
          () =>
            go(next.matchId ? "matches/" + next.matchId : "rooms/" + room.id),
          0,
        );
        return;
      }
      const p = await api<{ id: string }>("presets", {
        id: action === "copy" ? undefined : preset || undefined,
        name,
        deck,
        revision: presetRevision,
      });
      setPreset(p.id);
      setPresetRevision(
        action === "copy" || !preset ? 1 : (presetRevision ?? 0) + 1,
      );
      await reload();
      setDirty(needsApply(deck, room));
      setMsg("个人预设已保存");
    } catch (e) {
      setMsg((e as Error).message);
      await reload();
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      {confirmation}
      <div className="page-title">
        <div>
          <span className="eyebrow">备战工坊</span>
          <h1>{room ? "本局备战" : "我的卡组"}</h1>
        </div>
        <a
          className="outline"
          href={room ? "/play/rooms/" + room.id : "/play/"}
        >
          {room ? "返回房间" : "返回大厅"}
        </a>
      </div>
      <div className="panel editor-head">
        <div className="tools">
          <Choice
            label="个人预设"
            value={preset}
            items={[
              { id: "", name: room ? "本局卡组" : "默认卡组" },
              ...session.presets,
            ]}
            onChange={choosePreset}
          />
          <label>
            预设名称
            <input
              value={name}
              maxLength={32}
              onChange={(e) => {
                setName(e.target.value);
                setDirty(true);
              }}
            />
          </label>
          <button disabled={busy} onClick={() => submit("save")}>
            保存预设
          </button>
          {preset && (
            <>
              <button disabled={busy} onClick={() => submit("copy")}>
                另存一套
              </button>
              <button disabled={busy} onClick={() => submit("delete")}>
                删除预设
              </button>
            </>
          )}
          {room && (
            <button
              className="gold"
              disabled={busy}
              onClick={() => submit("apply")}
            >
              应用到本局
            </button>
          )}
        </div>
        <div className="section-title">
          <h2>出战卡组</h2>
          <small>选择卡位后替换卡牌</small>
        </div>
        {room &&
          (room.deckVersion !== version ||
            room.settingsVersion !== settings) && (
            <p className="notice">
              房间配置已更新。
              <button onClick={() => choosePreset("")}>重新载入本局配置</button>
            </p>
          )}
        <div className="slots">
          {deck.cards.map((id, i) => (
            <button
              key={i}
              draggable={Boolean(id)}
              onDragStart={(e) =>
                e.dataTransfer.setData("application/x-deck-slot", String(i))
              }
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const value = e.dataTransfer.getData("application/x-deck-slot");
                if (!/^[0-7]$/.test(value)) return;
                const from = Number(value);
                const next = structuredClone(deck);
                [next.cards[from], next.cards[i]] = [
                  next.cards[i],
                  next.cards[from],
                ];
                change(next);
                setSlot(i);
                if (next.cards[i]) setFocus(next.cards[i]);
              }}
              className={"slot " + (slot === i ? "selected" : "")}
              onClick={() => {
                setSlot(i);
                if (id) setFocus(id);
              }}
            >
              {id && <img src={byId.get(id)?.image} alt="" />}
              <span>{i < 2 ? "主动槽 " + (i + 1) : "卡位 " + (i + 1)}</span>
              <b>{byId.get(id)?.name ?? "空位"}</b>
            </button>
          ))}
        </div>
      </div>
      {msg && (
        <p role="status" className="notice">
          {msg}
        </p>
      )}
      <div className="library">
        <div className="panel">
          <div className="section-title">
            <h2>卡牌收藏</h2>
            <small>{list.length} 张</small>
          </div>
          <div className="tools filters">
            <input
              aria-label="搜索卡牌"
              placeholder="搜索卡牌名称"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <Choice
              compact
              label="类型"
              value={type}
              onChange={setType}
              items={[
                { id: "", name: "全部类型" },
                { id: "unit", name: "单位" },
                { id: "spell", name: "法术" },
                { id: "building", name: "建筑" },
              ]}
            />
            <Choice
              compact
              label="费用排序"
              value={order}
              onChange={setOrder}
              items={[
                { id: "default", name: "默认排序" },
                { id: "asc", name: "费用由低到高" },
                { id: "desc", name: "费用由高到低" },
              ]}
            />
          </div>
          <div className="collection">
            {list.map((x) => (
              <button
                className={"tile " + (focus === x.id ? "selected" : "")}
                key={x.id}
                onClick={() => setFocus(x.id)}
              >
                <img loading="lazy" src={x.image} alt="" />
                <small>{x.costLabel ?? x.cost}</small>
                <b>{x.name}</b>
              </button>
            ))}
          </div>
          {!list.length && <p>没有匹配的卡牌</p>}
        </div>
        <aside className="panel details">
          <img src={card.image} alt="" />
          <h2>{card.name}</h2>
          <p>{card.description}</p>
          <button className="gold" onClick={assign}>
            {deck.cards.includes(focus) && deck.cards[slot] !== focus
              ? "交换到"
              : "放入"}
            第 {slot + 1} 位
          </button>
          {deck.cards[slot] && (
            <button
              onClick={() => {
                const d = structuredClone(deck);
                delete d.skills[d.cards[slot]];
                d.cards[slot] = "";
                change(d);
              }}
            >
              清空第 {slot + 1} 位
            </button>
          )}
          {card.skills.length > 0 && (
            <fieldset>
              <legend>技能选择</legend>
              {card.skills.map((s) => (
                <label key={s.id}>
                  <input
                    type="radio"
                    name="skill"
                    checked={deck.skills[focus] === s.id}
                    disabled={!deck.cards.includes(focus)}
                    onChange={() =>
                      change({
                        ...deck,
                        skills: { ...deck.skills, [focus]: s.id },
                      })
                    }
                  />
                  <strong>{s.name}</strong>
                  <small>{s.description}</small>
                </label>
              ))}
            </fieldset>
          )}
        </aside>
      </div>
    </section>
  );
}
