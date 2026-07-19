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
// Fact extraction patterns — each entry carries its own importance priority:
//
//   1 = Critical  — identity basics always included in the prompt
//   2 = Important — stable personal context
//   3 = Normal    — preferences that can rotate out of the 8-slot window
//
// Adding a new fact type only requires adding an entry here — no separate
// lookup table to keep in sync.
// Only one value per key is extracted per message to avoid false positives.
// ---------------------------------------------------------------------------
const FACT_PATTERNS: Array<{ key: string; priority: number; pattern: RegExp; group: number }> = [
  // Name — priority 1 (critical)
  { key: "name",     priority: 1, pattern: /\bmy name is ([A-Za-z][\w ]{0,24})/i,                              group: 1 },
  { key: "name",     priority: 1, pattern: /\bcall me ([A-Za-z][\w]{1,20})\b/i,                                group: 1 },
  { key: "name",     priority: 1, pattern: /\bi go by ([A-Za-z][\w]{1,20})\b/i,                                group: 1 },
  // Nickname — priority 1 (critical)
  { key: "nickname", priority: 1, pattern: /\bmy nickname is ([A-Za-z][\w ]{0,20})/i,                          group: 1 },
  { key: "nickname", priority: 1, pattern: /\bthey (?:call|know) me (?:as )?([A-Za-z][\w ]{0,20})/i,          group: 1 },
  // Language — priority 1 (critical)
  { key: "language", priority: 1, pattern: /\bi (?:speak|prefer) ([A-Za-z]{3,20})\b/i,                         group: 1 },
  // Location — priority 2 (important); all patterns update the same key via upsert
  { key: "from",     priority: 2, pattern: /\bi(?:'m| am) from ([A-Za-z][\w ,]{2,25})/i,                       group: 1 },
  { key: "from",     priority: 2, pattern: /\bi(?:'ve)? moved to ([A-Za-z][\w ,]{2,25})/i,                     group: 1 },
  { key: "from",     priority: 2, pattern: /\bi(?:'m| am) (?:now )?(?:living|based) in ([A-Za-z][\w ,]{2,25})/i, group: 1 },
  { key: "from",     priority: 2, pattern: /\bi now live in ([A-Za-z][\w ,]{2,25})/i,                          group: 1 },
  // Age — priority 2 (important; only plausible human ages)
  { key: "age",      priority: 2, pattern: /\bi(?:'m| am) (\d{1,2})(?: years? old)?\b/i,                       group: 1 },
  // Likes — priority 3 (normal)
  { key: "likes",    priority: 3, pattern: /\bi (?:really )?(?:like|love|enjoy|adore) ([^.!?\n]{3,35})/i,      group: 1 },
  // Dislikes — priority 3 (normal)
  { key: "dislikes", priority: 3, pattern: /\bi (?:really )?(?:hate|dislike|can't stand|don't like) ([^.!?\n]{3,35})/i, group: 1 },
  // Favourite — priority 3 (normal)
  { key: "favorite", priority: 3, pattern: /\bmy (?:fav(?:ou?rite)?) (?:\w+ )?is ([^.!?\n]{2,35})/i,          group: 1 },
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
// Derived priority lookup — built once at module load from FACT_PATTERNS so
// there is a single source of truth. Adding a new fact type only requires
// an entry in FACT_PATTERNS; no second table to keep in sync.
// ---------------------------------------------------------------------------
const KEY_PRIORITY: Record<string, number> = {};
for (const { key, priority } of FACT_PATTERNS) {
  if (!(key in KEY_PRIORITY)) KEY_PRIORITY[key] = priority;
}

function priorityOf(key: string): number {
  return KEY_PRIORITY[key] ?? 3;
}

const MAX_FACTS_IN_PROMPT = 8;

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
    // Fetch more than we need so the tier sort has enough to work with.
    // DB orders by recency; we re-sort in code so critical facts (name,
    // nickname, language) always survive the MAX_FACTS_IN_PROMPT slice,
    // even if the user hasn't mentioned them recently.
    const rows = await sql<{ fact_key: string; fact_value: string }[]>`
      SELECT fact_key, fact_value FROM user_facts
      WHERE bot_id = ${botId} AND user_id = ${userId}
      ORDER BY updated_at DESC
      LIMIT 20
    `;
    const sorted = [...rows].sort(
      (a, b) => priorityOf(a.fact_key) - priorityOf(b.fact_key),
    );
    return Object.fromEntries(
      sorted.slice(0, MAX_FACTS_IN_PROMPT).map((r) => [r.fact_key, r.fact_value]),
    );
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
