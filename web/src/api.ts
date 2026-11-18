import { navigate } from "./navigation";
export interface Skill {
  id: string;
  name: string;
  description: string;
}
export interface Card {
  id: string;
  name: string;
  type: string;
  cost: number;
  costLabel?: string;
  image: string;
  description: string;
  skills: Skill[];
}
export interface Catalog {
  cards: Card[];
  version: string;
  defaultDeck: string[];
  modes: { id: string; name: string; mapIds: string[] }[];
  maps: { id: string; name: string; image: string }[];
}
export interface Deck {
  cards: string[];
  skills: Record<string, string>;
}
export interface Preset {
  id: string;
  name: string;
  revision: number;
  deck: Deck;
}
export interface Session {
  name: string;
  roomId: string | null;
  presets: Preset[];
}
export interface Room {
  id: string;
  code: string;
  kind: "ai" | "friend";
  mode: string;
  map: string;
  round: number;
  revision: number;
  settingsVersion: number;
  status: string;
  matchId: string | null;
  seats: { name: string; ready: boolean; online: boolean; ai: boolean }[];
  me: number;
  deck: Deck;
  deckVersion: number;
}
export interface Match {
  id: string;
  roomId: string;
  mode: string;
  map: string;
  round: number;
  me: number;
  opponent: string;
  deck: Deck;
  status: string;
}
export async function api<T>(
  path: string,
  body?: unknown,
  method?: string,
): Promise<T> {
  const res = await fetch("/api/" + path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "访问失败，请重试");
  return data as T;
}
export function updateRoom(r: Room, action: string, extra: object = {}) {
  return api<Room>("rooms/" + r.id, {
    action,
    round: r.round,
    settingsVersion: r.settingsVersion,
    deckVersion: r.deckVersion,
    ...extra,
  });
}
export const href = (path = "") => "/play/" + path;
export function go(path = "") {
  navigate(href(path));
}
export function defaultDeck(c: Catalog): Deck {
  const skills: Record<string, string> = {};
  for (const id of c.defaultDeck) {
    const skill = c.cards.find((x) => x.id === id)?.skills[0];
    if (skill) skills[id] = skill.id;
  }
  return { cards: [...c.defaultDeck], skills };
}
