import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import express from "express";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const HELIUS_AUTH = process.env.HELIUS_AUTH || "";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const APP_ORIGIN = process.env.APP_ORIGIN || "";
const DEPOSIT_ADDRESS = process.env.DEPOSIT_ADDRESS || "";
const DATABASE_PATH = path.resolve(
  process.env.DATABASE_PATH || path.join(ROOT, "data", "phygitals.sqlite"),
);
const MICRO = 1_000_000;
const REFERRAL_BONUS = MICRO;
const WITHDRAWAL_FEE = 3_290_000;
const MIN_WITHDRAWAL = 10 * MICRO;
const MINTS = new Map([
  ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "usdc"],
  ["Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", "usdt"],
]);
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const SOLANA_KEY_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

fs.mkdirSync(path.dirname(DATABASE_PATH), { recursive: true });
const db = new DatabaseSync(DATABASE_PATH);
db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    telegram_id TEXT PRIMARY KEY,
    username TEXT,
    referral_code TEXT NOT NULL UNIQUE,
    referred_by TEXT REFERENCES users(telegram_id),
    credits_micros INTEGER NOT NULL DEFAULT 0,
    usdc_micros INTEGER NOT NULL DEFAULT 0,
    usdt_micros INTEGER NOT NULL DEFAULT 0,
    wallet TEXT UNIQUE,
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
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS deposits (
    signature TEXT NOT NULL,
    transfer_index INTEGER NOT NULL,
    telegram_id TEXT NOT NULL REFERENCES users(telegram_id),
    token TEXT NOT NULL,
    amount_micros INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (signature, transfer_index)
  );
  CREATE TABLE IF NOT EXISTS unclaimed_deposits (
    signature TEXT NOT NULL,
    transfer_index INTEGER NOT NULL,
    sender TEXT NOT NULL,
    token TEXT NOT NULL,
    amount_micros INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (signature, transfer_index)
  );
  CREATE TABLE IF NOT EXISTS withdrawal_requests (
    id TEXT PRIMARY KEY,
    telegram_id TEXT NOT NULL REFERENCES users(telegram_id),
    token TEXT NOT NULL CHECK (token IN ('usdc', 'usdt')),
    destination TEXT NOT NULL,
    amount_micros INTEGER NOT NULL,
    fee_micros INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'paid', 'rejected')),
    payout_reference TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    processed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS withdrawal_pending_user
    ON withdrawal_requests(telegram_id, status);
