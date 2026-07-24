/**
 * M24 — KnowledgeReader.
 *
 * I/O adapter that loads existing KnowledgeRecords for specific keys so that
 * MemoryPolicy can make decisions as a pure function without touching storage.
 *
 * Separation of responsibilities:
 *   KnowledgeReader  — I/O: loads existing records by key set
 *   MemoryPolicy     — Pure: decides action given candidate + existing records
 *   MemoryEvolutionEngine — orchestrates both + performs writes
 *
 * The reader loads all knowledge for the scope and filters to the requested
 * key set. This avoids per-key queries and keeps the storage interaction to
 * one list() call per evolution pass.
 */

import type { KnowledgeRecord, MemoryScope } from "../memory/types.js";
import type { KnowledgeReaderStore } from "./memory-evolution-types.js";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/** Loads existing KnowledgeRecords by key from the store. */
export interface KnowledgeReader {
  /**
   * Returns existing KnowledgeRecords whose keys appear in the supplied set.
   * Returns an empty array when the store has no matching records.
   * Never throws — failures are propagated to the caller (MemoryEvolutionEngine
   * wraps the whole pass in a try/catch).
   */
  read(scope: MemoryScope, keys: readonly string[]): Promise<readonly KnowledgeRecord[]>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a KnowledgeReader backed by the supplied KnowledgeReaderStore.
 * The store is structurally typed — any object with a compatible load()
 * method is accepted (e.g. KnowledgeManager, InMemoryStorageProvider stub).
 */
export function createKnowledgeReader(store: KnowledgeReaderStore): KnowledgeReader {
  return {
    async read(scope: MemoryScope, keys: readonly string[]): Promise<readonly KnowledgeRecord[]> {
      if (keys.length === 0) return [];

      const keySet = new Set(keys);
      const all = await store.load(scope, { limit: 200 });
      return all.filter((record) => keySet.has(record.key));
    },
  };
}
