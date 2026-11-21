"""Generate a private iPhone installation profile for the local development lobby."""
import fcntl
import hashlib
from http.client import HTTPConnection
from http.cookies import SimpleCookie
import json
import os
from pathlib import Path
import plistlib
import re
import secrets
import shutil
import socket
import ssl
import subprocess
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
PHONE = ROOT / ".local/phone"
TLS = PHONE / "tls"
PROFILE = PHONE / "ClashLegends.mobileconfig"
GATEWAY = ROOT / "tools/macos/phone-gateway.mjs"


def hostname():
    label = subprocess.check_output(["/usr/sbin/scutil", "--get", "LocalHostName"], text=True).strip().lower()
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,61}[a-z0-9]|[a-z0-9]", label):
        raise RuntimeError("请检查 Mac 的本地主机名。")
    return label + ".local"


def certificates(host):
    # The issuing private key lives only in the temporary directory and is discarded.
    openssl = shutil.which("openssl")
    if TLS.is_dir() and (TLS / "host").read_text() == host and subprocess.run(
        [openssl, "x509", "-in", TLS / "server.pem", "-noout", "-checkend", "86400"],
        stdout=subprocess.DEVNULL,
    ).returncode == 0:
        return
    with tempfile.TemporaryDirectory(dir=PHONE) as tmp:
        folder = Path(tmp)
        def cert(*args):
            subprocess.run([openssl, *args], cwd=folder, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        ca = folder / "ca.cnf"
        ca.write_text(f"""[req]
distinguished_name = dn
prompt = no
x509_extensions = ca
[dn]
CN = ClashLegends Local Game
[ca]
basicConstraints = critical,CA:TRUE,pathlen:0
keyUsage = critical,keyCertSign
subjectKeyIdentifier = hash
nameConstraints = critical,permitted;DNS:{host}
""")
        (folder / "leaf.cnf").write_text(f"""basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:{host}
authorityKeyIdentifier=keyid
""")
        cert("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "400", "-config", "ca.cnf",
             "-keyout", "issuer.key", "-out", "ca.pem")
        cert("req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=" + host,
             "-keyout", "server.key", "-out", "server.csr")
        cert("x509", "-req", "-in", "server.csr", "-CA", "ca.pem", "-CAkey", "issuer.key",
             "-CAcreateserial", "-sha256", "-days", "365", "-extfile", "leaf.cnf", "-out", "server.pem")
        cert("verify", "-CAfile", "ca.pem", "server.pem")
        (folder / "host").write_text(host)
        TLS.mkdir(exist_ok=True)
        for name in ("ca.pem", "server.key", "server.pem", "host"):
            os.replace(folder / name, TLS / name)


def gateway_ready(host):
    context = ssl.create_default_context(cafile=str(TLS / "ca.pem"))
    try:
        with socket.create_connection(("127.0.0.1", 4319), timeout=1) as raw:
            with context.wrap_socket(raw, server_hostname=host) as conn:
                conn.sendall(f"HEAD /play/phone/ HTTP/1.1\r\nHost: {host}:4319\r\nConnection: close\r\n\r\n".encode())
                return conn.recv(64).startswith(b"HTTP/1.1 200 ")
    except OSError:
        return False


def ensure_gateway():
    with (PHONE / "gateway.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        host = hostname()
        certificates(host)
        if gateway_ready(host):
            return host
        # Replace only our previous listener, for example after a Mac hostname change.
        args = subprocess.run(["/usr/sbin/lsof", "-nP", "-iTCP:4319", "-sTCP:LISTEN", "-t"],
                              capture_output=True, text=True).stdout.split()
        if args:
            pid = int(args[0])
            command = subprocess.check_output(["/bin/ps", "-p", str(pid), "-o", "command="], text=True)
            if len(set(args)) != 1 or str(GATEWAY) not in command.split():
                raise RuntimeError("手机开发服务的 4319 端口已被其他应用占用。")
            os.kill(pid, 15)
            for _ in range(40):
                if subprocess.run(["/bin/ps", "-p", str(pid)], stdout=subprocess.DEVNULL).returncode:
                    break
                time.sleep(.05)
        with (PHONE / "gateway.log").open("ab") as log:
            child = subprocess.Popen([shutil.which("node") or "/opt/homebrew/bin/node", GATEWAY, host],
                                     cwd=PHONE, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
        for _ in range(50):
            if gateway_ready(host):
                return host
            if child.poll() is not None:
                break
            time.sleep(.1)
        raise RuntimeError("手机 HTTPS 服务启动失败，请检查 .local/phone/gateway.log。")


def session():
    # Only send local credentials to the running binary from this checkout.
    from start_lobby import project_listener
    if not project_listener():
        raise RuntimeError("请先打开桌面的 ClashLegends。")
    keys = dict(line.split("\t", 1) for line in (ROOT / ".local/accounts/login-keys.txt").read_text().splitlines())
    client = HTTPConnection("127.0.0.1", 4317, timeout=5)
    try:
        client.request("POST", "/api/account/login", json.dumps({"name": "admin", "key": keys["admin"]}),
                       {"Content-Type": "application/json"})
        response = client.getresponse()
        if response.status != 200:
            raise RuntimeError("本机管理员登录失败，请重新打开桌面游戏。")
        cookie = SimpleCookie(response.getheader("Set-Cookie"))["clash_account"].value
        return str(uuid.UUID(cookie))
    finally:
        client.close()


def payload(kind, suffix, title, **fields):
    identifier = "local.clashlegends.phone" + suffix
    return dict(PayloadType=kind, PayloadIdentifier=identifier, PayloadDisplayName=title, PayloadVersion=1,
                PayloadUUID=str(uuid.uuid5(uuid.NAMESPACE_DNS, identifier)).upper(), **fields)


def install_profile():
    host = ensure_gateway()
    ticket = secrets.token_urlsafe(32)
    tickets = PHONE / "tickets"
    tickets.mkdir(exist_ok=True)
    now = time.time()
    for old in tickets.iterdir():
        try:
            if old.stat().st_mtime < now - 86400:
                old.unlink()
        except FileNotFoundError:
            pass  # The phone redeemed it concurrently.
    entry = dict(until=int((now + 86400) * 1000), session=session())
    ca = ssl.PEM_cert_to_DER_cert((TLS / "ca.pem").read_text())
    profile = payload("Configuration", "", "ClashLegends 本地开发", PayloadContent=[
        payload("com.apple.security.root", ".ca", "ClashLegends Local Game", PayloadContent=ca),
        payload("com.apple.webClip.managed", ".icon", "ClashLegends", Label="ClashLegends",
                URL=f"https://{host}:4319/play/phone/#{ticket}", FullScreen=True, IgnoreManifestScope=True, IsRemovable=True,
                Precomposed=True, Icon=(ROOT / "web/public/media/game-icon.png").read_bytes()),
    ])
    with (PHONE / "profile.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        data = plistlib.dumps(profile)
        (tickets / hashlib.sha256(ticket.encode()).hexdigest()).write_text(json.dumps(entry))
        tmp = PROFILE.with_suffix(".tmp")
        tmp.write_bytes(data)
        tmp.replace(PROFILE)
    return PROFILE


if __name__ == "__main__":
    os.umask(0o077)
    PHONE.mkdir(parents=True, exist_ok=True)
    print(install_profile())
