import { preferences, subscribePreferences } from "./preferences";
export type Cue = "click" | "select" | "confirm" | "back";
const notes: Record<Cue, number[][]> = {
  click: [[430, 0, 0.055]],
  select: [
    [535, 0, 0.065],
    [730, 0.035, 0.075],
  ],
  confirm: [
    [430, 0, 0.09],
    [650, 0.055, 0.14],
  ],
  back: [
    [420, 0, 0.06],
    [300, 0.038, 0.07],
  ],
};
let mixer:
  | {
      context: AudioContext;
      master: GainNode;
      effects: GainNode;
      background: GainNode;
    }
  | undefined;
function levels() {
  if (!mixer) return;
  const p = preferences();
  for (const channel of ["master", "effects", "background"] as const)
    mixer[channel].gain.setTargetAtTime(
      p[channel] / 100,
      mixer.context.currentTime,
      0.008,
    );
}
subscribePreferences(levels);
function getMixer() {
  if (!mixer) {
    const context = new AudioContext();
    const master = context.createGain(),
      effects = context.createGain(),
      background = context.createGain();
    effects.connect(master);
    background.connect(master);
    master.connect(context.destination);
    mixer = { context, master, effects, background };
    levels();
  }
  return mixer;
}
export async function playCue(cue: Cue) {
  try {
    const { context, effects } = getMixer();
    if (context.state !== "running") await context.resume();
    if (
      !preferences().master ||
      !preferences().effects ||
      context.state !== "running"
    )
      return;
    for (const [pitch, offset, duration] of notes[cue]) {
      const voice = context.createOscillator(),
        amp = context.createGain();
      const start = context.currentTime + offset;
      voice.type = "sine";
      voice.frequency.setValueAtTime(pitch, start);
      amp.gain.setValueAtTime(0, start);
      amp.gain.linearRampToValueAtTime(0.17, start + 0.005);
      amp.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      voice.connect(amp);
      amp.connect(effects);
      voice.start(start);
      voice.stop(start + duration);
      voice.onended = () => {
        voice.disconnect();
        amp.disconnect();
      };
    }
  } catch {
    /* Browsers without an available audio device can still use the lobby. */
  }
}
export function installLobbySounds() {
  document.addEventListener(
    "click",
    (e) => {
      const control =
        e.target instanceof Element
          ? e.target.closest<HTMLElement>("button,a[href],input[type=radio]")
          : null;
      if (!control || control.matches(":disabled,[data-silent]")) return;
      const cue = control.dataset.cue as Cue | undefined;
      void playCue(
        cue ??
          (control.matches(".gold")
            ? "confirm"
            : control.matches("[role=option],.slot,.tile,input[type=radio]")
              ? "select"
              : "click"),
      );
    },
    true,
  );
}
