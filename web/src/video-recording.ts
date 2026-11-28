import { terrainFor } from "./battle-map";
import { useEffect, useRef, useState } from "react";
import type { Frame } from "./battle-field";
import { fieldMargin } from "./battle-geometry";
import { getMixer } from "./audio";
import type { Catalog, Match } from "./api";
import { cardArt } from "./card-art";
import { preferences, type RecordingOptions } from "./preferences";
import { downloadClip, saveClip } from "./video-library";

export type CaptureFrame = (
  frame: Frame,
  models: HTMLCanvasElement,
  overlay: HTMLCanvasElement,
  cinema: boolean,
) => void;
export function videoSupported() {
  return (
    typeof MediaRecorder !== "undefined" &&
    typeof HTMLCanvasElement.prototype.captureStream === "function"
  );
}
export function battleTime(ticks: number) {
  return formatTime(ticks / 20);
}
export function formatTime(time: number) {
  const seconds = Math.floor(time);
  return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
}

function startVideo(
  match: Match,
  catalog: Catalog,
  opts: RecordingOptions,
  finished: (message: string) => void,
) {
  if (!videoSupported())
    throw new Error("此浏览器不支持视频录制，可以使用对局回放");
  const canvas = document.createElement("canvas");
  const short = opts.resolution,
    long = Math.round((short * 16) / 9 / 2) * 2;
  const w = (canvas.width = opts.aspect === "16:9" ? long : short);
  const h = (canvas.height = opts.aspect === "9:16" ? long : short);
  const ctx = canvas.getContext("2d", { alpha: false })!;
  const images = new Map<string, HTMLImageElement>();
  const cards = new Map(catalog.cards.map((c) => [c.id, c]));
  function image(src: string) {
    let img = images.get(src);
    if (!img) {
      img = new Image();
      img.src = src;
      images.set(src, img);
    }
    return img.complete && img.naturalWidth ? img : undefined;
  }
  for (const id of match.deck.cards) {
    const c = cards.get(id);
    if (c) image(cardArt(c, true));
  }
  const map = catalog.maps.find((m) => m.id === match.map);
  const terrain = terrainFor(map, match.me);
  if (terrain) image(terrain);
  const stream = canvas.captureStream(opts.fps);
  let audio: MediaStreamAudioDestinationNode | undefined;
  function cleanup() {
    if (audio) getMixer().master.disconnect(audio);
    stream.getTracks().forEach((t) => t.stop());
    images.clear();
  }
  const parts: Blob[] = [];
  const created = Date.now();
  let recorder: MediaRecorder;
  let encodingError = false;
  const startedAt = performance.now();
  let stoppedAt: number | undefined;
  try {
    if (opts.audio) {
      const mixer = getMixer();
      audio = mixer.context.createMediaStreamDestination();
      mixer.master.connect(audio);
      for (const track of audio.stream.getAudioTracks()) stream.addTrack(track);
    }
    const mimeType = [
      "video/webm;codecs=vp8" + (opts.audio ? ",opus" : ""),
      "video/mp4",
      "video/webm",
    ].find((t) => MediaRecorder.isTypeSupported(t));
    recorder = new MediaRecorder(stream, {
      ...(mimeType ? { mimeType } : {}),
      videoBitsPerSecond: Math.round(w * h * opts.fps * 0.15),
    });
    recorder.ondataavailable = (e) => {
      if (e.data.size) parts.push(e.data);
    };
    recorder.onerror = () => {
      encodingError = true;
    };
    recorder.onstop = async () => {
      cleanup();
      if (!parts.length) {
        finished("浏览器未生成视频，请降低画质后重试");
        return;
      }
      const blob = new Blob(parts, {
        type: parts[0].type || recorder.mimeType,
      });
      const clip = {
        id:
          created +
          "-" +
          crypto.getRandomValues(new Uint32Array(1))[0].toString(16),
        title: (map?.name ?? match.map) + " · " + match.opponent,
        created,
        duration: ((stoppedAt ?? performance.now()) - startedAt) / 1000,
        width: w,
        height: h,
        blob,
      };
      try {
        await saveClip(clip);
        finished(
          encodingError
            ? "编码中断，已保存可用片段"
            : "视频已保存到「我的录制」",
        );
      } catch {
        downloadClip(clip);
        finished("本机储存不可用，已导出视频文件");
      }
    };
    recorder.start(1000);
  } catch (e) {
    cleanup();
    throw e;
  }

  // Composite inside the renderer's animation frame, before WebGL clears its drawing buffer.
  let last = -Infinity;
  const paint: CaptureFrame = (frame, gl, hud, cinema) => {
    const now = performance.now();
    if (recorder.state !== "recording" || now - last < 1000 / opts.fps - 1)
      return;
    last = now;
    const { map: m } = frame;
    const unit = Math.min(w / 720, h / 1280);
    const tray = opts.hud ? 160 * unit : 0;
    const cy = (h - tray) / 2;
    ctx.fillStyle = m.id === "lowtide-dock" ? "#233136" : "#213a32";
    ctx.fillRect(0, 0, w, h);
    if (cinema) {
      const scale = Math.max(w / gl.width, (h - tray) / gl.height);
      ctx.drawImage(
        gl,
        (w - gl.width * scale) / 2,
        cy - (gl.height * scale) / 2,
        gl.width * scale,
        gl.height * scale,
      );
    } else {
      const sy = Math.min(
        (h - tray) / (m.height + 2 * m.backMargin),
        (w * m.projection) / m.width,
      );
      const sx = sy / m.projection;
      const bg = m.terrain && image(m.terrain);
      if (bg) {
        const bw = m.backdropWidth * sx,
          bh = (bw * bg.naturalHeight) / bg.naturalWidth;
        ctx.drawImage(bg, (w - bw) / 2, cy - bh / 2, bw, bh);
      }
      const bw = (m.width + 2 * fieldMargin) * sx,
        bh = (m.height + 2 * fieldMargin) * sy;
      if (m.id === "lowtide-dock") {
        const depth = (m.height + 2 * m.backMargin) * sy;
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, cy - depth / 2, w, depth);
        ctx.clip();
      }
      if (gl.width > 0) ctx.drawImage(gl, (w - bw) / 2, cy - bh / 2, bw, bh);
      if (m.id === "lowtide-dock") ctx.restore();
      ctx.drawImage(hud, (w - bw) / 2, cy - bh / 2, bw, bh);
    }
    if (opts.hud) {
      ctx.save();
      ctx.translate(w / 2, h - tray);
      ctx.scale(unit, unit);
      ctx.fillStyle = "#12242bef";
      ctx.fillRect(-360, 0, 720, 160);
      ctx.textAlign = "center";
      ctx.font = "bold 19px sans-serif";
      frame.hand.forEach((id, i) => {
        const card = cards.get(id);
        if (!card) return;
        const x = -242 + i * 125;
        const face = image(cardArt(card, true));
        if (face) ctx.drawImage(face, x, 7, 114, 100);
        ctx.fillStyle = "#08151be8";
        ctx.fillRect(x, 79, 114, 28);
        ctx.fillStyle = "#fff";
        ctx.fillText(card.name, x + 57, 100, 109);
        ctx.fillStyle = "#f5d18f";
        ctx.fillText(String(frame.costs[i]), x + 12, 31);
      });
      ctx.fillStyle = "#f1d49a";
      ctx.fillText("金币 " + frame.gold, 0, 142);
      for (const [slot, id] of match.deck.cards.slice(0, 2).entries()) {
        const c = cards.get(frame.activeCards?.[slot] ?? id);
        const skill = c?.skills.find((s) => s.id === match.deck.skills[c.id]);
        const icon = skill?.image && image(skill.image);
        if (icon) ctx.drawImage(icon, slot ? 281 : -343, 19, 59, 59);
        ctx.fillText(
          String(frame.active[slot]?.uses ?? 0),
          slot ? 313 : -313,
          100,
        );
      }
      ctx.restore();
      ctx.font = "bold " + Math.max(15, 30 * unit) + "px monospace";
      ctx.textAlign = "center";
      ctx.fillStyle = "#10212bdd";
      const clockX = m.id === "lowtide-dock" ? w - 64 * unit : w / 2;
      ctx.fillRect(clockX - 54 * unit, 8 * unit, 108 * unit, 42 * unit);
      ctx.fillStyle = "white";
      ctx.fillText(battleTime(frame.remaining), clockX, 39 * unit);
    }
    if (frame.result) {
      ctx.fillStyle = "#0c1924b5";
      ctx.fillRect(0, cy - 35 * unit, w, 70 * unit);
      ctx.fillStyle = "white";
      ctx.textAlign = "center";
      ctx.font = "bold " + 38 * unit + "px sans-serif";
      ctx.fillText(
        frame.result.winner === null
          ? "平局"
          : frame.result.winner === match.me
            ? "胜利"
            : "战败",
        w / 2,
        cy + 14 * unit,
      );
    }
  };
  return {
    paint,
    stop() {
      if (recorder.state !== "inactive") {
        stoppedAt = performance.now();
        recorder.stop();
      }
    },
  };
}

export function useVideo(match: Match, catalog: Catalog) {
  const current = useRef<ReturnType<typeof startVideo> | null>(null);
  const [recording, mark] = useState(false),
    [message, notify] = useState("");
  const saving = useRef(false);
  function start() {
    if (current.current || saving.current) return;
    try {
      current.current = startVideo(
        match,
        catalog,
        preferences().recording,
        (text) => {
          saving.current = false;
          current.current = null;
          mark(false);
          notify(text);
        },
      );
      mark(true);
      notify("");
    } catch (e) {
      notify((e as Error).message);
    }
  }
  function stop() {
    if (!current.current || saving.current) return;
    saving.current = true;
    current.current.stop();
    mark(false);
    notify("正在保存视频…");
  }
  useEffect(() => () => current.current?.stop(), []);
  useEffect(() => {
    if (!recording) return;
    function guard(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [recording]);
  const paint: CaptureFrame = (frame, gl, hud, cinema) => {
    if (!current.current || saving.current) return;
    try {
      current.current.paint(frame, gl, hud, cinema);
    } catch {
      stop();
      notify("视频画面采集已中断，正在保存可用片段");
    }
  };
  return { recording, message, start, stop, paint };
}
