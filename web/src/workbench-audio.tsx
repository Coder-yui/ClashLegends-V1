import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import { getMixer, playCue, type Cue } from "./audio";
import sources from "./workbench-audio-sources.json";
import {
  audioCatalog,
  clipGainDb,
  clipSlice,
  profileForSound,
  profileSelections,
  type Selection,
  type ClipEvent,
} from "./reference-audio";

type Bank = { bank: number; buffer: AudioBuffer };
type Slice = ReturnType<typeof clipSlice>;
const interfaceCues: Record<Cue, string> = {
  click: "点击",
  select: "选择",
  confirm: "确认",
  back: "返回",
};

const eventColors = [
  "#95d4da",
  "#e8c487",
  "#b3c7fa",
  "#edaeab",
  "#afd6a3",
  "#d5b5e7",
];

function sourceLabel(id: number, spec: ClipEvent) {
  if (sources[id].external) return "外来音效";
  if (sources[id].edit) return "LoL 已加工";
  if (spec.fade_in || spec.fade_out) return "LoL 播放调校";
  const db = clipGainDb(id, spec);
  if (db) return `LoL ${db > 0 ? "+" : ""}${db} dB`;
  return "LoL 原版直用";
}

function SourceDetails({ id, spec }: { id: number; spec: ClipEvent }) {
  const { external, file, edit } = sources[id];
  const db = clipGainDb(id, spec);
  const playback = [`增益 ${db > 0 ? "+" : ""}${db} dB`];
  if (spec.fade_in) playback.push(`进入时淡入 ${spec.fade_in} 秒`);
  if (spec.fade_out && !spec.natural_tail) {
    const curve = spec.fade_out_curve === "exp1" ? "Exp1 曲线" : "线性";
    playback.push(`退出时${curve}淡出 ${spec.fade_out} 秒`);
  }
  return (
    <dl className="wb-source-details" aria-label="当前变体的音频来源与处理">
      <dt>素材来源</dt>
      <dd>
        {external ?? "英雄联盟"} <code>{file}</code>
      </dd>
      <dt>素材加工</dt>
      <dd>{edit ?? "未加工，保留原声"}</dd>
      <dt>对局播放</dt>
      <dd>{playback.join(" · ")}</dd>
    </dl>
  );
}

