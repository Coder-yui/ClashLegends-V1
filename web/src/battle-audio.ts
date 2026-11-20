import { getMixer } from "./audio";
import {
  audioCatalog,
  clipSlice,
  profileForSound,
  profileBanks,
  soundEvents,
  type Selection,
  type ClipEvent,
} from "./reference-audio";
import type { Frame } from "./battle-field";
import { preferences } from "./preferences";
import type { BattleEvent, BattleSound } from "./presentation";

interface Voice {
  source: AudioBufferSourceNode;
  gain: GainNode;
  sound: BattleSound;
  priority: number;
  slot: number;
  ended: boolean;
  owned: boolean;
  pan: StereoPannerNode;
}
interface Pending {
  selection: Selection;
  deadline: number;
  seq: number;
  tick: number;
  sound: BattleSound;
}
export type SoundTrace = {
  action:
    | "play"
    | "cancel"
    | "baseline"
    | "drop"
    | "layerStart"
    | "layerEnd"
    | "terminal";
  audioTime?: number;
  offset?: number;
  seq: number;
  tick: number;
  shown: number;
  sound?: BattleSound;
  pan?: number;
  reason?: string;
  cue?: string;
};

function unitOwns(name: string, spec: ClipEvent) {
  if (spec.owner) return spec.owner === "unit";
  if (name === "death" || name === "death:voice" || name.startsWith("spell:"))
    return false;
  const [family, phase] = name.split(":");
  if (
    [
      "active_buff",
      "control_immunity",
      "empowered_buff",
      "revival",
      "rebirth",
      "sanctuary",
      "blood_rage",
    ].includes(family)
  )
    return false;
  return (
    ["start", "voice", "sustain", "release", "end"].includes(phase) ||
    [
      "empowered_swing",
      "attack_swing",
      "active:cast",
      "active:spin",
      "charge:step",
      "first_strike:cast",
    ].includes(name) ||
    name.endsWith(":attack_swing")
  );
}

// Fetch/decode may fill the cache, but only the
// presentation clock can start a voice, including after reconnect or suspension.
export class BattleAudio {
  private mixer?: ReturnType<typeof getMixer>;
  private buffers = new Map<number, AudioBuffer>();
  private loading = new Set<number>();
  private wantedBanks = new Set<number>();
  private decodedBytes = 0;
  private retryAfter = new Map<number, number>();
  private voices = new Set<Voice>();
  private layers = new Map<string, { voice: Voice; spec: ClipEvent }>();
  private tails = new Set<Voice>();
  private heardLive = false;
  private terminal?: {
    destroyed: BattleSound[];
    due: number;
    announcement?: BattleSound;
    explosions: Voice[];
    done: boolean;
  };
  private playedGroups = new Map<string, number>();
  private pending: Pending[] = [];
  private cursor = 0;
  private enabled = false;
  private rate = 1;
  private disposed = false;
  private abort = new AbortController();

