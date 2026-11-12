// phygitals/server.js
// phygitals/server.js
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { db, inTransaction, isUnique, DATABASE_SCHEMA } from "./db.js";
import { createBot, normalizeAppUrl } from "./bot.js";
import { PLAYERS_PER_POOL, drawPack, loadPacks, packStatus } from "./packs.js";
import {
  USDC_MINT,
  RpcError,
  createRpc,
  findFeePayment,
  findSolPayment,
  newReference,
  solanaPayUrl,
  solanaPaySolUrl,
} from "./withdrawal-fee.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const HELIUS_AUTH = process.env.HELIUS_AUTH || "";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const APP_ORIGIN = (process.env.APP_ORIGIN || "").trim().replace(/\/+$/, "");
const DEPOSIT_ADDRESS = process.env.DEPOSIT_ADDRESS || "";
/* Public HTTPS address of this server; Telegram needs it for the webhook and the Mini App button.
   Falls back to APP_ORIGIN (if it is an https URL) and to the URLs common hosts provide. */
const APP_URL =
  normalizeAppUrl(process.env.APP_URL) ||
  normalizeAppUrl(APP_ORIGIN) ||
  normalizeAppUrl(process.env.RENDER_EXTERNAL_URL) ||
  normalizeAppUrl(process.env.RAILWAY_PUBLIC_DOMAIN);
const bot = createBot({
  token: BOT_TOKEN,
  appUrl: APP_URL,
  webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || "",
});
const MICRO = 1_000_000;
const REFERRAL_BONUS = MICRO;
const WITHDRAWAL_FEE = 3_290_000;
const MIN_WITHDRAWAL = 10 * MICRO;
/* The $3 is now collected once as the SOL activation fee, so nothing more is deducted per withdrawal. */
const DEFAULT_WHOOP_FEE = 0;
const MAX_WHOOP_FEE = 50 * MICRO;
const CENT = MICRO / 100;
/* Share of a card's value paid when it is sold back, and the smallest house
   edge a pack must keep. A pack whose average payout is too high is switched
   off automatically (see packs.js). */
const CARD_BUYBACK = Number(process.env.CARD_BUYBACK || 0.9);
const MIN_HOUSE_EDGE = Number(process.env.MIN_HOUSE_EDGE ?? 0.05);
const PACKS = loadPacks();
/* Owner override: sell packs even when their average payout is above the price.
   Set ALLOW_UNSAFE_ODDS=1 in .env. The prize pool is not changed. */
const ALLOW_UNSAFE_ODDS = /^(1|true|yes)$/i.test(process.env.ALLOW_UNSAFE_ODDS || "");
const PACK_STATUS = new Map(
  PACKS.map((pack) => {
    const status = packStatus(pack, { buyback: CARD_BUYBACK, minEdge: MIN_HOUSE_EDGE });
    return [
      pack.id,
      ALLOW_UNSAFE_ODDS && !status.available ? { ...status, available: true, unsafe: true } : status,
    ];
  }),
);
const WHOOP_TIMEOUT_MS = 8000;
const WHOOP_FEE_KEY = "whoop_withdrawal_fee_micros";
const MINTS = new Map([
  ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "usdc"],
  ["Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", "usdt"],
]);
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const SOLANA_KEY_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/* Withdrawal processing fee, paid on-chain by the user before a withdrawal is queued.
   Only public values live here: the fee wallet is a receive-only address and the server
   never holds a private key for it. The feature switches on when all of these are valid. */
const FEE_WALLET_ADDRESS = (process.env.FEE_WALLET_ADDRESS || "").trim();
const SOLANA_RPC_URL = (process.env.SOLANA_RPC_URL || "").trim();
const FEE_COMMITMENT = process.env.SOLANA_COMMITMENT === "confirmed" ? "confirmed" : "finalized";
const FEE_TTL_MS = Math.max(5, Number(process.env.FEE_PAYMENT_TTL_MINUTES || 30)) * 60_000;
const FEE_LATE_WINDOW_MS = 24 * 60 * 60_000;
const FEE_PROBLEM =
  !FEE_WALLET_ADDRESS && !SOLANA_RPC_URL
    ? null
    : !isSolanaAddress(FEE_WALLET_ADDRESS)
    ? "FEE_WALLET_ADDRESS is missing or not a valid Solana address"
    : FEE_WALLET_ADDRESS === DEPOSIT_ADDRESS
    ? "FEE_WALLET_ADDRESS must be different from DEPOSIT_ADDRESS"
    : !/^https?:\/\//.test(SOLANA_RPC_URL)
    ? "SOLANA_RPC_URL is missing or not an http(s) URL"
    : null;
const FEE_ENABLED = Boolean(FEE_WALLET_ADDRESS && SOLANA_RPC_URL && !FEE_PROBLEM);
/* One-time activation fee: ~$3 in SOL (0.0365 SOL by default; set SOL_ACTIVATION_LAMPORTS to follow the SOL price). */
const ACTIVATION_LAMPORTS = Math.max(1, Number(process.env.SOL_ACTIVATION_LAMPORTS || 36_500_000));
const ACTIVATION_ENABLED = isSolanaAddress(DEPOSIT_ADDRESS) && /^https?:\/\//.test(SOLANA_RPC_URL);
const activationRpc = ACTIVATION_ENABLED ? createRpc({ url: SOLANA_RPC_URL, commitment: FEE_COMMITMENT }) : null;
const feeRpc = FEE_ENABLED ? createRpc({ url: SOLANA_RPC_URL, commitment: FEE_COMMITMENT }) : null;