const ClipCatalog = memo(function ClipCatalog({
  events,
  event,
  variant,
  choose,
}: {
  events: Selection[];
  event: number;
  variant: number;
  choose: (event: number, variant: number) => void;
}) {
  return (
    <div className="wb-clip-catalog" aria-label="事件与音源变体">
      {events.map(({ name, spec }, e) => (
        <section
          key={name}
          style={
            {
              "--event-color": eventColors[e % eventColors.length],
            } as CSSProperties
          }
        >
          <h3>{name}</h3>
          <div>
            {spec.pool.map((id, i) => (
              <button
                key={i}
                data-silent
                aria-label={name + " 变体 " + (i + 1)}
                aria-description={sourceLabel(id, spec)}
                aria-pressed={event === e && variant === i}
                onClick={() => choose(e, i)}
              >
                <span aria-hidden="true">▸</span> {i + 1}{" "}
                <small>{clipSlice(id, spec).duration.toFixed(2)}s</small>
                <small className="wb-source-label">
                  {sourceLabel(id, spec)}
                </small>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
});

function ClipBrowser({
  events,
  cache,
}: {
  events: Selection[];
  cache: RefObject<Bank | null>;
}) {
  const [event, setEvent] = useState(0),
    [variant, setVariant] = useState(0);
  const selected = events[event];
  const id = selected.spec.pool[variant];
  const slice = clipSlice(id, selected.spec);
  const [position, setPosition] = useState(0);
  const [state, setState] = useState<
    "idle" | "loading" | "playing" | "paused" | "error" | "ended"
  >("idle");
  const request = useRef<AbortController | null>(null);
  const voice = useRef<{
    node: AudioBufferSourceNode;
    origin: number;
    duration: number;
  } | null>(null);
  const frame = useRef(0);

  function halt() {
    request.current?.abort();
    request.current = null;
    const active = voice.current;
    voice.current = null;
    active?.node.stop();
    cancelAnimationFrame(frame.current);
  }
  function pause() {
    const active = voice.current;
    if (active)
      setPosition(
        Math.min(
          active.duration,
          active.node.context.currentTime - active.origin,
        ),
      );
    halt();
    setState("paused");
  }
  useEffect(() => {
    function hide() {
      if (document.hidden && (voice.current || request.current)) pause();
    }
    document.addEventListener("visibilitychange", hide);
    return () => {
      document.removeEventListener("visibilitychange", hide);
      halt();
    };
  }, []);

  const play = useCallback(
    async (offset: number, clip: Slice) => {
      halt();
      setPosition(offset);
      if (offset >= clip.duration) {
        setState("ended");
        return;
      }
      const controller = new AbortController();
      request.current = controller;
      setState("loading");
      try {
        const { context, effects } = getMixer();
        if (context.state !== "running") await context.resume();
        let buffer =
          cache.current?.bank === clip.bank ? cache.current.buffer : undefined;
        if (!buffer) {
          const response = await fetch(
            "/play/media/audio/" + audioCatalog.files[clip.bank],
            { signal: controller.signal },
          );
          if (!response.ok) throw Error();
          buffer = await context.decodeAudioData(await response.arrayBuffer());
        }
        if (controller.signal.aborted) return;
        cache.current = { bank: clip.bank, buffer };
        const node = context.createBufferSource(),
          gain = context.createGain();
        node.buffer = buffer;
        gain.gain.value = clip.gain;
        node.connect(gain).connect(effects);
        const origin = context.currentTime - offset;
        node.onended = () => {
          node.disconnect();
          gain.disconnect();
          if (voice.current?.node !== node) return;
          voice.current = null;
          cancelAnimationFrame(frame.current);
          setPosition(clip.duration);
          setState("ended");
        };
        node.start(0, clip.start + offset, clip.duration - offset);
        voice.current = { node, origin, duration: clip.duration };
        setState("playing");
        function progress() {
          setPosition(Math.min(clip.duration, context.currentTime - origin));
          frame.current = requestAnimationFrame(progress);
        }
        frame.current = requestAnimationFrame(progress);
      } catch {
        if (!controller.signal.aborted) setState("error");
      } finally {
        if (request.current === controller) request.current = null;
      }
    },
    [cache],
  );
  const active = state === "loading" || state === "playing";
  function seek(offset: number) {
    if (active) void play(offset, slice);
    else {
      setPosition(offset);
      setState(offset >= slice.duration ? "ended" : "paused");
    }
  }
  const choose = useCallback(
    (e: number, i: number) => {
      const spec = events[e].spec;
      setEvent(e);
      setVariant(i);
      void play(0, clipSlice(spec.pool[i], spec));
    },
    [events, play],
  );
  return (
    <>
      <ClipCatalog
        events={events}
        event={event}
        variant={variant}
        choose={choose}
      />
      <div className="wb-player">
        <SourceDetails id={id} spec={selected.spec} />
        <strong>
          {selected.name} · 变体 {variant + 1}
        </strong>
        <label htmlFor="wb-clip-time">
          片段进度{" "}
          <output>
            {position.toFixed(2)} / {slice.duration.toFixed(2)} 秒
          </output>
        </label>
        <input
          id="wb-clip-time"
          aria-label="音频时间轴"
          type="range"
          min={0}
          max={slice.duration}
          step="any"
          value={position}
          onChange={(e) => seek(Number(e.target.value))}
          onKeyDown={(e) => {
            const delta = Math.min(0.1, slice.duration / 20);
            const next: Record<string, number> = {
              ArrowRight: position + delta,
              ArrowLeft: position - delta,
              Home: 0,
              End: slice.duration,
            };
            if (e.key in next) {
              e.preventDefault();
              seek(Math.min(slice.duration, Math.max(0, next[e.key])));
            }
          }}
        />
        <div className="wb-row">
          <button
            data-silent
            onClick={() =>
              active
                ? pause()
                : void play(state === "ended" ? 0 : position, slice)
            }
          >
            {active ? "暂停" : state === "paused" ? "继续播放" : "播放片段"}
          </button>
          <button
            data-silent
            disabled={state === "idle"}
            onClick={() => {
              halt();
              setPosition(0);
              setState("idle");
            }}
          >
            停止
          </button>
          <output role="status">
            {
              {
                idle: "",
                playing: "播放中",
                loading: "载入中",
                paused: "已暂停",
                ended: "播放完毕",
                error: "音频载入失败，可重试",
              }[state]
            }
          </output>
        </div>
      </div>
    </>
  );
}

export default function AudioPreview({
  kind,
  name,
}: {
  kind: string;
  name: string;
}) {
  const [team, setTeam] = useState("0"),
    [form, setForm] = useState("0");
  const cache = useRef<Bank | null>(null);
  const hasAlternate = audioCatalog.variants[kind + "/1/0"] !== undefined;
  const profile = profileForSound(
    kind,
    Number(team),
    hasAlternate && form === "1",
  );
  const events = useMemo(() => profileSelections(profile), [profile]);
  if (kind === "interface_audio") {
    return (
      <section className="wb-audio-panel">
        <h2>{name}</h2>
        <p>项目合成音。浏览器用正弦波生成这四种提示音。</p>
        <div className="wb-row">
          {(Object.keys(interfaceCues) as Cue[]).map((cue) => (
            <button key={cue} data-silent onClick={() => void playCue(cue)}>
              {interfaceCues[cue]}
            </button>
          ))}
        </div>
      </section>
    );
  }
  return (
    <section className="wb-audio-panel">
      <header className="wb-title">
        <h2>{name} · 音效</h2>
        <div className="wb-row">
          <div className="wb-segments" role="group" aria-label="音效阵营">
            {["蓝方", "红方"].map((v, i) => (
              <button
                key={v}
                aria-pressed={team === String(i)}
                onClick={() => setTeam(String(i))}
              >
                {v}
              </button>
            ))}
          </div>
          {hasAlternate && (
            <div className="wb-segments" role="group" aria-label="音效形态">
              {["基础形态", "变身形态"].map((v, i) => (
                <button
                  key={v}
                  aria-pressed={form === String(i)}
                  onClick={() => setForm(String(i))}
                >
                  {v}
                </button>
              ))}
            </div>
          )}
        </div>
      </header>
      {events.length ? (
        <ClipBrowser key={team + "/" + form} events={events} cache={cache} />
      ) : (
        <p>{name}暂无已接入的音效。</p>
      )}
    </section>
  );
}
