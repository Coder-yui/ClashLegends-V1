import { replayBookmarks } from "./player-data";
import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { api, href, type Match, type Catalog } from "./api";
import { Battlefield, type Frame } from "./battle-field";
import { useMatchAssets } from "./use-match-assets";
import { BATTLE_PROTOCOL, BattleEvents } from "./presentation";
import { ClipPlayer } from "./clip-player";
import { FullscreenButton } from "./fullscreen";
import { downloadClip, readClips, type VideoClip } from "./video-library";
import { battleTime, useVideo, videoSupported } from "./video-recording";
import { PlaybackSpeed, RecordingSettings } from "./recording-options";
import { Modal } from "./controls";

interface Saved {
  id: string;
  map: string;
  opponent: string;
  tick: number;
  finished: boolean;
  savedAt: number;
  compatible: boolean;
}
function VideoRow({ clip }: { clip: VideoClip }) {
  const [url, setUrl] = useState("");
  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );
  return (
    <article className="clip-row">
      <div>
        <strong>{clip.title}</strong>
        <small>
          {new Date(clip.created).toLocaleString()} · {clip.width} ×{" "}
          {clip.height} · {(clip.blob.size / 1048576).toFixed(1)} MB
        </small>
      </div>
      <button onClick={() => setUrl(url ? "" : URL.createObjectURL(clip.blob))}>
        {url ? "收起" : "播放视频"}
      </button>
      <button onClick={() => downloadClip(clip)}>下载视频</button>
      {url && <ClipPlayer clip={clip} url={url} close={() => setUrl("")} />}
    </article>
  );
}
export function Recordings({
  catalog,
  account,
}: {
  catalog: Catalog;
  account: boolean;
}) {
  const [rows, setRows] = useState<Saved[]>(),
    [videos, setVideos] = useState<VideoClip[]>(),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    async function loadReplays() {
      const saved = await api<Saved[]>("recordings");
      if (account) return saved;
      const bookmarks = replayBookmarks();
      const ids = Object.keys(bookmarks);
      if (!ids.length) return saved;
      const local = await api<Saved[]>("recordings/lookup", ids);
      const rows = new Map(saved.map((r) => [r.id, r]));
      for (const row of local)
        rows.set(row.id, { ...row, savedAt: bookmarks[row.id] });
      return [...rows.values()].sort((a, b) => b.savedAt - a.savedAt);
    }
    loadReplays()
      .then((r) => {
        if (active) setRows(r);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    const load = () =>
      readClips()
        .then((r) => {
          if (active) setVideos(r);
        })
        .catch(() => {
          if (active) setError("无法读取此浏览器的视频库");
        });
    void load();
    window.addEventListener("video-saved", load);
    return () => {
      active = false;
      window.removeEventListener("video-saved", load);
    };
  }, []);
  return (
    <section className="recordings">
      <div className="section-title">
        <h1>我的录制</h1>
        <a href={href()} className="outline">
          返回大厅
        </a>
      </div>
      {error && <p role="alert">{error}</p>}
      <h2>对局回放</h2>
      {rows?.length === 0 && <p>还没有保存的回放。</p>}
      {rows?.map((r) => (
        <article key={r.id} className="clip-row">
          <div>
            <strong>
              {catalog.maps.find((m) => m.id === r.map)?.name ?? r.map} ·{" "}
              {r.opponent}
            </strong>
            <small>
              {new Date(r.savedAt * 1000).toLocaleString()} ·{" "}
              {battleTime(r.tick)} · {r.finished ? "已结束" : "已记录进度"}
            </small>
          </div>
          {r.compatible && r.tick > 0 ? (
            <a className="outline" href={href("recordings/" + r.id)}>
              打开回放
            </a>
          ) : (
            <small>{r.compatible ? "等待开局" : "需要原规则版本"}</small>
          )}
        </article>
      ))}
      <h2>本机视频</h2>
      {videos?.length === 0 && <p>还没有录制的视频。</p>}
      {videos?.map((v) => (
        <VideoRow key={v.id} clip={v} />
      ))}
    </section>
  );
}
export function ReplayPage({
  match,
  catalog,
}: {
  match: Match;
  catalog: Catalog;
}) {
  const [frame, setFrame] = useState<Frame>(),
    [end, setEnd] = useState(0),
    [error, fail] = useState(""),
    [attempt, retry] = useState(0);
  const [rate, setRate] = useState(0),
    [speed, setSpeed] = useState(1),
    [scrub, setScrub] = useState<number | null>(null);
  const [cinema, setCinema] = useState(false),
    [options, showOptions] = useState(false);
  const assets = useMatchAssets(match, catalog, match.playable);
  const video = useVideo(match, catalog);
  const sock = useRef<WebSocket | null>(null);
  const seekTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!match.playable || !assets.resources) return;
    let closed = false,
      endTick = 0,
      baseline = 0;
    const url = new URL("/api/recordings/" + match.id + "/play", location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(url);
    sock.current = ws;
    const events = new BattleEvents();
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (closed) return;
      if (msg.protocol !== BATTLE_PROTOCOL) {
        fail("回放协议不兼容");
        ws.close();
        return;
      }
      if (msg.type === "replay") {
        endTick = msg.end;
        setEnd(endTick);
        return;
      }
      if (msg.type !== "frame") return;
      const cues = events.read(msg.presentation);
      if (events.reset) baseline++;
      const generation = baseline;
      setFrame((previous) => ({
        ...msg,
        baseline: generation,
        cues: [
          ...(previous?.baseline === generation
            ? (previous.cues ?? [])
            : []
          ).filter((c) => c.tick + 24 >= msg.tick),
          ...cues,
        ],
      }));
      if (msg.tick >= endTick && !msg.result) setRate(0);
    };
    ws.onclose = () => {
      if (!closed) {
        fail((prev) => prev || "回放连接已断开，请重新打开。");
        setRate(0);
      }
    };
    return () => {
      closed = true;
      clearTimeout(seekTimer.current);
      ws.close();
      sock.current = null;
    };
  }, [match.id, match.playable, assets.resources, attempt]);
  useEffect(() => {
    if (!frame?.result || !rate) return;
    const tail = window.setTimeout(() => setRate(0), 8000);
    return () => clearTimeout(tail);
  }, [!!frame?.result, rate]);
  function send(control: object) {
    if (sock.current?.readyState === WebSocket.OPEN)
      sock.current.send(JSON.stringify(control));
  }
  function play(r: number) {
    if (frame && frame.tick >= end && r) send({ seek: 0 });
    setRate(r);
    send({ rate: r });
  }
  function seek(n: number) {
    setScrub(n);
    clearTimeout(seekTimer.current);
    seekTimer.current = window.setTimeout(() => {
      send({ seek: n });
      setScrub(null);
    }, 110);
  }
  const m = frame?.map;
  return (
    <section
      className="battle-layout replay-layout"
      style={
        m
          ? ({
              "--map-width": m.width,
              "--map-height": m.height,
              "--ground-depth": m.height + 2 * m.backMargin,
              "--projection": m.projection,
              "--backdrop-width": m.backdropWidth,
              "--terrain": m.terrain ? 'url("' + m.terrain + '")' : "none",
            } as CSSProperties)
          : undefined
      }
    >
      <div className="battle-stage">
        {frame && (
          <Battlefield
            frame={frame}
            resources={assets.resources}
            me={match.me}
            deck={match.deck.cards}
            playback={rate}
            cinema={cinema}
            onPaint={video.paint}
            play={() => {}}
          />
        )}
      </div>
      <div className="replay-header">
        <a href={href("recordings")}>‹ 我的录制</a>
        <FullscreenButton />
      </div>
      {(!match.playable || assets.failed || error || !frame) && (
        <div className="replay-status">
          {error ||
            (!match.playable
              ? "需要原规则版本"
              : assets.failed
                ? "回放资源加载失败"
                : "正在准备回放…")}
          {assets.failed && (
            <button onClick={assets.retry}>重新加载资源</button>
          )}
          {error && (
            <button
              onClick={() => {
                fail("");
                retry((n) => n + 1);
              }}
            >
              重新打开
            </button>
          )}
        </div>
      )}
      <div className="replay-bar">
        <label className="replay-time">
          <span>{battleTime(scrub ?? frame?.tick ?? 0)}</span>
          <input
            type="range"
            aria-label="回放进度"
            min="0"
            max={end}
            value={scrub ?? frame?.tick ?? 0}
            onChange={(e) => seek(Number(e.target.value))}
          />
          <span>{battleTime(end)}</span>
        </label>
        <div className="replay-buttons">
          <button
            disabled={!frame || !!error}
            onClick={() => play(rate ? 0 : speed)}
          >
            {rate ? "暂停" : "播放"}
          </button>
          <PlaybackSpeed
            value={speed}
            onChange={(n) => {
              setSpeed(n);
              if (rate) play(n);
            }}
          />
          <button aria-pressed={cinema} onClick={() => setCinema((v) => !v)}>
            {cinema ? "恢复俯视" : "自由镜头"}
          </button>
          <button
            disabled={!frame || !videoSupported()}
            onClick={video.recording ? video.stop : video.start}
          >
            {video.recording ? "停止录制" : "录制视频"}
          </button>
          <button aria-label="录制设置" onClick={() => showOptions(true)}>
            ⚙
          </button>
        </div>
        {cinema && (
          <small>拖动旋转，右键或双指拖动平移，滚轮或双指捏合缩放。</small>
        )}
        {video.message && <small role="status">{video.message}</small>}
      </div>
      {options && (
        <Modal title="录制设置" onClose={() => showOptions(false)}>
          <RecordingSettings />
        </Modal>
      )}
    </section>
  );
}