async function initDb() {
  if (DATABASE_SCHEMA) await db.exec(`CREATE SCHEMA IF NOT EXISTS "${DATABASE_SCHEMA}"`);
  await db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    telegram_id TEXT PRIMARY KEY,
    username TEXT,
    referral_code TEXT NOT NULL UNIQUE,
    referred_by TEXT REFERENCES users(telegram_id),
    credits_micros BIGINT NOT NULL DEFAULT 0,
    usdc_micros BIGINT NOT NULL DEFAULT 0,
    usdt_micros BIGINT NOT NULL DEFAULT 0,
    wallet TEXT UNIQUE,
    welcomed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS referrals (
    referred_id TEXT PRIMARY KEY REFERENCES users(telegram_id),
    referrer_id TEXT NOT NULL REFERENCES users(telegram_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS wallet_link_challenges (
    telegram_id TEXT PRIMARY KEY REFERENCES users(telegram_id),
    address TEXT NOT NULL,
    nonce TEXT NOT NULL,
    expires_at BIGINT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS deposits (
    signature TEXT NOT NULL,
    transfer_index INTEGER NOT NULL,
    telegram_id TEXT NOT NULL REFERENCES users(telegram_id),
    token TEXT NOT NULL,
    amount_micros BIGINT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (signature, transfer_index)
  );
  CREATE TABLE IF NOT EXISTS unclaimed_deposits (
    signature TEXT NOT NULL,
    transfer_index INTEGER NOT NULL,
    sender TEXT NOT NULL,
    token TEXT NOT NULL,
    amount_micros BIGINT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (signature, transfer_index)
  );
  CREATE TABLE IF NOT EXISTS withdrawal_requests (
    id TEXT PRIMARY KEY,
    telegram_id TEXT NOT NULL REFERENCES users(telegram_id),
    token TEXT NOT NULL CHECK (token IN ('usdc', 'usdt')),
    destination TEXT NOT NULL,
    amount_micros BIGINT NOT NULL,
    fee_micros BIGINT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'paid', 'rejected')),
    stage TEXT NOT NULL DEFAULT 'queued',
    payout_reference TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    processed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS withdrawal_pending_user
    ON withdrawal_requests(telegram_id, status);
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS whoop_links (
    telegram_id TEXT PRIMARY KEY REFERENCES users(telegram_id),
    whoop_username TEXT NOT NULL,
    whoop_name TEXT,
    linked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS whoop_withdrawals (
    id TEXT PRIMARY KEY,
    telegram_id TEXT NOT NULL REFERENCES users(telegram_id),
    whoop_username TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    amount_micros BIGINT NOT NULL CHECK (amount_micros > 0),
    fee_micros BIGINT NOT NULL CHECK (fee_micros >= 0),
    net_micros BIGINT NOT NULL CHECK (net_micros > 0),
    token TEXT NOT NULL DEFAULT 'credits',
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'completed', 'failed')),
    whoop_tx_id TEXT,
    failure_reason TEXT,
    last_error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT,
    UNIQUE (telegram_id, idempotency_key)
  );
  CREATE INDEX IF NOT EXISTS whoop_withdrawals_status
    ON whoop_withdrawals(status, updated_at);
  CREATE TABLE IF NOT EXISTS ledger (
    id BIGSERIAL PRIMARY KEY,
    withdrawal_id TEXT NOT NULL REFERENCES whoop_withdrawals(id),
    telegram_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('whoop_withdrawal', 'service_fee')),
    amount_micros BIGINT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (withdrawal_id, kind)
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    id BIGSERIAL PRIMARY KEY,
    at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    ref TEXT,
    detail TEXT
  );
  CREATE TABLE IF NOT EXISTS whoop_activation (
    telegram_id TEXT PRIMARY KEY REFERENCES users(telegram_id),
    reference TEXT NOT NULL UNIQUE,
    lamports BIGINT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    paid_at TEXT,
    signature TEXT UNIQUE,
    payer TEXT
  );
  CREATE TABLE IF NOT EXISTS cards (
    id BIGSERIAL PRIMARY KEY,
    telegram_id TEXT NOT NULL REFERENCES users(telegram_id),
    pack_id TEXT NOT NULL,
    price_micros BIGINT NOT NULL,
    value_micros BIGINT NOT NULL,
    odds_index INTEGER NOT NULL,
    player_idx INTEGER NOT NULL,
    elite INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'owned' CHECK (status IN ('owned', 'sold')),
    sold_micros BIGINT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    sold_at TEXT
  );
  CREATE INDEX IF NOT EXISTS cards_owner ON cards(telegram_id, status);
  /* Withdrawal processing fee. A request waits in stage 'awaiting_fee' until its fee is
     verified on-chain, then moves to 'queued'. */
  CREATE TABLE IF NOT EXISTS withdrawal_fee_payments (
    id TEXT PRIMARY KEY,
    withdrawal_id TEXT NOT NULL UNIQUE REFERENCES withdrawal_requests(id),
    telegram_id TEXT NOT NULL REFERENCES users(telegram_id),
    reference TEXT NOT NULL UNIQUE,
    recipient TEXT NOT NULL,
    mint TEXT NOT NULL,
    amount_micros BIGINT NOT NULL CHECK (amount_micros > 0),
    status TEXT NOT NULL DEFAULT 'awaiting'
      CHECK (status IN ('awaiting', 'confirmed', 'expired', 'cancelled', 'refunded')),
    signature TEXT UNIQUE,
    payer TEXT,
    last_error TEXT,
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,
    confirmed_at BIGINT,
    closed_at BIGINT
  );
  CREATE INDEX IF NOT EXISTS fee_payments_status ON withdrawal_fee_payments(status, closed_at);
`);
}
await initDb();

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function verifyInitData(raw) {
  if (!BOT_TOKEN || typeof raw !== "string" || !raw) return null;
  const params = new URLSearchParams(raw);
  const entries = [...params.entries()];
  if (new Set(entries.map(([key]) => key)).size !== entries.length) return null;
  const hash = params.get("hash");
  if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) return null;
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join("\n");
  const secret = crypto
    .createHmac("sha256", "WebAppData")
    .update(BOT_TOKEN)
    .digest();
  const calculated = crypto
    .createHmac("sha256", secret)
    .update(dataCheckString)
    .digest("hex");
  if (!safeEqual(calculated, hash)) return null;

  const authDate = Number(params.get("auth_date"));
  const age = Date.now() / 1000 - authDate;
  if (!Number.isFinite(authDate) || age > 86400 || age < -60) return null;

  try {
    const user = JSON.parse(params.get("user"));
    const id = String(user.id);
    if (!/^\d{1,20}$/.test(id)) return null;
    return {
      id,
      username:
        typeof user.username === "string" &&
        /^[A-Za-z0-9_]{1,32}$/.test(user.username)
          ? user.username
          : null,
    };
  } catch {
    return null;
  }
}

function decodeBase58(value) {
  if (typeof value !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value))
    return null;
  let number = 0n;
  for (const char of value) {
    const digit = BASE58.indexOf(char);
    if (digit < 0) return null;
    number = number * 58n + BigInt(digit);
  }
  const hex = number ? number.toString(16).padStart(Math.ceil(number.toString(16).length / 2) * 2, "0") : "";
  const body = hex ? Buffer.from(hex, "hex") : Buffer.alloc(0);
  let leadingZeroes = 0;
  while (value[leadingZeroes] === "1") leadingZeroes++;
  const decoded = Buffer.concat([Buffer.alloc(leadingZeroes), body]);
  return decoded.length === 32 ? decoded : null;
}

function isSolanaAddress(value) {
  return !!decodeBase58(value);
}

function makeReferralCode() {
  return crypto.randomBytes(6).toString("hex");
}

async function findUser(id) {
  return await db.prepare("SELECT * FROM users WHERE telegram_id = ?").get(id);
}

async function ensureUser(telegram) {
  let user = await findUser(telegram.id);
  if (user) {
    if (telegram.username && telegram.username !== user.username) {
      await db.prepare("UPDATE users SET username = ? WHERE telegram_id = ?").run(
        telegram.username,
        telegram.id,
      );
      user = await findUser(telegram.id);
    }
    return user;
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = makeReferralCode();
    /* ON CONFLICT DO NOTHING instead of catching an error: in Postgres an error would abort an
       enclosing transaction. Nothing inserted means either a parallel request created this user
       first, or the referral code collided; both are handled below. */
    await db.prepare(
      "INSERT INTO users (telegram_id, username, referral_code) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
    ).run(telegram.id, telegram.username, code);
    user = await findUser(telegram.id);
    if (user) return user;
  }
  throw new Error("Could not allocate a unique referral code");
}

async function publicProfile(id) {
  const user = await findUser(id);
  if (!user) throw new ApiError(404, "Account not found. Sign in again.");
  const pending = await db
    .prepare(
      `SELECT token, COALESCE(SUM(amount_micros), 0) AS reserved
       FROM withdrawal_requests WHERE telegram_id = ? AND status = 'pending'
       GROUP BY token`,
    )
    .all(id);
  const reserved = Object.fromEntries(pending.map((row) => [row.token, row.reserved]));
  const referrals = (await db
    .prepare("SELECT COUNT(*) AS count FROM referrals WHERE referrer_id = ?")
    .get(id)).count;
  const referred = user.referred_by
    ? await db
        .prepare("SELECT username, created_at FROM users WHERE telegram_id = ?")
        .get(user.referred_by)
    : null;

  return {
    id: user.telegram_id,
    welcomed: Boolean(user.welcomed),
    code: user.referral_code,
    credits: (user.credits_micros - await whoopReserved(id)) / MICRO,
    usdc: (user.usdc_micros - (reserved.usdc || 0) - await whoopReserved(id, "usdc")) / MICRO,
    usdt: (user.usdt_micros - (reserved.usdt || 0) - await whoopReserved(id, "usdt")) / MICRO,
    wallet: user.wallet,
    invited: referrals,
    earned: referrals,
    pending: 0,
    referredBy: referred
      ? {
          name: referred.username ? `@${referred.username}` : "Telegram user",
          date: `${referred.created_at.replace(" ", "T")}Z`,
        }
      : null,
  };
}

async function attachReferral(userId, code) {
  if (typeof code !== "string" || !/^[a-f0-9]{12}$/i.test(code)) return false;
  const user = await findUser(userId);
  if (user.referred_by) return false;
  const referrer = await db
    .prepare("SELECT telegram_id FROM users WHERE lower(referral_code) = lower(?)")
    .get(code);
  if (!referrer || referrer.telegram_id === userId) return false;

  await db.prepare("UPDATE users SET referred_by = ? WHERE telegram_id = ?").run(
    referrer.telegram_id,
    userId,
  );
  await db.prepare(
    "INSERT INTO referrals (referred_id, referrer_id) VALUES (?, ?)",
  ).run(userId, referrer.telegram_id);
  await db.prepare(
    "UPDATE users SET credits_micros = credits_micros + ? WHERE telegram_id IN (?, ?)",
  ).run(REFERRAL_BONUS, referrer.telegram_id, userId);
  return true;
}

function walletChallengeMessage(telegramId, address, nonce) {
  return `Link Solana wallet ${address} to Telegram account ${telegramId}. Nonce: ${nonce}`;
}

function verifyWalletSignature(address, message, encodedSignature) {
  const publicKeyBytes = decodeBase58(address);
  if (
    !publicKeyBytes ||
    typeof encodedSignature !== "string" ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encodedSignature)
  )
    return false;
  const signature = Buffer.from(encodedSignature, "base64");
  if (signature.length !== 64) return false;
  try {
    const publicKey = crypto.createPublicKey({
      key: Buffer.concat([SOLANA_KEY_PREFIX, publicKeyBytes]),
      format: "der",
      type: "spki",
    });
    return crypto.verify(null, Buffer.from(message), publicKey, signature);
  } catch {
    return false;
  }
}

function toMicros(value) {
  if (
    typeof value !== "string" &&
    typeof value !== "number"
  )
    return null;
  const text = String(value);
  if (!/^\d{1,10}(?:\.\d{1,6})?$/.test(text)) return null;
  const amount = Number(text);
  const micros = Math.round(amount * MICRO);
  return Number.isSafeInteger(micros) && micros > 0 ? micros : null;
}

function webhookAuthorized(value) {
  return HELIUS_AUTH && safeEqual(value, HELIUS_AUTH);
}


/* ---------- Whoop Wallet integration ---------- */
const whoopUrl = () => (process.env.WHOOP_API_URL || "").replace(/\/+$/, "");
const whoopKey = () => process.env.WHOOP_INTEGRATION_KEY || "";
const whoopConfigured = () => !!(whoopUrl() && whoopKey());
const inflight = new Set();
const rateHits = new Map();

function rateLimit(key, max, windowMs) {
  const t = Date.now();
  const hits = (rateHits.get(key) || []).filter((x) => t - x < windowMs);
  if (hits.length >= max) {
    rateHits.set(key, hits);
    throw new ApiError(429, "Too many attempts. Please wait a few minutes.");
  }
  hits.push(t);
  rateHits.set(key, hits);
}

async function audit(actor, action, ref, detail) {
  await db.prepare("INSERT INTO audit_log (actor, action, ref, detail) VALUES (?, ?, ?, ?)").run(
    actor,
    action,
    ref ?? null,
    detail === undefined ? null : JSON.stringify(detail),
  );
}

async function whoopFeeMicros() {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").get(WHOOP_FEE_KEY);
  const value = row ? Number(row.value) : DEFAULT_WHOOP_FEE;
  return Number.isSafeInteger(value) && value >= 0 ? value : DEFAULT_WHOOP_FEE;
}

const WHOOP_TOKENS = { credits: "credits_micros", usdc: "usdc_micros", usdt: "usdt_micros" };
const whoopToken = (value) => {
  const token = value === undefined || value === null || value === "" ? "credits" : value;
  if (!Object.hasOwn(WHOOP_TOKENS, token))
    throw new ApiError(400, "Choose credits, USDC or USDT.");
  return token;
};

/* Amount held for pending Whoop withdrawals paid from one balance. */
async function whoopReserved(id, token = "credits") {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(amount_micros), 0) AS n FROM whoop_withdrawals
       WHERE telegram_id = ? AND status = 'pending' AND token = ?`,
    )
    .get(id, token);
  return row.n;
}

