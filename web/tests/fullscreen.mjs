import assert from "node:assert/strict";
import { chromium, devices } from "playwright-core";

const baseURL = process.env.LOBBY_URL ?? "http://127.0.0.1:4317";
const browser = await chromium.launch({ channel: "chrome" });
const button = (page, name) => page.getByRole("button", { name, exact: true });

try {
  for (const mobile of [false, true]) {
    const page = await browser.newPage({
      ...(mobile
        ? devices["Pixel 7"]
        : { viewport: { width: 1280, height: 800 } }),
      baseURL,
    });
    page.setDefaultTimeout(15000);
    let battleSocket;
    page.on("websocket", (socket) => {
      if (socket.url().includes("/api/matches/")) battleSocket = socket;
    });
    await page.goto("/play/");
    await button(page, "进入全屏").click();
    await page.waitForFunction(
      () => document.fullscreenElement === document.documentElement,
    );
    await button(page, "对战 AI →").click();
    await button(page, "进入备战 →").click();
    await page.locator(".prep-header").waitFor();
    await button(page, "退出全屏").click();
    await page.waitForFunction(() => !document.fullscreenElement);
    await button(page, "进入全屏").click();
    await button(page, "开始游戏").click();
    await page.locator(".match-loading").waitFor();
    const hand = page.locator(".battle-hand button:enabled:not(.unaffordable)");
    await hand.first().waitFor();
    await hand.first().click();
    const field = page.locator(".battle-input");
    const box = await field.boundingBox();
    const accepted = battleSocket.waitForEvent("framereceived", {
      predicate: ({ payload }) => JSON.parse(payload).type === "receipt",
    });
    await field.click({
      position: { x: box.width * 0.25, y: box.height * 0.65 },
    });
    const receipt = JSON.parse((await accepted).payload);
    assert.equal(receipt.error, null);
    await page.waitForFunction(
      (tick) =>
        Number(document.querySelector(".battle-input").dataset.tick) >= tick,
      receipt.executeTick,
    );
    await button(page, "退出全屏").waitFor();
    if (mobile) {
      await page.setViewportSize({ width: 844, height: 390 });
      const title = await page.locator(".battle-title").boundingBox();
      const timer = await page.locator(".battle-time").boundingBox();
      assert.ok(title.x + title.width <= timer.x, "横屏顶栏应留出计时器空间");
    }
    await page.evaluate(() => document.exitFullscreen());
    await button(page, "进入全屏").click();
    await button(page, "退出全屏").click();
    assert.equal(await page.evaluate(() => document.fullscreenElement), null);
    await page.close();
  }

  const phone = await browser.newPage({ ...devices["iPhone 13"], baseURL });
  await phone.addInitScript(() => {
    Object.defineProperty(document, "fullscreenEnabled", { value: false });
    Object.defineProperty(document, "webkitFullscreenEnabled", {
      value: false,
    });
  });
  await phone.goto("/play/");
  await button(phone, "进入全屏").click();
  const help = phone.getByRole("dialog", { name: "全屏游玩" });
  await help.getByText(/添加到主屏幕/).waitFor();
  await help.getByRole("button", { name: "关闭" }).click();
  await phone.addInitScript(() =>
    Object.defineProperty(navigator, "standalone", { value: true }),
  );
  await phone.reload();
  await phone.getByRole("heading", { name: "对战大厅" }).waitFor();
  assert.equal(await button(phone, "进入全屏").count(), 0);
  const manifestURL = await phone
    .locator('link[rel="manifest"]')
    .evaluate((link) => link.href);
  const manifest = await (await phone.request.get(manifestURL)).json();
  assert.equal(manifest.display, "fullscreen");
  assert.equal(manifest.start_url, "/play/");
  for (const icon of manifest.icons) {
    const response = await phone.request.get(
      new URL(icon.src, manifestURL).href,
    );
    assert.equal(response.headers()["content-type"], "image/png");
  }
  console.log(
    "Desktop and mobile fullscreen across lobby, preparation and battle, external exit, iPhone guidance and launch manifest passed.",
  );
} finally {
  await browser.close();
}
