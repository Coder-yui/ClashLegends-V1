import {
  usePreferences,
  updatePreferences,
  type RecordingOptions,
} from "./preferences";
import { Choice } from "./controls";
import { videoSupported } from "./video-recording";
export function RecordingSettings() {
  const { recording: r } = usePreferences();
  const canRecordVideo = videoSupported();
  function update(patch: Partial<RecordingOptions>) {
    updatePreferences({ recording: { ...r, ...patch } });
  }
  return (
    <fieldset className="recording-options">
      <legend>对局录制</legend>
      <Choice
        label="开局自动录制"
        value={r.mode}
        onChange={(mode) => update({ mode: mode as RecordingOptions["mode"] })}
        items={[
          { id: "off", name: "关闭" },
          { id: "replay", name: "对局回放" },
          { id: "video", name: "对局视频", disabled: !canRecordVideo },
          { id: "both", name: "回放和视频", disabled: !canRecordVideo },
        ]}
      />
      <p>回放可以暂停、变速和移动镜头。视频保存在此浏览器，可下载分享。</p>
      {canRecordVideo ? (
        <>
          <Choice
            label="视频画幅"
            value={r.aspect}
            items={["9:16", "16:9", "1:1"].map((id) => ({ id, name: id }))}
            onChange={(aspect) =>
              update({ aspect: aspect as RecordingOptions["aspect"] })
            }
          />
          <Choice
            label="视频清晰度"
            value={String(r.resolution)}
            items={[540, 720, 1080].map((n) => ({
              id: String(n),
              name: n + "p",
            }))}
            onChange={(id) =>
              update({
                resolution: Number(id) as RecordingOptions["resolution"],
              })
            }
          />
          <Choice
            label="视频帧率"
            value={String(r.fps)}
            items={[24, 30, 60].map((n) => ({
              id: String(n),
              name: n + " FPS",
            }))}
            onChange={(id) =>
              update({ fps: Number(id) as RecordingOptions["fps"] })
            }
          />
          <label>
            <input
              type="checkbox"
              checked={r.audio}
              onChange={(e) => update({ audio: e.target.checked })}
            />
            录入游戏声音
          </label>
          <label>
            <input
              type="checkbox"
              checked={r.hud}
              onChange={(e) => update({ hud: e.target.checked })}
            />
            录入手牌和计时器
          </label>
        </>
      ) : (
        <p>当前浏览器支持对局回放，视频录制不可用。</p>
      )}
    </fieldset>
  );
}

export function PlaybackSpeed({
  value,
  onChange,
}: {
  value: number;
  onChange: (speed: number) => void;
}) {
  return (
    <Choice
      compact
      label="播放速度"
      value={String(value)}
      items={[0.25, 0.5, 1, 2, 4].map((n) => ({
        id: String(n),
        name: n + "×",
      }))}
      onChange={(id) => onChange(Number(id))}
    />
  );
}