`);

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function inTransaction(fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
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

function findUser(id) {
  return db.prepare("SELECT * FROM users WHERE telegram_id = ?").get(id);
}

function ensureUser(telegram) {
  let user = findUser(telegram.id);
  if (user) {
    if (telegram.username && telegram.username !== user.username) {
      db.prepare("UPDATE users SET username = ? WHERE telegram_id = ?").run(
        telegram.username,
        telegram.id,
      );
      user = findUser(telegram.id);
    }
    return user;
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = makeReferralCode();
    try {
      db.prepare(
        "INSERT INTO users (telegram_id, username, referral_code) VALUES (?, ?, ?)",
      ).run(telegram.id, telegram.username, code);
      return findUser(telegram.id);
    } catch (error) {
      if (!String(error.message).includes("UNIQUE")) throw error;
    }
  }
  throw new Error("Could not allocate a unique referral code");
}

function publicProfile(id) {
  const user = findUser(id);
  if (!user) throw new ApiError(404, "Account not found. Sign in again.");
  const pending = db
    .prepare(
      `SELECT token, COALESCE(SUM(amount_micros), 0) AS reserved
       FROM withdrawal_requests WHERE telegram_id = ? AND status = 'pending'
       GROUP BY token`,
    )
    .all(id);
  const reserved = Object.fromEntries(pending.map((row) => [row.token, row.reserved]));
  const referrals = db
    .prepare("SELECT COUNT(*) AS count FROM referrals WHERE referrer_id = ?")
    .get(id).count;
  const referred = user.referred_by
    ? db
        .prepare("SELECT username, created_at FROM users WHERE telegram_id = ?")
        .get(user.referred_by)
    : null;

  return {
    id: user.telegram_id,
    code: user.referral_code,
    credits: user.credits_micros / MICRO,
    usdc: (user.usdc_micros - (reserved.usdc || 0)) / MICRO,
    usdt: (user.usdt_micros - (reserved.usdt || 0)) / MICRO,
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

function attachReferral(userId, code) {
  if (typeof code !== "string" || !/^[a-f0-9]{12}$/i.test(code)) return false;
  const user = findUser(userId);
  if (user.referred_by) return false;
  const referrer = db
    .prepare("SELECT telegram_id FROM users WHERE lower(referral_code) = lower(?)")
    .get(code);
  if (!referrer || referrer.telegram_id === userId) return false;

  db.prepare("UPDATE users SET referred_by = ? WHERE telegram_id = ?").run(
    referrer.telegram_id,
    userId,
  );
  db.prepare(
    "INSERT INTO referrals (referred_id, referrer_id) VALUES (?, ?)",
  ).run(userId, referrer.telegram_id);
  db.prepare(
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

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  const origin = req.get("origin");
  if (origin && APP_ORIGIN && APP_ORIGIN !== "*" && origin !== APP_ORIGIN)
    return res.sendStatus(403);
  if (origin && APP_ORIGIN === "*") res.set("Access-Control-Allow-Origin", "*");
  else if (origin && origin === APP_ORIGIN)
    res.set("Access-Control-Allow-Origin", APP_ORIGIN);
  res.set("Access-Control-Allow-Headers", "X-Telegram-Init-Data, X-Admin-Token, Content-Type, Authorization");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

function auth(req, res, next) {
  const telegram = verifyInitData(req.get("X-Telegram-Init-Data"));
  if (!telegram) return res.status(401).json({ error: "Valid Telegram sign-in required." });
  req.telegram = telegram;
  next();
}

function adminAuth(req, res, next) {
  if (!ADMIN_TOKEN)
    return res.status(503).json({ error: "Withdrawal review is not configured." });
  if (!safeEqual(req.get("X-Admin-Token"), ADMIN_TOKEN))
    return res.status(401).json({ error: "Unauthorized." });
  next();
}

app.get("/", (_req, res) => res.sendFile(path.join(ROOT, "index.html")));
app.use("/assets", express.static(path.join(ROOT, "assets")));

app.get("/api/me", auth, (req, res) => {
  res.json(publicProfile(req.telegram.id));
});

app.post("/api/signup", auth, (req, res) => {
  const result = inTransaction(() => {
    ensureUser(req.telegram);
    const awarded = attachReferral(req.telegram.id, req.body?.ref);
    return { ...publicProfile(req.telegram.id), referralAwarded: awarded };
  });
  res.json(result);
});

app.get("/api/rewards", auth, (req, res) => {
  res.json(publicProfile(req.telegram.id));
});

app.post("/api/redeem", auth, (req, res) => {
  const result = inTransaction(() => {
    ensureUser(req.telegram);
    const awarded = attachReferral(req.telegram.id, req.body?.code);
    if (!awarded) {
      const user = findUser(req.telegram.id);
      if (user.referred_by) throw new ApiError(409, "A referral code has already been used.");
      throw new ApiError(400, "That referral code is not valid.");
    }
    return { ...publicProfile(req.telegram.id), referralAwarded: true };
  });
  res.json(result);
});

app.get("/api/balance", auth, (req, res) => {
  const profile = publicProfile(req.telegram.id);
  res.json({
    credits: profile.credits,
    usdc: profile.usdc,
    usdt: profile.usdt,
    wallet: profile.wallet,
  });
});

app.get("/api/deposit-address", auth, (_req, res) => {
  if (!isSolanaAddress(DEPOSIT_ADDRESS))
    return res.status(503).json({ error: "Crypto deposits are not configured." });
  res.json({ address: DEPOSIT_ADDRESS });
});

app.post("/api/link-wallet/challenge", auth, (req, res) => {
  const address = req.body?.address;
  if (!isSolanaAddress(address) || address === DEPOSIT_ADDRESS)
    return res.status(400).json({ error: "Enter a valid Solana address." });

  const user = inTransaction(() => ensureUser(req.telegram));
  const nonce = crypto.randomBytes(24).toString("hex");
  const message = walletChallengeMessage(user.telegram_id, address, nonce);
  db.prepare(
    `INSERT INTO wallet_link_challenges (telegram_id, address, nonce, expires_at)
     VALUES (?, ?, ?, ?) ON CONFLICT(telegram_id) DO UPDATE SET
       address = excluded.address, nonce = excluded.nonce, expires_at = excluded.expires_at`,
  ).run(user.telegram_id, address, nonce, Date.now() + 5 * 60 * 1000);
  res.json({ nonce, message });
});

app.post("/api/link-wallet", auth, (req, res) => {
  const { address, nonce, signature } = req.body || {};
  const challenge = db
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

  inTransaction(() => {
    const current = db
      .prepare("SELECT * FROM wallet_link_challenges WHERE telegram_id = ?")
      .get(req.telegram.id);
    if (
      !current ||
      current.address !== address ||
      current.nonce !== nonce ||
      current.expires_at < Date.now()
    )
      throw new ApiError(400, "Wallet link request expired. Try again.");
    const owner = db
      .prepare("SELECT telegram_id FROM users WHERE wallet = ?")
      .get(address);
    if (owner && owner.telegram_id !== req.telegram.id)
      throw new ApiError(409, "That wallet is already linked to another account.");
    db.prepare("UPDATE users SET wallet = ? WHERE telegram_id = ?").run(
      address,
      req.telegram.id,
    );
    const unclaimed = db
      .prepare("SELECT * FROM unclaimed_deposits WHERE sender = ?")
      .all(address);
    for (const deposit of unclaimed) {
      const inserted = db
        .prepare(
          `INSERT OR IGNORE INTO deposits
            (signature, transfer_index, telegram_id, token, amount_micros)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          deposit.signature,
          deposit.transfer_index,
          req.telegram.id,
          deposit.token,
          deposit.amount_micros,
        );
      if (inserted.changes) {
        db.prepare(
          "UPDATE users SET credits_micros = credits_micros + ? WHERE telegram_id = ?",
        ).run(deposit.amount_micros, req.telegram.id);
      }
      db.prepare(
        "DELETE FROM unclaimed_deposits WHERE signature = ? AND transfer_index = ?",
      ).run(deposit.signature, deposit.transfer_index);
    }
    db.prepare("DELETE FROM wallet_link_challenges WHERE telegram_id = ?").run(
      req.telegram.id,
    );
  });
  res.json({ wallet: address });
});

