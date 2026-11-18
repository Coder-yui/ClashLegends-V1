import { useState } from "react";
import {
  actions,
  allowedKey,
  boundAction,
  defaultBindings,
  keyLabel,
  usePreferences,
  updatePreferences,
} from "./preferences";
import type { Action } from "./preferences";
import { Modal } from "./controls";
import { playCue } from "./audio";

export function Settings({ close }: { close: () => void }) {
  const p = usePreferences(),
    [capture, setCapture] = useState<Action | null>(null),
    [hint, setHint] = useState("");
  return (
    <Modal title="游戏设置" onClose={close}>
      <p className="settings-note">设置自动保存在此浏览器。</p>
      <fieldset className="volume-controls">
        <legend>声音</legend>
        {(
          [
            ["master", "总音量"],
            ["effects", "音效音量"],
            ["background", "背景音量"],
          ] as const
        ).map(([id, label]) => (
          <label key={id}>
            <span>{label}</span>
            <input
              type="range"
              min="0"
              max="100"
              value={p[id]}
              aria-label={label}
              aria-valuetext={p[id] + "%"}
              onChange={(e) =>
                updatePreferences({ [id]: Number(e.target.value) })
              }
            />
            <output>{p[id]}%</output>
          </label>
        ))}
        <button
          type="button"
          data-silent
          onClick={() => void playCue("confirm")}
        >
          试听音效
        </button>
      </fieldset>
      <fieldset className="key-controls">
        <legend>对局按键</legend>
        <p>手牌可用鼠标或按键选中。再按同一手牌键取消，选中后点击战场出牌。</p>
        <p>点击下方键位可重新绑定，Esc 取消改键。</p>
        {actions.map(([id, label]) => (
          <div className="key-row" key={id}>
            <span>{label}</span>
            <button
              type="button"
              aria-label={"绑定" + label}
              aria-pressed={capture === id}
              onBlur={() => setCapture((prev) => (prev === id ? null : prev))}
              onClick={() => {
                setCapture(id);
                setHint("");
              }}
              onKeyDown={(e) => {
                if (capture !== id || e.key === "Tab") return;
                e.preventDefault();
                e.stopPropagation();
                if (e.repeat) return;
                if (e.key === "Escape") {
                  setCapture(null);
                  setHint("");
                  return;
                }
                if (
                  e.ctrlKey ||
                  e.altKey ||
                  e.metaKey ||
                  e.shiftKey ||
                  !allowedKey(e.code)
                ) {
                  setHint("请选择字母、数字、方向键或空格。");
                  return;
                }
                const owner = boundAction(e.code);
                if (owner && owner !== id) {
                  setHint(
                    "这个键已绑定到" +
                      actions.find((a) => a[0] === owner)![1] +
                      "。",
                  );
                  return;
                }
                updatePreferences({
                  bindings: { ...p.bindings, [id]: e.code },
                });
                setCapture(null);
                setHint(label + "已绑定 " + keyLabel(e.code));
                void playCue("select");
              }}
            >
              {capture === id ? "请按键…" : keyLabel(p.bindings[id])}
            </button>
          </div>
        ))}
        <p className="key-hint" role="status">
          {hint}
        </p>
        <button
          onClick={() => {
            updatePreferences({ bindings: { ...defaultBindings } });
            setCapture(null);
            setHint("已恢复默认键位");
          }}
        >
          恢复默认键位
        </button>
      </fieldset>
      <div className="footer-actions">
        <button className="gold" onClick={close}>
          完成
        </button>
      </div>
    </Modal>
  );
}
