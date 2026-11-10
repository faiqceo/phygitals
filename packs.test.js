import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "phygitals-packs-test-"));

/* Two packs that are safe to sell (average payout well under price) and one
   that pays out more than it costs and must stay switched off. */
const testPacks = [
  {
    id: "ok",
    name: "Safe Pack",
    price: 10,
    elite: true,
    odds: [[1, 50], [5, 30], [10, 15], [50, 4], [200, 1]],
  },
  {
    id: "cheap",
    name: "Cheap Pack",
    price: 1,
    elite: false,
    odds: [[0.5, 70], [1, 25], [5, 5]],
  },
  {
    id: "bad",
    name: "Generous Pack",
    price: 5,
    elite: false,
    odds: [[10, 50], [100, 50]],
  },
];
const packsFile = path.join(dataDir, "packs.json");
fs.writeFileSync(packsFile, JSON.stringify(testPacks));

process.env.BOT_TOKEN = "111111:test-token-not-a-real-bot-token";
process.env.ADMIN_TOKEN = "test-admin-token-test-admin-token";
process.env.DATABASE_PATH = path.join(dataDir, "test.sqlite");
process.env.PACKS_CONFIG = packsFile;

const { app, db } = await import("./server.js");
const packs = await import("./packs.js");
let server;
let baseUrl;

function initData(id, username) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id, username }),
  });
  const check = [...params.entries()]
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(process.env.BOT_TOKEN).digest();
  params.set("hash", crypto.createHmac("sha256", secret).update(check).digest("hex"));
  return params.toString();
}

