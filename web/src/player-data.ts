import {
  api,
  defaultDeck,
  type Catalog,
  type Deck,
  type PlayerFields,
  type Session,
  type SlotKey,
} from "./api";

export const guestKey = "clashlegends.guest.v1";
export const slotKeys: SlotKey[] = ["slot0", "slot1", "slot2", "slot3"];
export const blankDeck = (): Deck => ({ cards: Array(8).fill(""), skills: {} });
export const defaultName = (n: number) => "卡组 " + (n + 1);
export function fieldsFor(s: Session): PlayerFields {
  if (s.role) return s.fields ?? {};
  try {
    const raw = localStorage.getItem(guestKey);
    if (raw) {
      const fields = JSON.parse(raw);
      if (fields && typeof fields === "object" && !Array.isArray(fields))
        return fields;
    }
  } catch {
    /* A restricted browser can still enter the lobby. */
  }
  // The previous release kept guest presets on the server. Import into this browser once.
  const fields: PlayerFields = {};
  s.presets.slice(0, 4).forEach((p, i) => {
    fields[slotKeys[i]] = {
      name: [...p.name].slice(0, 8).join(""),
      deck: p.deck,
    };
  });
  if (s.presets.length) {
    try {
      localStorage.setItem(guestKey, JSON.stringify(fields));
    } catch {}
  }
  return fields;
}
export function slotFor(s: Session, c: Catalog, n: number) {
  const saved = s.fields?.[slotKeys[n]];
  if (!saved || !Array.isArray(saved.deck?.cards))
    return {
      name: defaultName(n),
      deck: n === 0 ? defaultDeck(c) : blankDeck(),
    };
  // Resolve older collection cards and skill choices against the current editor's catalog.
  const deck = blankDeck();
  saved.deck.cards.slice(0, 8).forEach((id, i) => {
    const card = c.cards.find((card) => card.id === id);
    if (!card || deck.cards.includes(id)) return;
    deck.cards[i] = id;
    const selected = saved.deck.skills?.[id];
    const skill =
      card.skills.find((skill) => skill.id === selected) ?? card.skills[0];
    if (skill) deck.skills[id] = skill.id;
  });
  return { name: saved.name, deck };
}
function selectionKey(s: Session) {
  return (
    "clashlegends.selected-deck:" + (s.role ? "account/" + s.name : "guest")
  );
}
export function selectSlot(s: Session, n: number) {
  try {
    sessionStorage.setItem(selectionKey(s), String(n));
  } catch {}
}
export function activeSlot(s: Session) {
  try {
    const selected = sessionStorage.getItem(selectionKey(s));
    if (selected !== null && /^[0-3]$/.test(selected)) return Number(selected);
  } catch {}
  const n = s.fields?.active ?? 0;
  return slotKeys[n] ? n : 0;
}
export async function saveField<K extends SlotKey | "profile">(
  s: Session,
  key: K,
  value: NonNullable<PlayerFields[K]>,
  before: PlayerFields[K] | null = s.fields?.[key],
) {
  if (s.role) {
    await api("account/data", {
      owner: s.name,
      field: key,
      value,
      before: before ?? null,
    });
  } else {
    const write = () => {
      const fields = fieldsFor(s);
      if (
        JSON.stringify(fields[key] ?? null) !==
          JSON.stringify(before ?? null) &&
        JSON.stringify(fields[key]) !== JSON.stringify(value)
      )
        throw new Error("这项记录已在其他页面更改，请重新载入后保存");
      Object.assign(fields, { [key]: value });
      const n = slotKeys.indexOf(key as SlotKey);
      if (n >= 0) fields.active = n;
      localStorage.setItem(guestKey, JSON.stringify(fields));
    };
    if (navigator.locks) await navigator.locks.request(guestKey, write);
    else write();
  }
}
export function roomLoadout(s: Session, c: Catalog) {
  const deck = slotFor(s, c, activeSlot(s)).deck;
  return deck.cards.every(Boolean) ? deck : undefined;
}

const bookmarkPrefix = "clashlegends.guest-replay:";
export function bookmarkReplay(id: string) {
  const key = bookmarkPrefix + id;
  if (!localStorage.getItem(key))
    localStorage.setItem(key, String(Math.floor(Date.now() / 1000)));
}
export function replayBookmarks() {
  return Object.fromEntries(
    Object.keys(localStorage)
      .filter((k) => k.startsWith(bookmarkPrefix))
      .map((k) => [
        k.slice(bookmarkPrefix.length),
        Number(localStorage.getItem(k)),
      ]),
  );
}
