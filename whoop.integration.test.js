// phygitals/whoop.integration.test.js
/* End-to-end tests: the real Whoop Wallet server runs as a child process, so every
   "completed" withdrawal below was confirmed by Whoop's own API, not a stub.
   Set WHOOP_SERVER_PATH if the Whoop repo is not at ../whoop-wallet. */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const whoopServer =
  process.env.WHOOP_SERVER_PATH || path.resolve(here, "../whoop-wallet/telegram-bot/server.js");
const skip = fs.existsSync(whoopServer) ? false : `Whoop server not found at ${whoopServer}`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phy-whoop-"));
const PHY_BOT = "111111:phygitals-test-token";
const WHOOP_BOT = "222222:whoop-test-token";
const ADMIN = "admin-test-token-admin-test-token";
const SERVICE_KEY = crypto.randomBytes(24).toString("hex");
process.env.BOT_TOKEN = PHY_BOT;
process.env.ADMIN_TOKEN = ADMIN;
process.env.DATABASE_PATH = path.join(dir, "phy.sqlite");
process.env.WHOOP_INTEGRATION_KEY = SERVICE_KEY;

const { app, db, reconcilePending } = await import("./server.js");
const MICRO = 1_000_000;
let phy, whoop, phyUrl, whoopUrl, whoopProc;

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

function signed(botToken, id, extra = {}) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id, username: `user${id}`, first_name: "T", ...extra }),
  });
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  params.set("hash", crypto.createHmac("sha256", secret).update(check).digest("hex"));
  return params.toString();
}