app.get("/admin/withdrawals", adminAuth, (req, res) => {
  const status = req.query.status === "all" ? null : "pending";
  const requests = status
    ? db
        .prepare(
          `SELECT id, telegram_id AS telegramId, token, destination,
            amount_micros * 1.0 / ? AS amount, fee_micros * 1.0 / ? AS fee,
            (amount_micros - fee_micros) * 1.0 / ? AS receive, status, created_at AS createdAt
           FROM withdrawal_requests WHERE status = ? ORDER BY created_at`,
        )
        .all(MICRO, MICRO, MICRO, status)
    : db
        .prepare(
          `SELECT id, telegram_id AS telegramId, token, destination,
            amount_micros * 1.0 / ? AS amount, fee_micros * 1.0 / ? AS fee,
            (amount_micros - fee_micros) * 1.0 / ? AS receive, status, created_at AS createdAt
           FROM withdrawal_requests ORDER BY created_at DESC LIMIT 500`,
        )
        .all(MICRO, MICRO, MICRO);
  res.json({ requests });
});

app.get("/admin/unclaimed-deposits", adminAuth, (_req, res) => {
  const deposits = db
    .prepare(
      `SELECT signature, transfer_index AS transferIndex, sender, token,
        amount_micros * 1.0 / ? AS amount, created_at AS createdAt
       FROM unclaimed_deposits ORDER BY created_at DESC LIMIT 500`,
    )
    .all(MICRO);
  res.json({ deposits });
});

app.post("/api/withdraw", auth, (req, res) => {
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

  const request = inTransaction(() => {
    const user = findUser(req.telegram.id);
    if (!user) throw new ApiError(404, "Account not found.");
    const reserved = db
      .prepare(
        `SELECT COALESCE(SUM(amount_micros), 0) AS amount FROM withdrawal_requests
         WHERE telegram_id = ? AND token = ? AND status = 'pending'`,
      )
      .get(req.telegram.id, token).amount;
    if (user[`${token}_micros`] - reserved < amount)
      throw new ApiError(400, "Insufficient available balance.");
    const id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO withdrawal_requests
        (id, telegram_id, token, destination, amount_micros, fee_micros)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, req.telegram.id, token, destination, amount, WITHDRAWAL_FEE);
    return id;
  });
  res.status(202).json({
    id: request,
    status: "pending",
    fee: WITHDRAWAL_FEE / MICRO,
    receive: (amount - WITHDRAWAL_FEE) / MICRO,
  });
});

