import { useRef, useState } from "react";
import { api, type Catalog, type Session } from "./api";
import { cardArt } from "./card-art";
import { Modal } from "./controls";
import { saveField } from "./player-data";
import { flushPreferences } from "./preferences";

export function avatarImage(id: string | undefined, catalog?: Catalog) {
  if (id?.startsWith("data:image/webp;base64,")) return id;
  const c = catalog?.cards.find((c) => c.id === id);
  return c ? cardArt(c, true) : "/play/media/crest.webp";
}
async function importAvatar(file: File) {
  if (
    !["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
    file.size > 8 * 1024 * 1024
  )
    throw new Error("请选择 8 MB 以内的 PNG、JPEG 或 WebP 图片");
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 128;
    const size = Math.min(bitmap.width, bitmap.height);
    canvas
      .getContext("2d")!
      .drawImage(
        bitmap,
        (bitmap.width - size) / 2,
        (bitmap.height - size) / 2,
        size,
        size,
        0,
        0,
        128,
        128,
      );
    const data = canvas.toDataURL("image/webp", 0.8);
    if (!data.startsWith("data:image/webp;base64,") || data.length > 60000)
      throw new Error("无法处理这张图片");
    return data;
  } finally {
    bitmap.close();
  }
}
export function PlayerProfile({
  session,
  catalog,
  reload,
  close,
}: {
  session: Session;
  catalog: Catalog;
  reload: () => Promise<void>;
  close: () => void;
}) {
  const [before] = useState(session.fields?.profile ?? null);
  const [avatar, setAvatar] = useState(before?.avatar ?? ""),
    [bio, setBio] = useState(before?.bio ?? "");
  const [login, showLogin] = useState(false),
    [name, setName] = useState(""),
    [key, setKey] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const upload = useRef<HTMLInputElement>(null);
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function switchUser(path: string, data: object) {
    await run(async () => {
      await flushPreferences();
      await api("account/" + path, data);
      try {
        localStorage.setItem("clashlegends.identity", String(Date.now()));
      } catch {}
      location.reload();
    });
  }
  return (
    <Modal
      title={login ? "内测账号登录" : "玩家资料"}
      onClose={() => {
        if (!busy) close();
      }}
    >
      {login ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void switchUser("login", { name: name.trim(), key: key.trim() });
          }}
        >
          <label>
            账号
            <input
              required
              autoComplete="username"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            登录密钥
            <input
              required
              type="password"
              autoComplete="current-password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
          </label>
          <div className="footer-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                showLogin(false);
                setError("");
              }}
            >
              返回
            </button>
            <button className="gold" disabled={busy}>
              登录
            </button>
          </div>
        </form>
      ) : (
        <div className="player-card">
          <div className="player-identity">
            <img src={avatarImage(avatar, catalog)} alt="当前头像" />
            <div>
              <h3>{session.name}</h3>
              <small>
                {session.role === "admin"
                  ? "管理员"
                  : session.role
                    ? "内测玩家"
                    : "游客 · 保存在此浏览器"}
              </small>
            </div>
          </div>
          <fieldset>
            <legend>头像</legend>
            <div className="avatar-choices">
              {["", "ashe", "garen", "anivia", "teemo", "sona"].map((id) => {
                const title =
                  catalog.cards.find((c) => c.id === id)?.name ?? "大厅徽章";
                return (
                  <button
                    key={id}
                    aria-label={title + "头像"}
                    aria-pressed={avatar === id}
                    onClick={() => setAvatar(id)}
                  >
                    <img src={avatarImage(id, catalog)} alt="" />
                  </button>
                );
              })}
            </div>
            <button onClick={() => upload.current?.click()} disabled={busy}>
              上传图片
            </button>
            <input
              hidden
              ref={upload}
              type="file"
              aria-label="上传头像"
              accept="image/png,image/jpeg,image/webp"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file)
                  void run(async () => setAvatar(await importAvatar(file)));
              }}
            />
          </fieldset>
          <label>
            个人简介
            <textarea
              rows={3}
              maxLength={120}
              placeholder="写几句自我介绍"
              value={bio}
              onChange={(e) => setBio(e.target.value)}
            />
          </label>
          <div className="footer-actions">
            {session.accountsEnabled && (
              <button
                disabled={busy}
                onClick={() =>
                  session.role ? void switchUser("logout", {}) : showLogin(true)
                }
              >
                {session.role ? "退出账号" : "内测账号登录"}
              </button>
            )}
            <button
              className="gold"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await saveField(session, "profile", { avatar, bio }, before);
                  await reload();
                  close();
                })
              }
            >
              保存资料
            </button>
          </div>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </Modal>
  );
}
