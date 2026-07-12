import argon2 from "argon2";
import { randomBytes } from "node:crypto";

const KEY_PREFIX = "jx_live_";

/** Generates a long, random, prefixed API key: jx_live_<32 random bytes, base64url>. */
export function generateApiKey(): string {
  return KEY_PREFIX + randomBytes(32).toString("base64url");
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