async function phyApi(id, url, { method = "GET", body, admin } = {}) {
  const res = await fetch(`${phyUrl}${url}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(admin !== undefined ? { "X-Admin-Token": admin } : { "X-Telegram-Init-Data": signed(PHY_BOT, id) }),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

const whoopSessions = new Map();
async function whoopApi(url, { method = "GET", body, token, key } = {}) {
  const res = await fetch(`${whoopUrl}${url}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(key ? { "x-integration-key": key } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}
async function whoopUser(id, pin = "4826") {
  if (whoopSessions.has(id)) return whoopSessions.get(id);
  const auth = await whoopApi("/api/auth", { method: "POST", body: { initData: signed(WHOOP_BOT, id) } });
  assert.equal(auth.status, 200);
  const token = auth.body.token;
  const setup = await whoopApi("/api/pin/setup", { method: "POST", token, body: { pin: pin } });
  assert.equal(setup.status, 200);
  const user = { token, pin, username: auth.body.me.username };
  whoopSessions.set(id, user);
  return user;
}
const whoopBalance = async (id) => (await whoopApi("/api/sync", { token: (await whoopUser(id)).token })).body;

async function link(id) {
  const w = await whoopUser(id);
  const code = await whoopApi("/api/integrations/phygitals/link-code", { method: "POST", token: w.token, body: { pin: w.pin } });
  assert.equal(code.status, 200);
  return phyApi(id, "/api/whoop/link", { method: "POST", body: { code: code.body.code } });
}
function fund(id, dollars) {
  /* Test fixture: stands in for a confirmed deposit, which is credited to credits_micros. */
  phyApi(id, "/api/me");
  db.prepare("UPDATE users SET credits_micros = ? WHERE telegram_id = ?").run(dollars * MICRO, String(id));
}
const key = () => crypto.randomBytes(16).toString("hex");
const withdraw = (id, amount, extra = {}) =>
  phyApi(id, "/api/whoop/withdraw", {
    method: "POST",
    body: { amount, confirm: true, expectedFee: 3, idempotencyKey: key(), ...extra },
  });
const credits = (id) => db.prepare("SELECT credits_micros AS c FROM users WHERE telegram_id = ?").get(String(id)).c / MICRO;

before(async () => {
  if (skip) return;
  phy = app.listen(0);
  phyUrl = `http://127.0.0.1:${phy.address().port}`;
  const port = await freePort();
  whoopUrl = `http://127.0.0.1:${port}`;
  whoopProc = spawn(process.execPath, [whoopServer], {
    env: { ...process.env, PORT: String(port), DB_PATH: path.join(dir, "whoop.db"), BOT_TOKEN: WHOOP_BOT,
      PHYGITALS_INTEGRATION_KEY: SERVICE_KEY, DEPOSIT_API_KEY: "unused-admin-key-unused-admin-key" },
    stdio: "ignore",
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${whoopUrl}/api/health`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  process.env.WHOOP_API_URL = whoopUrl;
});
after(() => { phy?.close(); whoopProc?.kill(); });

test("linking needs a one-time code from the same Telegram account", { skip }, async () => {
  const unlinked = await phyApi(1001, "/api/whoop/status");
  assert.equal(unlinked.body.linked, false);
  assert.equal((await withdraw(1001, 20)).status, 409);

  const ok = await link(1001);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.linked, true);
  assert.equal(ok.body.whoopUsername, "user1001");

  // a code made by a different Telegram account cannot be attached to this Phygitals user
  const other = await whoopUser(1002);
  const code = await whoopApi("/api/integrations/phygitals/link-code", { method: "POST", token: other.token, body: { pin: other.pin } });
  const stolen = await phyApi(1001, "/api/whoop/link", { method: "POST", body: { code: code.body.code } });
  assert.equal(stolen.status, 403);
  assert.equal((await phyApi(1001, "/api/whoop/status")).body.whoopUsername, "user1001");

  // codes are single use, wrong PIN gets no code, bad service key is refused
  const w = await whoopUser(1003);
  const c = await whoopApi("/api/integrations/phygitals/link-code", { method: "POST", token: w.token, body: { pin: w.pin } });
  assert.equal((await phyApi(1003, "/api/whoop/link", { method: "POST", body: { code: c.body.code } })).status, 200);
  assert.equal((await phyApi(1003, "/api/whoop/link", { method: "POST", body: { code: c.body.code } })).status, 400);
  assert.equal((await whoopApi("/api/integrations/phygitals/link-code", { method: "POST", token: w.token, body: { pin: "9999" } })).status, 403);
  assert.equal((await whoopApi("/api/integrations/phygitals/verify-link", { method: "POST", key: "wrong", body: { code: "ABCD-EFGH" } })).status, 401);
});

test("withdrawal credits Whoop once, charges the $3 fee once, and records both ledger lines", { skip }, async () => {
  fund(1001, 50);
  const before = (await whoopBalance(1001)).balance;
  const quote = await phyApi(1001, "/api/whoop/quote?amount=20");
  assert.deepEqual([quote.body.amount, quote.body.fee, quote.body.receive], [20, 3, 17]);
  assert.equal(quote.body.destination, "@user1001");

  const idem = key();
  const first = await withdraw(1001, 20, { idempotencyKey: idem });
  assert.equal(first.status, 200);
  assert.equal(first.body.status, "completed");
  assert.ok(first.body.whoopTxId);
  const replay = await withdraw(1001, 20, { idempotencyKey: idem });
  assert.equal(replay.body.id, first.body.id);

  const after = await whoopBalance(1001);
  assert.equal(after.balance - before, 1700);
  assert.equal(after.txs.filter((t) => t.note === "Withdrawal from Phygitals").length, 1);
  assert.equal(credits(1001), 30);
  const ledger = db.prepare("SELECT kind, amount_micros FROM ledger WHERE withdrawal_id = ? ORDER BY kind").all(first.body.id).map((r) => ({ ...r }));
  assert.deepEqual(ledger, [{ kind: "service_fee", amount_micros: 3 * MICRO }, { kind: "whoop_withdrawal", amount_micros: 17 * MICRO }]);
  assert.equal((await withdraw(1001, 25, { idempotencyKey: idem })).status, 409);
});

test("validation: balance, minimum, fee change, confirmation, cents", { skip }, async () => {
  fund(1001, 30);
  assert.equal((await withdraw(1001, 31)).status, 400);
  assert.equal((await withdraw(1001, 9)).status, 400);
  assert.equal((await withdraw(1001, 12.345)).status, 400);
  assert.equal((await withdraw(1001, 20, { confirm: false })).status, 400);
  assert.equal((await withdraw(1001, 20, { expectedFee: 1 })).status, 409);
  assert.equal((await withdraw(1001, 20, { idempotencyKey: "short" })).status, 400);
  assert.equal(credits(1001), 30);
});

test("cannot read or use another user's withdrawal", { skip }, async () => {
  fund(1003, 20);
  const mine = await withdraw(1003, 10);
  assert.equal(mine.status, 200);
  assert.equal((await phyApi(1001, `/api/whoop/withdrawals/${mine.body.id}`)).status, 404);
  assert.equal((await phyApi(1003, `/api/whoop/withdrawals/${mine.body.id}`)).status, 200);
});

test("when Whoop cannot be reached the balance stays reserved, then settles once on retry", { skip }, async () => {
  fund(1001, 40);
  const before = (await whoopBalance(1001)).balance;
  process.env.WHOOP_API_URL = `http://127.0.0.1:${await freePort()}`;
  const pending = await withdraw(1001, 15);
  assert.equal(pending.status, 202);
  assert.equal(pending.body.status, "pending");
  assert.equal((await phyApi(1001, "/api/whoop/status")).body.available, 25);   // reserved
  assert.equal((await withdraw(1001, 30)).status, 400);                         // cannot spend the reserved part
  assert.equal(credits(1001), 40);                                              // not deducted before confirmation
  assert.equal((await phyApi(1001, "/api/whoop/unlink", { method: "POST" })).status, 409);

  process.env.WHOOP_API_URL = whoopUrl;
  await reconcilePending({ olderThanSeconds: 0 });
  await reconcilePending({ olderThanSeconds: 0 });
  const done = await phyApi(1001, `/api/whoop/withdrawals/${pending.body.id}`);
  assert.equal(done.body.status, "completed");
  assert.equal((await whoopBalance(1001)).balance - before, 1200);
  assert.equal(credits(1001), 25);
});

test("a definite refusal from Whoop fails the withdrawal and releases the reservation", { skip }, async () => {
  fund(1001, 40);
  const w = await whoopUser(1001);
  assert.equal((await whoopApi("/api/integrations/phygitals/unlink", { method: "POST", token: w.token, body: { pin: w.pin } })).status, 200);
  const failed = await withdraw(1001, 20);
  assert.equal(failed.status, 422);
  assert.equal(failed.body.status, "failed");
  assert.equal(credits(1001), 40);
  assert.equal((await phyApi(1001, "/api/whoop/status")).body.available, 40);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE withdrawal_id = ?").get(failed.body.id).n, 0);
  assert.ok((await link(1001)).body.linked);   // reconnect works
});

test("admin: fee is configurable, volume and fees are reported, access is protected", { skip }, async () => {
  assert.equal((await phyApi(0, "/admin/whoop-summary", { admin: "wrong" })).status, 401);
  const summary = (await phyApi(0, "/admin/whoop-summary", { admin: ADMIN })).body;
  assert.equal(summary.completed, 3);      // 20 + 10 + 15 earlier in this file
  assert.equal(summary.volume, 45);
  assert.equal(summary.feesCollected, 9);
  assert.equal(summary.sentToWhoop, 36);
  assert.equal(summary.failed, 1);

  assert.equal((await phyApi(0, "/admin/settings/whoop-fee", { admin: ADMIN, method: "POST", body: { fee: "2.50" } })).body.fee, 2.5);
  fund(1001, 20);
  assert.equal((await phyApi(1001, "/api/whoop/quote?amount=10")).body.receive, 7.5);
  assert.equal((await withdraw(1001, 10)).status, 409);                                  // client still showing $3
  const ok = await withdraw(1001, 10, { expectedFee: 2.5 });
  assert.equal(ok.body.fee, 2.5);
  await phyApi(0, "/admin/settings/whoop-fee", { admin: ADMIN, method: "POST", body: { fee: "3" } });

  const list = (await phyApi(0, "/admin/whoop-withdrawals?status=failed", { admin: ADMIN })).body.withdrawals;
  assert.equal(list.length, 1);
  const done = (await phyApi(0, "/admin/whoop-withdrawals?status=completed", { admin: ADMIN })).body.withdrawals;
  assert.ok(done.every((w) => w.whoopTxId));
  assert.ok((await phyApi(0, "/admin/audit?limit=5", { admin: ADMIN })).body.entries.length > 0);
});
