import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AnimationMixer,
  HemisphereLight,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from "three";
import { ChoiceList } from "./controls";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";
import { loadModel, releaseAsset, modelSurfaces } from "./battle-models";
import { clipRoles, type ModelProfile } from "./battle-motion";

export default function ModelPreview({
  profile,
  children,
}: {
  profile: ModelProfile;
  children: ReactNode;
}) {
  const surface = useRef<HTMLCanvasElement>(null);
  const state = useRef({ clip: profile.idle, playing: true, time: 0 });
  const reset = useRef<(() => void) | undefined>(undefined);
  const [clips, setClips] = useState<{ name: string; duration: number }[]>([]);
  const [display, setDisplay] = useState({ ...state.current });
  const [error, setError] = useState("");
  const selected = clips.find((c) => c.name === display.clip);
  const usage = clipRoles(profile);
  const marker = [
    ...profile.attacks,
    ...Object.values(profile.casts ?? {}),
  ].find((action) => action.clip === display.clip)?.marker;
  function edit(value: Partial<typeof display>) {
    Object.assign(state.current, value);
    setDisplay({ ...state.current });
  }
  useEffect(() => {
    const canvas = surface.current!;
    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true });
    } catch {
      setError("WebGL 无法启动");
      return;
    }
    const scene = new Scene(),
      camera = new PerspectiveCamera(34, 1, 0.1, 6000);
    scene.add(new HemisphereLight(0xffffff, 0xc5d4d1, 2));
    const orbit = new OrbitControls(camera, canvas);
    orbit.enablePan = false;
    let alive = true,
      asset: GLTF | undefined,
      mixer: AnimationMixer | undefined,
      frame = 0;
    let last = performance.now(),
      lastUI = 0,
      active = "";
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    const resize = new ResizeObserver(() => {
      const w = canvas.clientWidth,
        h = canvas.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    });
    resize.observe(canvas);
    void loadModel(profile, "review")
      .then((gltf) => {
        if (!alive) {
          releaseAsset(gltf);
          return;
        }
        asset = gltf;
        scene.add(asset.scene);
        const box = gltf.bounds;
        const surfaces = modelSurfaces(asset.scene, profile);
        renderer.localClippingEnabled = true;
        const center = box.getCenter(new Vector3());
        const size = box.getSize(new Vector3()).length();
        orbit.target.copy(center);
        camera.near = Math.max(0.001, size / 2000);
        camera.far = Math.max(10, size * 10);
        camera.updateProjectionMatrix();
        camera.position
          .copy(center)
          .add(
            new Vector3(0.45, 0.26, 1).normalize().multiplyScalar(size * 2.05),
          );
        orbit.minDistance = size * 0.45;
        orbit.maxDistance = size * 3;
        orbit.update();
        orbit.saveState();
        reset.current = () => orbit.reset();
        mixer = new AnimationMixer(asset.scene);
        setClips(
          asset.animations
            .filter((c) => profile.asset === "ashe" || usage.has(c.name))
            .sort(
              (a, b) =>
                Number(usage.has(b.name)) - Number(usage.has(a.name)) ||
                a.name.localeCompare(b.name, "en", { numeric: true }),
            )
            .map((c) => ({
              name: c.name,
              duration:
                c.name === profile.death.clip
                  ? Math.min(c.duration, profile.death.clipEnd ?? Infinity)
                  : c.duration,
            })),
        );
        function render(now: number) {
          const s = state.current;
          const clip = asset!.animations.find((c) => c.name === s.clip);
          if (clip) {
            const action = mixer!.clipAction(clip);
            if (active !== s.clip) {
              mixer!.stopAllAction();
              action.reset().play();
              action.paused = true;
              active = s.clip;
            }
            const end =
              clip.name === profile.death.clip
                ? Math.min(clip.duration, profile.death.clipEnd ?? Infinity)
                : clip.duration;
            if (s.playing && end > 0)
              s.time = (s.time + Math.min((now - last) / 1000, 0.1)) % end;
            if (
              clip.name === profile.additive ||
              clip.name === profile.setupPose
            ) {
              const idle = asset!.animations.find(
                (c) => c.name === profile.idle,
              )!;
              const base = mixer!.clipAction(idle).play();
              base.paused = true;
              base.time = idle.duration ? s.time % idle.duration : 0;
            }
            action.time = s.time;
            mixer!.update(0);
            surfaces?.(clip.name, s.time);
            if (now - lastUI > 80 && s.playing) {
              setDisplay({ ...s });
              lastUI = now;
            }
          }
          last = now;
          renderer.render(scene, camera);
          frame = requestAnimationFrame(render);
        }
        frame = requestAnimationFrame(render);
      })
      .catch(() => {
        if (alive) setError("模型加载失败");
      });
    return () => {
      alive = false;
      cancelAnimationFrame(frame);
      resize.disconnect();
      orbit.dispose();
      mixer?.stopAllAction();
      if (asset) {
        mixer?.uncacheRoot(asset.scene);
        releaseAsset(asset);
      }
      renderer.dispose();
      renderer.forceContextLoss();
      reset.current = undefined;
    };
  }, [profile]);
  return (
    <div className="wb-layout">
      <aside className="wb-tools">
        {children}
        <div className="wb-preview-controls">
          <div>动作片段</div>
          <ChoiceList
            label="动作片段"
            value={display.clip}
            onChange={(clip) => edit({ clip, time: 0, playing: true })}
            items={clips.map((c) => ({
              id: c.name,
              name:
                c.name +
                " · " +
                (usage.get(c.name) ?? "未接入") +
                " · " +
                c.duration.toFixed(2) +
                " 秒",
              bound: usage.has(c.name),
            }))}
          />

          <label>
            时间轴{" "}
            <output>
              {display.time.toFixed(2)} / {(selected?.duration ?? 0).toFixed(2)}{" "}
              秒
            </output>
            <input
              aria-label="动作时间轴"
              type="range"
              min="0"
              max={selected?.duration ?? 0}
              step=".001"
              value={display.time}
              onChange={(e) =>
                edit({ playing: false, time: Number(e.target.value) })
              }
            />
          </label>
          <div className="wb-row">
            <button
              disabled={!selected}
              onClick={() => edit({ playing: !display.playing })}
            >
              {display.playing ? "暂停动作" : "继续动作"}
            </button>
            <button onClick={() => edit({ playing: true, time: 0 })}>
              重播
            </button>
            {marker !== undefined && (
              <button onClick={() => edit({ playing: false, time: marker })}>
                定位出手 · {marker.toFixed(2)} 秒
              </button>
            )}
            <button onClick={() => reset.current?.()}>复位视角</button>
          </div>
          <small>拖动模型旋转，滚轮缩放。</small>
        </div>
      </aside>
      <section className="wb-display">
        <div className="wb-view">
          <canvas ref={surface} aria-label="模型观察" />
          {error && <p role="alert">{error}</p>}
        </div>
      </section>
    </div>
  );
}
