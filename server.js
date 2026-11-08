// Reference server: credits deposits automatically (1 USDC/USDT sent = $1 pack credits).
// This is a starting point. Replace the in-memory Maps with a real database before launch.
import express from "express";
import crypto from "node:crypto";

const { BOT_TOKEN, HELIUS_AUTH, APP_ORIGIN = "*", PORT = 3000 } = process.env;
const MINT = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "usdc",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "usdt",
};
const DEPOSIT_ADDRESS = process.env.DEPOSIT_ADDRESS; // the one shared address every user sends to
const users = new Map(); // telegramId -> { credits, usdc, usdt, wallet }
const wallets = new Map(); // sender wallet address -> telegramId (set when the user links their wallet)
const seen = new Set(); // processed transaction signatures (so nothing is credited twice)
const unclaimed = []; // deposits from wallets nobody has linked: review these by hand

// With ONE shared deposit address the only way to know who sent a transfer is the sender's wallet.
// Each user links the wallet they send from; a transfer FROM that wallet TO the deposit address is
// credited to them. Sends from an exchange (a shared hot wallet) cannot be matched this way, so they
// land in `unclaimed` for manual review.

function verifyInitData(raw) {
  const p = new URLSearchParams(raw || "");
  const hash = p.get("hash");
  p.delete("hash");
  const str = [...p.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n");
  const secret = crypto
    .createHmac("sha256", "WebAppData")
    .update(BOT_TOKEN)
    .digest();
  const calc = crypto.createHmac("sha256", secret).update(str).digest("hex");
  if (!hash || calc !== hash) return null;
  if (Date.now() / 1000 - Number(p.get("auth_date")) > 86400) return null;
  return JSON.parse(p.get("user")).id;
}

async function getUser(id) {
  if (!users.has(id))
    users.set(id, { credits: 0, usdc: 0, usdt: 0, wallet: null });
  return users.get(id);
}

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use((req, res, next) => {
  res.set({
    "Access-Control-Allow-Origin": APP_ORIGIN,
    "Access-Control-Allow-Headers": "X-Telegram-Init-Data, Content-Type",
  });
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
const auth = async (req, res, next) => {
  const id = verifyInitData(req.get("X-Telegram-Init-Data"));
  if (!id) return res.sendStatus(401);
  req.user = await getUser(id);
  req.user.id = id;
  next();
};

app.get("/api/balance", auth, (req, res) => {
  const { credits, usdc, usdt, wallet } = req.user;
  res.json({ credits, usdc, usdt, wallet });
});
app.get("/api/deposit-address", auth, (req, res) =>
  res.json({ address: DEPOSIT_ADDRESS }),
);

app.post("/api/link-wallet", auth, (req, res) => {
  const addr = String(req.body?.address || "");
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr) || addr === DEPOSIT_ADDRESS)
    return res.sendStatus(400);
  const owner = wallets.get(addr);
  if (owner && owner !== req.user.id) return res.sendStatus(409); // already linked to someone else
  if (req.user.wallet) wallets.delete(req.user.wallet);
  wallets.set(addr, req.user.id);
  req.user.wallet = addr;
  res.sendStatus(204);
});

// Webhook from your Solana provider (written for Helius "enhanced" webhooks; check your provider's docs
// for the exact payload). It fires when a transfer arrives, usually within seconds.
app.post("/webhook/helius", (req, res) => {
  if (req.get("authorization") !== HELIUS_AUTH) return res.sendStatus(401);
  for (const tx of req.body || []) {
    if (!tx.signature || seen.has(tx.signature)) continue;
    for (const t of tx.tokenTransfers || []) {
      if (t.toUserAccount !== DEPOSIT_ADDRESS || !MINT[t.mint]) continue;
      const uid = wallets.get(t.fromUserAccount);
      const amount = Number(t.tokenAmount);
      if (uid)
        users.get(uid).credits += amount; // 1:1 pack credits
      else
        unclaimed.push({
          sig: tx.signature,
          from: t.fromUserAccount,
          amount,
          token: MINT[t.mint],
        });
    }
    seen.add(tx.signature);
  }
  res.sendStatus(200);
});

app.listen(PORT, () => console.log("listening on " + PORT));
