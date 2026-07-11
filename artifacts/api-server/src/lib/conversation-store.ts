/**
 * Conversation history — persisted in Neon, one row per conversation.
 *
 * Conversation key scheme:
 *   DM:    botId::userId
 *   Group: botId::groupId::userId
 *
 * Expiry: 24h inactivity by default (CONVERSATION_TTL_MS). Enforced two ways:
 *   1. Lazily — checked on every read; an expired row is deleted on access.
 *   2. A background sweep every hour, for conversations nobody reads again.
 *
 * History cap: HISTORY_LIMIT messages (default 40) kept per conversation;
 * message_count tracks the lifetime total separately.
 */

import { getSql } from "./db.js";
import { logger } from "./logger.js";

export interface Message {
  role: "user" | "assistant";
  /** userId for user messages, "june" for AI replies */
  speaker: string;
  content: string;
  /** unix seconds */
  ts: number;
}

const TTL_MS = (() => {
  const raw = process.env["CONVERSATION_TTL_MS"];
  const parsed = raw ? Number(raw) : NaN;
  return Number.isNaN(parsed) || parsed <= 0 ? 24 * 60 * 60 * 1000 : parsed;
})();

const HISTORY_LIMIT = (() => {
  const raw = process.env["HISTORY_LIMIT"];
  const parsed = raw ? Number(raw) : NaN;
  return Number.isNaN(parsed) || parsed <= 0 ? 40 : parsed;
})();

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // hourly sweep

export function buildConversationKey(botId: string, userId: string, groupId?: string): string {
  return groupId ? `${botId}::${groupId}::${userId}` : `${botId}::${userId}`;
}

export async function getHistory(key: string): Promise<Message[]> {
  const sql = getSql();
  const cutoff = new Date(Date.now() - TTL_MS);

  const rows = await sql<{ messages: Message[]; last_activity: Date }[]>`
    SELECT messages, last_activity FROM conversations WHERE conversation_key = ${key}
  `;

  if (rows.length === 0) return [];

  // Lazy expiry: if stale, wipe it now instead of returning old context
  if (rows[0]!.last_activity < cutoff) {
    await sql`DELETE FROM conversations WHERE conversation_key = ${key}`;
    return [];
  }

  return rows[0]!.messages ?? [];
}

export async function appendMessages(
  key: string,
  botId: string,
  userId: string,
  groupId: string | undefined,
  newMessages: Message[],
): Promise<void> {
  const sql = getSql();
  const existing = await getHistory(key); // also applies lazy expiry
  const updated = [...existing, ...newMessages].slice(-HISTORY_LIMIT);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messagesJson = sql.json(updated as any);

  await sql`
    INSERT INTO conversations (conversation_key, bot_id, user_id, group_id, messages, message_count, last_activity)
    VALUES (${key}, ${botId}, ${userId}, ${groupId ?? null}, ${messagesJson}, ${newMessages.length}, NOW())
    ON CONFLICT (conversation_key) DO UPDATE
      SET messages = ${messagesJson},
          message_count = conversations.message_count + ${newMessages.length},
          last_activity = NOW()
  `;
}

export async function resetConversation(key: string): Promise<void> {
  const sql = getSql();
  await sql`DELETE FROM conversations WHERE conversation_key = ${key}`;
}

export async function runCleanup(): Promise<void> {
  try {
    const sql = getSql();
    const cutoff = new Date(Date.now() - TTL_MS);
    const result = await sql`DELETE FROM conversations WHERE last_activity < ${cutoff}`;
    if (result.count > 0) {
      logger.info({ deleted: result.count }, "Cleaned up inactive conversations");
    }
  } catch (err) {
    logger.error({ err }, "Conversation cleanup sweep failed");
  }
}

export function startCleanupJob(): void {
  runCleanup();
  setInterval(runCleanup, CLEANUP_INTERVAL_MS).unref();
}
