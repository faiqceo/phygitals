import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "phygitals-bot-test-"));
process.env.BOT_TOKEN = "111111:test-token-not-a-real-bot-token";
process.env.APP_URL = "https://packs.example.com/some/path";
process.env.DATABASE_PATH = path.join(dataDir, "bot.sqlite");

// Capture every call the bot makes to the Telegram API instead of hitting the network.
const telegramCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (String(url).startsWith("https://api.telegram.org/")) {
    telegramCalls.push({
      method: String(url).split("/").pop(),
      body: JSON.parse(options.body),
    });
    return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
  }
  return realFetch(url, options);
};

const { app, bot } = await import("./server.js");
const { welcomeText, normalizeAppUrl } = await import("./bot.js");
let server, baseUrl;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const update = (text, extra = {}) => ({
  update_id: 1,
  message: {
    message_id: 1,
    text,
    chat: { id: 42, type: "private" },
    from: { id: 42, first_name: "Ada" },
    ...extra,
  },
});
const post = (body, secret = bot.secret) =>
  fetch(`${baseUrl}/telegram/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(secret ? { "X-Telegram-Bot-Api-Secret-Token": secret } : {}),
    },
    body: JSON.stringify(body),
  });
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

test("app URL is reduced to a clean https origin", () => {
  assert.equal(bot.origin, "https://packs.example.com");
  assert.equal(normalizeAppUrl("http://insecure.example.com"), "");
  assert.equal(normalizeAppUrl("my-app.up.railway.app"), "https://my-app.up.railway.app");
  assert.equal(normalizeAppUrl(""), "");
});

test("/start sends a welcome message with a Mini App button", async () => {
  telegramCalls.length = 0;
  const res = await post(update("/start"));
  assert.equal(res.status, 200);
  await settle();
  assert.equal(telegramCalls.length, 1);
  const { method, body } = telegramCalls[0];
  assert.equal(method, "sendMessage");
  assert.equal(body.chat_id, 42);
  assert.match(body.text, /Welcome to Phygitals Ada!/);
  assert.equal(body.parse_mode, "HTML");
  const button = body.reply_markup.inline_keyboard[0][0];
  assert.equal(button.web_app.url, "https://packs.example.com/");
});

test("/start with a referral code passes it to the Mini App as ?ref=", async () => {
  telegramCalls.length = 0;
  await post(update("/start 06BFAD705AF6"));
  await settle();
  const url = telegramCalls[0].body.reply_markup.inline_keyboard[0][0].web_app.url;
  assert.equal(url, "https://packs.example.com/?ref=06bfad705af6");
});

test("/start@BotName works and junk payloads are not forwarded", async () => {
  telegramCalls.length = 0;
  await post(update("/start@Phygitalls_bot"));
  await post(update('/start "><script>'));
  await settle();
  assert.equal(telegramCalls.length, 2);
  for (const call of telegramCalls)
    assert.equal(
      call.body.reply_markup.inline_keyboard[0][0].web_app.url,
      "https://packs.example.com/",
    );
});

test("names are HTML-escaped in the welcome text", () => {
  assert.match(welcomeText("<b>x</b>"), /&lt;b&gt;x&lt;\/b&gt;/);
});

test("other private messages get a nudge; group chats are ignored", async () => {
  telegramCalls.length = 0;
  await post(update("hello"));
  await post(update("/start", { chat: { id: -100, type: "supergroup" } }));
  await settle();
  assert.equal(telegramCalls.length, 1);
  assert.match(telegramCalls[0].body.text, /Tap the button/);
});

test("webhook rejects requests without the correct secret", async () => {
  telegramCalls.length = 0;
  assert.equal((await post(update("/start"), "")).status, 401);
  assert.equal((await post(update("/start"), "wrong")).status, 401);
  await settle();
  assert.equal(telegramCalls.length, 0);
});

test("setup registers webhook, command, menu button and descriptions", async () => {
  telegramCalls.length = 0;
  const result = await bot.setup();
  assert.deepEqual(
    telegramCalls.map((c) => c.method),
    ["setWebhook", "setMyCommands", "setChatMenuButton", "setMyDescription", "setMyShortDescription"],
  );
  assert.equal(telegramCalls[0].body.url, "https://packs.example.com/telegram/webhook");
  assert.equal(telegramCalls[0].body.secret_token, bot.secret);
  assert.equal(telegramCalls[1].body.commands[0].command, "start");
  assert.equal(telegramCalls[2].body.menu_button.web_app.url, "https://packs.example.com/");
  assert.equal(result.webhook, true);
});