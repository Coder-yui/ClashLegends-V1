import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { Card } from "./api";
import { Face } from "./preparation";
import { BattleCardFace } from "./match-page";
import { Choice } from "./controls";
import { alternateProfile, profileFor } from "./battle-motion";
import {
  defaultShot,
  height,
  loadSubject,
  newMember,
  PhotoScene,
  readShot,
  width,
  type Member,
  type Shot,
} from "./photo-scene";
import "./photo-studio.css";

type Subject = Awaited<ReturnType<typeof loadSubject>>;
type Loaded = { subject?: Subject; error?: string; identity: string };
const identity = (m: Member) => JSON.stringify([m.kind, m.team, m.alternate]);
function SubjectView({
  scene,
  member,
  file,
  index,
  light,
  report,
}: {
  scene: PhotoScene;
  member: Member;
  file?: File;
  index: number;
  light: number;
  report: (i: number, v?: Loaded) => void;
}) {
  const [loaded, setLoaded] = useState<Subject>();
  const source = identity(member);
  useEffect(() => {
    let closed = false,
      owner: Subject | undefined;
    setLoaded(undefined);
    loadSubject(member, file)
      .then((s) => {
        if (closed) {
          s.dispose();
          return;
        }
        owner = s;
        scene.scene.add(s.root);
        setLoaded(s);
      })
      .catch((e) => {
        if (!closed)
          report(index, { identity: source, error: String(e.message ?? e) });
      });
    return () => {
      closed = true;
      owner?.dispose();
      report(index);
    };
  }, [scene, source, file, index, report]);
  useLayoutEffect(() => {
    if (!loaded) return;
    try {
      loaded.pose(member, light);
      scene.draw();
      report(index, { identity: source, subject: loaded });
    } catch (e) {
      report(index, { identity: source, error: String(e) });
    }
  }, [scene, loaded, member, light, report, index, source]);
  return null;
}
function Slider({
  name,
  value,
  min,
  max,
  step = 0.01,
  onChange,
}: {
  name: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="photo-slider">
      <span>{name}</span>
      <input
        type="range"
        aria-label={name}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <output>{Number(value.toFixed(3))}</output>
    </label>
  );
}
async function localKey(file: File) {
  // Portable file identity, including local-network HTTP without Web Crypto.
  let hash = 0x811c9dc5;
  for (const byte of new Uint8Array(await file.arrayBuffer()))
    hash = Math.imul(hash ^ byte, 0x01000193);
  return (
    "local:" +
    file.size.toString(16) +
    "-" +
    (hash >>> 0).toString(16) +
    "/" +
    file.name
  );
}
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 30000);
}
type ObjectInfo = { id: string; name: string };
export default function PhotoStudio({
  id,
  card,
  objects,
  team,
  alternate,
}: {
  id: string;
  card?: Card;
  objects: ObjectInfo[];
  team: number;
  alternate: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [scene, setScene] = useState<PhotoScene>();
  const [shot, setShot] = useState(() => defaultShot(id, team, alternate));
  const [loaded, setLoaded] = useState<Record<number, Loaded>>({});
  const [index, select] = useState(0),
    [section, setSection] = useState("members");
  const [files, setFiles] = useState<Record<string, File>>({});
  const [playing, setPlaying] = useState(false);
  const [addKind, setAddKind] = useState("");
  const [status, message] = useState(""),
    [failure, setFailure] = useState("");
  const [candidate, setCandidate] = useState("");
  const [proof, showProof] = useState(false);
  const [saved, setSaved] = useState(() => {
    try {
      return !!localStorage.getItem("clash.photo." + id);
    } catch {
      return false;
    }
  });
  const pickFile = useRef<HTMLInputElement>(null),
    pickRecipe = useRef<HTMLInputElement>(null);
  const drag = useRef<{ x: number; y: number; a: number; e: number } | null>(
    null,
  );
  const member = shot.members[index];
  const objectName = (kind: string) =>
    objects.find((o) => o.id === kind)?.name ??
    kind.replace(/^local:[^/]*\//, "");
  const options = objects
    .filter((o) => profileFor({ kind: o.id, team }))
    .map((o) => ({ id: o.id, name: o.name }));
  const source = addKind || member?.kind || options[0]?.id;
  const subject = loaded[index]?.subject;
  const activeClip = member?.clip || subject?.idle || "";
  const duration =
    subject?.clips.find((c) => c.name === activeClip)?.duration ?? 0;
  useEffect(() => {
    if (!playing || !duration) return;
    let last = performance.now(),
      frame = 0;
    function tick(now: number) {
      if (now - last >= 1000 / 30) {
        const delta = (now - last) / 1000;
        last = now;
        setShot((s) => ({
          ...s,
          members: s.members.map((m, i) =>
            i === index ? { ...m, time: (m.time + delta) % duration } : m,
          ),
        }));
      }
      frame = requestAnimationFrame(tick);
    }
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, duration, index]);
  const report = useCallback(
    (i: number, v?: Loaded) =>
      setLoaded((old) => {
        const next = { ...old };
        if (v) next[i] = v;
        else delete next[i];
        return next;
      }),
    [],
  );
  useEffect(() => {
    let stage: PhotoScene;
    try {
      stage = new PhotoScene(canvas.current!);
      setScene(stage);
    } catch (e) {
      setFailure("摄影棚启动失败：" + String(e));
    }
    return () => stage?.dispose();
  }, []);
  useLayoutEffect(() => {
    scene?.configure(shot);
  }, [shot, scene]);
  useEffect(
    () => () => {
      if (candidate) URL.revokeObjectURL(candidate);
    },
    [candidate],
  );
  const update = (patch: Partial<Shot>) => setShot((s) => ({ ...s, ...patch }));
  function changeMember(patch: Partial<Member>) {
    setPlaying(false);
    setShot((s) => ({
      ...s,
      members: s.members.map((m, i) => (i === index ? { ...m, ...patch } : m)),
    }));
  }
  function append(kind: string) {
    if (!kind || shot.members.length >= 64) return;
    setPlaying(false);
    const next = newMember(
      kind,
      member?.team ?? team,
      member?.kind === kind && member.alternate,
    );
    next.x = (member?.x ?? -0.5) + 0.5;
    update({ members: [...shot.members, next] });
    select(shot.members.length);
    setSection("members");
  }
  const ready =
    !!scene &&
    !!shot.members.length &&
    shot.members.every(
      (m, i) => loaded[i]?.identity === identity(m) && !!loaded[i]?.subject,
    );
  const firstFrame = useRef(true);
  function fit() {
    if (scene && ready)
      update(scene.fit(shot.members.map((_, i) => loaded[i].subject!.root)));
  }
  useLayoutEffect(() => {
    if (ready && firstFrame.current) {
      firstFrame.current = false;
      fit();
    }
  }, [ready]);
  async function shoot() {
    if (!scene || !ready) return;
    setPlaying(false);
    try {
      const blob = await scene.capture();
      setCandidate(URL.createObjectURL(blob));
      showProof(!!card);
      download(blob, id + "-card.png");
      message("已导出 " + width + " × " + height + " PNG");
    } catch (e) {
      message(String(e));
    }
  }
  function restore(raw: string) {
    const next = readShot(raw, id);
    setPlaying(false);
    firstFrame.current = false;
    setShot(next);
    select(0);
    showProof(false);
    setCandidate("");
    message("已恢复构图");
  }
  function save() {
    setPlaying(false);
    const json = JSON.stringify(shot, null, 2);
    download(
      new Blob([json + "\n"], { type: "application/json" }),
      id + "-shot.json",
    );
    try {
      localStorage.setItem("clash.photo." + id, json);
      setSaved(true);
      message("已保存构图并导出 JSON");
    } catch {
      message("已导出 JSON，可用「打开方案」恢复");
    }
  }
  const fileName = (k: string) =>
    files[k]?.name || k.replace(/^local:[^/]*\//, "");
  return (
    <div className="wb-layout photo-layout">
      <aside className="wb-tools photo-tools">
        <nav className="wb-row">
          {[
            ["members", "成员与动作"],
            ["camera", "机位与光线"],
            ["files", "成片与方案"],
          ].map(([key, name]) => (
            <button
              key={key}
              aria-pressed={section === key}
              onClick={() => setSection(key)}
            >
              {name}
            </button>
          ))}
        </nav>
        {section === "members" && (
          <section>
            <h2>{card?.name ?? objectName(id)} · 成员</h2>
            <div className="wb-row">
              {shot.members.map((m, i) => (
                <button
                  key={i}
                  aria-pressed={i === index}
                  onClick={() => {
                    setPlaying(false);
                    select(i);
                  }}
                >
                  {i + 1} {objectName(m.kind)}
                </button>
              ))}
            </div>
            {member && (
              <>
                <div className="wb-row">
                  {!member.kind.startsWith("local:") &&
                    [0, 1].map((t) => (
                      <button
                        key={t}
                        aria-pressed={member.team === t}
                        onClick={() =>
                          changeMember({ team: t, clip: "", time: 0 })
                        }
                      >
                        {t ? "红方" : "蓝方"}
                      </button>
                    ))}
                  {alternateProfile(member.kind) && (
                    <button
                      aria-pressed={member.alternate}
                      onClick={() =>
                        changeMember({
                          alternate: !member.alternate,
                          clip: "",
                          time: 0,
                        })
                      }
                    >
                      变身形态
                    </button>
                  )}
                  <button
                    onClick={() => {
                      update({
                        members: shot.members.filter((_, i) => i !== index),
                      });
                      setPlaying(false);
                      select(Math.max(0, index - 1));
                    }}
                  >
                    移除成员
                  </button>
                </div>
                {!!subject?.clips.length && (
                  <>
                    <Choice
                      label="摄影动作"
                      value={activeClip}
                      items={subject.clips.map((c) => ({
                        id: c.name,
                        name: c.name,
                      }))}
                      onChange={(clip) => changeMember({ clip, time: 0 })}
                    />
                    <button
                      disabled={!duration}
                      onClick={() => setPlaying(!playing)}
                    >
                      {playing ? "定格动作" : "播放动作"}
                    </button>
                    <Slider
                      name="定格时间（秒）"
                      value={member.time}
                      min={0}
                      max={duration}
                      step={0.001}
                      onChange={(time) => changeMember({ time })}
                    />
                  </>
                )}
                {(
                  [
                    ["x", "横向位置", -4, 4],
                    ["y", "高度", -3, 3],
                    ["z", "纵深", -4, 4],
                    ["yaw", "成员朝向", -180, 180],
                    ["scale", "成员大小", 0.1, 4],
                  ] as const
                ).map(([key, name, min, max]) => (
                  <Slider
                    key={key}
                    name={name}
                    value={member[key]}
                    min={min}
                    max={max}
                    step={key === "yaw" ? 1 : 0.01}
                    onChange={(v) => changeMember({ [key]: v })}
                  />
                ))}
              </>
            )}
            <Choice
              label="添加模型"
              value={source ?? ""}
              items={[
                ...options,
                ...Object.keys(files).map((k) => ({
                  id: k,
                  name: fileName(k),
                })),
              ]}
              onChange={setAddKind}
            />
            <div className="wb-row">
              <button
                disabled={!source || shot.members.length >= 64}
                onClick={() => append(source)}
              >
                添加成员
              </button>
              <button onClick={() => pickFile.current?.click()}>
                打开候选 GLB
              </button>
            </div>
            <input
              hidden
              type="file"
              accept=".glb"
              ref={pickFile}
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (!f) return;
                let k: string;
                try {
                  k = await localKey(f);
                } catch {
                  message("无法读取候选 GLB");
                  return;
                }

                setFiles((old) => ({ ...old, [k]: f }));
                setAddKind(k);
                const i = shot.members.findIndex((m) => m.kind === k);
                if (i < 0) append(k);
                else select(i);
              }}
            />
          </section>
        )}
        {section === "camera" && (
          <section>
            <h2>相机</h2>
            <button disabled={!ready} onClick={fit}>
              完整取景
            </button>
            {(
              [
                ["azimuth", "水平环绕", -180, 180, 1],
                ["elevation", "俯仰", -85, 85, 1],
                ["distance", "镜头距离", 0.8, 12, 0.01],
                ["targetX", "横向取景", -3, 3, 0.01],
                ["targetY", "取景高度", -2, 4, 0.01],
                ["light", "灯光强度", 0.1, 3, 0.01],
              ] as const
            ).map(([key, name, min, max, step]) => (
              <Slider
                key={key}
                name={name}
                value={shot[key]}
                min={min}
                max={max}
                step={step}
                onChange={(v) => update({ [key]: v })}
              />
            ))}
            <details className="photo-color">
              <summary>
                背景色 <span style={{ backgroundColor: shot.background }} />{" "}
                {shot.background}
              </summary>
              {["红", "绿", "蓝"].map((name, i) => {
                const start = 1 + i * 2;
                return (
                  <Slider
                    key={name}
                    name={name}
                    min={0}
                    max={255}
                    step={1}
                    value={parseInt(
                      shot.background.slice(start, start + 2),
                      16,
                    )}
                    onChange={(v) =>
                      update({
                        background:
                          shot.background.slice(0, start) +
                          v.toString(16).padStart(2, "0") +
                          shot.background.slice(start + 2),
                      })
                    }
                  />
                );
              })}
            </details>
            <label>
              <input
                type="checkbox"
                checked={shot.transparent}
                onChange={(e) => update({ transparent: e.target.checked })}
              />
              透明背景
            </label>
            <label>
              <input
                type="checkbox"
                checked={shot.floor}
                onChange={(e) => update({ floor: e.target.checked })}
              />
              显示地面
            </label>
          </section>
        )}
        {section === "files" && (
          <section>
            <h2>构图方案</h2>
            <div className="wb-row">
              <button onClick={save}>保存方案</button>
              <button
                disabled={!saved}
                onClick={() => {
                  try {
                    restore(localStorage.getItem("clash.photo." + id) ?? "");
                  } catch (e) {
                    message(String(e));
                  }
                }}
              >
                恢复已存方案
              </button>
              <button onClick={() => pickRecipe.current?.click()}>
                打开方案
              </button>
              <input
                hidden
                type="file"
                accept=".json"
                ref={pickRecipe}
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f)
                    try {
                      restore(await f.text());
                    } catch (err) {
                      message(String(err));
                    }
                }}
              />
            </div>
          </section>
        )}
        <footer className="wb-row">
          <button className="gold" disabled={!ready} onClick={shoot}>
            拍摄卡面 PNG
          </button>
          {card && (
            <button aria-pressed={proof} onClick={() => showProof(!proof)}>
              {proof ? "返回取景" : "查看卡槽裁切"}
            </button>
          )}
        </footer>
        <p role="status">{status}</p>
        {(failure || Object.values(loaded).some((v) => v.error)) && (
          <p role="alert">
            {failure || Object.values(loaded).find((v) => v.error)?.error}
          </p>
        )}
        {!shot.members.length && (
          <p>可添加模型，或打开本地候选 GLB 开始取景。</p>
        )}
      </aside>
      <section className="wb-display photo-stage">
        <canvas
          hidden={proof}
          ref={canvas}
          aria-label="卡面取景"
          onPointerDown={(e) => {
            drag.current = {
              x: e.clientX,
              y: e.clientY,
              a: shot.azimuth,
              e: shot.elevation,
            };
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (d)
              update({
                azimuth: ((d.a - (e.clientX - d.x) * 0.5 + 540) % 360) - 180,
                elevation: Math.max(
                  -85,
                  Math.min(85, d.e + (e.clientY - d.y) * 0.4),
                ),
              });
          }}
          onPointerUp={() => (drag.current = null)}
          onPointerCancel={() => (drag.current = null)}
          onWheel={(e) =>
            update({
              distance: Math.max(
                0.8,
                Math.min(12, shot.distance * Math.exp(e.deltaY * 0.001)),
              ),
            })
          }
        />
        {scene &&
          shot.members.map((m, i) => (
            <SubjectView
              key={i + identity(m)}
              member={m}
              scene={scene}
              index={i}
              light={shot.light}
              file={files[m.kind]}
              report={report}
            />
          ))}
        {proof && card && (
          <div className="photo-proof" aria-label="卡面裁切对照">
            <h2>
              {candidate ? "本次成片" : "当前正式卡面"} · {card.name}
            </h2>
            <figure>
              <div className="prep-collection">
                <div className="prep-card">
                  <Face card={card} preview={candidate} />
                </div>
              </div>
              <figcaption>卡池</figcaption>
            </figure>
            <figure>
              <div className="prep-identity">
                <div className="prep-card">
                  <Face card={card} preview={candidate} />
                </div>
              </div>
              <figcaption>详情</figcaption>
            </figure>
            <figure>
              <div className="battle-card">
                <BattleCardFace
                  card={card}
                  cost={card.cost}
                  preview={candidate}
                />
              </div>
              <figcaption>手牌</figcaption>
            </figure>
          </div>
        )}
      </section>
    </div>
  );
}
