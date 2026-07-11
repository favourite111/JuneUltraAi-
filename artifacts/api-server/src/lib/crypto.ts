import argon2 from "argon2";
import { createHmac, randomBytes } from "node:crypto";

const KEY_PREFIX = "jx_live_";
const WEBHOOK_SECRET_PREFIX = "whsec_";

/** Generates a long, random, prefixed API key: jx_live_<32 random bytes, base64url>. */
export function generateApiKey(): string {
  return KEY_PREFIX + randomBytes(32).toString("base64url");
}

/**
 * Generates a dedicated webhook signing secret: whsec_<32 random bytes,
 * base64url>. Deliberately separate from the bot's API key — the API key
 * is stored as an Argon2id hash (one-way, unrecoverable), so it can't be
 * reused as an HMAC secret. This secret is stored in plaintext (there's no
 * way around that for HMAC — the server must be able to re-sign every
 * delivery) and shown to the admin once, the same way the API key is.
 */
export function generateWebhookSecret(): string {
  return WEBHOOK_SECRET_PREFIX + randomBytes(32).toString("base64url");
}

/** Signs a raw request body with the bot's webhook secret (HMAC-SHA256, hex digest). */
export function signWebhookPayload(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

/** Hashes a raw API key with Argon2id for storage. */
export function hashApiKey(rawKey: string): Promise<string> {
  return argon2.hash(rawKey, { type: argon2.argon2id });
}

/** Verifies a raw API key against a stored Argon2id hash. */
export async function verifyApiKeyHash(hash: string, rawKey: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, rawKey);
  } catch {
    return false;
  }
}
