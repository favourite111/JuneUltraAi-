/**
 * Phase 3C — Milestone 7: Long-Term Knowledge Foundation
 *
 * KnowledgeManager provides typed CRUD operations over the long_term_knowledge
 * storage tier.  It is a standalone service — no EventBus wiring, no LLM calls,
 * no embeddings.
 *
 * Design constraints:
 *   - Purely deterministic (injectable clock via KnowledgeManagerOptions.nowFn).
 *   - Uses the existing StorageProvider contract without modifications.
 *   - Upsert is keyed by KnowledgeRecord.key (same pattern as UserFact in the
 *     user_profile tier).
 *   - merge() is version-guarded: incoming records only overwrite stored ones when
 *     incoming.version > stored.version.
 *   - remove() uses the read-filter-delete-reappend pattern established in M5.
 *   - load() filters expired records by default (records where expiresAt ≤ nowMs).
 *   - Results are sorted by importance × confidence descending (highest relevance
 *     first) — ready for future token-budget eviction.
 */

import type {
  KnowledgeCategory,
  KnowledgeRecord,
  MemoryScope,
  StorageKey,
  StorageProvider,
} from "./types.js";

// ---------------------------------------------------------------------------
// Options & result types
// ---------------------------------------------------------------------------

export interface KnowledgeLoadOptions {
  /**
   * When true, returns records where expiresAt ≤ nowMs.
   * Default: false (expired records excluded).
   */
  readonly includeExpired?: boolean;
  /**
   * Filter results to only the listed categories.
   * Omit (or pass an empty array) to return all categories.
   */
  readonly categories?: readonly KnowledgeCategory[];
  /**
   * Minimum confidence threshold (inclusive, 0–1).
   * Default: 0 (all confidence levels returned).
   */
  readonly minConfidence?: number;
  /**
   * Maximum number of records to return after all filters are applied.
   * Default: 200.
   */
  readonly limit?: number;
}

/**
 * Result of a KnowledgeManager.merge() call.
 */
export interface MergeResult {
  /** Records that were upserted (new or incoming.version > stored.version). */
  readonly upserted: number;
  /** Records skipped because stored.version ≥ incoming.version. */
  readonly skipped: number;
}

/**
 * Constructor options for KnowledgeManager.
 */
export interface KnowledgeManagerOptions {
  /**
   * Injectable wall-clock source for deterministic testing.
   * Default: () => Date.now().
   */
  readonly nowFn?: () => number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LOAD_LIMIT = 200;

// ---------------------------------------------------------------------------
// KnowledgeManager
// ---------------------------------------------------------------------------

/**
 * Manages the long_term_knowledge storage tier.
 *
 * Usage:
 *   const km = new KnowledgeManager(storageProvider);
 *   await km.upsert(scope, { recordId: "...", key: "preference.verbosity", value: "...", ... });
 *   const records = await km.load(scope);
 */
export class KnowledgeManager {
  private readonly nowFn: () => number;

  constructor(
    private readonly provider: StorageProvider,
    options?: KnowledgeManagerOptions,
  ) {
    this.nowFn = options?.nowFn ?? (() => Date.now());
  }

  // ---------------------------------------------------------------------------
  // upsert()
  // ---------------------------------------------------------------------------

  /**
   * Persists a single KnowledgeRecord, overwriting any previous record with the
   * same key for this scope.
   *
   * The caller is responsible for constructing a fully-formed KnowledgeRecord
   * (including recordId, version, timestamps).  Use KnowledgeManager.merge()
   * when version-guarded batch writes are needed.
   */
  async upsert(scope: MemoryScope, record: KnowledgeRecord): Promise<void> {
    await this.provider.upsert(this._key(scope), record.key, record);
  }

  // ---------------------------------------------------------------------------
  // load()
  // ---------------------------------------------------------------------------

