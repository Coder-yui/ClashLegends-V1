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
export interface Preferences {
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
function read(): Preferences {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "null");
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
      master: volume(v.master, defaults.master),
      effects: volume(v.effects, defaults.effects),
      background: volume(v.background, defaults.background),
      bindings: valid && !legacyDefault ? v.bindings : defaultBindings,
    };
  } catch {
    return defaults;
  }
}
let current = read();
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
  try {
    localStorage.setItem(key, JSON.stringify({ ...current, bindingVersion }));
  } catch {
    /* Remains available for this visit. */
  }
  listeners.forEach((fn) => fn());
}
window.addEventListener("storage", (e) => {
  if (e.key === key || e.key === null) {
    current = read();
    listeners.forEach((fn) => fn());
  }
});
export function boundAction(code: string) {
  return actions.find(([id]) => current.bindings[id] === code)?.[0];
}
