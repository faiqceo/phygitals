// phygitals/bot.js
// Telegram bot: answers /start with a welcome message and an "Open" button that
// launches the Mini App. Uses the Bot API over plain fetch (no extra dependency).
import crypto from "node:crypto";

const TELEGRAM_API = "https://api.telegram.org";
const REF_PATTERN = /^[a-f0-9]{12}$/i; // same shape the server accepts as a referral code

export const BUTTON_TEXT = "🎴 Open Phygitals";

const escapeHtml = (value) =>
  String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function welcomeText(firstName) {
  const name = firstName ? ` ${escapeHtml(firstName).slice(0, 64)}` : "";
  return [
    `👋 <b>Welcome to Phygitals${name}!</b>`,
    "",
    "⚽ Open football card packs and build your collection.",
    "🎁 Invite friends: you both get <b>$1</b> in pack credits.",
    "💳 Add funds and manage your wallet right inside the app.",
    "",
    "Tap the button below to start 👇",
    "",
    "<i>18+ only.</i>",
  ].join("\n");
}

export const NUDGE_TEXT = "Tap the button below to open Phygitals 👇";

/* Turns whatever the host gave us into a clean https origin, or "" if unusable.
   Telegram only opens Mini Apps over HTTPS. */
export function normalizeAppUrl(value) {
  if (!value) return "";
  const text = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(text);
    if (url.protocol !== "https:") return "";
    return url.origin;
  } catch {
    return "";
  }
}

export function createBot({
  token,
  appUrl,
  webhookSecret,
  fetchImpl = (...args) => globalThis.fetch(...args),
  log = console,
}) {
  const origin = normalizeAppUrl(appUrl);
  const enabled = Boolean(token && origin);
  const secret =
    webhookSecret ||
    (token ? crypto.createHmac("sha256", token).update("telegram-webhook").digest("hex") : "");

  async function call(method, payload) {
    const response = await fetchImpl(`${TELEGRAM_API}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok)
      throw new Error(`Telegram ${method} failed: ${data.description || response.status}`);
    return data.result;
  }

  /* The Mini App URL, optionally carrying a referral code the front end reads from ?ref= */
  function miniAppUrl(ref) {
    const url = new URL("/", origin);
    if (ref && REF_PATTERN.test(ref)) url.searchParams.set("ref", ref.toLowerCase());
    return url.toString();
  }

  const keyboard = (ref) => ({
    inline_keyboard: [[{ text: BUTTON_TEXT, web_app: { url: miniAppUrl(ref) } }]],
  });

  async function handleMessage(message) {
    // web_app buttons only work in private chats
    if (!message || message.chat?.type !== "private" || typeof message.text !== "string")
      return;
    const chatId = message.chat.id;
    const start = message.text.trim().match(/^\/start(?:@\w+)?(?:\s+(\S+))?$/i);
    if (start) {
      await call("sendMessage", {
        chat_id: chatId,
        text: welcomeText(message.from?.first_name),
        parse_mode: "HTML",
        reply_markup: keyboard(start[1]),
      });
      return;
    }
    await call("sendMessage", {
      chat_id: chatId,
      text: NUDGE_TEXT,
      reply_markup: keyboard(),
    });
  }

  async function handleUpdate(update) {
    if (!enabled || !update?.message) return;
    try {
      await handleMessage(update.message);
    } catch (error) {
      log.error("Telegram update failed:", error.message);
    }
  }

  /* Registers the webhook, /start command, menu button and bot description. Each step is
     independent so one failure does not block the rest. */
  async function setup() {
    if (!enabled) return { enabled: false };
    const steps = {
      webhook: () =>
        call("setWebhook", {
          url: `${origin}/telegram/webhook`,
          secret_token: secret,
          allowed_updates: ["message"],
        }),
      commands: () =>
        call("setMyCommands", {
          commands: [{ command: "start", description: "Open Phygitals" }],
        }),
      menuButton: () =>
        call("setChatMenuButton", {
          menu_button: { type: "web_app", text: "Play", web_app: { url: miniAppUrl() } },
        }),
      description: () =>
        call("setMyDescription", {
          description:
            "Open football card packs, build your collection and earn rewards by inviting friends. Press Start to begin.",
        }),
      shortDescription: () =>
        call("setMyShortDescription", { short_description: "Football card packs on Telegram." }),
    };
    const results = {};
    for (const [name, run] of Object.entries(steps)) {
      try {
        await run();
        results[name] = true;
      } catch (error) {
        results[name] = false;
        log.error(`Telegram setup (${name}) failed:`, error.message);
      }
    }
    return { enabled: true, ...results };
  }

  return { enabled, origin, secret, miniAppUrl, handleUpdate, setup };
}