/* Pending Whoop withdrawals from any balance (used to block changing wallets). */
async function whoopReservedAll(id) {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(amount_micros), 0) AS n FROM whoop_withdrawals
       WHERE telegram_id = ? AND status = 'pending'`,
    )
    .get(id);
  return row.n;
}

/* Referral bonuses are promotional credit, so they are not cashable to Whoop. */
async function withdrawableMicros(id, token = "credits") {
  const user = await findUser(id);
  if (!user) return 0;
  if (token !== "credits") {
    /* Winnings: everything not already held by a pending on-chain request or Whoop withdrawal. */
    const heldRow = await db
      .prepare(
        `SELECT COALESCE(SUM(amount_micros), 0) AS n FROM withdrawal_requests
         WHERE telegram_id = ? AND token = ? AND status = 'pending'`,
      )
      .get(id, token);
    const held = heldRow.n;
    return Math.max(0, user[WHOOP_TOKENS[token]] - held - await whoopReserved(id, token));
  }
  const referredRow = await db
    .prepare("SELECT COUNT(*) AS n FROM referrals WHERE referrer_id = ?")
    .get(id);
  const referred = referredRow.n;
  const bonus = (referred + (user.referred_by ? 1 : 0)) * REFERRAL_BONUS;
  return Math.max(0, Math.max(0, user.credits_micros - bonus) - await whoopReserved(id));
}

async function whoopLink(id) {
  return await db.prepare("SELECT * FROM whoop_links WHERE telegram_id = ?").get(id);
}

async function quoteFor(amount) {
  const fee = await whoopFeeMicros();
  if (!amount || amount < MIN_WITHDRAWAL)
    throw new ApiError(400, `Minimum withdrawal is $${(MIN_WITHDRAWAL / MICRO).toFixed(2)}.`);
  if (amount % CENT !== 0)
    throw new ApiError(400, "Amounts can have at most two decimal places.");
  if (amount <= fee) throw new ApiError(400, "Amount does not cover the service fee.");
  return { amount, fee, net: amount - fee };
}

class WhoopError extends Error {
  constructor(message, { retriable, status, code }) {
    super(message);
    this.retriable = retriable;
    this.status = status;
    this.code = code;
  }
}

async function whoopRequest(pathname, body) {
  if (!whoopConfigured())
    throw new WhoopError("Whoop Wallet is not configured.", { retriable: true, status: 503, code: "not_configured" });
  let response;
  try {
    response = await fetch(`${whoopUrl()}${pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-integration-key": whoopKey() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(WHOOP_TIMEOUT_MS),
    });
  } catch (error) {
    throw new WhoopError(`Could not reach Whoop Wallet (${error.name}).`, { retriable: true, status: 0, code: "network" });
  }
  let data = {};
  try {
    data = await response.json();
  } catch {}
  if (response.ok) return data;
  /* 4xx answers about the request itself are final. Auth, rate-limit and 5xx answers
     mean we do not know the outcome, so the withdrawal stays reserved and is retried. */
  const retriable = response.status >= 500 || [401, 408, 423, 429].includes(response.status);
  throw new WhoopError(data.error || `Whoop Wallet answered ${response.status}.`, {
    retriable,
    status: response.status,
    code: data.code,
  });
}

function publicWithdrawal(row) {
  return {
    id: row.id,
    status: row.status,
    token: row.token || "credits",
    amount: row.amount_micros / MICRO,
    fee: row.fee_micros / MICRO,
    receive: row.net_micros / MICRO,
    destination: `@${row.whoop_username}`,
    whoopTxId: row.whoop_tx_id,
    error: row.status === "failed" ? row.failure_reason : null,
    createdAt: `${row.created_at.replace(" ", "T")}Z`,
    completedAt: row.completed_at ? `${row.completed_at.replace(" ", "T")}Z` : null,
  };
}

/* Sends one reserved withdrawal to Whoop and settles it. Safe to call repeatedly:
   Whoop credits at most once per reference, and the settle step runs only while pending. */
