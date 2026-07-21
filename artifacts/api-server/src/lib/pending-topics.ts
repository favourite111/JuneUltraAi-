/**
 * Pending Topics — unfinished conversational threads stored in Neon.
 *
 * Lifecycle:
 *   open     → June asked about a story; waiting for the user to continue
 *   closed   → user followed up (auto-detected) or conversation was reset
 *   expired  → open for > TOPIC_EXPIRY_DAYS days — swept by the cleanup job
 *
 * Deduplication:
 *   Each topic carries a `topic_key` (the category slug from TOPIC_PATTERNS —
 *   e.g. "school/studies", "relationships"). When saving, if an open topic with
 *   the same bot+user+topic_key already exists, we update its text and timestamp
 *   instead of inserting a duplicate row. This prevents accumulation like:
 *     [school/studies] "my exams are stressing me"
 *     [school/studies] "I think I'll fail these exams"
 *   into a single merged record.
 *
 * Cap:
 *   At most MAX_OPEN_TOPICS open topics per user per bot. When the cap is
 *   reached, the oldest non-high-priority topic is evicted before inserting.
 */

import { getSql } from "./db.js";
import { logger } from "./logger.js";

export type TopicImportance = "low" | "medium" | "high";
export type TopicStatus     = "open" | "closed" | "expired";

export interface PendingTopic {
  id:         number;
  topicText:  string;
  topicKey:   string | null;
  importance: TopicImportance;
  createdAt:  Date;
  updatedAt:  Date;
}

const MAX_OPEN_TOPICS      = 5;
const TOPIC_EXPIRY_DAYS    = 7;
const CLEANUP_INTERVAL_MS  = 24 * 60 * 60 * 1000; // daily sweep

// ---------------------------------------------------------------------------
// Importance classification
// Scans the raw user message for emotional weight or life-stage significance.
// ---------------------------------------------------------------------------

const HIGH_IMPORTANCE_RE =
  /\b(died|death|passed away|cancer|sick|hospital|broke\s*up|breakup|fired|lost\s+(my|the)\s+job|pregnant|accident|depressed|depression|anxiety|divorce|fight with|argument with|assault|abuse|suicid)\b/i;

const MEDIUM_IMPORTANCE_RE =
  /\b(project|applying|interview|moving|trip|exam|test|deadline|launch|starting|planning|working on|promotion|relationship|crush|proposal|wedding|graduation)\b/i;

