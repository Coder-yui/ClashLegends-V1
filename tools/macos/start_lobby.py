"""Prepare the local developer host for the macOS launcher."""
import fcntl
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import time
from http.client import HTTPConnection

ROOT = Path(__file__).resolve().parents[2]
LOCAL = ROOT / ".local/desktop"
BINARY = ROOT / "target/debug/clash-lobby"
PORT = 4317
DATABASE = "clashlegends-v1-lobby-db"


def run(*args, **opts):
    return subprocess.run(args, cwd=ROOT, check=True, **opts)


def listening(port):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.5):
            return True
    except OSError:
        return False


def database():
    if listening(55432):
        return
    if shutil.which("orb") and subprocess.run(
        ["docker", "info"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    ).returncode:
        run("orb", "start")
    names = run("docker", "container", "ls", "-a", "--format", "{{.Names}}", capture_output=True, text=True).stdout.splitlines()
    if DATABASE in names:
        run("docker", "start", DATABASE)
    else:
        run("docker", "run", "-d", "--name", DATABASE, "-p", "127.0.0.1:55432:5432",
            "-e", "POSTGRES_USER=clash_lobby", "-e", "POSTGRES_PASSWORD=clash_local_dev",
            "-e", "POSTGRES_DB=clash_lobby", "-v", "clashlegends_v1_lobby_pgdata:/var/lib/postgresql/data",
            "postgres:16-alpine")
    for _ in range(80):
        if subprocess.run(["docker", "exec", DATABASE, "pg_isready", "-U", "clash_lobby"],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
            return
        time.sleep(0.5)
    raise RuntimeError("开发数据库尚未就绪。")


def build():
    web = ROOT / "web"
    if not (web / "node_modules/.bin/vite").exists():
        run("npm", "--prefix", "web", "ci")
    index = web / "dist/index.html"
    inputs = [web / name for name in ("index.html", "package.json", "package-lock.json", "vite.config.ts", "tsconfig.json")]
    for folder in ("src", "public"):
        inputs.extend((web / folder).rglob("*"))
    if not index.exists() or any(p.exists() and p.stat().st_mtime > index.stat().st_mtime for p in inputs):
        run("npm", "--prefix", "web", "run", "build")
    run("cargo", "build", "--locked", "-p", "clash-lobby")


def project_listener():
    pids = subprocess.run(["/usr/sbin/lsof", "-nP", "-iTCP:4317", "-sTCP:LISTEN", "-t"],
                          capture_output=True, text=True).stdout.split()
    if len(set(pids)) != 1:
        return None
    pid = int(pids[0])
    files = run("/usr/sbin/lsof", "-a", "-p", str(pid), "-d", "cwd,txt", "-Fn", capture_output=True, text=True).stdout.splitlines()
    return pid if "n" + str(ROOT) in files and "n" + str(BINARY) in files else None


def ready():
    conn = HTTPConnection("127.0.0.1", PORT, timeout=2)
    try:
        conn.request("GET", "/api/battle/catalog")
        response = conn.getresponse()
        return response.status == 200 and json.load(response).get("workbench") is True
    except (OSError, ValueError):
        return False
    finally:
        conn.close()


def start():
    database()
    registry = ROOT / ".local/accounts/registry.json"
    if not registry.parent.exists():
        run(sys.executable, "tools/provision_accounts.py")
    if not registry.is_file() or not (registry.parent / "login-keys.txt").is_file():
        raise RuntimeError("请检查 .local/accounts 中的账号登记表和本机登录密钥。")
    build()
    state = LOCAL / "host.json"
    if listening(PORT):
        pid = project_listener()
        if not pid:
            raise RuntimeError("4317 端口已由其他服务使用。")
        saved = json.loads(state.read_text()) if state.exists() else {}
        if saved.get("pid") != pid:
            if ready():
                return
            raise RuntimeError("请先关闭当前手动启动的大厅，再双击桌面图标。")
        if saved.get("build") == BINARY.stat().st_mtime_ns and ready():
            return
        os.kill(pid, signal.SIGTERM)
        for _ in range(100):
            if not listening(PORT):
                break
            time.sleep(0.1)
        if listening(PORT):
            raise RuntimeError("旧版开发服务仍在运行。")
    env = dict(os.environ, LOBBY_ADDR="0.0.0.0:4317", LOBBY_WORKBENCH="1",
               LOBBY_ACCOUNTS_FILE=str(registry),
               DATABASE_URL="postgresql://clash_lobby:clash_local_dev@127.0.0.1:55432/clash_lobby")
    with (LOCAL / "server.log").open("ab") as log:
        proc = subprocess.Popen([BINARY], cwd=ROOT, env=env, stdin=subprocess.DEVNULL,
                                stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    for _ in range(100):
        if proc.poll() is not None:
            break
        if ready() and project_listener() == proc.pid:
            state.write_text(json.dumps({"pid": proc.pid, "build": BINARY.stat().st_mtime_ns}))
            return
        time.sleep(0.1)
    raise RuntimeError("大厅启动失败，请查看 .local/desktop/server.log。")


if __name__ == "__main__":
    os.umask(0o077)
    LOCAL.mkdir(parents=True, exist_ok=True)
    os.environ["PATH"] = os.pathsep.join([str(Path.home() / ".cargo/bin"), "/opt/homebrew/opt/rustup/bin",
                                         "/opt/homebrew/bin", "/usr/local/bin", os.environ.get("PATH", "/usr/bin:/bin")])
    with (LOCAL / "startup.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            start()
            from phone import PHONE, ensure_gateway
            if (PHONE / "tls/host").is_file():
                try:
                    ensure_gateway()
                except Exception as exc:
                    print(f"手机 HTTPS 服务未启动：{exc}", file=sys.stderr)
        except Exception as exc:
            sys.exit(str(exc))
