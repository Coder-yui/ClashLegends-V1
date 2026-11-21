import { useEffect, useState, type ReactNode } from "react";
import { Choice, useConfirmation } from "./controls";
import { internalLink, navigate } from "./navigation";
import { Preparation } from "./preparation";
import {
  go,
  updateRoom,
  type Catalog,
  type Room,
  type Session,
  type Slot,
} from "./api";
import {
  activeSlot,
  defaultName,
  saveField,
  selectSlot,
  slotFor,
  slotKeys,
} from "./player-data";

interface Draft extends Slot {
  before: Slot | null;
}
interface TabState {
  roomView?: boolean;
  index: number;
  edits: Record<number, Draft>;
  version?: number;
  settings?: number;
}
function readTab(key: string): TabState | null {
  try {
    const tab = JSON.parse(sessionStorage.getItem(key) ?? "null");
    if (
      tab &&
      slotKeys[tab.index] &&
      tab.edits &&
      Object.values(tab.edits).every((v) => {
        const d = v as Draft;
        return (
          typeof d?.name === "string" &&
          d.deck?.cards?.length === 8 &&
          d.deck.skills
        );
      })
    )
      return tab;
  } catch {}
  return null;
}

export function Editor({
  catalog,
  session,
  room,
  reload,
  reloadFields,
  collection = false,
  online = true,
  management,
}: {
  catalog: Catalog;
  session: Session;
  room?: Room;
  reload: () => Promise<void>;
  reloadFields: () => Promise<void>;
  collection?: boolean;
  online?: boolean;
  management?: ReactNode;
}) {
  const { ask, confirmation } = useConfirmation();
  const tabKey = [
    "clashlegends.deck-editor.v2",
    session.role ? session.name : "guest",
    catalog.version,
    room?.id ?? "decks",
    room?.round ?? 0,
  ].join(":");
  const [tab, setTab] = useState<TabState>(() => {
    const previous = readTab(tabKey);
    if (previous && (room || Object.keys(previous.edits).length))
      return previous;
    return {
      index: activeSlot(session),
      edits: {},
      version: room?.deckVersion,
      settings: room?.settingsVersion,
    };
  });
  const [msg, setMsg] = useState(""),
    [busy, setBusy] = useState(false);
  const { index, edits } = tab;
  const key = slotKeys[index];
  const saved = slotFor(session, catalog, index);
  const initialRoomSlot =
    room &&
    tab.roomView !== false &&
    index === activeSlot(session) &&
    (room.round > 1 || room.deckVersion > 1 || saved.deck.cards.every(Boolean));
  const current = edits[index] ?? {
    ...saved,
    deck: initialRoomSlot ? room.deck : saved.deck,
    before: session.fields?.[key] ?? null,
  };
  const dirty = Object.keys(edits).length > 0;
  const modifiedElsewhere =
    !!edits[index] &&
    JSON.stringify(edits[index].before) !==
      JSON.stringify(session.fields?.[key] ?? null);
  const stale =
    !!room &&
    (tab.version !== room.deckVersion || tab.settings !== room.settingsVersion);
  const changed =
    room &&
    current.deck.cards.some(
      (id, i) =>
        id !== room.deck.cards[i] ||
        current.deck.skills[id] !== room.deck.skills[id],
    );

  useEffect(() => {
    if (!room || dirty || !stale) return;
    setTab((t) => ({
      ...t,
      version: room.deckVersion,
      settings: room.settingsVersion,
    }));
  }, [dirty, stale, room]);
  useEffect(() => {
    try {
      sessionStorage.setItem(tabKey, JSON.stringify(tab));
    } catch {}
  }, [tabKey, tab]);
  useEffect(() => {
    if (!dirty) return;
    const guard = async (e: MouseEvent) => {
      const link = internalLink(e);
      if (!link || link.href === location.href) return;
      e.preventDefault();
      if (
        await ask(
          "离开备战编辑器",
          "离开后将放弃尚未保存的卡组修改。",
          "放弃并离开",
        )
      ) {
        sessionStorage.removeItem(tabKey);
        navigate(link.href);
      }
    };
    document.addEventListener("click", guard, true);
    return () => document.removeEventListener("click", guard, true);
  }, [dirty, tabKey, ask]);
  function edit(patch: Partial<Slot>) {
    if (busy) return;
    setTab((t) => ({
      ...t,
      edits: { ...t.edits, [index]: { ...current, ...patch } },
    }));
    setMsg("");
  }
  function switchSlot(i: number) {
    selectSlot(session, i);
    setTab((t) => ({ ...t, index: i, roomView: false }));
    setMsg("");
  }
  async function submit(action: "ready" | "apply" | "save") {
    if (busy) return;
    setBusy(true);
    setMsg("");
    try {
      if (action === "save") {
        const value = {
          name: current.name.trim() || defaultName(index),
          deck: current.deck,
        };
        await saveField(session, key, value, current.before);
        selectSlot(session, index);
        await reloadFields();
        setTab((t) => {
          const edits = { ...t.edits };
          delete edits[index];
          return { ...t, edits, roomView: false };
        });
        setMsg("个人预设已保存");
      } else if (room) {
        if (current.deck.cards.some((id) => !id))
          throw new Error("请先填满八个卡位");
        let r = {
          ...room,
          deckVersion: tab.version!,
          settingsVersion: tab.settings!,
        };
        if (changed) r = await updateRoom(r, "deck", { deck: current.deck });
        if (action === "ready")
          r = await updateRoom(r, "ready", {
            ready: changed || !r.seats[r.me].ready,
          });
        setTab((t) => ({
          ...t,
          version: r.deckVersion,
          settings: r.settingsVersion,
        }));
        if (r.matchId) go("matches/" + r.matchId);
        else {
          await reload();
          setMsg(action === "apply" ? "已应用到本局" : "");
        }
      }
    } catch (e) {
      setMsg((e as Error).message);
      await (action === "save" ? reloadFields() : reload()).catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {confirmation}
      <Preparation
        catalog={catalog}
        collection={collection}
        room={room}
        management={management}
        deck={current.deck}
        change={(deck) => edit({ deck })}
        busy={busy}
        index={index}
        switchSlot={switchSlot}
        name={current.name}
        rename={(name) => edit({ name })}
        save={() => submit("save")}
        apply={() => submit("apply")}
        legacy={
          collection &&
          session.presets.length > 0 && (
            <Choice
              label="载入旧版预设"
              value=""
              items={[{ id: "", name: "选择旧版预设" }, ...session.presets]}
              onChange={(id) => {
                const p = session.presets.find((p) => p.id === id);
                if (p)
                  edit({
                    name: [...p.name].slice(0, 8).join(""),
                    deck: p.deck,
                  });
              }}
            />
          )
        }
        readyDisabled={
          !!room &&
          (!online ||
            stale ||
            room.seats.length !== 2 ||
            room.seats.some((s) => !s.online))
        }
        caption={
          room
            ? room.kind === "ai"
              ? "开始游戏"
              : room.seats[room.me].ready && !changed
                ? "取消准备"
                : "准备"
            : "保存预设"
        }
        submit={() => submit(room ? "ready" : "save")}
        footerMessage={msg}
        back="/play/"
        notice={
          modifiedElsewhere ? (
            <div className="notice">
              这套卡组已有新的保存记录。
              <button
                onClick={() => {
                  setTab((t) => {
                    const edits = { ...t.edits };
                    delete edits[index];
                    return { ...t, edits, roomView: false };
                  });
                  setMsg("");
                }}
              >
                载入已保存的卡组
              </button>
            </div>
          ) : (
            stale && (
              <div className="notice">
                房间配置已更新。
                <button
                  onClick={() => {
                    setTab((t) => ({
                      ...t,
                      version: room!.deckVersion,
                      settings: room!.settingsVersion,
                      edits: {
                        ...t.edits,
                        [index]: { ...current, deck: room!.deck },
                      },
                    }));
                  }}
                >
                  重新载入本局配置
                </button>
              </div>
            )
          )
        }
      />
    </>
  );
}
