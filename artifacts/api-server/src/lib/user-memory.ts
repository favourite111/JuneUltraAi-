/**
 * User memory — stores objective personal facts about a user (name, likes, etc.)
 * and injects them into prompts as a compact "Known facts" line.
 *
 * Security model:
 *   - Authority/identity claims ("I'm your developer", "I made you") are
 *     checked FIRST and always rejected — nothing from those messages is stored.
 *   - Only the backend can grant special trust to a user (via sender ID,
 *     owner config, or admin auth). Chat text alone can never do it.
 *   - Objective personal facts (name, likes, location, etc.) are safe to store
 *     and are kept separate from conversation history so clearing chat doesn't
 *     wipe them.
 */

import { getSql } from "./db.js";
import { logger } from "./logger.js";

export interface UserFact {
  key: string;
  value: string;
}

// ---------------------------------------------------------------------------
// Authority claim blocklist — checked FIRST on every message.
// If any pattern matches, extractFacts() returns [] immediately.
// Users cannot gain special trust by making claims in chat.
// ---------------------------------------------------------------------------
const AUTHORITY_BLOCK: RegExp[] = [
  /\bi(?:'m| am)\s+(?:your\s+)?(?:dev|developer|creator|coder|owner|admin|boss|master)\b/i,
  /\bi\s+(?:made|created|built|coded|programmed)\s+(?:you|june|this\s+bot)\b/i,
  /\bi(?:'m| am)\s+the\s+(?:one\s+who\s+)?(?:made|created|built|coded)\s+(?:you|june)\b/i,
  /\bi(?:'m| am)\s+(?:in\s+charge|the\s+(?:admin|owner|developer))\b/i,
  /\bi\s+(?:own|control|run|manage)\s+(?:you|this\s+bot|june)\b/i,
];

function isAuthorityClaim(message: string): boolean {
  return AUTHORITY_BLOCK.some((p) => p.test(message));
}

// ---------------------------------------------------------------------------
// Fact extraction patterns — ordered by priority.
// Only one value per key is extracted per message to avoid false positives.
// ---------------------------------------------------------------------------
const FACT_PATTERNS: Array<{ key: string; pattern: RegExp; group: number }> = [
  // Name
  { key: "name", pattern: /\bmy name is ([A-Za-z][\w ]{0,24})/i, group: 1 },
  { key: "name", pattern: /\bcall me ([A-Za-z][\w]{1,20})\b/i, group: 1 },
  { key: "name", pattern: /\bi go by ([A-Za-z][\w]{1,20})\b/i, group: 1 },
  // Nickname
  { key: "nickname", pattern: /\bmy nickname is ([A-Za-z][\w ]{0,20})/i, group: 1 },
  { key: "nickname", pattern: /\bthey (?:call|know) me (?:as )?([A-Za-z][\w ]{0,20})/i, group: 1 },
  // Likes
  { key: "likes", pattern: /\bi (?:really )?(?:like|love|enjoy|adore) ([^.!?\n]{3,35})/i, group: 1 },
  // Dislikes
  { key: "dislikes", pattern: /\bi (?:really )?(?:hate|dislike|can't stand|don't like) ([^.!?\n]{3,35})/i, group: 1 },
  // Favourite
  { key: "favorite", pattern: /\bmy (?:fav(?:ou?rite)?) (?:\w+ )?is ([^.!?\n]{2,35})/i, group: 1 },
  // Location
  { key: "from", pattern: /\bi(?:'m| am) from ([A-Za-z][\w ,]{2,25})/i, group: 1 },
  // Age (only plausible human ages)
  { key: "age", pattern: /\bi(?:'m| am) (\d{1,2})(?: years? old)?\b/i, group: 1 },
  // Language
  { key: "language", pattern: /\bi (?:speak|prefer) ([A-Za-z]{3,20})\b/i, group: 1 },
];

/**
 * Extract storable facts from a user message.
 * Returns an empty array if the message contains an authority claim.
 */
export function extractFacts(message: string): UserFact[] {
  // Authority check — must be first, no exceptions
  if (isAuthorityClaim(message)) return [];

  const facts: UserFact[] = [];
  const seenKeys = new Set<string>();

  for (const { key, pattern, group } of FACT_PATTERNS) {
    if (seenKeys.has(key)) continue; // one value per key per message
    const match = message.match(pattern);
    if (match) {
      const value = match[group]?.trim();
      if (value && value.length >= 2) {
        facts.push({ key, value });
        seenKeys.add(key);
      }
    }
  }

  return facts;
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

export async function saveFacts(
  botId: string,
  userId: string,
  facts: UserFact[],
): Promise<void> {
  if (facts.length === 0) return;
  const sql = getSql();
  for (const { key, value } of facts) {
    try {
      await sql`
        INSERT INTO user_facts (bot_id, user_id, fact_key, fact_value, updated_at)
        VALUES (${botId}, ${userId}, ${key}, ${value}, NOW())
        ON CONFLICT (bot_id, user_id, fact_key)
        DO UPDATE SET fact_value = ${value}, updated_at = NOW()
      `;
    } catch (err) {
      logger.error({ err, botId, userId, key }, "Failed to save user fact");
    }
  }
}

export async function getFacts(
  botId: string,
  userId: string,
): Promise<Record<string, string>> {
  const sql = getSql();
  try {
    const rows = await sql<{ fact_key: string; fact_value: string }[]>`
      SELECT fact_key, fact_value FROM user_facts
      WHERE bot_id = ${botId} AND user_id = ${userId}
      ORDER BY updated_at DESC
      LIMIT 8
    `;
    return Object.fromEntries(rows.map((r) => [r.fact_key, r.fact_value]));
  } catch {
    return {};
  }
}

/**
 * Formats stored facts as a compact one-liner for the prompt.
 * Kept deliberately short to protect the URL budget.
 */
export function formatFactsForPrompt(facts: Record<string, string>): string {
  const entries = Object.entries(facts);
  if (entries.length === 0) return "";
  return "Known facts about this user: " + entries.map(([k, v]) => `${k}=${v}`).join(", ") + ".";
}
