// phygitals/withdrawal-fee.js
// Everything needed to collect and verify the withdrawal processing fee on Solana.
// No private keys are used here: we only generate public "reference" keys and read the chain.
import crypto from "node:crypto";

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function encodeBase58(bytes) {
  let number = BigInt(`0x${Buffer.from(bytes).toString("hex") || "0"}`);
  let encoded = "";
  while (number > 0n) {
    encoded = BASE58[Number(number % 58n)] + encoded;
    number /= 58n;
  }
  let zeroes = 0;
  while (zeroes < bytes.length && bytes[zeroes] === 0) zeroes++;
  return "1".repeat(zeroes) + encoded;
}

/* A fresh, unique public key used only to tag one payment (Solana Pay "reference").
   The matching private key is thrown away; it is never needed. */
export function newReference() {
  const { publicKey } = crypto.generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" });
  return encodeBase58(der.subarray(der.length - 32));
}

/* Solana Pay transfer-request link. Wallets that support it fill in the recipient,
   amount, token and reference, so the user only has to approve. */
export function solanaPayUrl({ recipient, micros, mint = USDC_MINT, reference, label, message }) {
  const amount = (micros / 1_000_000).toFixed(2);
  const query = new URLSearchParams({
    amount,
    "spl-token": mint,
    reference,
    label,
    message,
  });
  return `solana:${recipient}?${query.toString()}`;
}

export class RpcError extends Error {
  constructor(message, { retriable = true } = {}) {
    super(message);
    this.retriable = retriable;
  }
}

export function createRpc({ url, commitment = "finalized", timeoutMs = 8000, fetchImpl = fetch }) {
  async function call(method, params) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new RpcError(`Could not reach the Solana RPC (${error.name}).`);
    }
    if (!response.ok) throw new RpcError(`Solana RPC answered HTTP ${response.status}.`);
    let body;
    try {
      body = await response.json();
    } catch {
      throw new RpcError("Solana RPC returned an unreadable response.");
    }
    if (body.error) throw new RpcError(`Solana RPC error: ${body.error.message || body.error.code}`);
    return body.result;
  }
  return {
    commitment,
    /* Newest signatures whose transaction mentions this reference key. */
    signaturesFor(reference) {
      return call("getSignaturesForAddress", [reference, { commitment, limit: 10 }]);
    },
    transaction(signature) {
      return call("getTransaction", [
        signature,
        { commitment, encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
      ]);
    },
  };
}

function balanceOf(list, owner, mint) {
  let total = 0n;
  for (const entry of list || []) {
    if (entry?.owner === owner && entry?.mint === mint) {
      try {
        total += BigInt(entry.uiTokenAmount?.amount ?? "0");
      } catch {}
    }
  }
  return total;
}

/* Decides whether one parsed transaction is a valid fee payment. Pure function, no network.
   The transaction must have succeeded, carry our unique reference, and have increased the
   fee wallet's balance of the expected token by at least the fee. */
export function checkFeeTransaction(tx, { reference, recipient, mint = USDC_MINT, minMicros }) {
  if (!tx || !tx.meta || !tx.transaction?.message)
    return { ok: false, reason: "Transaction is not available yet." };
  if (tx.meta.err) return { ok: false, reason: "The payment transaction failed on-chain." };
  const keys = tx.transaction.message.accountKeys || [];
  const referenced = keys.some((key) => (typeof key === "string" ? key : key.pubkey) === reference);
  if (!referenced) return { ok: false, reason: "Transaction does not carry this payment's reference." };
  const received =
    balanceOf(tx.meta.postTokenBalances, recipient, mint) -
    balanceOf(tx.meta.preTokenBalances, recipient, mint);
  if (received < BigInt(minMicros))
    return { ok: false, reason: "The amount received is lower than the processing fee." };
  const signer = keys.find((key) => typeof key !== "string" && key.signer);
  return {
    ok: true,
    payer: signer ? signer.pubkey : null,
    receivedMicros: Number(received),
    slot: tx.slot ?? null,
    blockTime: tx.blockTime ?? null,
  };
}

/* Looks the reference up on-chain and returns the first signature that is a valid payment.
   Returns { status: "paid", signature, ... } | { status: "none" } | { status: "invalid", reason }.
   Throws RpcError when the chain could not be read (the caller keeps the payment pending). */
export async function findFeePayment(rpc, expected) {
  const signatures = await rpc.signaturesFor(expected.reference);
  let invalid = null;
  for (const entry of signatures || []) {
    if (entry.err) {
      invalid = "A payment attempt failed on-chain; nothing was charged for it.";
      continue;
    }
    const tx = await rpc.transaction(entry.signature);
    const verdict = checkFeeTransaction(tx, expected);
    if (verdict.ok) return { status: "paid", signature: entry.signature, ...verdict };
    invalid = verdict.reason;
  }
  return invalid ? { status: "invalid", reason: invalid } : { status: "none" };
}
