/**
 * Phase 3B — PostgresStorageProvider (ADR-005, Milestone 8)
 *
 * Production StorageProvider implementation backed by PostgreSQL (Neon).
 * Wraps the existing postgres.js client from lib/db.ts.
 *
 * This provider maps the abstract StorageProvider interface to the physical
 * schema defined in lib/schema.ts:
 *   - session            → (not yet in schema; in-memory fallback)
 *   - conversation       → conversations table
 *   - user_profile       → user_facts table
 *   - tool_execution     → (not yet in schema; in-memory fallback)
 *   - long_term_knowledge → long_term_knowledge table (Milestone 7)
 *
 * Schema for long_term_knowledge table (run once per database):
 *   CREATE TABLE IF NOT EXISTS long_term_knowledge (
 *     bot_id       TEXT        NOT NULL,
 *     user_id      TEXT        NOT NULL,
 *     record_key   TEXT        NOT NULL,
 *     record_value JSONB       NOT NULL,
 *     updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 *     PRIMARY KEY (bot_id, user_id, record_key)
 *   );
 */

import { getSql } from "../../db.js";
import {
  type ListOptions,
  type ScopePrefix,
  type StorageKey,
  type StorageProvider,
  type WriteOptions,
  type WriteResult,
  WriteConflictError,
} from "../types.js";

export class PostgresStorageProvider implements StorageProvider {
  private readonly sql = getSql();

  async read<T>(key: StorageKey): Promise<T | null> {
    if (key.tier === "session") {
      const rows = await this.sql`
        SELECT session_data
        FROM sessions
        WHERE bot_id = ${key.botId} AND user_id = ${key.userId} AND session_id = ${key.qualifier ?? 'default'}
      `;
      if (rows.length === 0) return null;
      return rows[0].session_data as T;
    }

    if (key.tier === "user_profile") {
      const rows = await this.sql`
        SELECT fact_key, fact_value, updated_at
        FROM user_facts
        WHERE bot_id = ${key.botId} AND user_id = ${key.userId}
      `;
      if (rows.length === 0) return null;
      
      // Map rows to a Record<string, any> for the user_profile tier
      const result: Record<string, any> = {};
      for (const row of rows) {
        try {
          result[row.fact_key] = JSON.parse(row.fact_value);
        } catch {
          result[row.fact_key] = row.fact_value;
        }
      }
      return result as T;
    }

    return null;
  }

  async list<T>(key: StorageKey, options: ListOptions): Promise<T[]> {
    if (key.tier === "conversation") {
      const rows = await this.sql`
        SELECT messages
        FROM conversations
        WHERE bot_id = ${key.botId} AND user_id = ${key.userId}
      `;
      if (rows.length === 0) return [];
      
      let messages = rows[0].messages;
      if (options.order === "desc") {
        messages = [...messages].reverse();
      }
      return messages.slice(0, options.limit) as T[];
    }

    if (key.tier === "user_profile") {
      const rows = await this.sql`
        SELECT fact_key, fact_value, updated_at
        FROM user_facts
        WHERE bot_id = ${key.botId} AND user_id = ${key.userId}
      `;
      
      const facts = rows.map(row => {
        let value = row.fact_value;
        try {
          value = JSON.parse(row.fact_value);
        } catch {
          // keep as string
        }
        return {
          key: row.fact_key,
          value: typeof value === 'object' ? value.value : value,
          confidence: typeof value === 'object' ? value.confidence : 1.0,
          importance: typeof value === 'object' ? value.importance : 0.5,
          source: typeof value === 'object' ? value.source : "explicit",
          createdAt: row.updated_at.getTime(),
          confirmedAt: row.updated_at.getTime(),
          sensitive: false,
          decayed: false
        };
      });

      if (options.order === "desc") {
        facts.reverse();
      }
      return facts.slice(0, options.limit) as T[];
    }

    if (key.tier === "long_term_knowledge") {
      const rows = await this.sql`
        SELECT record_key, record_value, updated_at
        FROM long_term_knowledge
        WHERE bot_id = ${key.botId} AND user_id = ${key.userId}
        ORDER BY updated_at ASC
        LIMIT ${options.limit ?? 200}
      `;

      const records = rows.map(row => {
        const v = typeof row.record_value === "string"
          ? JSON.parse(row.record_value)
          : row.record_value;
        return { ...v, key: row.record_key };
      });

      if (options.order === "desc") {
        records.reverse();
      }
      return records as T[];
    }

    if (key.tier === "session") {
      const rows = await this.sql`
        SELECT session_id, session_data, last_activity_at
        FROM sessions
        WHERE bot_id = ${key.botId} AND user_id = ${key.userId}
        ORDER BY last_activity_at DESC
        LIMIT ${options.limit ?? 100}
      `;
      return rows.map(row => ({
        ...row.session_data,
        sessionId: row.session_id,
        lastActivityAt: row.last_activity_at.getTime()
      })) as T[];
    }

    if (key.tier === "tool_execution") {
      const rows = await this.sql`
        SELECT tool_name, execution_time, success, metadata
        FROM tool_executions
        WHERE bot_id = ${key.botId} AND user_id = ${key.userId}
        ORDER BY execution_time DESC
        LIMIT ${options.limit ?? 50}
      `;
      return rows.map(row => ({
        toolName: row.tool_name,
        executionTime: row.execution_time.getTime(),
        success: row.success,
        metadata: row.metadata
      })) as T[];
    }

    return [];
  }

