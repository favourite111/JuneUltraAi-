import { getSql } from "./db.js";
import { logger } from "./logger.js";
import { startCleanupJob } from "./conversation-store.js";

/**
 * Creates the bots + conversations tables if they don't exist, and starts
 * the background sweeps (hourly inactive-conversation cleanup).
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
  // Authority/identity claims are never stored here; that enforcement is in user-memory.ts.
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

  logger.info("Neon schema ready");

  startCleanupJob();
}
