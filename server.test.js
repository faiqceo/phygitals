import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "phygitals-test-"));
process.env.BOT_TOKEN = "9123283968:AAG47fhN8_QL9L7ELuNGKjfOXzCPC4RVBXg";
process.env.HELIUS_AUTH = "833dbda2-40a0-4af6-9602-dc162526b090t";
process.env.ADMIN_TOKEN ="0b9c69bcb7af73a1aab5aa1d6d49febc79ce2b4cc32280d867d20dafe05fff05";
process.env.DEPOSIT_ADDRESS = "Gv9xGpfbRAgCoUnQFpBikvqV2Q88zhAzeHeUBz7X7cvo";
process.env.DATABASE_PATH = path.join(dataDir, "test.sqlite");

const { app, db } = await import("./server.js");
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
  const secret = crypto
    .createHmac("sha256", "WebAppData")
    .update(process.env.BOT_TOKEN)
    .digest();
  params.set(
    "hash",
    crypto.createHmac("sha256", secret).update(check).digest("hex"),
  );
  return params.toString();
}

function encodeBase58(bytes) {
  let number = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
  let encoded = "";
  while (number > 0n) {
    encoded =
      "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"[
        Number(number % 58n)
      ] + encoded;
    number /= 58n;
  }
  let zeroes = 0;
  while (bytes[zeroes] === 0) zeroes++;
  return "1".repeat(zeroes) + encoded;
}

