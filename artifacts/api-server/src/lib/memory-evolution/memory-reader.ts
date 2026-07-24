/**
 * M24 — MemoryReader (pre-planning advisory read).
 *
 * Provides the Planner with a focused, query-specific view of long-term
 * knowledge before intent detection begins. This is distinct from the broader
 * MemoryContext loaded by MemoryManager.load() — it performs a targeted
 * semantic + deterministic retrieval tuned specifically for the user's prompt.
 *
 * Architectural invariant:
 *   MemoryReaderResult is advisory ONLY. The Planner reads the records to
 *   inform its decisions but MUST NOT delegate any decision to them.
 *   "Use tool X" must never originate from a memory record.
 *
 * Usage in request pipeline:
 *   memoryManager.load()        → broad budget-constrained snapshot
 *   memoryReader.read()         → focused query-ranked records (additive)
 *   agentPlanner.plan()         → receives merged, deduplicated knowledge
 *
 * Failures are non-fatal — the caller (chat.ts) wraps this in try/catch and
 * falls back to the existing MemoryContext records if the read fails.
 */

import type { MemoryScope } from "../memory/types.js";
import type {
  MemoryReader,
  MemoryReaderResult,
  MemoryReaderStore,
} from "./memory-evolution-types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum records returned by a MemoryReader.read() call. */
const MEMORY_READER_LIMIT = 10;

/** Minimum confidence required for records returned to the Planner. */
const MEMORY_READER_MIN_CONFIDENCE = 0.40;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a MemoryReader backed by the supplied MemoryReaderStore.
 * The store is structurally typed — any object with a compatible
 * loadRelevant() method is accepted (e.g. KnowledgeManager).
 */
export function createMemoryReader(store: MemoryReaderStore): MemoryReader {
  return {
    async read(scope: MemoryScope, query: string): Promise<MemoryReaderResult> {
      const records = await store.loadRelevant(scope, query, {
        limit: MEMORY_READER_LIMIT,
        minConfidence: MEMORY_READER_MIN_CONFIDENCE,
      });

      return Object.freeze({
        records,
        query,
        loadedAt: Date.now(),
      });
    },
  };
}
