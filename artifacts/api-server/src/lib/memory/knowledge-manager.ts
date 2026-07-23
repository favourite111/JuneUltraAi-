/**
 * Phase 3C — Knowledge lifecycle and retrieval orchestration
 *
 * KnowledgeManager owns the long-term knowledge lifecycle and orchestrates the
 * injected embedding and vector-storage abstractions. It is not intelligent:
 * it prepares deterministic source text, delegates embedding, and coordinates
 * persistence and retrieval.
 *
 * Design constraints:
 *   - Purely deterministic apart from injected provider I/O.
 *   - Uses the existing StorageProvider contract without modifications.
 *   - Upsert is keyed by KnowledgeRecord.key (same pattern as UserFact in the
 *     user_profile tier).
 *   - merge() is version-guarded: incoming records only overwrite stored ones when
 *     incoming.version > stored.version.
 *   - remove() uses the read-filter-delete-reappend pattern established in M5.
 *   - load() filters expired records by default (records where expiresAt ≤ nowMs).
 *   - Retrieval ordering is owned by KnowledgeManager; vector indexes remain
 *     derived and disposable.
 */

import { createHash } from "node:crypto";
import type {
  KnowledgeCategory,
  KnowledgeRecord,
  MemoryScope,
  StorageKey,
  StorageProvider,
} from "./types.js";
import type { EmbeddingProvider } from "./embedding-provider.js";
import { tokenise } from "./relevance-scorer.js";
import type {
  VectorIndexEntry,
  VectorSearchOptions,
  VectorStorageProviderContract,
} from "./providers/vector-storage-provider.js";

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
  /**
   * Text-to-vector provider. Concrete implementations are selected by the
   * composition root and never imported by KnowledgeManager.
   */
  readonly embeddingProvider?: EmbeddingProvider;
  /**
   * Derived vector index. It receives vectors, never source text.
   */
  readonly vectorStorageProvider?: VectorStorageProviderContract;
}

export interface KnowledgeRelevantOptions extends KnowledgeLoadOptions {
  readonly similarityThreshold?: number;
}

export type KnowledgeVectorDrift =
  | "missing-vector"
  | "pending-vector"
  | "stale-vector"
  | "orphaned-vector"
  | "invalid-vector";

export interface KnowledgeIndexReport {
  readonly scope: MemoryScope;
  readonly missing: readonly string[];
  readonly pending: readonly string[];
  readonly stale: readonly string[];
  readonly orphaned: readonly string[];
  readonly invalid: readonly string[];
  readonly repaired: readonly string[];
  readonly deleted: readonly string[];
  readonly dryRun: boolean;
}

export interface KnowledgeReconcileOptions {
  readonly scope: MemoryScope;
  readonly batchSize?: number;
  readonly dryRun?: boolean;
}

