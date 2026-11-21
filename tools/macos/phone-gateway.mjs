// HTTPS for the local development phone. Keep the lobby's HTTP and WebSocket routes.
import https from "node:https";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import { createHash } from "node:crypto";

const authority = process.argv[2] + ":4319";
const origin = "https://" + authority;

const server = https.createServer({
  key: fs.readFileSync("tls/server.key"), cert: fs.readFileSync("tls/server.pem"),
  minVersion: "TLSv1.2",
}, (request, response) => {
  if (request.headers.host?.toLowerCase() !== authority) {
    response.writeHead(421).end();
    return;
  }
  if (request.url === "/play/phone/") {
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'none'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    }).end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ClashLegends</title><p>正在打开管理员大厅…</p><a hidden href="/play/">进入普通大厅</a><script src="/play/phone/launch.js"></script></html>');
    return;
  }
  if (request.url === "/play/phone/launch.js") {
    response.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-store" })
      .end(fs.readFileSync(new URL("./phone-launch.js", import.meta.url)));
    return;
  }
  if (request.url === "/play/phone/activate") {
    // A custom header keeps the ticket out of URLs, access logs and referrers.
    const ticket = request.headers["x-clash-pair"];
    if (request.method !== "POST" || request.headers.origin !== origin ||
        typeof ticket !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) {
      response.writeHead(403).end();
      return;
    }
    try {
      // Synchronous check and unlink make redemption single-use within this listener.
      const pending = "tickets/" + createHash("sha256").update(ticket).digest("hex");
      const entry = JSON.parse(fs.readFileSync(pending));
      if (Date.now() < entry.until) {
        fs.unlinkSync(pending);
        response.writeHead(204, {
          "Set-Cookie": "clash_account=" + entry.session + "; Secure; HttpOnly; Path=/; SameSite=Strict; Max-Age=2592000",
          "Cache-Control": "no-store",
        }).end();
        return;
      }
    } catch (error) {
      if (error.code !== "ENOENT") console.error("无法读取手机配对记录");
    }
    response.writeHead(403, { "Cache-Control": "no-store" }).end();
    return;
  }

  const upstream = http.request({ hostname: "127.0.0.1", port: 4317,
    path: request.url, method: request.method, headers: request.headers }, (reply) => {
    response.writeHead(reply.statusCode, reply.headers);
    reply.on("error", () => response.destroy());
    reply.pipe(response);
  });
  upstream.on("error", () => {
    if (!response.headersSent) response.writeHead(502);
    response.end();
  });
  response.on("close", () => upstream.destroy());
  request.pipe(upstream);
});

server.on("upgrade", (request, socket, head) => {
  if (request.headers.host?.toLowerCase() !== authority || request.headers.origin !== origin ||
      request.headers.upgrade?.toLowerCase() !== "websocket" || !request.url.startsWith("/api/")) {
    socket.destroy();
    return;
  }
  const upstream = net.connect(4317, "127.0.0.1", () => {
    const headerLines = Object.entries(request.headers).map(([name, value]) => name + ": " + value);
    upstream.write(["GET " + request.url + " HTTP/1.1", ...headerLines, "", ""].join("\r\n"));
    if (head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  socket.on("error", () => upstream.destroy());
  upstream.on("error", () => socket.destroy());
  socket.on("close", () => upstream.destroy());
  upstream.on("close", () => socket.destroy());
});
server.listen(4319, "0.0.0.0");
