import crypto from "node:crypto";
import fs from "node:fs";

/*
 * Server-side pack definitions and drawing.
 *
 * The server is the only place a draw happens. The browser shows whatever the
 * server returns and never decides an outcome.
 *
 * Odds are [cardValueUsd, percentChance]. Each pack's chances must add up to
 * exactly 100 (checked in basis points, i.e. hundredths of a percent).
 *
 * To change odds or prices without editing code, point PACKS_CONFIG at a JSON
 * file containing an array shaped like DEFAULT_PACKS.
 */

export const PLAYERS_PER_POOL = 6;

export const DEFAULT_PACKS = [
  {
    id: "leg",
    name: "Legend Pack",
    price: 35,
    elite: false,
    odds: [[20, 12], [35, 23], [100, 34], [300, 21.5], [1000, 9], [10000, 0.5]],
  },
  {
    id: "hero",
    name: "Hero Pack",
    price: 25,
    elite: true,
    odds: [[15, 12], [25, 24], [60, 34], [200, 20.5], [800, 9], [5000, 0.5]],
  },
  {
    id: "icon",
    name: "Icon Pack",
    price: 15,
    elite: true,
    odds: [[10, 12], [15, 24], [40, 34], [120, 20.5], [500, 9], [2500, 0.5]],
  },
  {
    id: "std",
    name: "Standard Pack",
    price: 5,
    elite: false,
    odds: [[1, 15], [5, 26], [20, 32], [50, 18], [100, 7.5], [500, 1.5]],
  },
];

const BASIS_POINTS = 10_000;

function isMoney(value) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    Math.abs(value * 100 - Math.round(value * 100)) < 1e-6
  );
}

/** Throws if a pack definition is unusable. Returns the pack when it is fine. */
export function validatePack(pack) {
  if (!pack || typeof pack.id !== "string" || !/^[a-z0-9_-]{1,24}$/.test(pack.id))
    throw new Error("Pack needs an id of lowercase letters, digits, - or _.");
  if (!isMoney(pack.price))
    throw new Error(`Pack ${pack.id}: price must be a positive amount with at most 2 decimals.`);
  if (!Array.isArray(pack.odds) || pack.odds.length < 2)
    throw new Error(`Pack ${pack.id}: odds must list at least two outcomes.`);
  let total = 0;
  for (const entry of pack.odds) {
    if (!Array.isArray(entry) || !isMoney(entry[0]))
      throw new Error(`Pack ${pack.id}: every outcome needs a positive card value.`);
    const bp = Math.round(Number(entry[1]) * 100);
    if (!Number.isFinite(bp) || bp <= 0 || Math.abs(Number(entry[1]) * 100 - bp) > 1e-6)
      throw new Error(`Pack ${pack.id}: chances must be positive with at most 2 decimals.`);
    total += bp;
  }
  if (total !== BASIS_POINTS)
    throw new Error(`Pack ${pack.id}: chances add up to ${total / 100}%, not 100%.`);
  return pack;
}

export function loadPacks(configPath = process.env.PACKS_CONFIG) {
  let list = DEFAULT_PACKS;
  if (configPath) {
    list = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (!Array.isArray(list) || !list.length) throw new Error("PACKS_CONFIG must be a non-empty array.");
  }
  const ids = new Set();
  return list.map((pack) => {
    validatePack(pack);
    if (ids.has(pack.id)) throw new Error(`Duplicate pack id ${pack.id}.`);
    ids.add(pack.id);
    return {
      id: pack.id,
      name: String(pack.name || pack.id),
      price: pack.price,
      elite: Boolean(pack.elite),
      odds: pack.odds.map(([value, chance]) => [value, chance]),
    };
  });
}

/** Average card value of one pack, in dollars. */
export function expectedValue(pack) {
  return pack.odds.reduce((sum, [value, chance]) => sum + (value * chance) / 100, 0);
}

/**
 * A pack may only be sold when, even if every card is sold straight back, the
 * average payout stays below the price by at least `minEdge` (0.05 = 5%).
 * Without this, a pack can pay out more than it costs and drain the balance.
 */
export function packStatus(pack, { buyback, minEdge }) {
  const ev = expectedValue(pack);
  const payout = ev * buyback;
  const ceiling = pack.price * (1 - minEdge);
  const available = payout <= ceiling + 1e-9;
  return {
    available,
    expectedValue: Number(ev.toFixed(2)),
    expectedPayout: Number(payout.toFixed(2)),
    maxAllowedPayout: Number(ceiling.toFixed(2)),
    reason: available
      ? null
      : `Average payout ($${payout.toFixed(2)}) is above the allowed maximum ($${ceiling.toFixed(2)}) for a $${pack.price} pack. Lower the card values or raise the price.`,
  };
}

/** Picks one outcome. `randomInt` is injectable so tests can be exact. */
export function drawPack(pack, randomInt = crypto.randomInt) {
  const roll = randomInt(BASIS_POINTS);
  let cumulative = 0;
  for (let index = 0; index < pack.odds.length; index++) {
    cumulative += Math.round(pack.odds[index][1] * 100);
    if (roll < cumulative) return { index, value: pack.odds[index][0] };
  }
  // Unreachable because validatePack guarantees the chances total 100%.
  throw new Error("Draw fell outside the odds table.");
}
