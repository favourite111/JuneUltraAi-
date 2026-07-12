/**
 * Bot registry — Neon-backed. Registering a bot is a row insert; no config
 * changes or redeploys needed.
 *
 * API key verification uses Argon2id (slow, brute-force resistant) but caches
 * verified results for a short window so it doesn't add latency to every
 * request. Cache entries are invalidated immediately whenever a bot is
 * updated, suspended, deleted, or its key is regenerated — revoked
 * credentials stop working on the very next request, not after the TTL.
 */

import { createHash } from "node:crypto";
import { getSql } from "./db.js";
import { generateApiKey, hashApiKey, verifyApiKeyHash } from "./crypto.js";
import { logger } from "./logger.js";

export interface Bot {
  botId: string;
  owner: string;
  status: "active" | "suspended";
  createdAt: Date;
  lastSeen: Date | null;
}

const VERIFY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const verifiedCache = new Map<string, { valid: boolean; expiresAt: number }>();
const botCacheKeys = new Map<string, Set<string>>(); // botId -> cache keys, for instant invalidation

function cacheKeyFor(botId: string, rawKey: string): string {
  return createHash("sha256").update(`${botId}:${rawKey}`).digest("hex");
}

/** Clears any cached verification results for this bot. Call on any mutation. */
function invalidateBotCache(botId: string): void {
  const keys = botCacheKeys.get(botId);
  if (keys) {
    for (const k of keys) verifiedCache.delete(k);
    botCacheKeys.delete(botId);
  }
}

export async function registerBot(botId: string, owner: string): Promise<{ botId: string; apiKey: string }> {
  const sql = getSql();
  const rawKey = generateApiKey();
  const hash = await hashApiKey(rawKey);

  await sql`
    INSERT INTO bots (bot_id, api_key_hash, owner, status)
    VALUES (${botId}, ${hash}, ${owner}, 'active')
  `;

  return { botId, apiKey: rawKey };
}

export async function regenerateApiKey(botId: string): Promise<string | null> {
  const sql = getSql();
  const rawKey = generateApiKey();
  const hash = await hashApiKey(rawKey);

  const result = await sql`
    UPDATE bots SET api_key_hash = ${hash} WHERE bot_id = ${botId}
    RETURNING bot_id
  `;

  if (result.length === 0) return null;

  invalidateBotCache(botId);
  return rawKey;
}

export async function setBotStatus(botId: string, status: "active" | "suspended"): Promise<boolean> {
  const sql = getSql();
  const result = await sql`
    UPDATE bots SET status = ${status} WHERE bot_id = ${botId}
    RETURNING bot_id
  `;

  invalidateBotCache(botId);
  return result.length > 0;
}

export async function deleteBot(botId: string): Promise<boolean> {
  const sql = getSql();
  const result = await sql`DELETE FROM bots WHERE bot_id = ${botId} RETURNING bot_id`;
  invalidateBotCache(botId);
  return result.length > 0;
}

export async function listBots(): Promise<Bot[]> {
  const sql = getSql();
  const rows = await sql<
    {
      bot_id: string;
      owner: string;
      status: string;
      created_at: Date;
      last_seen: Date | null;
    }[]
  >`SELECT bot_id, owner, status, created_at, last_seen FROM bots ORDER BY created_at DESC`;

  return rows.map((r) => ({
    botId: r.bot_id,
    owner: r.owner,
    status: r.status as "active" | "suspended",
    createdAt: r.created_at,
    lastSeen: r.last_seen,
  }));
}

/**
 * Verifies that rawKey belongs to botId and the bot is active.
 * Uses the verification cache to avoid re-hashing on every request.
 */
export async function verifyBotKey(botId: string, rawKey: string): Promise<boolean> {
  const cacheKey = cacheKeyFor(botId, rawKey);
  const cached = verifiedCache.get(cacheKey);
  const now = Date.now();

  if (cached && cached.expiresAt > now) {
    return cached.valid;
  }

  const sql = getSql();
  const rows = await sql<{ api_key_hash: string; status: string }[]>`
    SELECT api_key_hash, status FROM bots WHERE bot_id = ${botId}
  `;

  let valid = false;
  if (rows.length > 0 && rows[0]!.status === "active") {
    valid = await verifyApiKeyHash(rows[0]!.api_key_hash, rawKey);
  }

  verifiedCache.set(cacheKey, { valid, expiresAt: now + VERIFY_CACHE_TTL_MS });
  if (!botCacheKeys.has(botId)) botCacheKeys.set(botId, new Set());
  botCacheKeys.get(botId)!.add(cacheKey);

  if (valid) {
    sql`UPDATE bots SET last_seen = NOW() WHERE bot_id = ${botId}`.catch((err) => {
      logger.error({ err }, "Failed to update bot last_seen");
    });
  }

  return valid;
}