  constructor(
    private me: number,
    private trace?: (event: SoundTrace) => void,
  ) {
    try {
      this.mixer = getMixer();
      for (const team of [0, 1])
        for (const kind of [
          "melee_minion",
          "ranged_minion",
          "siege_minion",
          "princess_tower",
          "nexus",
          "match",
        ])
          this.warm(kind, team);
    } catch {
      // The match clock and renderer also run on devices without Web Audio.
    }
  }
  private load(key: number) {
    if (
      !this.mixer ||
      this.disposed ||
      this.buffers.has(key) ||
      this.loading.has(key) ||
      performance.now() < (this.retryAfter.get(key) ?? 0)
    )
      return;
    const { context } = this.mixer;
    this.loading.add(key);
    void fetch("/play/media/audio/" + audioCatalog.files[key], {
      signal: this.abort.signal,
    })
      .then((r) => {
        if (!r.ok) throw new Error("Audio bank " + r.status);
        return r.arrayBuffer();
      })
      .then((bytes) => context.decodeAudioData(bytes))
      .then((buffer) => {
        if (!this.disposed) {
          this.buffers.set(key, buffer);
          this.decodedBytes += buffer.length * buffer.numberOfChannels * 4;
          this.trim();
        }
      })
      .catch(() => {
        this.retryAfter.set(key, performance.now() + 5000);
      })
      .finally(() => this.loading.delete(key));
  }
  private trim() {
    if (this.decodedBytes <= 96 * 1024 * 1024) return;
    for (const [key, buffer] of this.buffers) {
      if (this.wantedBanks.has(key)) continue;
      this.buffers.delete(key);
      this.decodedBytes -= buffer.length * buffer.numberOfChannels * 4;
      if (this.decodedBytes <= 96 * 1024 * 1024) break;
    }
  }
  private warm(kind: string, team: number, form = false) {
    for (const key of profileBanks(profileForSound(kind, team, form))) {
      this.wantedBanks.add(key);
      this.load(key);
    }
  }
  prepare(frame: Frame, deck?: readonly string[]) {
    this.wantedBanks.clear();
    for (const e of frame.cues ?? []) {
      if (e.seq > this.cursor)
        for (const s of e.sounds ?? []) this.warm(s.kind, s.team, s.form);
    }
    this.warm("match", 0);
    for (const id of deck ?? frame.hand) this.warm(id, this.me);
    for (const u of frame.units)
      this.warm(u.audioKind ?? u.kind, u.team, u.alternateForm);
    for (const l of frame.soundLayers ?? []) this.warm(l.kind, l.team, l.form);
    for (const spell of frame.spells) this.warm(spell.key, spell.team);
    for (const shot of frame.shots)
      this.warm(shot.sourceKind, shot.team, shot.form);
    this.trim();
  }
  private stop(voice: Voice, fade = 0.01, curve = "linear") {
    this.voices.delete(voice);
    if (voice.ended) return;
    const { context } = voice.source;
    if (context.state !== "running") {
      voice.source.disconnect();
      voice.source.stop();
      return;
    }
    const now = context.currentTime;
    const gain = voice.gain.gain;
    const initial = gain.value;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(initial, now);
    if (curve === "exp1") {
      // The original Wwise Exp1 fade uses (t + 1) * t / 2 in linear amplitude.
      for (let i = 1; i <= 16; i++) {
        const t = i / 16;
        gain.linearRampToValueAtTime(
          initial * (1 - ((t + 1) * t) / 2),
          now + fade * t,
        );
      }
    } else gain.linearRampToValueAtTime(0, now + fade);
    voice.source.stop(now + fade);
  }
  reset(cursor: number) {
    this.cursor = cursor;
    this.playedGroups.clear();
    this.heardLive = false;
    this.terminal = undefined;
    this.pending = [];
    for (const { voice } of this.layers.values()) this.stop(voice);
    this.layers.clear();
    for (const voice of this.tails) this.stop(voice);
    this.tails.clear();
    for (const voice of this.voices) this.stop(voice);
  }
  private cancel(event: BattleEvent, shown: number) {
    const { kind, data } = event.fact;
    let matches: (s: BattleSound, owned: boolean) => boolean;
    if (kind === "attackCancelled") {
      const { id, start } = data as { id: number; start: number };
      matches = (s) =>
        s.owner === id &&
        s.key === start &&
        (s.phase === "windup" || s.phase === "windup2");
    } else if (kind === "died") {
      matches = (s, owned) => s.owner === data && owned;
    } else if (
      kind === "controlled" &&
      Array.isArray(data) &&
      ["Freeze", "Stasis"].includes(data[1])
    ) {
      matches = (s, owned) => s.owner === data[0] && owned;
    } else return;
    this.pending = this.pending.filter(
      (item) =>
        !matches(
          item.sound,
          unitOwns(item.selection.name, item.selection.spec),
        ),
    );
    for (const voice of this.voices)
      if (matches(voice.sound, voice.owned)) this.stop(voice);
    if (kind === "attackCancelled")
      this.trace?.({
        action: "cancel",
        seq: event.seq,
        tick: event.tick,
        shown,
      });
  }
  render(
    frame: Frame,
    shown: number,
    rate: number,
    live: boolean,
    latestCursor: number,
  ) {
    const enabled =
      live &&
      !document.hidden &&
      rate > 0 &&
      this.mixer?.context.state === "running" &&
      preferences().master > 0 &&
      preferences().effects > 0;
    if (!enabled || !this.enabled) {
      this.reset(latestCursor);
      if (enabled)
        this.trace?.({
          action: "baseline",
          seq: this.cursor,
          tick: frame.tick,
          shown,
        });
      this.enabled = !!enabled;
      return;
    }
    if (frame.result) {
      this.finish(frame, shown);
      return;
    }
    this.heardLive = true;
    if (this.rate !== rate) {
      this.rate = rate;
      for (const voice of this.voices) voice.source.playbackRate.value = rate;
    }
    this.updateLayers(frame, shown, rate);
    const now = performance.now();
    for (const e of frame.cues ?? []) {
      if (e.seq <= this.cursor) continue;
      if (e.tick > shown) break;
      this.cursor = e.seq;
      this.cancel(e, shown);
      for (const sound of e.sounds ?? []) {
        const profile = profileForSound(sound.kind, sound.team, sound.form);
        const lead =
          sound.phase === "windup" ? profile.attack_swing_lead_time : undefined;
        const due =
          lead === undefined || sound.release === undefined
            ? e.tick
            : Math.max(e.tick, sound.release - lead * 20);
        for (const selection of soundEvents(sound)) {
          const grouped = profile.attack_hit_once_by_segment;
          const group =
            selection.spec.scope === "deployment_group"
              ? ["deploy", sound.kind, sound.team, sound.group ?? sound.owner]
              : sound.phase === "hit" &&
                  grouped?.length &&
                  grouped[((sound.cycle ?? 1) - 1) % grouped.length]
                ? ["hit", sound.owner, sound.form, sound.cycle]
                : null;
          if (group) {
            const id = group.join("/");
            if (this.playedGroups.has(id)) continue;
            this.playedGroups.set(id, e.tick);
          }
          this.pending.push({
            selection,
            seq: e.seq,
            tick: due,
            sound,
            deadline: Infinity,
          });
        }
      }
    }
    for (const [id, tick] of this.playedGroups)
      if (tick + 200 < shown) this.playedGroups.delete(id);
    this.pending = this.pending.filter((item) => {
      if (item.tick > shown) return true;
      if (item.deadline === Infinity) item.deadline = now + 50;
      if ((shown - item.tick) / rate > 1 || now > item.deadline) {
        this.trace?.({ action: "drop", ...item, shown, reason: "late" });
        return false;
      }
      return !this.play(item, frame.map.width, shown, rate);
    });
  }
  // False means a bank is still loading. Revisit at most one display tick later.
  private play(item: Pending, width: number, shown: number, rate: number) {
    const { sound } = item;
    const { spec } = item.selection;
    const clip = this.clip(sound, spec);
    if (!clip) return false;
    const name = item.selection.name;
    const priority =
      spec.bus === "Voice" || name === "death"
        ? 3
        : name.includes(":") && !name.startsWith("first_strike:")
          ? 2
          : name.includes("hit") || name.startsWith("empowered")
            ? 1
            : 0;
    const limit = priority >= 2 ? 24 : 20;
    const occupied = new Set<number>();
    let victim: Voice | undefined;
    for (const voice of this.voices) {
      if (voice.slot >= limit) continue;
      occupied.add(voice.slot);
      if (!victim || voice.priority < victim.priority) victim = voice;
    }
    let slot = 0;
    while (occupied.has(slot)) slot++;
    if (slot === limit) {
      if (!victim || victim.priority > priority) {
        this.trace?.({ action: "drop", ...item, shown, reason: "capacity" });
        return true;
      }
      slot = victim.slot;
      this.stop(victim);
    }
    const voice = this.voice(sound, clip, width, rate);
    voice.slot = slot;
    voice.priority = priority;
    voice.owned = unitOwns(item.selection.name, spec);
    this.voices.add(voice);
    voice.source.start(0, clip.start, clip.duration);
    this.trace?.({ action: "play", ...item, shown, pan: voice.pan.pan.value });
    return true;
  }
  private clip(sound: BattleSound, spec: ClipEvent) {
    const seed =
      (Math.imul(sound.owner, 2654435761) ^
        Math.imul(sound.key, 2246822519)) >>>
      0;
    const variant = (seed ^ (seed >>> 16)) >>> 0;
    const clip = spec.pool[variant % spec.pool.length];
    const slice = clipSlice(clip, spec);
    const key = slice.bank;
    const buffer = this.buffers.get(key);
    if (!buffer) {
      this.wantedBanks.add(key);
      this.load(key);
      return undefined;
    }
    return { buffer, ...slice };
  }
  private stereo(sound: BattleSound, width: number) {
    return sound.kind === "match"
      ? 0
      : Math.max(-1, Math.min(1, (sound.position.x * 2) / width - 1)) *
          (this.me ? -0.65 : 0.65);
  }
  private voice(
    sound: BattleSound,
    clip: { buffer: AudioBuffer; gain: number },
    width: number,
    rate: number,
  ): Voice {
    const { context, effects } = this.mixer!;
    const source = context.createBufferSource(),
      gain = context.createGain(),
      pan = context.createStereoPanner();
    source.buffer = clip.buffer;
    source.playbackRate.value = rate;
    pan.pan.value = this.stereo(sound, width);
    gain.gain.value = clip.gain;
    source.connect(gain).connect(pan).connect(effects);
    const voice = {
      source,
      gain,
      pan,
      sound,
      ended: false,
      owned: false,
      priority: 0,
      slot: -1,
    };
    source.onended = () => {
      voice.ended = true;
      this.voices.delete(voice);
      this.tails.delete(voice);
      source.disconnect();
      gain.disconnect();
      pan.disconnect();
    };
    return voice;
  }
  private updateLayers(frame: Frame, shown: number, rate: number) {
    const requested = [...(frame.soundLayers ?? [])];
    for (const shot of frame.shots) {
      if (
        !shot.volley &&
        profileForSound(shot.sourceKind, shot.team, shot.form)
          .attack_launch_until_impact
      )
        requested.push({
          kind: shot.sourceKind,
          form: shot.form,
          cycle: shot.cycle,
          team: shot.team,
          owner: shot.id,
          phase: "projectileFlight",
          position: shot.position,
          key: shot.born,
          loop: false,
        });
    }
    for (const area of frame.areas) {
      if (!area.audio) continue;
      const [origin, phase, start] = area.audio;
      requested.push({
        kind: origin.kind,
        team: origin.team === "Blue" ? 0 : 1,
        form: origin.form,
        owner: area.id,
        phase,
        position: area.position,
        key: start,
        loop: true,
      });
    }
    for (const spell of frame.spells) {
      const flight = shown < spell.impact;
      if (!flight && shown >= spell.end) continue;
      const phase = flight ? "spell:flight" : "spell:zone_sustain";
      // Tower disable hum belongs to each affected tower.
      if (spell.key === "medium_lightning") continue;
      const progress = flight
        ? Math.max(
            0,
            Math.min(
              1,
              (shown - spell.born) / Math.max(1, spell.impact - spell.born),
            ),
          )
        : 1;
      const pos = flight
        ? {
            x: spell.origin.x + (spell.position.x - spell.origin.x) * progress,
            y: spell.origin.y + (spell.position.y - spell.origin.y) * progress,
          }
        : spell.position;
      requested.push({
        kind: spell.key,
        team: spell.team,
        owner: spell.id,
        phase,
        position: pos,
        key: flight ? spell.born : spell.impact,
        loop: true,
      });
    }
    const wanted = new Set<string>();
    for (const sound of requested) {
      const selection = soundEvents(sound)[0];
      if (!selection) continue;
      const spec = selection.spec;
      const id = [
        sound.owner,
        sound.kind,
        Number(!!sound.form),
        sound.phase,
        sound.key,
      ].join("/");
      wanted.add(id);
      const current = this.layers.get(id);
      if (current) {
        current.voice.pan.pan.value = this.stereo(sound, frame.map.width);
        current.voice.source.playbackRate.value = rate;
        continue;
      }
      if (this.layers.size >= 24) continue;
      const clip = this.clip(sound, spec);
      if (!clip) continue;
      const elapsed = Math.max(0, (shown - sound.key) / 20);
      const loop = sound.loop && !spec.natural_tail;
      if (!loop && elapsed >= clip.duration) continue;
      const offset = loop ? elapsed % clip.duration : elapsed;
      const voice = this.voice(sound, clip, frame.map.width, rate);
      this.layers.set(id, { voice, spec });
      if (spec.fade_in && elapsed < spec.fade_in) {
        const now = voice.source.context.currentTime;
        voice.gain.gain.setValueAtTime(
          (clip.gain * elapsed) / spec.fade_in,
          now,
        );
        voice.gain.gain.linearRampToValueAtTime(
          clip.gain,
          now + (spec.fade_in - elapsed) / rate,
        );
      }
      if (loop) {
        voice.source.loopStart = clip.start;
        voice.source.loopEnd = clip.start + clip.duration;
        voice.source.loop = true;
        voice.source.start(0, clip.start + offset);
      } else voice.source.start(0, clip.start + offset, clip.duration - offset);
      this.trace?.({
        action: "layerStart",
        cue: selection.name,
        seq: this.cursor,
        tick: sound.key,
        shown,
        sound,
        offset,
      });
    }
    for (const [id, { voice, spec }] of this.layers)
      if (!wanted.has(id)) {
        this.layers.delete(id);
        if (!voice.ended) this.tails.add(voice);
        if (!spec.natural_tail)
          this.stop(
            voice,
            Math.max(0.01, (spec.fade_out ?? 0) / rate),
            spec.fade_out_curve,
          );
        this.trace?.({
          action: "layerEnd",
          seq: this.cursor,
          tick: frame.tick,
          shown,
          sound: voice.sound,
        });
      }
  }
  private finish(frame: Frame, shown: number) {
    const now = this.mixer!.context.currentTime;
    if (!this.terminal) {
      if (!this.heardLive) return;
      const destroyed = (frame.cues ?? [])
        .filter((e) => e.seq > this.cursor && e.tick <= shown)
        .flatMap((e) => e.sounds ?? [])
        .filter((s) => s.kind === "nexus" && s.phase === "death");
      this.reset(frame.presentation.cursor);
      const winner = frame.result!.winner;
      const announcement =
        winner === null
          ? undefined
          : {
              kind: "match",
              phase: winner === this.me ? "victory" : "defeat",
              key: frame.tick,
              owner: 0,
              team: this.me,
              position: { x: 0, y: 0 },
            };
      this.terminal = {
        destroyed,
        announcement,
        explosions: [],
        due: now,
        done: false,
      };
    }
    const end = this.terminal;
    if (end.done) return;
    const play = (s: BattleSound) => {
      const selection = soundEvents(s)[0];
      if (!selection) return;
      const clip = this.clip(s, selection.spec);
      if (!clip) return;
      const v = this.voice(s, clip, frame.map.width, 1);
      this.tails.add(v);
      v.source.start(0, clip.start, clip.duration);
      this.trace?.({
        action: "terminal",
        cue: selection.name,
        audioTime: now,
        seq: frame.presentation.cursor,
        tick: frame.tick,
        shown,
        sound: s,
      });
      return v;
    };
    end.destroyed = end.destroyed.filter((s) => {
      const voice = play(s);
      if (!voice) return now < end.due + 1 && end.explosions.length === 0;
      end.explosions.push(voice);
      end.due = now + 5;
      return false;
    });
    if (end.destroyed.length || now < end.due) return;
    if (!end.announcement) {
      end.done = true;
      return;
    }
    const voice = play(end.announcement);
    if (!voice && now < end.due + 1) return;
    end.done = true;
    if (voice)
      voice.source.addEventListener(
        "ended",
        () => {
          for (const v of end.explosions) if (!v.ended) this.stop(v, 1);
        },
        { once: true },
      );
  }
  dispose() {
    this.disposed = true;
    this.abort.abort();
    this.reset(0);
    this.buffers.clear();
  }
}