export function classifyImportance(text: string): TopicImportance {
  if (HIGH_IMPORTANCE_RE.test(text))   return "high";
  if (MEDIUM_IMPORTANCE_RE.test(text)) return "medium";
  return "low";
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/**
 * Saves a pending topic with deduplication by topic_key.
 *
 * If an open topic with the same (bot_id, user_id, topic_key) already exists,
 * it is updated in place (topic_text refreshed, updated_at bumped) instead of
 * inserting a duplicate row. Falls through to insert when topic_key is null
 * or no matching open row exists.
 */
export async function savePendingTopic(
  botId:      string,
  userId:     string,
  topicText:  string,
  importance: TopicImportance,
  topicKey:   string | null = null,
): Promise<void> {
  try {
    const sql = getSql();

    // Deduplication: update existing open row for the same topic category
    if (topicKey) {
      const updated = await sql`
        UPDATE pending_topics
        SET   topic_text = ${topicText},
              importance = ${importance},
              updated_at = NOW()
        WHERE bot_id    = ${botId}
          AND user_id   = ${userId}
          AND topic_key = ${topicKey}
          AND status    = 'open'
      `;
      if (updated.count > 0) return; // merged — no new row needed
    }

    // Enforce cap before inserting a fresh row
    const [row] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM pending_topics
      WHERE bot_id = ${botId} AND user_id = ${userId} AND status = 'open'
    `;
    if (Number(row?.count ?? 0) >= MAX_OPEN_TOPICS) {
      // Evict the oldest low/medium-priority open topic to make room
      await sql`
        DELETE FROM pending_topics
        WHERE id = (
          SELECT id FROM pending_topics
          WHERE bot_id = ${botId} AND user_id = ${userId} AND status = 'open'
          ORDER BY
            CASE importance WHEN 'high' THEN 1 ELSE 0 END DESC,
            updated_at ASC
          LIMIT 1
        )
      `;
    }

    await sql`
      INSERT INTO pending_topics (bot_id, user_id, topic_text, importance, topic_key)
      VALUES (${botId}, ${userId}, ${topicText}, ${importance}, ${topicKey})
    `;
  } catch (err) {
    logger.error({ err }, "Failed to save pending topic");
  }
}

/**
 * Returns up to 3 open topics for a user, sorted by importance then most-recently updated.
 */
export async function getOpenTopics(
  botId:  string,
  userId: string,
): Promise<PendingTopic[]> {
  try {
    const sql = getSql();
    const rows = await sql<{
      id:         number;
      topic_text: string;
      topic_key:  string | null;
      importance: string;
      created_at: Date;
      updated_at: Date;
    }[]>`
      SELECT id, topic_text, topic_key, importance, created_at, updated_at
      FROM pending_topics
      WHERE bot_id = ${botId} AND user_id = ${userId} AND status = 'open'
      ORDER BY
        CASE importance WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
        updated_at DESC
      LIMIT 3
    `;
    return rows.map((r) => ({
      id:         r.id,
      topicText:  r.topic_text,
      topicKey:   r.topic_key,
      importance: r.importance as TopicImportance,
      createdAt:  r.created_at,
      updatedAt:  r.updated_at,
    }));
  } catch (err) {
    logger.error({ err }, "Failed to get open topics");
    return [];
  }
}

/**
 * Marks a single topic as closed (the user followed up on it).
 */
export async function closeTopic(id: number): Promise<void> {
  try {
    const sql = getSql();
    await sql`
      UPDATE pending_topics
      SET status = 'closed', closed_at = NOW()
      WHERE id = ${id}
    `;
  } catch (err) {
    logger.error({ err }, "Failed to close topic");
  }
}

/**
 * Closes all open topics for a user (called on conversation reset).
 */
export async function closeAllTopics(botId: string, userId: string): Promise<void> {
  try {
    const sql = getSql();
    await sql`
      UPDATE pending_topics
      SET status = 'closed', closed_at = NOW()
      WHERE bot_id = ${botId} AND user_id = ${userId} AND status = 'open'
    `;
  } catch (err) {
    logger.error({ err }, "Failed to close all topics");
  }
}

/**
 * Closes ALL open topics for a bot — used by factory reset.
 */
export async function closeAllTopicsForBot(botId: string): Promise<void> {
  try {
    const sql = getSql();
    await sql`
      UPDATE pending_topics
      SET status = 'closed', closed_at = NOW()
      WHERE bot_id = ${botId} AND status = 'open'
    `;
  } catch (err) {
    logger.error({ err }, "Failed to close all topics for bot");
  }
}

// ---------------------------------------------------------------------------
// Expiry sweep — marks open topics older than TOPIC_EXPIRY_DAYS as 'expired'.
// Runs daily so stale threads from users who never finished a story don't
// accumulate forever.
// ---------------------------------------------------------------------------

export async function runTopicCleanup(): Promise<void> {
  try {
    const sql    = getSql();
    const cutoff = new Date(Date.now() - TOPIC_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    const result = await sql`
      UPDATE pending_topics
      SET   status    = 'expired',
            closed_at = NOW()
      WHERE status     = 'open'
        AND updated_at < ${cutoff}
    `;
    if (result.count > 0) {
      logger.info({ expired: result.count }, "Expired stale pending topics");
    }
  } catch (err) {
    logger.error({ err }, "Topic expiry sweep failed");
  }
}

export function startTopicCleanupJob(): void {
  runTopicCleanup();
  setInterval(runTopicCleanup, CLEANUP_INTERVAL_MS).unref();
}
