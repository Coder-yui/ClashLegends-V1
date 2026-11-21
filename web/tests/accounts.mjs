// Run against a disposable account-enabled lobby with keys from provision_accounts.py.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";
const keys = Object.fromEntries(
  (await readFile(process.env.TEST_LOGIN_KEYS, "utf8"))
    .trim()
    .split("\n")
    .map((line) => line.split("\t")),
);
const browser = await chromium.launch({ channel: "chrome" });
const baseURL = process.env.LOBBY_URL ?? "http://127.0.0.1:4317";
const stamp = Date.now().toString(36);
const problems = [];
const button = (p, name) => p.getByRole("button", { name, exact: true });
async function page(mobile = false) {
  const context = await browser.newContext({
    baseURL,
    viewport: mobile
      ? { width: 360, height: 780 }
      : { width: 1120, height: 850 },
    isMobile: mobile,
    hasTouch: mobile,
  });
  const p = await context.newPage();
  p.on("pageerror", (e) => problems.push(e.message));
  await p.goto("/play/");
  await p.getByRole("heading", { name: "对战大厅" }).waitFor();
  return p;
}
async function login(p, name) {
  await button(p, "玩家资料").click();
  await button(p, "内测账号登录").click();
  await p.getByLabel("账号", { exact: true }).fill(name);
  await p.getByLabel("登录密钥").fill(keys[name]);
  await button(p, "登录").click();
  await button(p, "玩家资料").filter({ hasText: name }).waitFor();
}
async function decks(p) {
  await p.getByRole("link", { name: "我的卡组", exact: true }).click();
}
const session = async (p) => (await p.request.get("/api/session")).json();
try {
  const a = await page(true);
  const posts = [];
  a.on("request", (r) => {
    if (r.method() === "POST") posts.push(new URL(r.url()).pathname);
  });
  await button(a, "玩家资料").tap();
  await a.getByLabel("个人简介").fill("本机游客 " + stamp);
  await button(a, "保存资料").tap();
  await decks(a);
  await button(a, "卡组 3").tap();
  await a.getByLabel("卡组名称").fill("游客第三区");
  await button(a, "保存预设").tap();
  await a.getByText("个人预设已保存").waitFor();
  assert.equal((await session(a)).fields, null);
  assert.deepEqual(posts, []);
  const bounds = await a
    .locator(".prep-deck-heading")
    .evaluate((el) =>
      [...el.children].map((c) => [
        c.getBoundingClientRect().left,
        c.getBoundingClientRect().right,
      ]),
    );
  assert.ok(
    bounds.every(
      ([x, y], i) => x >= 0 && y <= 360 && (!i || x >= bounds[i - 1][1] - 1),
    ),
  );
  await a.getByRole("link", { name: "返回大厅" }).tap();
  await login(a, "admin");
  await a.getByRole("link", { name: "开发工作台" }).waitFor();
  await button(a, "玩家资料").tap();
  await a
    .getByLabel("上传头像")
    .setInputFiles(
      new URL("../public/media/game-icon.png", import.meta.url).pathname,
    );
  await a.waitForFunction(() =>
    document
      .querySelector('img[alt="当前头像"]')
      ?.src.startsWith("data:image/webp;base64,"),
  );
  await a.getByLabel("个人简介").fill("管理员 " + stamp);
  await button(a, "保存资料").tap();
  await a.getByRole("dialog").waitFor({ state: "hidden" });
  await button(a, "游戏设置").click();
  await a.getByRole("slider", { name: "总音量" }).fill("42");
  await button(a, "完成").click();
  await decks(a);
  await button(a, "卡组 4").tap();
  await button(a, "随机").tap();
  await a.getByLabel("卡组名称").fill("第四套");
  await button(a, "保存预设").tap();
  await a.getByText("个人预设已保存").waitFor();
  const source = (await session(a)).fields;
  assert.equal(source.active, 3);
  assert.equal(source.preferences.master, 42);
  assert.equal(source.slot3.deck.cards.filter(Boolean).length, 8);
  const b = await page();
  await login(b, "admin");
  assert.deepEqual((await session(b)).fields, source);
  await b.getByRole("heading", { name: "第四套" }).waitFor();
  await button(b, "玩家资料").click();
  assert.equal(await b.getByLabel("个人简介").inputValue(), "管理员 " + stamp);
  assert.ok(
    (await b.locator('img[alt="当前头像"]').getAttribute("src")).startsWith(
      "data:image/webp;base64,",
    ),
  );
  await b.keyboard.press("Escape");
  await button(b, "游戏设置").click();
  assert.equal(
    await b.getByRole("slider", { name: "总音量" }).inputValue(),
    "42",
  );
  await button(b, "完成").click();
  await decks(b);
  await button(b, "随机").hover();
  await b.getByRole("tooltip").waitFor();
  await button(b, "卡组 2").focus();
  await b.keyboard.press("Enter");
  await b.getByLabel("卡组名称").fill("仅为草稿");
  await button(b, "卡组 4").click();
  assert.deepEqual((await session(b)).fields, source);
  await button(b, "卡组 2").click();
  assert.equal(await b.getByLabel("卡组名称").inputValue(), "仅为草稿");
  await button(b, "卡组 4").click();
  await b.getByRole("link", { name: "返回大厅" }).click();
  await button(b, "放弃并离开").click();
  await button(b, "对战 AI →").click();
  await button(b, "进入备战 →").click();
  await b.getByRole("heading", { name: "备战", exact: true }).waitFor();
  const room = await (
    await b.request.get("/api/rooms/" + b.url().split("/").pop())
  ).json();
  assert.deepEqual(room.deck, source.slot3.deck);
  await button(b, "卡组 1").click();
  await button(b, "卡组 2").click();
  assert.equal(await b.locator(".prep-start").isDisabled(), true);
  await button(b, "房间").click();
  await button(b, "离开房间").click();
  await button(b, "确认离开").click();
  await b.getByRole("heading", { name: "对战大厅" }).waitFor();
  await a.getByRole("link", { name: "返回大厅" }).click();
  await button(a, "玩家资料").click();
  await button(a, "退出账号").click();
  await a.getByRole("heading", { name: "游客第三区" }).waitFor();
  await button(a, "玩家资料").tap();
  assert.equal(
    await a.getByLabel("个人简介").inputValue(),
    "本机游客 " + stamp,
  );
  await a.keyboard.press("Escape");
  await login(a, "beta-01");
  assert.equal((await session(a)).role, "beta");
  assert.equal(await a.getByRole("link", { name: "开发工作台" }).count(), 0);
  assert.notEqual((await session(a)).fields.profile?.bio, source.profile.bio);
  const outsider = await page();
  assert.equal(
    (
      await outsider.request.post("/api/account/data", {
        data: {
          owner: "admin",
          field: "profile",
          before: null,
          value: { avatar: "", bio: "x" },
        },
      })
    ).status(),
    401,
  );
  assert.deepEqual(problems, []);
  console.log(
    "Guest local-only writes, four slots, mobile layout, desktop hover and keyboard, uploaded avatar, admin/beta roles, cross-browser settings and room deck verified.",
  );
} finally {
  await browser.close();
}
