import { useEffect, useRef, useState } from "react";
import {
  OrthographicCamera,
  Scene,
  WebGLRenderer,
  GridHelper,
  AnimationMixer,
  Mesh,
  type Object3D,
} from "three";
import {
  ParticleActor,
  ParticleLibrary,
  ParticleBackdrop,
  missileOrientation,
  systems,
  type ParticleQuality,
} from "./native-particles";

import { previewFloor } from "./battle-terrain";
import { Choice } from "./controls";
import { ModelResources } from "./battle-models";
import { profileFor } from "./battle-motion";
import recipes from "../../content/effect_recipes.json";
import { associatedSystems } from "./effect-bindings";
export default function EffectPreview({
  kind,
  skills,
  members,
}: {
  kind: string;
  skills: string[];
  members: string[];
}) {
  const related = Array.from(
    new Set([
      ...associatedSystems(kind, skills, members),
      ...Object.keys(systems).filter(
        (n) => n === kind || n.startsWith(kind + "/"),
      ),
    ]),
  )
    .filter((n) => systems[n])
    .sort();
  return related.length ? (
    <EffectInspector
      key={kind}
      kind={kind}
      members={members}
      related={related}
    />
  ) : (
    <p className="wb-empty">当前对象暂无已接入的特效。</p>
  );
}

