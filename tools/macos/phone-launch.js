// Runs inside the installed Home Screen app so its own cookie store receives the session.
(async () => {
  const ticket = location.hash.slice(1);
  history.replaceState(null, "", location.pathname);
  async function isAdmin() {
    const response = await fetch("/api/session", { cache: "no-store" });
    if (!response.ok) throw new Error("暂时无法连接大厅，请确认 Mac 上的游戏已经启动。");
    return (await response.json()).role === "admin";
  }
  if (!(await isAdmin())) {
    const paired = await fetch("/play/phone/activate", { method: "POST", headers: { "X-Clash-Pair": ticket } });
    if (!paired.ok || !(await isAdmin())) {
      throw new Error("请在 Mac 上重新生成手机安装文件，通过隔空投送安装后再打开图标。");
    }
  }
  location.replace("/play/");
})().catch((error) => {
  document.querySelector("p").textContent = error.message;
  document.querySelector("a").hidden = false;
});