async function callApi(url, userId, { method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: {
      "X-Telegram-Init-Data": initData(userId, `user${userId}`),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { response, data: text ? JSON.parse(text) : null };
}

const give = (id, dollars) =>
  db.prepare("UPDATE users SET credits_micros = credits_micros + ? WHERE telegram_id = ?").run(
    dollars * 1_000_000,
    String(id),
  );

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/* ---------- Pack engine ---------- */

test("the pack odds shipped in the repo pay out far more than they cost, so the guard switches them off", () => {
  for (const pack of packs.DEFAULT_PACKS) {
    const status = packs.packStatus(pack, { buyback: 0.9, minEdge: 0.05 });
    assert.equal(status.available, false, `${pack.id} should be off`);
    assert.ok(status.expectedPayout > pack.price * 5, `${pack.id} pays ~6x its price`);
  }
});

test("validatePack rejects odds that do not add up to 100%", () => {
  assert.throws(
    () => packs.validatePack({ id: "x", price: 5, odds: [[1, 50], [2, 40]] }),
    /not 100%/,
  );
  assert.throws(() => packs.validatePack({ id: "x", price: 0, odds: [[1, 50], [2, 50]] }), /price/);
  assert.doesNotThrow(() => packs.validatePack({ id: "x", price: 5, odds: [[1, 50], [2, 50]] }));
});

test("drawPack maps each roll to the right outcome at the boundaries", () => {
  const pack = testPacks[0]; // 50 / 30 / 15 / 4 / 1 percent
  const at = (roll) => packs.drawPack(pack, () => roll).index;
  assert.equal(at(0), 0);
  assert.equal(at(4999), 0);
  assert.equal(at(5000), 1);
  assert.equal(at(7999), 1);
  assert.equal(at(8000), 2);
  assert.equal(at(9499), 2);
  assert.equal(at(9500), 3);
  assert.equal(at(9899), 3);
  assert.equal(at(9900), 4);
  assert.equal(at(9999), 4);
});

test("real draws land near the stated odds", () => {
  const counts = [0, 0, 0, 0, 0];
  const n = 100_000;
  for (let i = 0; i < n; i++) counts[packs.drawPack(testPacks[0]).index]++;
  const expected = [0.5, 0.3, 0.15, 0.04, 0.01];
  counts.forEach((count, i) => {
    assert.ok(Math.abs(count / n - expected[i]) < 0.01, `outcome ${i}: ${count / n}`);
  });
});

/* ---------- Account fix ---------- */

test("a first request never says 'Account not found' and onboarding is tracked", async () => {
  const me = await callApi("/api/me", 7001);
  assert.equal(me.response.status, 200);
  assert.equal(me.data.welcomed, false);

  const balance = await callApi("/api/balance", 7001);
  assert.equal(balance.response.status, 200);

  const signup = await callApi("/api/signup", 7001, { method: "POST", body: {} });
  assert.equal(signup.data.welcomed, true);
  assert.equal((await callApi("/api/me", 7001)).data.welcomed, true);
});

test("an account that was wiped is recreated on the next request instead of erroring", async () => {
  await callApi("/api/signup", 7002, { method: "POST", body: {} });
  db.exec("PRAGMA foreign_keys = OFF");
  db.prepare("DELETE FROM users WHERE telegram_id = '7002'").run();
  db.exec("PRAGMA foreign_keys = ON");
  const again = await callApi("/api/balance", 7002);
  assert.equal(again.response.status, 200);
  assert.equal(again.data.credits, 0);
});

/* ---------- Buying and selling ---------- */

test("/api/packs lists server odds and marks unsafe packs unavailable", async () => {
  const { response, data } = await callApi("/api/packs", 7003);
  assert.equal(response.status, 200);
  const byId = Object.fromEntries(data.packs.map((p) => [p.id, p]));
  assert.equal(byId.ok.available, true);
  assert.equal(byId.cheap.available, true);
  assert.equal(byId.bad.available, false);
  assert.deepEqual(byId.ok.odds, testPacks[0].odds);
});

test("buying needs enough credits and an available pack", async () => {
  await callApi("/api/signup", 7004, { method: "POST", body: {} });
  const broke = await callApi("/api/packs/buy", 7004, { method: "POST", body: { packId: "ok" } });
  assert.equal(broke.response.status, 402);

  give(7004, 100);
  const off = await callApi("/api/packs/buy", 7004, { method: "POST", body: { packId: "bad" } });
  assert.equal(off.response.status, 503);
  const unknown = await callApi("/api/packs/buy", 7004, { method: "POST", body: { packId: "nope" } });
  assert.equal(unknown.response.status, 404);
  assert.equal((await callApi("/api/balance", 7004)).data.credits, 100);
});

test("a purchase debits the price, saves the card, and the card survives a reload", async () => {
  await callApi("/api/signup", 7005, { method: "POST", body: {} });
  give(7005, 50);

  const buy = await callApi("/api/packs/buy", 7005, { method: "POST", body: { packId: "ok" } });
  assert.equal(buy.response.status, 200);
  assert.equal(buy.data.credits, 40);
  const card = buy.data.card;
  assert.ok([1, 5, 10, 50, 200].includes(card.value));
  assert.equal(card.packId, "ok");
  assert.ok(card.playerIdx >= 0 && card.playerIdx < 6);
  assert.equal(card.sellBack, +(card.value * 0.9).toFixed(2));

  const owned = await callApi("/api/cards", 7005);
  assert.equal(owned.data.cards.length, 1);
  assert.equal(owned.data.cards[0].id, card.id);

  const audit = db.prepare("SELECT * FROM audit_log WHERE action = 'pack_bought' AND ref = ?").get(String(card.id));
  assert.ok(audit);
});

test("selling pays 90% once, never twice, and only the owner can sell", async () => {
  await callApi("/api/signup", 7006, { method: "POST", body: {} });
  await callApi("/api/signup", 7007, { method: "POST", body: {} });
  give(7006, 20);
  const { data: bought } = await callApi("/api/packs/buy", 7006, { method: "POST", body: { packId: "ok" } });
  const card = bought.card;

  const stolen = await callApi("/api/cards/sell", 7007, {
    method: "POST",
    body: { cardId: card.id, to: "credits" },
  });
  assert.equal(stolen.response.status, 404);

  const usdc = await callApi("/api/cards/sell", 7006, {
    method: "POST",
    body: { cardId: card.id, to: "usdc" },
  });
  assert.equal(usdc.response.status, 400);

  const sold = await callApi("/api/cards/sell", 7006, {
    method: "POST",
    body: { cardId: card.id, to: "credits" },
  });
  assert.equal(sold.response.status, 200);
  assert.equal(sold.data.paid, card.sellBack);
  assert.equal(sold.data.credits, +(10 + card.sellBack).toFixed(2));

  const twice = await callApi("/api/cards/sell", 7006, {
    method: "POST",
    body: { cardId: card.id, to: "credits" },
  });
  assert.equal(twice.response.status, 409);
  assert.equal((await callApi("/api/cards", 7006)).data.cards.length, 0);
  assert.equal((await callApi("/api/balance", 7006)).data.credits, sold.data.credits);
});

test("credits reserved for a pending withdrawal cannot be spent on packs", async () => {
  await callApi("/api/signup", 7008, { method: "POST", body: {} });
  give(7008, 10);
  db.prepare(
    `INSERT INTO whoop_withdrawals (id, telegram_id, whoop_username, idempotency_key, amount_micros, fee_micros, net_micros, status)
     VALUES ('w-test', '7008', 'someone', 'k1', 8000000, 3000000, 5000000, 'pending')`,
  ).run();
  const blocked = await callApi("/api/packs/buy", 7008, { method: "POST", body: { packId: "ok" } });
  assert.equal(blocked.response.status, 402);
});