function emitterPageSize() {
  if (
    window.matchMedia("(max-height: 540px) and (orientation: landscape)")
      .matches
  )
    return 4;
  return window.matchMedia("(min-width: 1000px) and (min-height: 740px)")
    .matches
    ? 12
    : 6;
}
export function EffectInspector({
  kind,
  members,
  related,
}: {
  kind: string;
  members: string[];
  related: string[];
}) {
  const [name, select] = useState(related[0]);
  const [firstLayer, setFirstLayer] = useState(0);
  const [pageSize, setPageSize] = useState(emitterPageSize);
  useEffect(() => {
    const resize = () => setPageSize(emitterPageSize());
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const layerPage = Math.floor(firstLayer / pageSize);
  const recipe = (recipes as Record<string, { wad: string; entry: string }>)[
    name
  ];
  const [models] = useState(() => new ModelResources());
  const [skinName, setSkinName] = useState("");
  useEffect(() => () => models.dispose(), [models]);
  const [playing, play] = useState(true),
    [age, seek] = useState(0),
    [duration, length] = useState(1);
  const [layers, list] = useState<string[]>([]),
    [muted, mute] = useState(new Set<string>());
  const [quality, setQuality] = useState<ParticleQuality>("high"),
    [error, fail] = useState("");
  const [zoom, setZoom] = useState(1);
  const canvas = useRef<HTMLCanvasElement>(null),
    time = useRef(0),
    options = useRef({ playing, muted, quality, zoom });
  options.current = { playing, muted, quality, zoom };
  function goto(t: number) {
    time.current = Math.max(0, Math.min(duration, t));
    seek(time.current);
  }
  useEffect(() => {
    const surface = canvas.current!;
    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({ canvas: surface, antialias: true });
    } catch (e) {
      fail(String(e));
      return;
    }
    const scene = new Scene(),
      camera = new OrthographicCamera(-400, 400, 400, -400, 1, 16000);
    renderer.setClearColor(0x18222a);
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    const grid = new GridHelper(4000, 40, 0x566671, 0x34414a);
    const floor = previewFloor();
    scene.add(floor, grid);
    const library = new ParticleLibrary(),
      backdrop = new ParticleBackdrop(library);
    let body: Object3D | undefined, mixer: AnimationMixer | undefined;
    let actor: ParticleActor | undefined,
      alive = true,
      raf = 0,
      previous = 0,
      lastRead = 0;
    time.current = 0;
    seek(0);
    list([]);
    setFirstLayer(0);
    mute(new Set());
    fail("");
    setSkinName("");
    void library
      .load(name)
      .then(async (track) => {
        if (!alive) return;
        if (track.layers.some((l) => l.quadType === 11)) {
          const profile =
            profileFor({ kind: members[0] ?? kind, team: 0 }) ??
            profileFor({ kind: "ashe", team: 0 })!;
          const model = await models.body(profile);
          if (!alive) return;
          body = model.scene;
          scene.add(body);
          setSkinName(profile.asset);
          mixer = new AnimationMixer(body);
          const idle = model.animations.find((c) => c.name === profile.idle);
          if (idle) mixer.clipAction(idle).play();
        }
        if (!alive) return;
        actor = new ParticleActor(name, track);
        scene.add(actor.root);
        if (body) {
          const meshes: Mesh[] = [];
          body.traverse((o) => {
            if (o instanceof Mesh && o.geometry.getAttribute("uv"))
              meshes.push(o);
          });
          actor.sources = meshes;
        }
        list(track.layers.map((l) => l.name));
        length(track.duration);
        // Give long forward beams enough room on the same camera used for ordinary local effects.
        const span = name === "final_spark/beam" ? 2100 : 440;
        const center = name === "final_spark/beam" ? 1450 : 0;
        camera.position.set(
          0,
          4000 * Math.sin((54 * Math.PI) / 180),
          center + 4000 * Math.cos((54 * Math.PI) / 180),
        );
        camera.lookAt(0, 0, center);
        const draw = (now: number) => {
          if (!alive || !actor) return;
          const opt = options.current;
          if (previous && opt.playing)
            time.current =
              (time.current + (now - previous) / 1000) % track.duration;
          previous = now;
          const w = Math.max(1, surface.clientWidth),
            h = Math.max(1, surface.clientHeight);
          if (
            surface.width !== Math.floor(w * renderer.getPixelRatio()) ||
            surface.height !== Math.floor(h * renderer.getPixelRatio())
          )
            renderer.setSize(w, h, false);
          camera.left = (-span * w) / h / opt.zoom;
          camera.right = -camera.left;
          camera.top = span / opt.zoom;
          camera.bottom = -camera.top;
          camera.updateProjectionMatrix();
          mixer?.setTime(time.current);
          const wave = name === "sona/wave";
          if (wave) actor.previewMotion(time.current);
          if (name.startsWith("ashe/") && name !== "ashe/hit")
            actor.root.quaternion.copy(missileOrientation);
          actor.sample(
            time.current,
            opt.quality,
            opt.muted,
            wave,
            Infinity,
            true,
          );
          backdrop.capture(
            renderer,
            scene,
            camera,
            actor.root,
            actor.inputs,
            body ? [body] : [],
          );
          renderer.render(scene, camera);
          surface.dataset.system = name;
          surface.dataset.particles = String(actor.drawn);
          if (now - lastRead > 80) {
            seek(time.current);
            lastRead = now;
          }
          raf = requestAnimationFrame(draw);
        };
        raf = requestAnimationFrame(draw);
      })
      .catch((e) => {
        if (alive) fail(String(e));
      });
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      if (body) {
        mixer?.stopAllAction();
        mixer?.uncacheRoot(body);
        body.removeFromParent();
      }
      actor?.dispose();
      backdrop.dispose();
      library.dispose();
      grid.dispose();
      floor.geometry.dispose();
      floor.material.dispose();
      renderer.dispose();
      if (!surface.isConnected) renderer.forceContextLoss();
    };
  }, [name]);
  return (
    <section className="wb-fx">
      <aside>
        <Choice
          label="原生特效"
          value={name}
          onChange={select}
          items={related.map((id) => ({ id, name: id }))}
        />
        <div className="wb-fx-settings">
          <Choice
            label="画质"
            value={quality}
            onChange={(v) => setQuality(v as ParticleQuality)}
            items={[
              { id: "high", name: "高" },
              { id: "low", name: "低" },
            ]}
          />
          <label>
            缩放
            <input
              type="range"
              min=".2"
              max="4"
              step=".1"
              value={zoom}
              onChange={(e) => setZoom(+e.target.value)}
            />
          </label>
        </div>
        <details>
          <summary>原生来源</summary>
          <code className="wb-fx-path">
            {recipe.wad}
            <br />
            {recipe.entry}
          </code>
        </details>
        {skinName && <p>附着模型 · {skinName}</p>}
        <section className="wb-emitters">
          <div className="wb-title">
            <h2>发射器 · {layers.length}</h2>
            {layers.length > pageSize && (
              <div className="wb-row">
                <button
                  aria-label="上一页发射器"
                  disabled={!layerPage}
                  onClick={() => setFirstLayer((layerPage - 1) * pageSize)}
                >
                  ‹
                </button>
                <output>
                  {layerPage + 1} / {Math.ceil(layers.length / pageSize)}
                </output>
                <button
                  aria-label="下一页发射器"
                  disabled={(layerPage + 1) * pageSize >= layers.length}
                  onClick={() => setFirstLayer((layerPage + 1) * pageSize)}
                >
                  ›
                </button>
              </div>
            )}
          </div>
          <div className="wb-emitter-list">
            {layers
              .slice(layerPage * pageSize, (layerPage + 1) * pageSize)
              .map((n, i) => (
                <label key={i}>
                  <input
                    type="checkbox"
                    checked={!muted.has(n)}
                    onChange={() =>
                      mute((old) => {
                        const v = new Set(old);
                        if (v.has(n)) v.delete(n);
                        else v.add(n);
                        return v;
                      })
                    }
                  />
                  <span>{n}</span>
                </label>
              ))}
          </div>
        </section>
      </aside>
      <div className="wb-fx-stage">
        <canvas key={name} ref={canvas} aria-label="原生粒子预览" />
        {error && <p role="alert">{error}</p>}
        <div className="wb-row">
          <button onClick={() => play(!playing)}>
            {playing ? "暂停特效" : "播放特效"}
          </button>
          <button
            onClick={() => {
              play(false);
              goto(time.current - 0.05);
            }}
          >
            前一 Tick
          </button>
          <button
            onClick={() => {
              play(false);
              goto(time.current + 0.05);
            }}
          >
            后一 Tick
          </button>
          <output>
            {age.toFixed(2)} / {duration.toFixed(2)} s
          </output>
        </div>
        <input
          aria-label="特效时间"
          type="range"
          min="0"
          max={duration}
          step="any"
          value={age}
          onChange={(e) => {
            play(false);
            goto(+e.target.value);
          }}
        />
      </div>
    </section>
  );
}
