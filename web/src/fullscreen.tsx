import { useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Modal } from "./controls";

const doc = document as Document & {
  webkitFullscreenElement?: Element;
  webkitFullscreenEnabled?: boolean;
  webkitExitFullscreen?: () => void;
};
const screenRoot = doc.documentElement as HTMLElement & {
  webkitRequestFullscreen?: () => void;
};
const fullscreenDisplay = matchMedia("(display-mode: fullscreen)");
const standaloneDisplay = matchMedia("(display-mode: standalone)");

function screenMode() {
  if (doc.fullscreenElement || doc.webkitFullscreenElement) return "active";
  if (fullscreenDisplay.matches) return "app";
  if (doc.fullscreenEnabled || doc.webkitFullscreenEnabled) return "available";
  if (
    standaloneDisplay.matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone
  )
    return "app";
  return "unsupported";
}

function subscribe(update: () => void) {
  doc.addEventListener("fullscreenchange", update);
  doc.addEventListener("webkitfullscreenchange", update);
  fullscreenDisplay.addEventListener("change", update);
  standaloneDisplay.addEventListener("change", update);
  return () => {
    doc.removeEventListener("fullscreenchange", update);
    doc.removeEventListener("webkitfullscreenchange", update);
    fullscreenDisplay.removeEventListener("change", update);
    standaloneDisplay.removeEventListener("change", update);
  };
}

function fullscreenHelp() {
  if (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  )
    return "在 Safari 中打开游戏，点「分享」→「添加到主屏幕」。如果看到「作为网页 App 打开」，请启用它。之后从主屏幕的 ClashLegends 图标启动，游戏就会隐藏浏览器地址栏。";
  if (/Android/i.test(navigator.userAgent))
    return "请用 Chrome 打开游戏后再点全屏，或在浏览器菜单中选择「安装应用」，从主屏幕启动。";
  return "请在独立的浏览器标签页中打开游戏后重试，也可以使用浏览器菜单中的全屏功能。";
}

export function FullscreenButton({
  className,
  showText = false,
}: {
  className?: string;
  showText?: boolean;
}) {
  const mode = useSyncExternalStore(subscribe, screenMode);
  const [message, setMessage] = useState("");
  const active = mode === "active";
  const label = active ? "退出全屏" : "进入全屏";

  async function toggle() {
    try {
      if (active) {
        if (doc.exitFullscreen) await doc.exitFullscreen();
        else doc.webkitExitFullscreen?.();
      } else if (doc.fullscreenEnabled && screenRoot.requestFullscreen) {
        await screenRoot.requestFullscreen({ navigationUI: "hide" });
      } else if (
        doc.webkitFullscreenEnabled &&
        screenRoot.webkitRequestFullscreen
      ) {
        screenRoot.webkitRequestFullscreen();
      } else {
        setMessage(fullscreenHelp());
      }
    } catch {
      setMessage(
        active ? "请使用浏览器的退出全屏操作返回。" : fullscreenHelp(),
      );
    }
  }

  if (mode === "app") return null;
  return (
    <>
      <button
        type="button"
        className={className}
        onClick={toggle}
        aria-label={label}
        title={label}
      >
        <svg
          aria-hidden="true"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path
            d={
              active
                ? "M3 9h6V3m6 0v6h6M3 15h6v6m6 0v-6h6"
                : "M9 3H3v6m12-6h6v6M3 15v6h6m6 0h6v-6"
            }
          />
        </svg>
        {showText && <span>{active ? label : "全屏"}</span>}
      </button>
      {message &&
        createPortal(
          <Modal title="全屏游玩" onClose={() => setMessage("")}>
            <p>{message}</p>
          </Modal>,
          document.body,
        )}
    </>
  );
}