async function attemptPayout(id) {
  if (inflight.has(id)) return;
  inflight.add(id);
  try {
    const row = await db.prepare("SELECT * FROM whoop_withdrawals WHERE id = ?").get(id);
    if (!row || row.status !== "pending") return;
    await db.prepare(
      "UPDATE whoop_withdrawals SET attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    ).run(id);
    let result;
    try {
      result = await whoopRequest("/api/integrations/phygitals/credit", {
        telegramId: Number(row.telegram_id),
        amountCents: row.net_micros / CENT,
        reference: `phygitals:${row.id}`,
        note: "Withdrawal from Phygitals",
      });
    } catch (error) {
      if (!(error instanceof WhoopError) || error.retriable) {
        await db.prepare("UPDATE whoop_withdrawals SET last_error = ? WHERE id = ?").run(
          String(error.message).slice(0, 300),
          id,
        );
        await audit("system", "whoop_payout_retry_later", id, { error: error.message, status: error.status });
        return;
      }
      await inTransaction(async () => {
        const changed = await db
          .prepare(
            `UPDATE whoop_withdrawals SET status = 'failed', failure_reason = ?,
               updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'`,
          )
          .run(error.message.slice(0, 300), id);
        if (changed.changes) await audit("system", "whoop_withdrawal_failed", id, { reason: error.message, code: error.code });
      });
      return;
    }
    await inTransaction(async () => {
      const changed = await db
        .prepare(
          `UPDATE whoop_withdrawals SET status = 'completed', whoop_tx_id = ?, last_error = NULL,
             updated_at = CURRENT_TIMESTAMP, completed_at = CURRENT_TIMESTAMP
           WHERE id = ? AND status = 'pending'`,
        )
        .run(String(result.id || ""), id);
      if (!changed.changes) return;
      const user = await findUser(row.telegram_id);
      const column = WHOOP_TOKENS[row.token] || "credits_micros";
      const deducted = Math.min(user[column], row.amount_micros);
      await db.prepare(`UPDATE users SET ${column} = ${column} - ? WHERE telegram_id = ?`).run(
        deducted,
        row.telegram_id,
      );
      const insert = db.prepare(
        "INSERT INTO ledger (withdrawal_id, telegram_id, kind, amount_micros) VALUES (?, ?, ?, ?)",
      );
      await insert.run(id, row.telegram_id, "whoop_withdrawal", row.net_micros);
      if (row.fee_micros > 0) await insert.run(id, row.telegram_id, "service_fee", row.fee_micros);
      await audit("system", "whoop_withdrawal_completed", id, {
        whoopTxId: result.id,
        duplicate: !!result.duplicate,
        shortfall: row.amount_micros - deducted,
      });
    });
  } finally {
    inflight.delete(id);
  }
}

async function reconcilePending({ olderThanSeconds = 10, limit = 20 } = {}) {
  const rows = await db
    .prepare(
      `SELECT id FROM whoop_withdrawals WHERE status = 'pending'
       AND updated_at <= to_char(timezone('utc', now()) - make_interval(secs => ?), 'YYYY-MM-DD HH24:MI:SS')
       ORDER BY created_at LIMIT ?`,
    )
    .all(olderThanSeconds, limit);
  for (const row of rows) await attemptPayout(row.id);
  return rows.length;
}


/* ---------- Withdrawal processing fee ---------- */
const feeChecking = new Set();
const feeLastCheck = new Map();

async function feePaymentRow(id) {
  return await db.prepare("SELECT * FROM withdrawal_fee_payments WHERE id = ?").get(id);
}

async function feePaymentFor(withdrawalId) {
  return await db.prepare("SELECT * FROM withdrawal_fee_payments WHERE withdrawal_id = ?").get(withdrawalId);
}

/* The state the app shows. It is derived from stored facts, never from the browser. */
function withdrawalState(w, p) {
  if (w.status === "paid") return "paid";
  if (w.status === "rejected") return p && p.status === "refunded" ? "rejected_refunded" : p?.status === "expired" ? "expired" : p?.status === "cancelled" ? "cancelled" : "rejected";
  if (p && p.status === "awaiting") return "awaiting_payment";
  return "queued";
}

function publicFeeWithdrawal(w, p) {
  const state = withdrawalState(w, p);
  return {
    id: w.id,
    state,
    status: w.status,
    token: w.token,
    amount: w.amount_micros / MICRO,
    receive: (w.amount_micros - w.fee_micros) / MICRO,
    destination: w.destination,
    fee: p ? p.amount_micros / MICRO : w.fee_micros / MICRO,
    feeTxHash: p?.signature || null,
    payoutTxHash: w.payout_reference || null,
    createdAt: `${w.created_at.replace(" ", "T")}Z`,
    payment:
      p && p.status === "awaiting"
        ? {
            recipient: p.recipient,
            mint: p.mint,
            amount: p.amount_micros / MICRO,
            reference: p.reference,
            expiresAt: p.expires_at,
            url: solanaPayUrl({
              recipient: p.recipient,
              micros: p.amount_micros,
              mint: p.mint,
              reference: p.reference,
              label: "Phygitals",
              message: "Withdrawal processing fee",
            }),
            problem: p.last_error || null,
          }
        : null,
  };
}

/* Closes a payment nobody paid and releases the reserved withdrawal. */
async function closeUnpaidFee(paymentId, status, actor) {
  return inTransaction(async () => {
    const changed = await db
      .prepare(
        `UPDATE withdrawal_fee_payments SET status = ?, closed_at = ?
         WHERE id = ? AND status = 'awaiting'`,
      )
      .run(status, Date.now(), paymentId);
    if (!changed.changes) return false;
    const p = await feePaymentRow(paymentId);
    await db.prepare(
      `UPDATE withdrawal_requests SET status = 'rejected', stage = 'cancelled', processed_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'pending' AND stage = 'awaiting_fee'`,
    ).run(p.withdrawal_id);
    await audit(actor, `withdrawal_fee_${status}`, p.withdrawal_id, { paymentId });
    return true;
  });
}

/* Reads the chain for one payment and settles it. Safe to call repeatedly and concurrently:
   a payment is confirmed at most once (guarded update plus UNIQUE signature), and a failed
   or unreachable lookup never marks anything paid. */
async function checkFeePayment(paymentId) {
  if (!feeRpc || feeChecking.has(paymentId)) return;
  const p = await feePaymentRow(paymentId);
  if (!p) return;
  const open = p.status === "awaiting";
  const late =
    (p.status === "expired" || p.status === "cancelled") &&
    !p.signature &&
    Date.now() - (p.closed_at || 0) < FEE_LATE_WINDOW_MS;
  if (!open && !late) return;

  feeChecking.add(paymentId);
  try {
    let found;
    try {
      found = await findFeePayment(feeRpc, {
        reference: p.reference,
        recipient: p.recipient,
        mint: p.mint,
        minMicros: p.amount_micros,
      });
    } catch (error) {
      const message = String(error.message).slice(0, 200);
      if (p.last_error !== message) {
        await db.prepare("UPDATE withdrawal_fee_payments SET last_error = ? WHERE id = ?").run(message, p.id);
        await audit("system", "withdrawal_fee_check_failed", p.withdrawal_id, { error: message });
      }
      return;
    }

    if (found.status === "paid") {
      try {
        await inTransaction(async () => {
          const cur = await feePaymentRow(p.id);
          if (cur.status === "awaiting") {
            await db.prepare(
              `UPDATE withdrawal_fee_payments SET status = 'confirmed', signature = ?, payer = ?,
                 confirmed_at = ?, last_error = NULL WHERE id = ? AND status = 'awaiting'`,
            ).run(found.signature, found.payer, Date.now(), p.id);
            await db.prepare(
              `UPDATE withdrawal_requests SET stage = 'queued'
               WHERE id = ? AND status = 'pending' AND stage = 'awaiting_fee'`,
            ).run(p.withdrawal_id);
            await audit("system", "withdrawal_fee_confirmed", p.withdrawal_id, {
              signature: found.signature,
              payer: found.payer,
              receivedMicros: found.receivedMicros,
              slot: found.slot,
            });
          } else if ((cur.status === "expired" || cur.status === "cancelled") && !cur.signature) {
            /* Paid after the request was closed: the withdrawal no longer exists, so the
               fee goes back to the user's USDC balance instead of being kept. */
            await db.prepare(
              `UPDATE withdrawal_fee_payments SET status = 'refunded', signature = ?, payer = ?, last_error = NULL
               WHERE id = ? AND signature IS NULL`,
            ).run(found.signature, found.payer, p.id);
            await db.prepare("UPDATE users SET usdc_micros = usdc_micros + ? WHERE telegram_id = ?").run(
              found.receivedMicros,
              p.telegram_id,
            );
            await audit("system", "withdrawal_fee_late_refunded", p.withdrawal_id, {
              signature: found.signature,
              receivedMicros: found.receivedMicros,
            });
          }
        });
      } catch (error) {
        if (isUnique(error)) {
          await audit("system", "withdrawal_fee_signature_reused", p.withdrawal_id, { signature: found.signature });
          await db.prepare("UPDATE withdrawal_fee_payments SET last_error = ? WHERE id = ?").run(
            "That transaction was already used for another payment.",
            p.id,
          );
        } else throw error;
      }
      return;
    }

    if (open && Date.now() > p.expires_at) {
      await closeUnpaidFee(p.id, "expired", "system");
      return;
    }
    const note = found.status === "invalid" ? found.reason.slice(0, 200) : null;
    if (note !== p.last_error)
      await db.prepare("UPDATE withdrawal_fee_payments SET last_error = ? WHERE id = ?").run(note, p.id);
  } finally {
    feeChecking.delete(paymentId);
  }
}

async function reconcileFeePayments() {
  if (!feeRpc) return 0;
  const rows = await db
    .prepare(
      `SELECT id FROM withdrawal_fee_payments
       WHERE status = 'awaiting'
          OR (status IN ('expired', 'cancelled') AND signature IS NULL AND closed_at > ?)
       ORDER BY created_at LIMIT 50`,
    )
    .all(Date.now() - FEE_LATE_WINDOW_MS);
  for (const row of rows) await checkFeePayment(row.id);
  return rows.length;
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  const origin = req.get("origin");
  if (origin && APP_ORIGIN && APP_ORIGIN !== "*" && origin !== APP_ORIGIN) {
    console.warn(`Origin rejected: request came from "${origin}" but APP_ORIGIN is "${APP_ORIGIN}". They must match exactly.`);
    return res.status(403).json({ error: "Server setup problem: APP_ORIGIN does not match this site's address." });
  }
  if (origin && APP_ORIGIN === "*") res.set("Access-Control-Allow-Origin", "*");
  else if (origin && origin === APP_ORIGIN)
    res.set("Access-Control-Allow-Origin", APP_ORIGIN);
  res.set("Access-Control-Allow-Headers", "X-Telegram-Init-Data, X-Admin-Token, Content-Type, Authorization");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

async function auth(req, res, next) {
  const raw = req.get("X-Telegram-Init-Data");
  const telegram = verifyInitData(raw);
  if (!telegram) {
    let reason;
    let error;
    if (!BOT_TOKEN) {
      reason = "BOT_TOKEN is not set on the server";
      error = "Server setup problem: BOT_TOKEN is not set.";
    } else if (!raw) {
      reason = "no Telegram initData sent (app not opened from inside Telegram)";
      error = "Please open Phygitals from inside Telegram.";
    } else {
      reason = "initData failed verification (BOT_TOKEN is not the token of the bot that opened the app, or the data is older than 24h)";
      error = "Telegram sign-in could not be verified. Close and reopen the app from the bot.";
    }
    console.warn(`Auth rejected on ${req.method} ${req.path}: ${reason}`);
    return res.status(401).json({ error });
  }
  req.telegram = telegram;
  /* Telegram has already proven who this is, so make sure their account row
     exists. This is what stops "Account not found" after a restart or a
     first visit that never reached the signup call. */
  try {
    await ensureUser(telegram);
  } catch (error) {
    console.error("Could not create account:", error);
    return res.status(500).json({ error: "Could not load your account. Please try again." });
  }
  next();
}

function adminAuth(req, res, next) {
  if (!ADMIN_TOKEN)
    return res.status(503).json({ error: "Withdrawal review is not configured." });
  if (!safeEqual(req.get("X-Admin-Token"), ADMIN_TOKEN))
    return res.status(401).json({ error: "Unauthorized." });
  next();
}

app.get("/healthz", async (_req, res) =>
  res.json({
    ok: true,
    botToken: Boolean(BOT_TOKEN),
    appOrigin: APP_ORIGIN || null,
    telegramBot: bot.enabled,
    /* Data lives in PostgreSQL (DATABASE_URL), not on this server's disk, so it survives restarts. */
    users: (await db.prepare("SELECT COUNT(*) AS n FROM users").get()).n,
    database: "postgres",
  }),
);
app.get("/", (_req, res) => res.sendFile(path.join(ROOT, "index.html")));
app.use("/assets", express.static(path.join(ROOT, "assets")));

app.get("/api/me", auth, async (req, res) => {
  res.json(await publicProfile(req.telegram.id));
});

app.post("/api/signup", auth, async (req, res) => {
  const result = await inTransaction(async () => {
    await ensureUser(req.telegram);
    const awarded = await attachReferral(req.telegram.id, req.body?.ref);
    await db.prepare("UPDATE users SET welcomed = 1 WHERE telegram_id = ?").run(req.telegram.id);
    return { ...(await publicProfile(req.telegram.id)), referralAwarded: awarded };
  });
  res.json(result);
});

app.get("/api/rewards", auth, async (req, res) => {
  res.json(await publicProfile(req.telegram.id));
});

app.post("/api/redeem", auth, async (req, res) => {
  const result = await inTransaction(async () => {
    await ensureUser(req.telegram);
    const awarded = await attachReferral(req.telegram.id, req.body?.code);
    if (!awarded) {
      const user = await findUser(req.telegram.id);
      if (user.referred_by) throw new ApiError(409, "A referral code has already been used.");
      throw new ApiError(400, "That referral code is not valid.");
    }
    return { ...(await publicProfile(req.telegram.id)), referralAwarded: true };
  });
  res.json(result);
});

app.get("/api/balance", auth, async (req, res) => {
  const profile = await publicProfile(req.telegram.id);
  res.json({
    credits: profile.credits,
    usdc: profile.usdc,
    usdt: profile.usdt,
    wallet: profile.wallet,
  });
});

/* ---------- Packs, collection and sell-back (all outcomes decided here) ---------- */

function sellBackMicros(valueMicros) {
  // Never round in the player's favour: pay whole cents, rounded down.
  return Math.floor((valueMicros * CARD_BUYBACK) / CENT) * CENT;
}

function publicCard(row) {
  return {
    id: row.id,
    packId: row.pack_id,
    value: row.value_micros / MICRO,
    oddsIndex: row.odds_index,
    playerIdx: row.player_idx,
    elite: Boolean(row.elite),
    sellBack: sellBackMicros(row.value_micros) / MICRO,
  };
}

app.get("/api/packs", auth, async (_req, res) => {
  res.json({
    buyback: CARD_BUYBACK,
    packs: PACKS.map((pack) => {
      const status = PACK_STATUS.get(pack.id);
      return {
        id: pack.id,
        name: pack.name,
        price: pack.price,
        elite: pack.elite,
        odds: pack.odds,
        available: status.available,
        reason: status.available ? null : "This pack is not open for purchase right now.",
      };
    }),
  });
});

app.post("/api/packs/buy", auth, async (req, res) => {
  const pack = PACKS.find((item) => item.id === req.body?.packId);
  if (!pack) throw new ApiError(404, "That pack does not exist.");
  if (!PACK_STATUS.get(pack.id).available)
    throw new ApiError(503, "This pack is not open for purchase right now.");
  const priceMicros = toMicros(pack.price);

  const result = await inTransaction(async () => {
    const user = await findUser(req.telegram.id);
    const spendable = user.credits_micros - await whoopReserved(user.telegram_id);
    if (spendable < priceMicros)
      throw new ApiError(402, "Not enough credits. Tap + to add funds.");

    await db.prepare("UPDATE users SET credits_micros = credits_micros - ? WHERE telegram_id = ?").run(
      priceMicros,
      user.telegram_id,
    );
    const { index, value } = drawPack(pack);
    const playerIdx = crypto.randomInt(PLAYERS_PER_POOL);
    const elite = pack.elite && index >= 3 ? 1 : 0;
    const card = await db
      .prepare(
        `INSERT INTO cards (telegram_id, pack_id, price_micros, value_micros, odds_index, player_idx, elite)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(user.telegram_id, pack.id, priceMicros, toMicros(value), index, playerIdx, elite);
    await audit(`user:${user.telegram_id}`, "pack_bought", String(card.id), {
      pack: pack.id,
      price: priceMicros,
      value: card.value_micros,
    });
    return card;
  });

  res.json({ card: publicCard(result), credits: (await publicProfile(req.telegram.id)).credits });
});

app.get("/api/cards", auth, async (req, res) => {
  const rows = await db
    .prepare("SELECT * FROM cards WHERE telegram_id = ? AND status = 'owned' ORDER BY id DESC")
    .all(req.telegram.id);
  res.json({ cards: rows.map(publicCard) });
});

app.post("/api/cards/sell", auth, async (req, res) => {
  const to = req.body?.to;
  if (to !== "credits" && to !== "usdc")
    throw new ApiError(400, "Choose pack credits or USDC.");
  const cardId = Number(req.body?.cardId);
  if (!Number.isSafeInteger(cardId) || cardId <= 0)
    throw new ApiError(400, "Choose a card to sell.");

  const paid = await inTransaction(async () => {
    const card = await db
      .prepare("SELECT * FROM cards WHERE id = ? AND telegram_id = ?")
      .get(cardId, req.telegram.id);
    if (!card) throw new ApiError(404, "Card not found.");
    if (card.status !== "owned") throw new ApiError(409, "That card was already sold.");
    const payout = sellBackMicros(card.value_micros);
    await db.prepare(
      "UPDATE cards SET status = 'sold', sold_micros = ?, sold_at = CURRENT_TIMESTAMP WHERE id = ?",
    ).run(payout, card.id);
    const column = to === "usdc" ? "usdc_micros" : "credits_micros";
    await db.prepare(`UPDATE users SET ${column} = ${column} + ? WHERE telegram_id = ?`).run(
      payout,
      req.telegram.id,
    );
    await audit(`user:${req.telegram.id}`, "card_sold", String(card.id), { payout, to });
    return payout;
  });

  const profile = await publicProfile(req.telegram.id);
  res.json({ paid: paid / MICRO, credits: profile.credits, usdc: profile.usdc });
});

app.get("/api/deposit-address", auth, async (_req, res) => {
  if (!isSolanaAddress(DEPOSIT_ADDRESS))
    return res.status(503).json({ error: "Crypto deposits are not configured." });
  res.json({ address: DEPOSIT_ADDRESS });
});

app.post("/api/link-wallet/challenge", auth, async (req, res) => {
  const address = req.body?.address;
  if (!isSolanaAddress(address) || address === DEPOSIT_ADDRESS)
    return res.status(400).json({ error: "Enter a valid Solana address." });

  const user = await inTransaction(async () => await ensureUser(req.telegram));
  const nonce = crypto.randomBytes(24).toString("hex");
  const message = walletChallengeMessage(user.telegram_id, address, nonce);
  await db.prepare(
    `INSERT INTO wallet_link_challenges (telegram_id, address, nonce, expires_at)
     VALUES (?, ?, ?, ?) ON CONFLICT(telegram_id) DO UPDATE SET
       address = excluded.address, nonce = excluded.nonce, expires_at = excluded.expires_at`,
  ).run(user.telegram_id, address, nonce, Date.now() + 5 * 60 * 1000);
  res.json({ nonce, message });
});

app.post("/api/link-wallet", auth, async (req, res) => {
  const { address, nonce, signature } = req.body || {};
  const challenge = await db
    .prepare("SELECT * FROM wallet_link_challenges WHERE telegram_id = ?")
    .get(req.telegram.id);
  if (
    !challenge ||
    challenge.address !== address ||
    challenge.nonce !== nonce ||
    challenge.expires_at < Date.now()
  )
    return res.status(400).json({ error: "Wallet link request expired. Try again." });

  const message = walletChallengeMessage(req.telegram.id, address, nonce);
  if (!verifyWalletSignature(address, message, signature))
    return res.status(400).json({ error: "Wallet signature could not be verified." });

  await inTransaction(async () => {
    const current = await db
      .prepare("SELECT * FROM wallet_link_challenges WHERE telegram_id = ?")
      .get(req.telegram.id);
    if (
      !current ||
      current.address !== address ||
      current.nonce !== nonce ||
      current.expires_at < Date.now()
    )
      throw new ApiError(400, "Wallet link request expired. Try again.");
    const owner = await db
      .prepare("SELECT telegram_id FROM users WHERE wallet = ?")
      .get(address);
    if (owner && owner.telegram_id !== req.telegram.id)
      throw new ApiError(409, "That wallet is already linked to another account.");
    await db.prepare("UPDATE users SET wallet = ? WHERE telegram_id = ?").run(
      address,
      req.telegram.id,
    );
    const unclaimed = await db
      .prepare("SELECT * FROM unclaimed_deposits WHERE sender = ?")
      .all(address);
    for (const deposit of unclaimed) {
      const inserted = await db
        .prepare(
          `INSERT INTO deposits
            (signature, transfer_index, telegram_id, token, amount_micros)
           VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        )
        .run(
          deposit.signature,
          deposit.transfer_index,
          req.telegram.id,
          deposit.token,
          deposit.amount_micros,
        );
      if (inserted.changes) {
        await db.prepare(
          "UPDATE users SET credits_micros = credits_micros + ? WHERE telegram_id = ?",
        ).run(deposit.amount_micros, req.telegram.id);
      }
      await db.prepare(
        "DELETE FROM unclaimed_deposits WHERE signature = ? AND transfer_index = ?",
      ).run(deposit.signature, deposit.transfer_index);
    }
    await db.prepare("DELETE FROM wallet_link_challenges WHERE telegram_id = ?").run(
      req.telegram.id,
    );
  });
  res.json({ wallet: address });
});

app.get("/admin/withdrawals", adminAuth, async (req, res) => {
  const status = req.query.status === "all" ? null : "pending";
  /* Requests still waiting for their processing fee are not reviewable, so they are not
     in the pending queue. */
  const requests = status
    ? await db
        .prepare(
          `SELECT w.id, w.telegram_id AS "telegramId", w.token, w.destination,
            w.amount_micros * 1.0 / ? AS amount, w.fee_micros * 1.0 / ? AS fee,
            (w.amount_micros - w.fee_micros) * 1.0 / ? AS receive, w.status, w.stage,
            w.created_at AS "createdAt", p.signature AS "feeTxHash", p.amount_micros * 1.0 / ? AS "feePaid"
           FROM withdrawal_requests w LEFT JOIN withdrawal_fee_payments p ON p.withdrawal_id = w.id
           WHERE w.status = ? AND w.stage = 'queued' ORDER BY w.created_at`,
        )
        .all(MICRO, MICRO, MICRO, MICRO, status)
    : await db
        .prepare(
          `SELECT w.id, w.telegram_id AS "telegramId", w.token, w.destination,
            w.amount_micros * 1.0 / ? AS amount, w.fee_micros * 1.0 / ? AS fee,
            (w.amount_micros - w.fee_micros) * 1.0 / ? AS receive, w.status, w.stage,
            w.created_at AS "createdAt", p.signature AS "feeTxHash", p.amount_micros * 1.0 / ? AS "feePaid",
            w.payout_reference AS "payoutTxHash"
           FROM withdrawal_requests w LEFT JOIN withdrawal_fee_payments p ON p.withdrawal_id = w.id
           ORDER BY w.created_at DESC LIMIT 500`,
        )
        .all(MICRO, MICRO, MICRO, MICRO);
  res.json({ requests });
});

app.get("/admin/unclaimed-deposits", adminAuth, async (_req, res) => {
  const deposits = await db
    .prepare(
      `SELECT signature, transfer_index AS "transferIndex", sender, token,
        amount_micros * 1.0 / ? AS amount, created_at AS "createdAt"
       FROM unclaimed_deposits ORDER BY created_at DESC LIMIT 500`,
    )
    .all(MICRO);
  res.json({ deposits });
});

/* The old on-chain route puts requests into manual review. Withdrawals now go straight to
   Whoop (POST /api/whoop/withdraw), so this route is off unless ONCHAIN_WITHDRAWALS_ENABLED=1. */
app.post("/api/withdraw", auth, async (req, res) => {
  if (process.env.ONCHAIN_WITHDRAWALS_ENABLED !== "1")
    return res.status(410).json({ error: "On-chain withdrawals are disabled. Withdraw to your Whoop Wallet instead." });
  const token = req.body?.token;
  const amount = toMicros(req.body?.amount);
  const destination = req.body?.destination;
  if (!["usdc", "usdt"].includes(token))
    return res.status(400).json({ error: "Choose USDC or USDT." });
  if (!amount || amount < MIN_WITHDRAWAL)
    return res.status(400).json({ error: "Minimum withdrawal is $10.00." });
  if (!isSolanaAddress(destination))
    return res.status(400).json({ error: "Enter a valid Solana destination address." });
  if (amount <= WITHDRAWAL_FEE)
    return res.status(400).json({ error: "Amount does not cover the withdrawal fee." });

  if (FEE_ENABLED) rateLimit(`withdraw:${req.telegram.id}`, 10, 10 * 60_000);

  const request = await inTransaction(async () => {
    const user = await findUser(req.telegram.id);
    if (!user) throw new ApiError(404, "Account not found.");
    if (FEE_ENABLED) {
      const open = await db
        .prepare(
          `SELECT id FROM withdrawal_requests
           WHERE telegram_id = ? AND status = 'pending' AND stage = 'awaiting_fee'`,
        )
        .get(req.telegram.id);
      if (open)
        throw new ApiError(
          409,
          "You already have a withdrawal waiting for its processing fee. Finish or cancel it first.",
        );
    }
    const reservedRow = await db
      .prepare(
        `SELECT COALESCE(SUM(amount_micros), 0) AS amount FROM withdrawal_requests
         WHERE telegram_id = ? AND token = ? AND status = 'pending'`,
      )
      .get(req.telegram.id, token);
    const reserved = reservedRow.amount;
    if (user[`${token}_micros`] - reserved - await whoopReserved(req.telegram.id, token) < amount)
      throw new ApiError(400, "Insufficient available balance.");
    const id = crypto.randomUUID();
    if (FEE_ENABLED) {
      /* The processing fee is paid on-chain, separately, so it is not also taken out of the
         withdrawal: fee_micros is 0 and the user receives the full amount. */
      await db.prepare(
        `INSERT INTO withdrawal_requests
          (id, telegram_id, token, destination, amount_micros, fee_micros, stage)
         VALUES (?, ?, ?, ?, ?, 0, 'awaiting_fee')`,
      ).run(id, req.telegram.id, token, destination, amount);
      const now = Date.now();
      await db.prepare(
        `INSERT INTO withdrawal_fee_payments
          (id, withdrawal_id, telegram_id, reference, recipient, mint, amount_micros, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        crypto.randomUUID(),
        id,
        req.telegram.id,
        newReference(),
        FEE_WALLET_ADDRESS,
        USDC_MINT,
        WITHDRAWAL_FEE,
        now,
        now + FEE_TTL_MS,
      );
      await audit(`user:${req.telegram.id}`, "withdrawal_requested", id, {
        token,
        amount,
        destination,
        feeMicros: WITHDRAWAL_FEE,
        awaitingFee: true,
      });
      return id;
    }
    await db.prepare(
      `INSERT INTO withdrawal_requests
        (id, telegram_id, token, destination, amount_micros, fee_micros)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, req.telegram.id, token, destination, amount, WITHDRAWAL_FEE);
    return id;
  });
  if (FEE_ENABLED) {
    const w = await db.prepare("SELECT * FROM withdrawal_requests WHERE id = ?").get(request);
    return res.status(202).json(publicFeeWithdrawal(w, await feePaymentFor(request)));
  }
  res.status(202).json({
    id: request,
    status: "pending",
    fee: WITHDRAWAL_FEE / MICRO,
    receive: (amount - WITHDRAWAL_FEE) / MICRO,
  });
});

/* Withdrawal processing fee: what the app needs to explain and collect it. */
app.get("/api/withdraw/config", auth, async (_req, res) => {
  res.json({
    feeRequired: FEE_ENABLED,
    fee: WITHDRAWAL_FEE / MICRO,
    token: "USDC",
    network: "Solana",
    ttlMinutes: Math.round(FEE_TTL_MS / 60_000),
  });
});

async function ownWithdrawal(req) {
  const w = await db
    .prepare("SELECT * FROM withdrawal_requests WHERE id = ? AND telegram_id = ?")
    .get(String(req.params.id), req.telegram.id);
  if (!w) throw new ApiError(404, "Withdrawal not found.");
  return w;
}

app.get("/api/withdraw/open", auth, async (req, res) => {
  const w = await db
    .prepare(
      `SELECT * FROM withdrawal_requests
       WHERE telegram_id = ? AND status = 'pending' AND stage = 'awaiting_fee'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(req.telegram.id);
  if (!w) return res.json({ withdrawal: null });
  const p = await feePaymentFor(w.id);
  await checkFeePayment(p.id);
  const fresh = await db.prepare("SELECT * FROM withdrawal_requests WHERE id = ?").get(w.id);
  res.json({ withdrawal: publicFeeWithdrawal(fresh, await feePaymentFor(w.id)) });
});

app.get("/api/withdraw/:id", auth, async (req, res) => {
  const w = await ownWithdrawal(req);
  let p = await feePaymentFor(w.id);
  /* Opening this status is what asks the chain "has it arrived?" — the answer comes from
     the chain, not from anything the browser says. Lookups are throttled per payment. */
  if (p && p.status === "awaiting" && Date.now() - (feeLastCheck.get(p.id) || 0) > 3000) {
    feeLastCheck.set(p.id, Date.now());
    await checkFeePayment(p.id);
    p = await feePaymentFor(w.id);
  }
  const fresh = await db.prepare("SELECT * FROM withdrawal_requests WHERE id = ?").get(w.id);
  res.json(publicFeeWithdrawal(fresh, p));
});

app.post("/api/withdraw/:id/cancel", auth, async (req, res) => {
  const w = await ownWithdrawal(req);
  const p = await feePaymentFor(w.id);
  if (!p) throw new ApiError(409, "This withdrawal has no pending fee to cancel.");
  /* Look at the chain first so a payment that is already on its way is never cancelled. */
  await checkFeePayment(p.id);
  const now = await feePaymentFor(w.id);
  if (now.status === "confirmed")
    throw new ApiError(409, "Your fee payment was already received, so this withdrawal is queued.");
  if (now.status === "awaiting") await closeUnpaidFee(now.id, "cancelled", `user:${req.telegram.id}`);
  const fresh = await db.prepare("SELECT * FROM withdrawal_requests WHERE id = ?").get(w.id);
  res.json(publicFeeWithdrawal(fresh, await feePaymentFor(w.id)));
});

app.post("/admin/withdrawals/:id/review", adminAuth, async (req, res) => {
  const { action, reference } = req.body || {};
  if (!["paid", "reject"].includes(action))
    return res.status(400).json({ error: "Choose paid or reject." });
  if (
    action === "paid" &&
    (typeof reference !== "string" || reference.trim().length < 8 || reference.length > 200)
  )
    return res.status(400).json({ error: "A payout reference is required." });

  await inTransaction(async () => {
    const request = await db
      .prepare("SELECT * FROM withdrawal_requests WHERE id = ?")
      .get(req.params.id);
    if (!request) throw new ApiError(404, "Withdrawal request not found.");
    if (request.status !== "pending")
      throw new ApiError(409, "Withdrawal request was already reviewed.");
    if (request.stage !== "queued")
      throw new ApiError(409, "This withdrawal is still waiting for its processing fee.");
    if (action === "reject") {
      /* The fee was paid for a withdrawal that will not happen, so it goes back to the
         user's USDC balance. */
      const fee = await feePaymentFor(request.id);
      if (fee && fee.status === "confirmed") {
        await db.prepare("UPDATE users SET usdc_micros = usdc_micros + ? WHERE telegram_id = ?").run(
          fee.amount_micros,
          request.telegram_id,
        );
        await db.prepare("UPDATE withdrawal_fee_payments SET status = 'refunded', closed_at = ? WHERE id = ?").run(
          Date.now(),
          fee.id,
        );
        await audit("admin", "withdrawal_fee_refunded", request.id, { amountMicros: fee.amount_micros });
      }
    }
    if (action === "paid") {
      const column = `${request.token}_micros`;
      const result = await db
        .prepare(`UPDATE users SET ${column} = ${column} - ? WHERE telegram_id = ? AND ${column} >= ?`)
        .run(request.amount_micros, request.telegram_id, request.amount_micros);
      if (result.changes !== 1)
        throw new ApiError(409, "Account balance changed; request was not completed.");
    }
    await db.prepare(
      `UPDATE withdrawal_requests SET status = ?, payout_reference = ?, processed_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    ).run(action === "paid" ? "paid" : "rejected", action === "paid" ? reference.trim() : null, request.id);
    await audit("admin", action === "paid" ? "withdrawal_paid" : "withdrawal_rejected", request.id, {
      reference: action === "paid" ? reference.trim() : null,
    });
  });
  res.json({ status: action === "paid" ? "paid" : "rejected" });
});

