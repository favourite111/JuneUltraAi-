import { getSql } from "./db.js";
import { logger } from "./logger.js";
import { startPrunerScheduler } from "./memory-singletons.js";
import { startTopicCleanupJob } from "./pending-topics.js";

/**
 * Creates the application tables if they don't exist and starts the pending
 * topic cleanup job. Memory retention is owned by the storage-pruner.
 */
export async function ensureSchema(): Promise<void> {
  const sql = getSql();

  await sql`
    CREATE TABLE IF NOT EXISTS bots (
      bot_id        TEXT PRIMARY KEY,
      api_key_hash  TEXT NOT NULL UNIQUE,
      owner         TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'active',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen     TIMESTAMPTZ
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS conversations (
      conversation_key  TEXT PRIMARY KEY,
      bot_id            TEXT NOT NULL REFERENCES bots(bot_id) ON DELETE CASCADE,
      user_id           TEXT NOT NULL,
      group_id          TEXT,
      messages          JSONB NOT NULL DEFAULT '[]',
      message_count     INTEGER NOT NULL DEFAULT 0,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_activity     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS idx_conv_bot_id ON conversations (bot_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_conv_last_activity ON conversations (last_activity)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_conv_group_id ON conversations (group_id) WHERE group_id IS NOT NULL`;

  // User memory — objective personal facts (name, likes, etc.) per user per bot.
  // User-profile records are validated by the Knowledge pipeline before storage.
  await sql`
    CREATE TABLE IF NOT EXISTS user_facts (
      bot_id      TEXT NOT NULL,
      user_id     TEXT NOT NULL,
      fact_key    TEXT NOT NULL,
      fact_value  TEXT NOT NULL,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (bot_id, user_id, fact_key)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_facts_bot_user ON user_facts (bot_id, user_id)`;

  // Long-term knowledge — durable synthesized facts about a user (Phase 3C, M13).
  // KnowledgeManager reads and writes this table; schema.ts is the single source
  // of truth so the table exists before any route handler runs.
  await sql`
    CREATE TABLE IF NOT EXISTS long_term_knowledge (
      bot_id        TEXT        NOT NULL,
      user_id       TEXT        NOT NULL,
      record_key    TEXT        NOT NULL,
      record_value  JSONB       NOT NULL,
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (bot_id, user_id, record_key)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_ltk_bot_user ON long_term_knowledge (bot_id, user_id)`;

  // Pending topics — unfinished conversational threads that June should follow up on.
  // Saved when June responds with curiosity (user starts a story); closed when the
  // user actually tells the story or the conversation is reset.
  await sql`
    CREATE TABLE IF NOT EXISTS pending_topics (
      id           BIGSERIAL PRIMARY KEY,
      bot_id       TEXT NOT NULL,
      user_id      TEXT NOT NULL,
      topic_text   TEXT NOT NULL,
      topic_key    TEXT,
      importance   TEXT NOT NULL DEFAULT 'low',
      status       TEXT NOT NULL DEFAULT 'open',
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      closed_at    TIMESTAMPTZ
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_topics_bot_user_status ON pending_topics (bot_id, user_id, status)`;

  // Migrate existing pending_topics rows that predate topic_key / updated_at columns.
  // ADD COLUMN IF NOT EXISTS is a no-op on fresh installs; safe to run every boot.
  await sql`ALTER TABLE pending_topics ADD COLUMN IF NOT EXISTS topic_key  TEXT`;
  await sql`ALTER TABLE pending_topics ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`;

  // M15-F2: Sessions table
  await sql`
    CREATE TABLE IF NOT EXISTS sessions (
      bot_id            TEXT NOT NULL,
      user_id           TEXT NOT NULL,
      session_id        TEXT NOT NULL,
      session_data      JSONB NOT NULL,
      last_activity_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (bot_id, user_id, session_id)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_sessions_last_activity ON sessions (last_activity_at)`;

  // M15-F3: Tool executions table
  await sql`
    CREATE TABLE IF NOT EXISTS tool_executions (
      id                BIGSERIAL PRIMARY KEY,
      bot_id            TEXT NOT NULL,
      user_id           TEXT NOT NULL,
      session_id        TEXT NOT NULL,
      tool_name         TEXT NOT NULL,
      execution_time    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      success           BOOLEAN NOT NULL,
      metadata          JSONB NOT NULL DEFAULT '{}',
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_tool_exec_bot_user ON tool_executions (bot_id, user_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_tool_exec_session ON tool_executions (session_id)`;

  logger.info("Neon schema ready");

  startTopicCleanupJob();
  startPrunerScheduler();
}
