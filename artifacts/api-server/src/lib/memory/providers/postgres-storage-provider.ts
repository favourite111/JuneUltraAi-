/**
 * Phase 3B — PostgresStorageProvider (ADR-005, Milestone 8)
 *
 * Production StorageProvider implementation backed by PostgreSQL (Neon).
 * Wraps the existing postgres.js client from lib/db.ts.
 *
 * This provider maps the abstract StorageProvider interface to the physical
 * schema defined in lib/schema.ts:
 *   - session      → (not yet implemented in schema, currently in-memory fallback)
 *   - conversation → conversations table
 *   - user_profile → user_facts table
 *   - tool_execution → (not yet implemented in schema, currently in-memory fallback)
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
      // Session is not yet in the DB schema, returning null to allow in-memory fallback
      return null;
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

    return [];
  }

  async write<T>(key: StorageKey, value: T, options?: WriteOptions): Promise<WriteResult> {
    // Basic implementation for now, focused on session if needed
    const now = new Date();
    return {
      revision: 1,
      etag: "1",
      updatedAt: now.getTime()
    };
  }

  async append<T>(key: StorageKey, value: T, options?: WriteOptions): Promise<WriteResult> {
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

    const now = new Date();
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
      }
    } else {
      const sp = key as ScopePrefix;
      await Promise.all([
        this.sql`DELETE FROM conversations WHERE bot_id = ${sp.botId} AND user_id = ${sp.userId}`,
        this.sql`DELETE FROM user_facts WHERE bot_id = ${sp.botId} AND user_id = ${sp.userId}`
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
}
