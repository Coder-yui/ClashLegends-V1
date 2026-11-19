import { Choice, useConfirmation } from "./controls";
import { internalLink, navigate } from "./navigation";
import { useEffect, useState, type ReactNode } from "react";
import { Preparation } from "./preparation";
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
  collection = false,
  reload,
  online = true,
  management,
}: {
  catalog: Catalog;
  session: Session;
  room?: Room;
  collection?: boolean;
  reload: () => Promise<void>;
  online?: boolean;
  management?: ReactNode;
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
  const byId = new Map(c.cards.map((x) => [x.id, x]));
  useEffect(() => {
    if (
      !room ||
      dirty ||
      (room.deckVersion === version && room.settingsVersion === settings)
    )
      return;
    setDeck(structuredClone(room.deck));
    setVersion(room.deckVersion);
    setSettings(room.settingsVersion);
  }, [room, dirty, version, settings]);
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
  const presetsForMenu = !collection
    ? session.presets.filter((p) => p.battleDeck)
    : session.presets;
  async function choosePreset(key: string) {
    if (
      dirty &&
      !(await ask("载入卡组", "载入后将替换当前未保存的修改。", "载入卡组"))
    )
      return;
    const p = session.presets.find((x) => x.id === key);
    const d = structuredClone(
      (collection ? p?.deck : p?.battleDeck) ?? room?.deck ?? defaultDeck(c),
    );
    for (const id of d.cards) {
      const first = byId.get(id)?.skills[0];
      if (first && !d.skills[id]) d.skills[id] = first.id;
    }
    setPreset(key);
    setPresetRevision(p?.revision);
    setName(p?.name ?? "我的卡组");
    setDeck(d);
    setDirty(needsApply(d, room));
    setVersion(room?.deckVersion);
    setSettings(room?.settingsVersion);
    setMsg("");
  }
  async function submit(
    action: "ready" | "apply" | "save" | "copy" | "delete",
  ) {
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
      if ((action === "apply" || action === "ready") && room) {
        let current = {
          ...room,
          deckVersion: version!,
          settingsVersion: settings!,
        };
        const changed = needsApply(deck, room);
        if (changed) {
          current = await updateRoom(current, "deck", {
            deck,
            presetId: preset || undefined,
          });
          setVersion(current.deckVersion);
          setSettings(current.settingsVersion);
        }
        if (action === "ready") {
          current = await updateRoom(current, "ready", {
            ready: changed || !current.seats[current.me].ready,
          });
        }
        setDirty(false);
        try {
          sessionStorage.removeItem(draftKey);
        } catch {}
        if (current.matchId) go("matches/" + current.matchId);
        else {
          await reload();
          setMsg(action === "apply" ? "已应用到本局" : "");
        }
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
  const stale =
    room && (version !== room.deckVersion || settings !== room.settingsVersion);
  const changed = needsApply(deck, room);
  const caption = room
    ? room.kind === "ai"
      ? "开始游戏"
      : room.seats[room.me].ready && !changed
        ? "取消准备"
        : "准备"
    : "保存预设";
  const presets = (
    <div className="prep-presets">
      <Choice
        label="个人预设"
        value={preset}
        items={[
          { id: "", name: room ? "本局卡组" : "默认卡组" },
          ...presetsForMenu,
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
      <div className="footer-actions">
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
          <button disabled={busy || !!stale} onClick={() => submit("apply")}>
            应用到本局
          </button>
        )}
      </div>
      {!room && (
        <a href={collection ? "/play/decks" : "/play/decks/collection"}>
          {collection ? "查看实战卡组" : "管理全部收藏预设"}
        </a>
      )}
      {msg && <p role="status">{msg}</p>}
    </div>
  );
  return (
    <>
      {confirmation}
      <Preparation
        catalog={c}
        collection={collection}
        deck={deck}
        change={change}
        room={room}
        busy={busy}
        management={management}
        presets={presets}
        caption={caption}
        readyDisabled={Boolean(
          room &&
          (!online ||
            stale ||
            room.seats.length !== 2 ||
            room.seats.some((seat) => !seat.online)),
        )}
        submit={() => submit(room ? "ready" : "save")}
        footerMessage={msg}
        back="/play/"
        notice={
          stale && (
            <div className="notice">
              房间配置已更新。
              <button onClick={() => choosePreset("")}>重新载入本局配置</button>
            </div>
          )
        }
      />
    </>
  );
}
