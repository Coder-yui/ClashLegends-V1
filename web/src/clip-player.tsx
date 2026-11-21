import { useRef, useState } from "react";
import { PlaybackSpeed } from "./recording-options";
import { Modal } from "./controls";
import { FullscreenButton } from "./fullscreen";
import { downloadClip, type VideoClip } from "./video-library";
import { formatTime } from "./video-recording";

export function ClipPlayer({
  clip,
  url,
  close,
}: {
  clip: VideoClip;
  url: string;
  close: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(clip.duration ?? 0);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [speed, setSpeed] = useState(1);
  const [error, setError] = useState("");
  function syncDuration(el: HTMLVideoElement) {
    // Older MediaRecorder WebM clips can omit their duration header.
    if (Number.isFinite(el.duration)) setDuration(el.duration);
    else if (!clip.duration && el.buffered.length)
      setDuration(el.buffered.end(el.buffered.length - 1));
  }
  function togglePlayback() {
    const el = video.current;
    if (!el) return;
    if (!el.paused) el.pause();
    else
      void el.play().catch(() => setError("无法播放此视频，可以下载后查看。"));
  }
  return (
    <Modal title={clip.title} onClose={close}>
      <div className="clip-player">
        <video
          ref={video}
          src={url}
          aria-label="对局视频"
          autoPlay
          playsInline
          muted={muted}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onVolumeChange={(e) => {
            setVolume(e.currentTarget.volume);
            setMuted(e.currentTarget.muted);
          }}
          onRateChange={(e) => setSpeed(e.currentTarget.playbackRate)}
          onDurationChange={(e) => syncDuration(e.currentTarget)}
          onProgress={(e) => syncDuration(e.currentTarget)}
          onTimeUpdate={(e) => {
            setPosition(e.currentTarget.currentTime);
            syncDuration(e.currentTarget);
          }}
          onError={() => setError("无法播放此视频，可以下载后查看。")}
        />
        <div className="replay-time">
          <span>{formatTime(position)}</span>
          <input
            type="range"
            aria-label="视频进度"
            aria-valuetext={formatTime(position)}
            min={0}
            max={duration}
            step="any"
            value={Math.min(position, duration)}
            disabled={!duration}
            onChange={(e) => {
              const time = Number(e.target.value);
              if (video.current) video.current.currentTime = time;
              setPosition(time);
            }}
          />
          <span>{duration ? formatTime(duration) : "–:––"}</span>
        </div>
        <div className="clip-actions">
          <button onClick={togglePlayback}>
            {playing ? "暂停视频" : "播放视频"}
          </button>
          <button aria-pressed={muted} onClick={() => setMuted(!muted)}>
            静音
          </button>
          <input
            type="range"
            aria-label="视频音量"
            min="0"
            max="1"
            step="0.01"
            value={muted ? 0 : volume}
            aria-valuetext={Math.round((muted ? 0 : volume) * 100) + "%"}
            onChange={(e) => {
              if (!video.current) return;
              video.current.volume = Number(e.target.value);
              video.current.muted = false;
            }}
          />
          <PlaybackSpeed
            value={speed}
            onChange={(n) => {
              if (video.current) video.current.playbackRate = n;
            }}
          />
          <FullscreenButton showText />
          <button onClick={() => downloadClip(clip)}>下载视频</button>
        </div>
        {error && <p role="alert">{error}</p>}
      </div>
    </Modal>
  );
}