app.post("/admin/withdrawals/:id/review", adminAuth, (req, res) => {
  const { action, reference } = req.body || {};
  if (!["paid", "reject"].includes(action))
    return res.status(400).json({ error: "Choose paid or reject." });
  if (
    action === "paid" &&
    (typeof reference !== "string" || reference.trim().length < 8 || reference.length > 200)
  )
    return res.status(400).json({ error: "A payout reference is required." });

  inTransaction(() => {
    const request = db
      .prepare("SELECT * FROM withdrawal_requests WHERE id = ?")
      .get(req.params.id);
    if (!request) throw new ApiError(404, "Withdrawal request not found.");
    if (request.status !== "pending")
      throw new ApiError(409, "Withdrawal request was already reviewed.");
    if (action === "paid") {
      const column = `${request.token}_micros`;
      const result = db
        .prepare(`UPDATE users SET ${column} = ${column} - ? WHERE telegram_id = ? AND ${column} >= ?`)
        .run(request.amount_micros, request.telegram_id, request.amount_micros);
      if (result.changes !== 1)
        throw new ApiError(409, "Account balance changed; request was not completed.");
    }
    db.prepare(
      `UPDATE withdrawal_requests SET status = ?, payout_reference = ?, processed_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    ).run(action === "paid" ? "paid" : "rejected", action === "paid" ? reference.trim() : null, request.id);
  });
  res.json({ status: action === "paid" ? "paid" : "rejected" });
});

app.post("/webhook/helius", (req, res) => {
  if (!HELIUS_AUTH)
    return res.status(503).json({ error: "Deposit webhook is not configured." });
  if (!webhookAuthorized(req.get("authorization")))
    return res.sendStatus(401);
  if (!Array.isArray(req.body))
    return res.status(400).json({ error: "Expected a Helius transaction array." });

  let credited = 0;
  inTransaction(() => {
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
      tx.tokenTransfers.forEach((transfer, transferIndex) => {
        if (
          transfer?.toUserAccount !== DEPOSIT_ADDRESS ||
          !MINTS.has(transfer.mint) ||
          typeof transfer.fromUserAccount !== "string"
        )
          return;
        const amount = toMicros(transfer.tokenAmount);
        if (!amount) return;
        const token = MINTS.get(transfer.mint);
        const user = db
          .prepare("SELECT telegram_id FROM users WHERE wallet = ?")
          .get(transfer.fromUserAccount);
        if (!user) {
          db.prepare(
            `INSERT OR IGNORE INTO unclaimed_deposits
              (signature, transfer_index, sender, token, amount_micros)
             VALUES (?, ?, ?, ?, ?)`,
          ).run(tx.signature, transferIndex, transfer.fromUserAccount, token, amount);
          return;
        }
        const inserted = db
          .prepare(
            `INSERT OR IGNORE INTO deposits
              (signature, transfer_index, telegram_id, token, amount_micros)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(tx.signature, transferIndex, user.telegram_id, token, amount);
        if (inserted.changes) {
          db.prepare(
            "UPDATE users SET credits_micros = credits_micros + ? WHERE telegram_id = ?",
          ).run(amount, user.telegram_id);
          credited++;
        }
      });
    }
  });
  res.json({ creditedTransfers: credited });
});

app.use((error, req, res, _next) => {
  const status = error instanceof ApiError ? error.status : 500;
  if (status >= 500) console.error(`${req.method} ${req.path}:`, error);
  res.status(status).json({
    error: status === 500 ? "Server error. Please try again later." : error.message,
  });
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  app.listen(PORT, () => {
    console.log(`Phygitals server listening on port ${PORT}`);
    if (!BOT_TOKEN) console.warn("BOT_TOKEN is not set; Telegram API requests will be rejected.");
    if (!isSolanaAddress(DEPOSIT_ADDRESS))
      console.warn("DEPOSIT_ADDRESS is missing or invalid; deposits are disabled.");
    if (!HELIUS_AUTH) console.warn("HELIUS_AUTH is not set; deposit webhook is disabled.");
  });
}

export { app, db };
