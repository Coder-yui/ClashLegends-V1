import { navigate } from "./navigation";
export interface Skill {
  cost?: number;
  image?: string;
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
  homeDeployment?: boolean;
  skillCost?: number;
  image: string;
  description: string;
  skills: Skill[];
}
export interface Catalog {
  workbench?: boolean;
  cards: Card[];
  version: string;
  defaultDeck: string[];
  modes: { id: string; name: string; mapIds: string[] }[];
  maps: { id: string; name: string; image: string; terrain?: string | null }[];
}
export interface Deck {
  cards: string[];
  skills: Record<string, string>;
}
export interface Preset {
  battleDeck: Deck | null;
  id: string;
  name: string;
  revision: number;
  deck: Deck;
}
export interface Slot {
  name: string;
  deck: Deck;
}
export interface Profile {
  avatar: string;
  bio: string;
}
export type SlotKey = "slot0" | "slot1" | "slot2" | "slot3";
export type PlayerFields = Partial<Record<SlotKey, Slot>> & {
  active?: number;
  profile?: Profile;
  preferences?: import("./preferences").Preferences;
};
export interface Session {
  accountsEnabled: boolean;
  role: "admin" | "beta" | null;
  fields: PlayerFields | null;
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
  capacity: number;
  seats: {
    slot: number;
    name: string;
    ready: boolean;
    online: boolean;
    ai: boolean;
  }[];
  me: number;
  deck: Deck;
  deckVersion: number;
}
export interface Result {
  winner: number | null;
  reason: "Nexus" | "Towers" | "Draw";
  tick: number;
}
export interface Match {
  assetVersion?: string;
  modelResources?: string[];
  result: Result | null;
  playable: boolean;
  id: string;
  roomId: string;
  mode: string;
  map: string;
  round: number;
  /** Viewing team (blue 0, red 1), also used by recordings and camera. */
  me: number;
  seat: number;
  teammate?: string | null;
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