  async write<T>(key: StorageKey, value: T, options?: WriteOptions): Promise<WriteResult> {
    const now = new Date();
    if (key.tier === "session") {
      const sessionData = JSON.stringify(value);
      await this.sql`
        INSERT INTO sessions (bot_id, user_id, session_id, session_data, last_activity_at, updated_at)
        VALUES (${key.botId}, ${key.userId}, ${key.qualifier ?? 'default'}, ${sessionData}::jsonb, ${now}, ${now})
        ON CONFLICT (bot_id, user_id, session_id)
        DO UPDATE SET session_data = ${sessionData}::jsonb, last_activity_at = ${now}, updated_at = NOW()
      `;
    }
    
    return {
      revision: 1,
      etag: "1",
      updatedAt: now.getTime()
    };
  }

  async append<T>(key: StorageKey, value: T, options?: WriteOptions): Promise<WriteResult> {
    const now = new Date();
    if (key.tier === "conversation") {
      const message = value as any;
      await this.sql`
        INSERT INTO conversations (conversation_key, bot_id, user_id, messages, last_activity)
        VALUES (${key.botId + '::' + key.userId}, ${key.botId}, ${key.userId}, ${JSON.stringify([message])}, NOW())
        ON CONFLICT (conversation_key)
        DO UPDATE SET 
          messages = conversations.messages || ${JSON.stringify([message])}::jsonb,
          last_activity = NOW(),
          message_count = conversations.message_count + 1
      `;
    }

    if (key.tier === "tool_execution") {
      const record = value as any;
      await this.sql`
        INSERT INTO tool_executions (bot_id, user_id, session_id, tool_name, execution_time, success, metadata)
        VALUES (${key.botId}, ${key.userId}, ${key.qualifier ?? 'default'}, ${record.toolName}, ${new Date(record.executionTime)}, ${record.success}, ${JSON.stringify(record.metadata)}::jsonb)
      `;
    }

    return {
      revision: 1,
      etag: "1",
      updatedAt: now.getTime()
    };
  }

  async upsert<T>(key: StorageKey, entryKey: string, value: T, options?: WriteOptions): Promise<WriteResult> {
    if (key.tier === "user_profile") {
      const fact = value as any;
      const factValue = typeof fact === 'object' ? JSON.stringify(fact) : String(fact);
      
      await this.sql`
        INSERT INTO user_facts (bot_id, user_id, fact_key, fact_value, updated_at)
        VALUES (${key.botId}, ${key.userId}, ${entryKey}, ${factValue}, NOW())
        ON CONFLICT (bot_id, user_id, fact_key)
        DO UPDATE SET fact_value = ${factValue}, updated_at = NOW()
      `;
    }

    if (key.tier === "long_term_knowledge") {
      const recordValue = JSON.stringify(value);
      await this.sql`
        INSERT INTO long_term_knowledge (bot_id, user_id, record_key, record_value, updated_at)
        VALUES (${key.botId}, ${key.userId}, ${entryKey}, ${recordValue}::jsonb, NOW())
        ON CONFLICT (bot_id, user_id, record_key)
        DO UPDATE SET record_value = ${recordValue}::jsonb, updated_at = NOW()
      `;
    }

    const now = new Date();
    return {
      revision: 1,
      etag: "1",
      updatedAt: now.getTime()
    };
  }

  async delete(key: StorageKey | ScopePrefix): Promise<void> {
    if ("tier" in key) {
      const sk = key as StorageKey;
      if (sk.tier === "conversation") {
        await this.sql`DELETE FROM conversations WHERE bot_id = ${sk.botId} AND user_id = ${sk.userId}`;
      } else if (sk.tier === "user_profile") {
        await this.sql`DELETE FROM user_facts WHERE bot_id = ${sk.botId} AND user_id = ${sk.userId}`;
      } else if (sk.tier === "long_term_knowledge") {
        await this.sql`DELETE FROM long_term_knowledge WHERE bot_id = ${sk.botId} AND user_id = ${sk.userId}`;
      }
    } else {
      const sp = key as ScopePrefix;
      await Promise.all([
        this.sql`DELETE FROM conversations WHERE bot_id = ${sp.botId} AND user_id = ${sp.userId}`,
        this.sql`DELETE FROM user_facts WHERE bot_id = ${sp.botId} AND user_id = ${sp.userId}`,
        this.sql`DELETE FROM long_term_knowledge WHERE bot_id = ${sp.botId} AND user_id = ${sp.userId}`,
      ]);
    }
  }

  async health(): Promise<"ok" | "degraded" | "unavailable"> {
    try {
      await this.sql`SELECT 1`;
      return "ok";
    } catch {
      return "unavailable";
    }
  }

  async listActiveScopes(): Promise<Array<{ botId: string; userId: string; tenantId: string }>> {
    // Collect all distinct (botId, userId) from tiers that need pruning
    const rows = await this.sql`
      SELECT DISTINCT bot_id, user_id FROM conversations
      UNION
      SELECT DISTINCT bot_id, user_id FROM sessions
      UNION
      SELECT DISTINCT bot_id, user_id FROM tool_executions
    `;
    return rows.map(row => ({
      botId: row.bot_id,
      userId: row.user_id,
      tenantId: "default" // PostgresStorageProvider currently defaults to one tenant
    }));
  }
}