async function callApi(
  url,
  userId,
  { method = "GET", body, headers = {} } = {},
) {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: {
      "X-Telegram-Init-Data": initData(userId, `user${userId}`),
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { response, data: text ? JSON.parse(text) : null };
}

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

test("referral rewards persist and confirmed deposits are credited once", async () => {
  const ownerSignup = await callApi("/api/signup", 1001, {
    method: "POST",
    body: {},
  });
  assert.equal(ownerSignup.response.status, 200);
  assert.match(ownerSignup.data.code, /^[a-f0-9]{12}$/);
  assert.equal(ownerSignup.data.credits, 0);

  const friendSignup = await callApi("/api/signup", 2002, {
    method: "POST",
    body: { ref: ownerSignup.data.code },
  });
  assert.equal(friendSignup.response.status, 200);
  assert.equal(friendSignup.data.referralAwarded, true);
  assert.equal(friendSignup.data.credits, 1);
  assert.equal(friendSignup.data.referredBy.name, "@user1001");

  const ownerProfile = await callApi("/api/me", 1001);
  assert.equal(ownerProfile.data.credits, 1);
  assert.equal(ownerProfile.data.invited, 1);
  assert.equal(ownerProfile.data.earned, 1);

  const duplicateRedeem = await callApi("/api/redeem", 2002, {
    method: "POST",
    body: { code: ownerSignup.data.code },
  });
  assert.equal(duplicateRedeem.response.status, 409);

  const pair = crypto.generateKeyPairSync("ed25519");
  const der = pair.publicKey.export({ format: "der", type: "spki" });
  const address = encodeBase58(der.subarray(-32));
  const challenge = await callApi("/api/link-wallet/challenge", 1001, {
    method: "POST",
    body: { address },
  });
  assert.equal(challenge.response.status, 200);
  const signature = crypto
    .sign(null, Buffer.from(challenge.data.message), pair.privateKey)
    .toString("base64");
  const linked = await callApi("/api/link-wallet", 1001, {
    method: "POST",
    body: { address, nonce: challenge.data.nonce, signature },
  });
  assert.equal(linked.response.status, 200);
  assert.equal(linked.data.wallet, address);

  const transfer = [
    {
      signature: "test-deposit-signature",
      tokenTransfers: [
        {
          fromUserAccount: address,
          toUserAccount: process.env.DEPOSIT_ADDRESS,
          mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          tokenAmount: 1.25,
        },
      ],
    },
  ];
  const webhook = await fetch(`${baseUrl}/webhook/helius`, {
    method: "POST",
    headers: {
      Authorization: process.env.HELIUS_AUTH,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(transfer),
  });
  assert.equal(webhook.status, 200);
  assert.equal((await webhook.json()).creditedTransfers, 1);

  const duplicateWebhook = await fetch(`${baseUrl}/webhook/helius`, {
    method: "POST",
    headers: {
      Authorization: process.env.HELIUS_AUTH,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(transfer),
  });
  assert.equal((await duplicateWebhook.json()).creditedTransfers, 0);
  const balance = await callApi("/api/balance", 1001);
  assert.equal(balance.data.credits, 2.25);

  const secondPair = crypto.generateKeyPairSync("ed25519");
  const secondDer = secondPair.publicKey.export({
    format: "der",
    type: "spki",
  });
  const secondAddress = encodeBase58(secondDer.subarray(-32));
  const unclaimedTransfer = [
    {
      signature: "unclaimed-deposit-signature",
      tokenTransfers: [
        {
          fromUserAccount: secondAddress,
          toUserAccount: process.env.DEPOSIT_ADDRESS,
          mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
          tokenAmount: 2,
        },
      ],
    },
  ];
  const unclaimedWebhook = await fetch(`${baseUrl}/webhook/helius`, {
    method: "POST",
    headers: {
      Authorization: process.env.HELIUS_AUTH,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(unclaimedTransfer),
  });
  assert.equal((await unclaimedWebhook.json()).creditedTransfers, 0);

  const unclaimedList = await fetch(`${baseUrl}/admin/unclaimed-deposits`, {
    headers: { "X-Admin-Token": process.env.ADMIN_TOKEN },
  });
  const { deposits } = await unclaimedList.json();
  assert.equal(deposits.length, 1);
  assert.equal(deposits[0].amount, 2);

  const friendChallenge = await callApi("/api/link-wallet/challenge", 2002, {
    method: "POST",
    body: { address: secondAddress },
  });
  const friendSignature = crypto
    .sign(
      null,
      Buffer.from(friendChallenge.data.message),
      secondPair.privateKey,
    )
    .toString("base64");
  const linkedFriend = await callApi("/api/link-wallet", 2002, {
    method: "POST",
    body: {
      address: secondAddress,
      nonce: friendChallenge.data.nonce,
      signature: friendSignature,
    },
  });
  assert.equal(linkedFriend.response.status, 200);
  const friendBalance = await callApi("/api/balance", 2002);
  assert.equal(friendBalance.data.credits, 3);

  db.prepare(
    "UPDATE users SET usdc_micros = 25000000 WHERE telegram_id = ?",
  ).run("1001");
  const withdrawal = await callApi("/api/withdraw", 1001, {
    method: "POST",
    body: { token: "usdc", amount: "10.00", destination: secondAddress },
  });
  assert.equal(withdrawal.response.status, 202);
  assert.equal(withdrawal.data.fee, 3.29);
  assert.equal(withdrawal.data.receive, 6.71);

  const reservedBalance = await callApi("/api/balance", 1001);
  assert.equal(reservedBalance.data.usdc, 15);
  const pendingRequests = await fetch(`${baseUrl}/admin/withdrawals`, {
    headers: { "X-Admin-Token": process.env.ADMIN_TOKEN },
  });
  const pending = (await pendingRequests.json()).requests;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].receive, 6.71);

  const rejected = await fetch(
    `${baseUrl}/admin/withdrawals/${withdrawal.data.id}/review`,
    {
      method: "POST",
      headers: {
        "X-Admin-Token": process.env.ADMIN_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: "reject" }),
    },
  );
  assert.equal(rejected.status, 200);
  const refundedBalance = await callApi("/api/balance", 1001);
  assert.equal(refundedBalance.data.usdc, 25);

  const paidWithdrawal = await callApi("/api/withdraw", 1001, {
    method: "POST",
    body: { token: "usdc", amount: "10.00", destination: secondAddress },
  });
  const paid = await fetch(
    `${baseUrl}/admin/withdrawals/${paidWithdrawal.data.id}/review`,
    {
      method: "POST",
      headers: {
        "X-Admin-Token": process.env.ADMIN_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        action: "paid",
        reference: "solana-test-signature-123",
      }),
    },
  );
  assert.equal(paid.status, 200);
  const completedBalance = await callApi("/api/balance", 1001);
  assert.equal(completedBalance.data.usdc, 15);
});

test("invalid Telegram init data cannot access account APIs", async () => {
  const homepage = await fetch(`${baseUrl}/`);
  assert.equal(homepage.status, 200);
  assert.match(await homepage.text(), /<title>Football Packs<\/title>/);

  const response = await fetch(`${baseUrl}/api/me`, {
    headers: { "X-Telegram-Init-Data": "user=%7B%22id%22%3A1%7D" },
  });
  assert.equal(response.status, 401);
});
