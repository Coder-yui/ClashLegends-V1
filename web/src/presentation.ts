// The first snapshot on each connection is the baseline for one-shot effects.
export const BATTLE_PROTOCOL = 3;
export type Point = { x: number; y: number };
export interface BattleSound {
  kind: string;
  team: number;
  owner: number;
  phase: string;
  form?: boolean;
  cycle?: number;
  segment?: number;
  empowered?: boolean;
  buff?: boolean;
  immune?: boolean;
  first?: boolean;
  deploy?: boolean;
  timed?: boolean;
  released?: boolean;
  group?: number;
  release?: number;
  position: Point;
  key: number;
}
export interface BattleEvent {
  sounds?: BattleSound[];
  seq: number;
  tick: number;
  fact: { kind: string; data: unknown };
}
export interface EventWindow {
  baseline?: boolean;
  after: number;
  cursor: number;
  events: BattleEvent[];
}
export class BattleEvents {
  private cursor?: number;
  reset = false;
  read(window: EventWindow) {
    const previous = this.cursor;
    this.cursor = window.cursor;
    this.reset = false;
    if (
      window.baseline ||
      previous === undefined ||
      previous < window.after ||
      previous > window.cursor
    ) {
      this.reset = true;
      return [];
    }
    return window.events.filter((e) => e.seq > previous);
  }
}