app.post("/webhook/helius", async (req, res) => {
  if (!HELIUS_AUTH)
    return res.status(503).json({ error: "Deposit webhook is not configured." });
  if (!webhookAuthorized(req.get("authorization")))
    return res.sendStatus(401);
  if (!Array.isArray(req.body))
    return res.status(400).json({ error: "Expected a Helius transaction array." });

  let credited = 0;
  await inTransaction(async () => {
    for (const tx of req.body) {
      if (
        !tx ||
        typeof tx.signature !== "string" ||
        !tx.signature ||
        tx.transactionError ||
        tx.err ||
        !Array.isArray(tx.tokenTransfers)
      )
        continue;
      for (const [transferIndex, transfer] of tx.tokenTransfers.entries()) {
        if (
          transfer?.toUserAccount !== DEPOSIT_ADDRESS ||
          !MINTS.has(transfer.mint) ||
          typeof transfer.fromUserAccount !== "string"
        )
          continue;
        const amount = toMicros(transfer.tokenAmount);
        if (!amount) continue;
        const token = MINTS.get(transfer.mint);
        const user = await db
          .prepare("SELECT telegram_id FROM users WHERE wallet = ?")
          .get(transfer.fromUserAccount);
        if (!user) {
          await db.prepare(
            `INSERT INTO unclaimed_deposits
              (signature, transfer_index, sender, token, amount_micros)
             VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
          ).run(tx.signature, transferIndex, transfer.fromUserAccount, token, amount);
          continue;
        }
        const inserted = await db
          .prepare(
            `INSERT INTO deposits
              (signature, transfer_index, telegram_id, token, amount_micros)
             VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
          )
          .run(tx.signature, transferIndex, user.telegram_id, token, amount);
        if (inserted.changes) {
          await db.prepare(
            "UPDATE users SET credits_micros = credits_micros + ? WHERE telegram_id = ?",
          ).run(amount, user.telegram_id);
          credited++;
        }
      }
    }
  });
  res.json({ creditedTransfers: credited });
});


app.get("/wallet", (_req, res) => res.sendFile(path.join(ROOT, "wallet.html")));

/* Telegram bot updates (/start etc). Telegram sends the secret in this header. */
app.post("/telegram/webhook", (req, res) => {
  if (!bot.enabled)
    return res.status(503).json({ error: "Telegram bot is not configured." });
  if (!safeEqual(req.get("x-telegram-bot-api-secret-token"), bot.secret))
    return res.sendStatus(401);
  // Answer right away so Telegram does not retry; the reply is sent in the background.
  res.sendStatus(200);
  bot.handleUpdate(req.body);
});

async function activationRow(id) {
  return await db.prepare("SELECT * FROM whoop_activation WHERE telegram_id = ?").get(id);
}

/* Withdrawals need the one-time activation payment first (only when the SOL check is configured). */
async function requireActivation(id) {
  if (!ACTIVATION_ENABLED) return;
  const row = await activationRow(id);
  if (!row || !row.paid_at)
    throw new ApiError(402, "Pay the one-time activation fee before your first withdrawal.");
}

async function whoopStatus(id) {
  const link = await whoopLink(id);
  const pending = await db
    .prepare("SELECT * FROM whoop_withdrawals WHERE telegram_id = ? AND status = 'pending' ORDER BY created_at")
    .all(id);
  return {
    configured: whoopConfigured(),
    linked: !!link,
    whoopUsername: link ? link.whoop_username : null,
    available: await withdrawableMicros(id) / MICRO,
    balances: {
      credits: await withdrawableMicros(id, "credits") / MICRO,
      usdc: await withdrawableMicros(id, "usdc") / MICRO,
      usdt: await withdrawableMicros(id, "usdt") / MICRO,
    },
    fee: await whoopFeeMicros() / MICRO,
    activation: {
      required: ACTIVATION_ENABLED,
      paid: !ACTIVATION_ENABLED || !!(await activationRow(id))?.paid_at,
      sol: ACTIVATION_LAMPORTS / 1e9,
    },
    min: MIN_WITHDRAWAL / MICRO,
    pending: pending.map(publicWithdrawal),
  };
}

app.get("/api/whoop/status", auth, async (req, res) => {
  await inTransaction(async () => await ensureUser(req.telegram));
  res.json(await whoopStatus(req.telegram.id));
});

app.post("/api/whoop/link", auth, async (req, res) => {
  rateLimit(`whoop-link:${req.telegram.id}`, 10, 10 * 60 * 1000);
  await inTransaction(async () => await ensureUser(req.telegram));
  const code = typeof req.body?.code === "string" ? req.body.code.slice(0, 20) : "";
  if (!code) throw new ApiError(400, "Enter the link code from Whoop Wallet.");
  let whoop;
  try {
    whoop = await whoopRequest("/api/integrations/phygitals/verify-link", { code });
  } catch (error) {
    if (error instanceof WhoopError && !error.retriable && error.status !== 0)
      throw new ApiError(400, "That link code is invalid or has expired.");
    throw new ApiError(502, "Could not reach Whoop Wallet. Try again shortly.");
  }
  if (String(whoop.telegramId) !== req.telegram.id)
    throw new ApiError(403, "That Whoop Wallet belongs to a different Telegram account.");
  await inTransaction(async () => {
    const current = await whoopLink(req.telegram.id);
    if (current && current.whoop_username !== whoop.username && await whoopReservedAll(req.telegram.id) > 0)
      throw new ApiError(409, "Wait for your pending withdrawal to finish before changing wallets.");
    await db.prepare(
      `INSERT INTO whoop_links (telegram_id, whoop_username, whoop_name) VALUES (?, ?, ?)
       ON CONFLICT(telegram_id) DO UPDATE SET whoop_username = excluded.whoop_username,
         whoop_name = excluded.whoop_name, linked_at = CURRENT_TIMESTAMP`,
    ).run(req.telegram.id, String(whoop.username), whoop.name ? String(whoop.name).slice(0, 60) : null);
    await audit(`user:${req.telegram.id}`, "whoop_linked", req.telegram.id, { whoopUsername: whoop.username });
  });
  res.json(await whoopStatus(req.telegram.id));
});

app.post("/api/whoop/unlink", auth, async (req, res) => {
  await inTransaction(async () => {
    if (await whoopReservedAll(req.telegram.id) > 0)
      throw new ApiError(409, "Wait for your pending withdrawal to finish before disconnecting.");
    const removed = await db.prepare("DELETE FROM whoop_links WHERE telegram_id = ?").run(req.telegram.id);
    if (removed.changes) await audit(`user:${req.telegram.id}`, "whoop_unlinked", req.telegram.id);
  });
  res.json(await whoopStatus(req.telegram.id));
});

/* Creates (once) and checks the user's activation payment. The browser polls this while the user pays. */
app.get("/api/whoop/activation", auth, async (req, res) => {
  await inTransaction(async () => await ensureUser(req.telegram));
  const id = req.telegram.id;
  if (!ACTIVATION_ENABLED) return res.json({ required: false, paid: true });
  rateLimit(`activation:${id}`, 120, 10 * 60_000);
  let row = await inTransaction(async () => {
    let r = await activationRow(id);
    if (!r) {
      await db.prepare("INSERT INTO whoop_activation (telegram_id, reference, lamports) VALUES (?, ?, ?)").run(
        id,
        newReference(),
        ACTIVATION_LAMPORTS,
      );
      r = await activationRow(id);
    }
    return r;
  });
  if (!row.paid_at) {
    try {
      const found = await findSolPayment(activationRpc, {
        reference: row.reference,
        recipient: DEPOSIT_ADDRESS,
        minLamports: row.lamports,
      });
      if (found.status === "paid") {
        await inTransaction(async () => {
          const done = await db
            .prepare(
              "UPDATE whoop_activation SET paid_at = CURRENT_TIMESTAMP, signature = ?, payer = ? WHERE telegram_id = ? AND paid_at IS NULL",
            )
            .run(found.signature, found.payer, id);
          if (done.changes)
            await audit(`user:${id}`, "whoop_activation_paid", id, {
              signature: found.signature,
              lamports: found.receivedLamports,
            });
        });
        row = await activationRow(id);
      }
    } catch (error) {
      if (!(error instanceof RpcError)) throw error; /* chain unreadable: stay pending, try again */
    }
  }
  const sol = row.lamports / 1e9;
  res.json({
    required: true,
    paid: !!row.paid_at,
    address: DEPOSIT_ADDRESS,
    sol,
    url: solanaPaySolUrl({
      recipient: DEPOSIT_ADDRESS,
      lamports: row.lamports,
      reference: row.reference,
      label: "Phygitals",
      message: "One-time activation fee",
    }),
  });
});

app.get("/api/whoop/quote", auth, async (req, res) => {
  const link = await whoopLink(req.telegram.id);
  if (!link) throw new ApiError(409, "Connect your Whoop Wallet first.");
  await requireActivation(req.telegram.id);
  const amount = toMicros(req.query.amount);
  if (!amount) throw new ApiError(400, "Enter a valid amount.");
  const token = whoopToken(req.query.token);
  const quote = await quoteFor(amount);
  if (quote.amount > await withdrawableMicros(req.telegram.id, token))
    throw new ApiError(400, "Insufficient available balance.");
  res.json({
    token,
    destination: `@${link.whoop_username}`,
    amount: quote.amount / MICRO,
    fee: quote.fee / MICRO,
    receive: quote.net / MICRO,
  });
});

app.post("/api/whoop/withdraw", auth, async (req, res) => {
  const { amount: rawAmount, idempotencyKey, confirm, expectedFee } = req.body || {};
  if (confirm !== true) throw new ApiError(400, "Confirm the withdrawal to continue.");
  if (typeof idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(idempotencyKey))
    throw new ApiError(400, "A valid idempotencyKey is required.");
  rateLimit(`whoop-withdraw:${req.telegram.id}`, 20, 10 * 60 * 1000);
  const amount = toMicros(rawAmount);
  if (!amount) throw new ApiError(400, "Enter a valid amount.");
  const token = whoopToken(req.body?.token);

  const row = await inTransaction(async () => {
    const existing = await db
      .prepare("SELECT * FROM whoop_withdrawals WHERE telegram_id = ? AND idempotency_key = ?")
      .get(req.telegram.id, idempotencyKey);
    if (existing) {
      if (existing.amount_micros !== amount || existing.token !== token)
        throw new ApiError(409, "That request ID was already used for a different withdrawal.");
      return existing;
    }
    const link = await whoopLink(req.telegram.id);
    if (!link) throw new ApiError(409, "Connect your Whoop Wallet first.");
    await requireActivation(req.telegram.id);
    const quote = await quoteFor(amount);
    if (toMicros(String(expectedFee)) !== quote.fee && !(expectedFee === 0 && quote.fee === 0))
      throw new ApiError(409, "The service fee changed. Review the withdrawal and confirm again.");
    if (quote.amount > await withdrawableMicros(req.telegram.id, token))
      throw new ApiError(400, "Insufficient available balance.");
    const id = crypto.randomUUID();
    await db.prepare(
      `INSERT INTO whoop_withdrawals
        (id, telegram_id, whoop_username, idempotency_key, amount_micros, fee_micros, net_micros, token)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, req.telegram.id, link.whoop_username, idempotencyKey, quote.amount, quote.fee, quote.net, token);
    await audit(`user:${req.telegram.id}`, "whoop_withdrawal_reserved", id, {
      token,
      amount: quote.amount,
      fee: quote.fee,
      destination: link.whoop_username,
    });
    return await db.prepare("SELECT * FROM whoop_withdrawals WHERE id = ?").get(id);
  });

  await attemptPayout(row.id);
  const latest = await db.prepare("SELECT * FROM whoop_withdrawals WHERE id = ?").get(row.id);
  const status = latest.status === "completed" ? 200 : latest.status === "failed" ? 422 : 202;
  res.status(status).json(publicWithdrawal(latest));
});

app.get("/api/whoop/withdrawals", auth, async (req, res) => {
  const rows = await db
    .prepare("SELECT * FROM whoop_withdrawals WHERE telegram_id = ? ORDER BY created_at DESC LIMIT 100")
    .all(req.telegram.id);
  res.json({ withdrawals: rows.map(publicWithdrawal) });
});

app.get("/api/whoop/withdrawals/:id", auth, async (req, res) => {
  const row = await db
    .prepare("SELECT * FROM whoop_withdrawals WHERE id = ? AND telegram_id = ?")
    .get(req.params.id, req.telegram.id);
  if (!row) throw new ApiError(404, "Withdrawal not found.");
  res.json(publicWithdrawal(row));
});

app.get("/admin/whoop-withdrawals", adminAuth, async (req, res) => {
  const status = ["pending", "completed", "failed"].includes(req.query.status) ? req.query.status : null;
  const rows = await db
    .prepare(
      `SELECT * FROM whoop_withdrawals ${status ? "WHERE status = ?" : ""} ORDER BY created_at DESC LIMIT 500`,
    )
    .all(...(status ? [status] : []));
  res.json({
    withdrawals: rows.map((row) => ({
      ...publicWithdrawal(row),
      telegramId: row.telegram_id,
      attempts: row.attempts,
      lastError: row.last_error,
      reference: `phygitals:${row.id}`,
    })),
  });
});

app.get("/admin/whoop-summary", adminAuth, async (_req, res) => {
  const by = async (status) =>
    await db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(amount_micros), 0) AS amount, COALESCE(SUM(net_micros), 0) AS net
         FROM whoop_withdrawals WHERE status = ?`,
      )
      .get(status);
  const done = await by("completed");
  const feesRow = await db
    .prepare("SELECT COALESCE(SUM(amount_micros), 0) AS n FROM ledger WHERE kind = 'service_fee'")
    .get();
  const fees = feesRow.n;
  const pendingSummary = await by("pending");
  const failedSummary = await by("failed");
  res.json({
    completed: done.n,
    volume: done.amount / MICRO,
    sentToWhoop: done.net / MICRO,
    feesCollected: fees / MICRO,
    pending: pendingSummary.n,
    pendingAmount: pendingSummary.amount / MICRO,
    failed: failedSummary.n,
    currentFee: await whoopFeeMicros() / MICRO,
  });
});

app.post("/admin/whoop-withdrawals/:id/retry", adminAuth, async (req, res) => {
  const row = await db.prepare("SELECT status FROM whoop_withdrawals WHERE id = ?").get(req.params.id);
  if (!row) throw new ApiError(404, "Withdrawal not found.");
  if (row.status !== "pending") throw new ApiError(409, "Only pending withdrawals can be retried.");
  await audit("admin", "whoop_withdrawal_retry", req.params.id);
  await attemptPayout(req.params.id);
  res.json(publicWithdrawal(await db.prepare("SELECT * FROM whoop_withdrawals WHERE id = ?").get(req.params.id)));
});

app.post("/admin/settings/whoop-fee", adminAuth, async (req, res) => {
  const rawFee = req.body?.fee;
  const fee = Number(rawFee) === 0 && rawFee !== "" && rawFee !== null && rawFee !== undefined ? 0 : toMicros(rawFee);
  if (fee === null || fee > MAX_WHOOP_FEE || fee % CENT !== 0)
    throw new ApiError(400, `Fee must be between $0 and $${MAX_WHOOP_FEE / MICRO}, in whole cents.`);
  const previous = await whoopFeeMicros();
  await db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
  ).run(WHOOP_FEE_KEY, String(fee));
  await audit("admin", "whoop_fee_changed", null, { from: previous, to: fee });
  res.json({ fee: fee / MICRO });
});

/* Testing only: give a user pack credits. Disabled unless ALLOW_TEST_CREDITS=1.
   Pack credits can be cashed out through Whoop, so leave this off in production. */
app.post("/admin/credit", adminAuth, async (req, res) => {
  if (!/^(1|true|yes)$/i.test(process.env.ALLOW_TEST_CREDITS || ""))
    throw new ApiError(403, "Test credits are disabled. Set ALLOW_TEST_CREDITS=1 to enable them.");
  const amount = toMicros(req.body?.amount);
  if (amount === null || amount > 100_000 * MICRO)
    throw new ApiError(400, "Amount must be between $0.01 and $100,000.");

  const { wallet, telegramId } = req.body || {};
  let user = null;
  if (typeof wallet === "string" && wallet)
    user = await db.prepare("SELECT * FROM users WHERE wallet = ?").get(wallet);
  else if (telegramId) user = await findUser(String(telegramId));
  if (!user)
    throw new ApiError(
      404,
      "No user found. The wallet must be linked in the app first (Add funds > link wallet), or pass telegramId instead.",
    );

  await inTransaction(async () => {
    await db.prepare("UPDATE users SET credits_micros = credits_micros + ? WHERE telegram_id = ?").run(
      amount,
      user.telegram_id,
    );
    await audit("admin", "test_credit", user.telegram_id, { amount, wallet: user.wallet });
  });
  res.json({ telegramId: user.telegram_id, wallet: user.wallet, credits: (await publicProfile(user.telegram_id)).credits });
});

app.get("/admin/audit", adminAuth, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  res.json({
    entries: await db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?").all(limit),
  });
});

app.use((error, req, res, _next) => {
  const status = error instanceof ApiError ? error.status : 500;
  if (status >= 500) console.error(`${req.method} ${req.path}:`, error);
  res.status(status).json({
    error: status === 500 ? "Server error. Please try again later." : error.message,
  });
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  setInterval(() => {
    reconcilePending().catch((error) => console.error("Whoop reconcile failed:", error));
  }, 5_000).unref();
  setInterval(() => {
    reconcileFeePayments().catch((error) => console.error("Fee payment reconcile failed:", error));
  }, 15_000).unref();
  app.listen(PORT, async () => {
    console.log(`Phygitals server listening on port ${PORT}`);
    if (!BOT_TOKEN) console.warn("BOT_TOKEN is not set; Telegram API requests will be rejected.");
    if (/REPLACE/i.test(BOT_TOKEN)) console.warn("BOT_TOKEN still contains the REPLACE_WITH placeholder; sign-in will fail.");
    if (/REPLACE/i.test(APP_ORIGIN)) console.warn("APP_ORIGIN still contains the REPLACE_WITH placeholder; sign-in will fail.");
    if (!bot.enabled)
      console.warn("APP_URL (public https URL) or BOT_TOKEN is missing; the Telegram bot (/start) is disabled.");
    else
      bot.setup().then((result) => console.log("Telegram bot setup:", JSON.stringify(result)));
    if (!isSolanaAddress(DEPOSIT_ADDRESS))
      console.warn("DEPOSIT_ADDRESS is missing or invalid; deposits are disabled.");
    if (!HELIUS_AUTH) console.warn("HELIUS_AUTH is not set; deposit webhook is disabled.");
    if (FEE_ENABLED)
      console.log(`Withdrawal processing fee: ON ($${WITHDRAWAL_FEE / MICRO} USDC to ${FEE_WALLET_ADDRESS}, ${FEE_COMMITMENT})`);
    else
      console.warn(
        `Withdrawal processing fee: OFF (${FEE_PROBLEM || "set FEE_WALLET_ADDRESS and SOLANA_RPC_URL to turn it on"}). ` +
          "Withdrawals use the old behavior and take the fee out of the amount.",
      );
    console.log(
      `Database: PostgreSQL (${(await db.prepare("SELECT COUNT(*) AS n FROM users").get()).n} users).`,
    );
    for (const pack of PACKS) {
      const s = PACK_STATUS.get(pack.id);
      console.log(
        s.unsafe
          ? `Pack ${pack.id}: ON (UNSAFE OVERRIDE) price $${pack.price} but average payout is $${s.expectedPayout}`
          : s.available
          ? `Pack ${pack.id}: ON  price $${pack.price}, average payout $${s.expectedPayout}`
          : `Pack ${pack.id}: OFF ${s.reason}`,
      );
    }
  });
}

export { app, db, bot, reconcilePending, attemptPayout, reconcileFeePayments };