  /**
   * Returns all knowledge records for the scope, filtered and sorted.
   *
   * Expired records (expiresAt ≤ nowMs) are excluded by default.
   * Results are sorted by importance × confidence descending so callers
   * can evict from the tail when a token budget is exhausted.
   */
  async load(
    scope: MemoryScope,
    options: KnowledgeLoadOptions = {},
  ): Promise<readonly KnowledgeRecord[]> {
    const {
      includeExpired = false,
      categories,
      minConfidence = 0,
      limit = DEFAULT_LOAD_LIMIT,
    } = options;

    const nowMs = this.nowFn();

    const raw = await this.provider.list<KnowledgeRecord>(this._key(scope), {
      limit,
      order: "asc",
    });

    let results: KnowledgeRecord[] = [...raw];

    // Expiry filter
    if (!includeExpired) {
      results = results.filter(
        (r) => r.expiresAt === undefined || r.expiresAt === null || r.expiresAt > nowMs,
      );
    }

    // Category filter
    if (categories && categories.length > 0) {
      const catSet = new Set<string>(categories);
      results = results.filter((r) => catSet.has(r.category));
    }

    // Confidence floor
    if (minConfidence > 0) {
      results = results.filter((r) => r.confidence >= minConfidence);
    }

    // Sort by relevance weight (importance × confidence) descending
    results.sort(
      (a, b) => b.importance * b.confidence - a.importance * a.confidence,
    );

    return results;
  }

  // ---------------------------------------------------------------------------
  // remove()
  // ---------------------------------------------------------------------------

  /**
   * Removes a single record by key.
   *
   * Uses the read-filter-delete-reappend pattern (see StoragePruner M5):
   *   1. Read all records.
   *   2. Identify the record to remove.
   *   3. Delete the entire tier bucket.
   *   4. Re-upsert all survivors in insertion order.
   *
   * Returns true if the record was found and deleted, false if not found.
   *
   * This is an O(n) operation proportional to the total number of records.
   * Avoid in hot paths; it is intended for admin/correction flows.
   */
  async remove(scope: MemoryScope, key: string): Promise<boolean> {
    const storageKey = this._key(scope);

    const all = await this.provider.list<KnowledgeRecord>(storageKey, {
      limit: DEFAULT_LOAD_LIMIT,
      order: "asc",
    });

    const survivors = all.filter((r) => r.key !== key);
    if (survivors.length === all.length) {
      return false; // key not found — nothing changed
    }

    await this.provider.delete(storageKey);
    for (const record of survivors) {
      await this.provider.upsert(storageKey, record.key, record);
    }

    return true;
  }

  // ---------------------------------------------------------------------------
  // removeAll()
  // ---------------------------------------------------------------------------

  /**
   * Deletes all knowledge records for the given scope.
   * Suitable for GDPR "forget me" flows (called by MemoryManager.forget()).
   */
  async removeAll(scope: MemoryScope): Promise<void> {
    await this.provider.delete(this._key(scope));
  }

  // ---------------------------------------------------------------------------
  // merge()
  // ---------------------------------------------------------------------------

  /**
   * Version-guarded batch upsert.
   *
   * For each incoming record:
   *   - If no record with the same key exists → upsert.
   *   - If existing.version < incoming.version → upsert (newer knowledge wins).
   *   - If existing.version ≥ incoming.version → skip (do not overwrite).
   *
   * This lets callers safely re-run knowledge synthesis (e.g. after a conversation
   * summarization pass) without overwriting manually curated corrections.
   */
  async merge(
    scope: MemoryScope,
    records: readonly KnowledgeRecord[],
  ): Promise<MergeResult> {
    if (records.length === 0) return { upserted: 0, skipped: 0 };

    const storageKey = this._key(scope);

    const existing = await this.provider.list<KnowledgeRecord>(storageKey, {
      limit: DEFAULT_LOAD_LIMIT,
      order: "asc",
    });

    const existingByKey = new Map<string, KnowledgeRecord>(
      existing.map((r) => [r.key, r]),
    );

    let upserted = 0;
    let skipped  = 0;

    for (const incoming of records) {
      const stored = existingByKey.get(incoming.key);
      if (stored !== undefined && stored.version >= incoming.version) {
        skipped += 1;
        continue;
      }
      await this.provider.upsert(storageKey, incoming.key, incoming);
      upserted += 1;
    }

    return { upserted, skipped };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _key(scope: MemoryScope): StorageKey {
    return {
      tier:     "long_term_knowledge",
      tenantId: scope.tenantId,
      botId:    scope.botId,
      userId:   scope.userId,
    };
  }
}