export const KNOWLEDGE_INDEX_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LOAD_LIMIT = 200;
const DEFAULT_RECONCILE_BATCH_SIZE = 50;

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
  private readonly embeddingProvider?: EmbeddingProvider;
  private readonly vectorStorageProvider?: VectorStorageProviderContract;
  // TODO(Milestone 12): persist pending-vector state for cross-process repair.
  private readonly pendingVectors = new Map<string, KnowledgeVectorDrift>();

  constructor(
    private readonly provider: StorageProvider,
    options?: KnowledgeManagerOptions,
  ) {
    this.nowFn = options?.nowFn ?? (() => Date.now());
    this.embeddingProvider = options?.embeddingProvider;
    this.vectorStorageProvider = options?.vectorStorageProvider;
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

    if (this.embeddingProvider && this.vectorStorageProvider) {
      try {
        await this.indexRecord(scope, record);
        this.pendingVectors.delete(scopedRecordKey(scope, record.key));
      } catch (error) {
        this.pendingVectors.set(
          scopedRecordKey(scope, record.key),
          "pending-vector",
        );
        throw error;
      }
    }
  }

  /**
   * Reports and optionally repairs drift in the derived vector index.
   *
   * Repair only changes derived vectors: authoritative knowledge is never
   * overwritten or deleted by this operation.
   */
  async reconcile(options: KnowledgeReconcileOptions): Promise<KnowledgeIndexReport> {
    const { scope, dryRun = false } = options;
    const batchSize = normalizeBatchSize(options.batchSize);
    const vectorProvider = this.vectorStorageProvider;
    if (!this.embeddingProvider || !vectorProvider) {
      throw new Error("Knowledge index reconciliation requires embedding and vector providers");
    }
    if (!vectorProvider.listVectors) {
      throw new Error("Vector provider does not support index inspection");
    }

    const [records, vectors] = await Promise.all([
      this.provider.list<KnowledgeRecord>(this._key(scope), {
        limit: DEFAULT_LOAD_LIMIT,
        order: "asc",
      }),
      vectorProvider.listVectors(scope),
    ]);
    const recordsByKey = new Map(records.map((record) => [record.key, record]));
    const vectorsByKey = new Map(vectors.map((vector) => [vector.sourceId, vector]));
    const missing: string[] = [];
    const pending: string[] = [];
    const stale: string[] = [];
    const invalid: string[] = [];
    const orphaned = vectors
      .filter((vector) => !recordsByKey.has(vector.sourceId))
      .map((vector) => vector.sourceId);

    for (const record of records) {
      const identity = scopedRecordKey(scope, record.key);
      const vector = vectorsByKey.get(record.key);
      if (this.pendingVectors.has(identity)) {
        pending.push(record.key);
      } else if (!vector) {
        missing.push(record.key);
      } else if (this.isInvalidVector(vector)) {
        invalid.push(record.key);
      } else if (!this.isCurrentVector(record, vector)) {
        stale.push(record.key);
      }
    }

    const repairCandidates = [...missing, ...pending, ...stale, ...invalid]
      .slice(0, batchSize);
    const repaired: string[] = [];
    const deleted: string[] = [];

    if (!dryRun) {
      for (const key of repairCandidates) {
        const record = recordsByKey.get(key);
        if (!record) continue;
        try {
          await this.indexRecord(scope, record);
          this.pendingVectors.delete(scopedRecordKey(scope, key));
          repaired.push(key);
        } catch {
          this.pendingVectors.set(scopedRecordKey(scope, key), "pending-vector");
        }
      }
      for (const key of orphaned.slice(0, Math.max(0, batchSize - repaired.length))) {
        await vectorProvider.deleteVector(scope, key);
        this.pendingVectors.delete(scopedRecordKey(scope, key));
        deleted.push(key);
      }
    }

    return {
      scope,
      missing,
      pending,
      stale,
      orphaned,
      invalid,
      repaired,
      deleted,
      dryRun,
    };
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

  /**
   * Loads knowledge ranked by semantic similarity when vector dependencies are
   * injected. Without them, it falls back to the deterministic knowledge
   * ordering used by the original storage-only manager.
   */
  async loadRelevant(
    scope: MemoryScope,
    query: string | undefined,
    options: KnowledgeRelevantOptions = {},
  ): Promise<readonly KnowledgeRecord[]> {
    if (!query) {
      return this.load(scope, options);
    }

    // Both branches start together. The deterministic branch is authoritative
    // and therefore also determines which semantic results can be hydrated.
    const [deterministicResult, semanticResult] = await Promise.allSettled([
      this.loadDeterministic(scope, query, options),
      this.loadSemantic(scope, query, options),
    ]);

    // If authoritative storage failed, vector metadata cannot be returned as
    // knowledge records. A derived index must never become the source of truth.
    if (deterministicResult.status !== "fulfilled") return [];

    const deterministic = deterministicResult.value;
    const semantic = semanticResult.status === "fulfilled" ? semanticResult.value : [];
    const seen = new Set(
      deterministic.map((record) => scopedRecordKey(scope, record.key)),
    );
    const merged = [...deterministic];

    // VectorStorageProvider already returns semantic candidates in descending
    // score order. Semantic ordering is used only for semantic-only records.
    for (const record of semantic) {
      const identity = scopedRecordKey(scope, record.key);
      if (!seen.has(identity)) {
        seen.add(identity);
        merged.push(record);
      }
    }

    return merged.slice(0, options.limit ?? DEFAULT_LOAD_LIMIT);
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
    await this.vectorStorageProvider?.deleteVector(scope, key);
    this.pendingVectors.delete(scopedRecordKey(scope, key));

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
    await this.vectorStorageProvider?.deleteScope(scope);
    for (const identity of this.pendingVectors.keys()) {
      if (identity.startsWith(`${scope.tenantId}\u0000${scope.botId}\u0000${scope.userId}\u0000`)) {
        this.pendingVectors.delete(identity);
      }
    }
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
      await this.upsert(scope, incoming);
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

  /**
   * Deterministic retrieval branch.
   *
   * Exact key matches outrank exact value/phrase matches, which outrank
   * deterministic token matches. Importance × confidence is only a
   * tie-breaker inside the same deterministic class.
   */
  private async loadDeterministic(
    scope: MemoryScope,
    query: string,
    options: KnowledgeRelevantOptions,
  ): Promise<readonly KnowledgeRecord[]> {
    const records = await this.loadFiltered(scope, options);
    const normalizedQuery = normalizeText(query);
    const queryTokens = tokenise(query);

    if (!normalizedQuery || queryTokens.size === 0) return [];

    const candidates = records.flatMap((record, insertionIndex) => {
      const key = normalizeText(record.key);
      const value = normalizeText(record.value);
      const exactKey = key === normalizedQuery;
      const exactValue = value.includes(normalizedQuery);
      const recordTokens = tokenise(`${record.key} ${record.value}`);
      let overlap = 0;
      for (const token of queryTokens) {
        if (recordTokens.has(token)) overlap += 1;
      }

      if (!exactKey && !exactValue && overlap === 0) return [];

      return [{
        record,
        matchClass: exactKey ? 0 : exactValue ? 1 : 2,
        overlap,
        weight: record.importance * record.confidence,
        insertionIndex,
      }];
    });

    candidates.sort((left, right) =>
      left.matchClass - right.matchClass ||
      right.overlap - left.overlap ||
      right.weight - left.weight ||
      left.insertionIndex - right.insertionIndex,
    );

    return candidates
      .slice(0, options.limit ?? DEFAULT_LOAD_LIMIT)
      .map(({ record }) => record);
  }

  /**
   * Semantic retrieval branch. It returns authoritative records in vector
   * score order and returns no results when the derived branch is unavailable.
   */
  private async loadSemantic(
    scope: MemoryScope,
    query: string,
    options: KnowledgeRelevantOptions,
  ): Promise<readonly KnowledgeRecord[]> {
    if (!this.embeddingProvider || !this.vectorStorageProvider) return [];

    const queryVector = await this.embeddingProvider.embed(query);
    this.validateDimensions(queryVector);

    const vectorOptions: VectorSearchOptions = {
      limit: options.limit ?? DEFAULT_LOAD_LIMIT,
      similarityThreshold: options.similarityThreshold,
    };
    const matches = await this.vectorStorageProvider.searchVectors(
      scope,
      queryVector,
      vectorOptions,
    );
    if (matches.length === 0) return [];

    const records = await this.loadFiltered(scope, options);
    const recordsByKey = new Map(records.map((record) => [record.key, record]));

    return matches
      .map((match) => recordsByKey.get(match.sourceId))
      .filter((record): record is KnowledgeRecord => record !== undefined);
  }

  private async loadFiltered(
    scope: MemoryScope,
    options: KnowledgeLoadOptions,
  ): Promise<KnowledgeRecord[]> {
    const raw = await this.provider.list<KnowledgeRecord>(this._key(scope), {
      limit: DEFAULT_LOAD_LIMIT,
      order: "asc",
    });
    const nowMs = this.nowFn();
    const categories = options.categories ? new Set(options.categories) : undefined;
    const minConfidence = options.minConfidence ?? 0;

    return raw.filter((record) =>
      (options.includeExpired ||
        record.expiresAt === undefined ||
        record.expiresAt === null ||
        record.expiresAt > nowMs) &&
      (categories === undefined || categories.has(record.category)) &&
      record.confidence >= minConfidence,
    );
  }

  private embeddingText(record: KnowledgeRecord): string {
    return `${record.key} ${record.value}`;
  }

  private async indexRecord(scope: MemoryScope, record: KnowledgeRecord): Promise<void> {
    if (!this.embeddingProvider || !this.vectorStorageProvider) return;
    const text = this.embeddingText(record);
    const vector = await this.embeddingProvider.embed(text);
    this.validateDimensions(vector);
    await this.vectorStorageProvider.upsertVector(scope, record.key, vector, {
      key: record.key,
      version: record.version,
      contentFingerprint: this.contentFingerprint(record),
      indexSchemaVersion: KNOWLEDGE_INDEX_SCHEMA_VERSION,
      providerId: this.embeddingProvider.providerId ?? "unspecified",
      modelId: this.embeddingProvider.modelId ?? "unspecified",
      dimensions: this.embeddingProvider.dimensions,
      lifecycleState: "indexed",
      indexedAt: this.nowFn(),
    });
  }

  private isInvalidVector(vector: VectorIndexEntry): boolean {
    const metadata = vector.metadata;
    return (
      vector.dimensions !== this.embeddingProvider?.dimensions ||
      metadata.indexSchemaVersion !== KNOWLEDGE_INDEX_SCHEMA_VERSION ||
      metadata.providerId !== (this.embeddingProvider?.providerId ?? "unspecified") ||
      metadata.modelId !== (this.embeddingProvider?.modelId ?? "unspecified") ||
      metadata.dimensions !== this.embeddingProvider?.dimensions
    );
  }

  private isCurrentVector(
    record: KnowledgeRecord,
    vector: VectorIndexEntry,
  ): boolean {
    return (
      vector.metadata.contentFingerprint === this.contentFingerprint(record) &&
      vector.metadata.lifecycleState === "indexed"
    );
  }

  private contentFingerprint(record: KnowledgeRecord): string {
    const canonical = canonicalizeKnowledgeRecord(record);
    return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
  }

  private validateDimensions(vector: readonly number[]): void {
    if (
      this.embeddingProvider &&
      vector.length !== this.embeddingProvider.dimensions
    ) {
      throw new RangeError(
        `Embedding dimension mismatch: expected ${this.embeddingProvider.dimensions}, received ${vector.length}`,
      );
    }
  }
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function scopedRecordKey(scope: MemoryScope, recordKey: string): string {
  return [
    scope.tenantId,
    scope.botId,
    scope.userId,
    recordKey,
  ].join("\u0000");
}

function normalizeBatchSize(value: number | undefined): number {
  if (value === undefined) return DEFAULT_RECONCILE_BATCH_SIZE;
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`batchSize must be a positive integer; got ${value}`);
  }
  return value;
}

function canonicalizeKnowledgeRecord(
  record: KnowledgeRecord,
): Record<string, unknown> {
  return {
    category: record.category,
    confidence: record.confidence,
    importance: record.importance,
    key: record.key,
    source: record.source,
    tags: [...record.tags].sort(),
    value: record.value,
    version: record.version,
  };
}
