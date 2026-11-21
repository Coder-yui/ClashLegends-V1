import { api, type Session } from "./api";
import { useSyncExternalStore } from "react";

export const actions = [
  ["hand1", "手牌 1", "KeyQ"],
  ["hand2", "手牌 2", "KeyW"],
  ["hand3", "手牌 3", "KeyE"],
  ["hand4", "手牌 4", "KeyR"],
  ["skill1", "主动槽 1 技能", "KeyD"],
  ["skill2", "主动槽 2 技能", "KeyF"],
] as const;
export type Action = (typeof actions)[number][0];
type Bindings = Record<Action, string>;
export interface RecordingOptions {
  mode: "off" | "replay" | "video" | "both";
  aspect: "9:16" | "16:9" | "1:1";
  resolution: 540 | 720 | 1080;
  fps: 24 | 30 | 60;
  audio: boolean;
  hud: boolean;
}
export interface Preferences {
  recording: RecordingOptions;
  master: number;
  effects: number;
  background: number;
  bindings: Bindings;
}
const key = "clashlegends.preferences.v1";
export const defaultBindings = Object.fromEntries(
  actions.map(([id, , code]) => [id, code]),
) as Bindings;
// Volume changes in the first release also persisted the entire default keymap.
const legacyBindings: Bindings = {
  hand1: "Digit1",
  hand2: "Digit2",
  hand3: "Digit3",
  hand4: "Digit4",
  skill1: "KeyQ",
  skill2: "KeyW",
};
const bindingVersion = 2;
const defaults: Preferences = {
  recording: {
    mode: "replay",
    aspect: "9:16",
    resolution: 720,
    fps: 30,
    audio: true,
    hud: true,
  },
  master: 75,
  effects: 75,
  background: 50,
  bindings: defaultBindings,
};
export function allowedKey(code: string) {
  return /^(Key[A-Z]|Digit[0-9]|Numpad[0-9]|Space|Arrow(Up|Down|Left|Right))$/.test(
    code,
  );
}
export function keyLabel(code: string) {
  return (
    (
      {
        Space: "空格",
        ArrowUp: "↑",
        ArrowDown: "↓",
        ArrowLeft: "←",
        ArrowRight: "→",
      } as Record<string, string>
    )[code] ?? code.replace(/^Key|^Digit/, "").replace("Numpad", "小键盘 ")
  );
}
function normalize(v: any): Preferences {
  try {
    if (!v) return defaults;
    const volume = (x: unknown, f: number) =>
      typeof x === "number" && Number.isFinite(x)
        ? Math.round(Math.max(0, Math.min(100, x)))
        : f;
    const valid =
      actions.every(
        ([id]) =>
          typeof v.bindings?.[id] === "string" && allowedKey(v.bindings[id]),
      ) &&
      new Set(actions.map(([id]) => v.bindings[id])).size === actions.length;
    const legacyDefault =
      v.bindingVersion === undefined &&
      actions.every(([id]) => v.bindings?.[id] === legacyBindings[id]);
    return {
      recording: {
        mode: ["off", "replay", "video", "both"].includes(v.recording?.mode)
          ? v.recording.mode
          : defaults.recording.mode,
        aspect: ["9:16", "16:9", "1:1"].includes(v.recording?.aspect)
          ? v.recording.aspect
          : defaults.recording.aspect,
        resolution: [540, 720, 1080].includes(v.recording?.resolution)
          ? v.recording.resolution
          : defaults.recording.resolution,
        fps: [24, 30, 60].includes(v.recording?.fps)
          ? v.recording.fps
          : defaults.recording.fps,
        audio: v.recording?.audio !== false,
        hud: v.recording?.hud !== false,
      },
      master: volume(v.master, defaults.master),
      effects: volume(v.effects, defaults.effects),
      background: volume(v.background, defaults.background),
      bindings: valid && !legacyDefault ? v.bindings : defaultBindings,
    };
  } catch {
    return defaults;
  }
}
function read(): Preferences {
  try {
    return normalize(JSON.parse(localStorage.getItem(key) ?? "null"));
  } catch {
    return defaults;
  }
}
let current = read();
let owner = "";
export function currentAccount() {
  return owner;
}
let previous: Preferences | null = null;
let pending = false;
let saving: Promise<void> | undefined;
let syncMessage = "";
export function preferenceStatus() {
  return syncMessage;
}
export function configurePreferences(s: Session) {
  const next = s.role ? s.name : "";
  if (next === owner && (!next || pending || saving)) return;
  owner = next;
  pending = false;
  syncMessage = "";
  previous = s.fields?.preferences ?? null;
  current = owner
    ? normalize(previous && { ...previous, bindingVersion })
    : read();
  listeners.forEach((fn) => fn());
}
export async function reloadAccountPreferences() {
  const session = await api<Session>("session");
  if (!saving && session.role && session.name === owner) {
    pending = false;
    configurePreferences(session);
  }
}
export function flushPreferences(): Promise<void> {
  if (saving) return saving;
  if (!pending || !owner) return Promise.resolve();
  saving = (async () => {
    const user = owner;
    try {
      while (pending && user === owner) {
        pending = false;
        const value = current;
        await api("account/data", {
          owner: user,
          field: "preferences",
          before: previous,
          value,
        });
        if (user === owner) previous = value;
      }
      syncMessage = "账号设置已保存";
    } catch (error) {
      if (user === owner) {
        pending = true;
        syncMessage = (error as Error).message;
      }
      throw error;
    } finally {
      saving = undefined;
      listeners.forEach((fn) => fn());
    }
  })();
  return saving;
}
const listeners = new Set<() => void>();
export function preferences() {
  return current;
}
export function subscribePreferences(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
export function usePreferences() {
  return useSyncExternalStore(subscribePreferences, preferences);
}
export function updatePreferences(patch: Partial<Preferences>) {
  current = { ...current, ...patch };
  if (owner) {
    pending = true;
    syncMessage = "正在保存账号设置…";
    void flushPreferences().catch(() => {});
  } else
    try {
      localStorage.setItem(key, JSON.stringify({ ...current, bindingVersion }));
    } catch {
      /* Remains available for this visit. */
    }
  listeners.forEach((fn) => fn());
}
window.addEventListener("storage", (e) => {
  if (!owner && (e.key === key || e.key === null)) {
    current = read();
    listeners.forEach((fn) => fn());
  }
});
export function boundAction(code: string) {
  return actions.find(([id]) => current.bindings[id] === code)?.[0];
}

export function usePreferenceStatus() {
  return useSyncExternalStore(subscribePreferences, preferenceStatus);
}
