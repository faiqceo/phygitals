import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { USDC_MINT, checkFeeTransaction, newReference, solanaPayUrl } from "./withdrawal-fee.js";

/* A tiny fake Solana JSON-RPC node. The server under test talks to it over real HTTP,
   so the real verification code runs; only the chain data is scripted. */
const chain = { signatures: new Map(), transactions: new Map(), down: false, calls: 0 };
const rpc = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    chain.calls++;
    if (chain.down) {
      res.writeHead(503).end("unavailable");
      return;
    }
    const { id, method, params } = JSON.parse(raw);
    let result = null;
    if (method === "getSignaturesForAddress") result = chain.signatures.get(params[0]) || [];
    if (method === "getTransaction") result = chain.transactions.get(params[0]) || null;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
  });
});
await new Promise((resolve) => rpc.listen(0, "127.0.0.1", resolve));

const FEE_WALLET = newReference();
const OTHER_WALLET = newReference();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "phygitals-fee-test-"));
process.env.BOT_TOKEN = "111111:test-token-not-a-real-bot-token";
process.env.ADMIN_TOKEN = "test-admin-token-test-admin-token";
process.env.DEPOSIT_ADDRESS = "Gv9xGpfbRAgCoUnQFpBikvqV2Q88zhAzeHeUBz7X7cvo";
process.env.DATABASE_PATH = path.join(dataDir, "test.sqlite");
process.env.FEE_WALLET_ADDRESS = FEE_WALLET;
process.env.SOLANA_RPC_URL = `http://127.0.0.1:${rpc.address().port}`;

const { app, db, reconcileFeePayments } = await import("./server.js");
let server;
let baseUrl;

function initData(id) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id, username: `user${id}` }),
  });
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(process.env.BOT_TOKEN).digest();
  params.set("hash", crypto.createHmac("sha256", secret).update(check).digest("hex"));
  return params.toString();
}

