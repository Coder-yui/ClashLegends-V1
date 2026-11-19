// The first snapshot on each connection is the baseline for one-shot effects.
export type Point = { x: number; y: number };
export interface BattleEvent {
  seq: number;
  tick: number;
  fact: { kind: string; data: unknown };
}
export interface EventWindow {
  after: number;
  cursor: number;
  events: BattleEvent[];
}
export class BattleEvents {
  private cursor?: number;
  baseline = 0;
  read(window: EventWindow) {
    const previous = this.cursor;
    this.cursor = window.cursor;
    if (
      previous === undefined ||
      previous < window.after ||
      previous > window.cursor
    ) {
      this.baseline = window.cursor;
      return [];
    }
    return window.events.filter((e) => e.seq > previous);
  }
}