async function callApi(url, userId, { method = "GET", body, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: {
      "X-Telegram-Init-Data": initData(userId),
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { response, data: text ? JSON.parse(text) : null };
}

const admin = (url, options = {}) =>
  callApi(url, 1, { ...options, headers: { "X-Admin-Token": process.env.ADMIN_TOKEN } });

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  await new Promise((resolve) => rpc.close(resolve));
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

let nextUser = 9100;
async function newUser(usdc = 50) {
  const id = nextUser++;
  await callApi("/api/signup", id, { method: "POST", body: {} });
  db.prepare("UPDATE users SET usdc_micros = ? WHERE telegram_id = ?").run(usdc * 1_000_000, String(id));
  return id;
}

const DESTINATION = newReference();
const startWithdrawal = (id, amount = "20.00") =>
  callApi("/api/withdraw", id, { method: "POST", body: { token: "usdc", amount, destination: DESTINATION } });

let sigCounter = 0;
/* Puts a payment transaction on the fake chain and returns its signature. */
function payOnChain(reference, opts = {}) {
  const {
    amount = 3_290_000,
    recipient = FEE_WALLET,
    mint = USDC_MINT,
    err = null,
    withReference = true,
    listedErr = null,
  } = opts;
  const signature = `sig-${++sigCounter}-${crypto.randomBytes(8).toString("hex")}`;
  const keys = [{ pubkey: newReference(), signer: true, writable: true }];
  if (withReference) keys.push({ pubkey: reference, signer: false, writable: false });
  chain.transactions.set(signature, {
    slot: 12345,
    blockTime: 1_700_000_000,
    meta: {
      err,
      preTokenBalances: [{ accountIndex: 3, mint, owner: recipient, uiTokenAmount: { amount: "1000000" } }],
      postTokenBalances: [{ accountIndex: 3, mint, owner: recipient, uiTokenAmount: { amount: String(1_000_000 + amount) } }],
    },
    transaction: { message: { accountKeys: keys } },
  });
  const list = chain.signatures.get(reference) || [];
  list.push({ signature, err: listedErr });
  chain.signatures.set(reference, list);
  return signature;
}

test("reference keys are valid, unique Solana public keys", () => {
  const a = newReference();
  const b = newReference();
  assert.notEqual(a, b);
  assert.match(a, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
});

test("solana pay link carries recipient, amount, USDC mint and reference", () => {
  const url = solanaPayUrl({ recipient: FEE_WALLET, micros: 3_290_000, reference: "REF" });
  assert.ok(url.startsWith(`solana:${FEE_WALLET}?`));
  const q = new URLSearchParams(url.split("?")[1]);
  assert.equal(q.get("amount"), "3.29");
  assert.equal(q.get("spl-token"), USDC_MINT);
  assert.equal(q.get("reference"), "REF");
});

test("checkFeeTransaction accepts only the right token, wallet, amount, reference and success", () => {
  const ref = newReference();
  const base = { reference: ref, recipient: FEE_WALLET, mint: USDC_MINT, minMicros: 3_290_000 };
  const tx = (o = {}) => {
    const sig = payOnChain(ref, o);
    return chain.transactions.get(sig);
  };
  assert.equal(checkFeeTransaction(tx(), base).ok, true);
  assert.equal(checkFeeTransaction(tx({ amount: 3_289_999 }), base).ok, false);
  assert.equal(checkFeeTransaction(tx({ recipient: OTHER_WALLET }), base).ok, false);
  assert.equal(checkFeeTransaction(tx({ mint: "So11111111111111111111111111111111111111112" }), base).ok, false);
  assert.equal(checkFeeTransaction(tx({ err: { InstructionError: [0, "Custom"] } }), base).ok, false);
  assert.equal(checkFeeTransaction(tx({ withReference: false }), base).ok, false);
  assert.equal(checkFeeTransaction(null, base).ok, false);
});

test("the app is told the fee is required and what it is", async () => {
  const id = await newUser();
  const { data } = await callApi("/api/withdraw/config", id);
  assert.equal(data.feeRequired, true);
  assert.equal(data.fee, 3.29);
  assert.equal(data.token, "USDC");
});

test("starting a withdrawal waits for the fee: full amount reserved, nothing queued, one open request", async () => {
  const id = await newUser();
  const { response, data } = await startWithdrawal(id);
  assert.equal(response.status, 202);
  assert.equal(data.state, "awaiting_payment");
  assert.equal(data.receive, 20, "fee is paid separately so it is not also taken from the amount");
  assert.equal(data.payment.recipient, FEE_WALLET);
  assert.equal(data.payment.mint, USDC_MINT);
  assert.equal(data.payment.amount, 3.29);
  assert.match(data.payment.reference, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  assert.ok(data.payment.url.startsWith("solana:"));

  assert.equal((await callApi("/api/balance", id)).data.usdc, 30, "amount is reserved");
  const again = await startWithdrawal(id);
  assert.equal(again.response.status, 409);

  const open = await callApi("/api/withdraw/open", id);
  assert.equal(open.data.withdrawal.id, data.id);

  const pending = await admin("/admin/withdrawals");
  assert.ok(!pending.data.requests.some((r) => r.id === data.id), "unpaid requests are not reviewable");
  const review = await admin(`/admin/withdrawals/${data.id}/review`, {
    method: "POST",
    body: { action: "paid", reference: "made-up-payout-ref" },
  });
  assert.equal(review.response.status, 409);
});

test("each withdrawal gets its own payment reference", async () => {
  const a = await newUser();
  const b = await newUser();
  const first = (await startWithdrawal(a)).data;
  const second = (await startWithdrawal(b)).data;
  assert.notEqual(first.payment.reference, second.payment.reference);
});

test("nothing is confirmed until the chain shows the payment; bad payments are ignored", async () => {
  const id = await newUser();
  const { data: w } = await startWithdrawal(id);
  const ref = w.payment.reference;
  const status = async () => (await callApi(`/api/withdraw/${w.id}`, id)).data;
  const settle = () => new Promise((r) => setTimeout(r, 3100)); // status lookups are throttled per payment

  assert.equal((await status()).state, "awaiting_payment");

  payOnChain(ref, { amount: 1_000_000 }); // too small
  payOnChain(ref, { err: { InstructionError: [0, "Custom"] }, listedErr: { InstructionError: [0, "Custom"] } }); // failed
  payOnChain(ref, { recipient: OTHER_WALLET }); // paid someone else
  await settle();
  const s1 = await status();
  assert.equal(s1.state, "awaiting_payment");
  assert.equal(s1.feeTxHash, null);
  assert.ok(s1.payment.problem, "tells the user why the attempt did not count");

  /* A frontend cannot confirm anything: there is no endpoint that accepts "I paid". */
  const forged = await fetch(`${baseUrl}/api/withdraw/${w.id}`, {
    method: "POST",
    headers: { "X-Telegram-Init-Data": initData(id), "Content-Type": "application/json" },
    body: JSON.stringify({ paid: true, signature: "x" }),
  });
  assert.equal(forged.status, 404, "there is no endpoint that accepts a client's claim of payment");
  assert.equal((await status()).state, "awaiting_payment");
});

test("a chain outage never confirms or fails a payment", async () => {
  const id = await newUser();
  const { data: w } = await startWithdrawal(id);
  chain.down = true;
  const s = (await callApi(`/api/withdraw/${w.id}`, id)).data;
  chain.down = false;
  assert.equal(s.state, "awaiting_payment");
  assert.match(s.payment.problem, /Solana RPC/);
});

test("a verified payment queues the withdrawal once and records both hashes", async () => {
  const id = await newUser();
  const { data: w } = await startWithdrawal(id);
  const signature = payOnChain(w.payment.reference);

  const confirmed = (await callApi(`/api/withdraw/${w.id}`, id)).data;
  assert.equal(confirmed.state, "queued");
  assert.equal(confirmed.feeTxHash, signature);
  assert.equal(confirmed.payment, null);
  assert.equal(confirmed.payoutTxHash, null, "no payout hash is invented before a real payout");

  /* Checking again, or running the background job, does not charge or confirm twice. */
  await reconcileFeePayments();
  await callApi(`/api/withdraw/${w.id}`, id);
  const rows = db.prepare("SELECT * FROM withdrawal_fee_payments WHERE withdrawal_id = ?").all(w.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].signature, signature);
  const confirmations = db
    .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'withdrawal_fee_confirmed' AND ref = ?")
    .get(w.id).n;
  assert.equal(confirmations, 1);
  assert.equal((await startWithdrawal(id, "10.00")).response.status, 202, "a new withdrawal may now be started");

  /* It is now in the existing review queue with the fee transaction attached. */
  const queue = await admin("/admin/withdrawals");
  const entry = queue.data.requests.find((r) => r.id === w.id);
  assert.equal(entry.feeTxHash, signature);
  assert.equal(entry.fee, 0);

  const payout = `payout-${crypto.randomBytes(6).toString("hex")}`;
  const paid = await admin(`/admin/withdrawals/${w.id}/review`, {
    method: "POST",
    body: { action: "paid", reference: payout },
  });
  assert.equal(paid.response.status, 200);
  const done = (await callApi(`/api/withdraw/${w.id}`, id)).data;
  assert.equal(done.state, "paid");
  assert.equal(done.payoutTxHash, payout);
  assert.equal(done.feeTxHash, signature);
  assert.equal((await callApi("/api/balance", id)).data.usdc, 30 - 10, "only the withdrawn amounts left the balance (20 paid, 10 reserved)");
});

test("one transaction cannot pay for two withdrawals", async () => {
  const a = await newUser();
  const b = await newUser();
  const { data: wa } = await startWithdrawal(a);
  const { data: wb } = await startWithdrawal(b);
  const sig = payOnChain(wa.payment.reference);
  // Make the same transaction also show up under b's reference.
  chain.signatures.set(wb.payment.reference, [{ signature: sig, err: null }]);
  assert.equal((await callApi(`/api/withdraw/${wa.id}`, a)).data.state, "queued");
  const second = (await callApi(`/api/withdraw/${wb.id}`, b)).data;
  assert.equal(second.state, "awaiting_payment");
  assert.equal(second.feeTxHash, null);
});

test("rejecting a paid withdrawal returns the fee to the user's USDC balance, once", async () => {
  const id = await newUser();
  const { data: w } = await startWithdrawal(id);
  payOnChain(w.payment.reference);
  await callApi(`/api/withdraw/${w.id}`, id);
  assert.equal((await callApi("/api/balance", id)).data.usdc, 30);

  const rejected = await admin(`/admin/withdrawals/${w.id}/review`, { method: "POST", body: { action: "reject" } });
  assert.equal(rejected.response.status, 200);
  assert.equal((await callApi("/api/balance", id)).data.usdc, 50 + 3.29);
  const again = await admin(`/admin/withdrawals/${w.id}/review`, { method: "POST", body: { action: "reject" } });
  assert.equal(again.response.status, 409);
  assert.equal((await callApi("/api/balance", id)).data.usdc, 50 + 3.29);
  assert.equal((await callApi(`/api/withdraw/${w.id}`, id)).data.state, "rejected_refunded");
});

test("an unpaid withdrawal expires and releases the reserved amount", async () => {
  const id = await newUser();
  const { data: w } = await startWithdrawal(id);
  db.prepare("UPDATE withdrawal_fee_payments SET expires_at = ? WHERE withdrawal_id = ?").run(Date.now() - 1000, w.id);
  await reconcileFeePayments();
  const s = (await callApi(`/api/withdraw/${w.id}`, id)).data;
  assert.equal(s.state, "expired");
  assert.equal((await callApi("/api/balance", id)).data.usdc, 50);
  assert.equal((await startWithdrawal(id)).response.status, 202);
});

test("a payment that lands after expiry is returned to the balance, not kept", async () => {
  const id = await newUser();
  const { data: w } = await startWithdrawal(id);
  db.prepare("UPDATE withdrawal_fee_payments SET expires_at = ? WHERE withdrawal_id = ?").run(Date.now() - 1000, w.id);
  await reconcileFeePayments();
  assert.equal((await callApi(`/api/withdraw/${w.id}`, id)).data.state, "expired");

  payOnChain(w.payment?.reference ?? db.prepare("SELECT reference FROM withdrawal_fee_payments WHERE withdrawal_id = ?").get(w.id).reference);
  await reconcileFeePayments();
  await reconcileFeePayments();
  assert.equal((await callApi("/api/balance", id)).data.usdc, 50 + 3.29, "refunded exactly once");
});

test("cancelling releases an unpaid withdrawal but never one that was already paid", async () => {
  const a = await newUser();
  const { data: wa } = await startWithdrawal(a);
  const cancelled = await callApi(`/api/withdraw/${wa.id}/cancel`, a, { method: "POST", body: {} });
  assert.equal(cancelled.response.status, 200);
  assert.equal(cancelled.data.state, "cancelled");
  assert.equal((await callApi("/api/balance", a)).data.usdc, 50);

  const b = await newUser();
  const { data: wb } = await startWithdrawal(b);
  payOnChain(wb.payment.reference);
  const blocked = await callApi(`/api/withdraw/${wb.id}/cancel`, b, { method: "POST", body: {} });
  assert.equal(blocked.response.status, 409);
  assert.equal((await callApi(`/api/withdraw/${wb.id}`, b)).data.state, "queued");
});

test("users cannot see or cancel each other's withdrawals", async () => {
  const a = await newUser();
  const b = await newUser();
  const { data: w } = await startWithdrawal(a);
  assert.equal((await callApi(`/api/withdraw/${w.id}`, b)).response.status, 404);
  assert.equal((await callApi(`/api/withdraw/${w.id}/cancel`, b, { method: "POST", body: {} })).response.status, 404);
});

test("withdrawals are logged for audit", () => {
  const actions = new Set(db.prepare("SELECT DISTINCT action FROM audit_log").all().map((r) => r.action));
  for (const a of [
    "withdrawal_requested",
    "withdrawal_fee_confirmed",
    "withdrawal_fee_expired",
    "withdrawal_fee_cancelled",
    "withdrawal_fee_refunded",
    "withdrawal_fee_late_refunded",
    "withdrawal_paid",
    "withdrawal_fee_check_failed",
  ])
    assert.ok(actions.has(a), `missing audit action ${a}`);
});

import { checkSolTransaction } from "./withdrawal-fee.js";
import test2 from "node:test";
import assert2 from "node:assert/strict";
{
  const mk = (post, err = null, ref = "REF") => ({
    meta: { err, preBalances: [10, 100], postBalances: [5, post] },
    transaction: { message: { accountKeys: [{ pubkey: "PAYER", signer: true }, { pubkey: "DEP", signer: false }, { pubkey: ref, signer: false }] } },
  });
  test2("SOL activation: accepts enough SOL with the reference", () => {
    const r = checkSolTransaction(mk(100 + 36_500_000), { reference: "REF", recipient: "DEP", minLamports: 36_500_000 });
    assert2.equal(r.ok, true);
    assert2.equal(r.payer, "PAYER");
  });
  test2("SOL activation: rejects too little, wrong reference, failed tx", () => {
    const base = { reference: "REF", recipient: "DEP", minLamports: 36_500_000 };
    assert2.equal(checkSolTransaction(mk(100 + 1000), base).ok, false);
    assert2.equal(checkSolTransaction(mk(100 + 36_500_000, null, "OTHER"), base).ok, false);
    assert2.equal(checkSolTransaction(mk(100 + 36_500_000, { InstructionError: 1 }), base).ok, false);
  });
}