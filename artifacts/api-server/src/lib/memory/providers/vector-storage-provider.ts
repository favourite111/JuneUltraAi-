/**
 * Phase 3C — VectorStorageProvider (ADR-005, Milestone 8)
 *
 * A StorageProvider decorator that adds vector-similarity ranking to any
 * backing StorageProvider via an injected EmbeddingProvider.
 *
 * Architecture (ADR-005 §13.3):
 *   VectorStorageProvider wraps an inner StorageProvider (e.g.
 *   InMemoryStorageProvider for tests, PostgresStorageProvider for production).
 *   All write operations are forwarded to the inner provider AND update an
 *   in-memory vector index.  list() with ListOptions.similarityQuery uses the
 *   vector index to rank results by cosine similarity; list() without it
 *   delegates to the inner provider unchanged, preserving all existing ordering
 *   and pagination behaviour.
 *
 * Vector index structure:
 *   Two separate indices track the two append/upsert write paths:
 *     lists  — Map<encodedKey, Array<VectorEntry<T>>>
 *              Populated by append(). Preserves insertion order.
 *     maps   — Map<encodedKey, Map<entryKey, VectorEntry<T>>>
 *              Populated by upsert(). Keyed by entryKey.
 *
 *   read() / write() / delete() / health() all delegate to the inner
 *   provider; delete() additionally clears matching vector index entries.
 *
 * Limitations documented (intentional for Phase 3C):
 *   - Items written directly to the inner provider (bypassing this decorator)
 *     do not appear in vector-ranked results; insertion-order list() is
 *     unaffected.
 *   - The vector index is in-memory and is not persisted.  A future
 *     VectorPostgresProvider (ADR-006) will store vectors in pgvector columns.
 *   - write() (single-value) is not indexed because single-value keys hold
 *     structured objects (SessionMemory, etc.) not free-text for semantic search.
 *
 * similarityThreshold:
 *   When ListOptions.similarityThreshold is set, items whose cosine similarity
 *   is strictly below the threshold are excluded from the result.  This is the
 *   first consumer of the reserved ListOptions.similarityThreshold field
 *   (ADR-005 §13.1).
 */

import type {
  ListOptions,
  ScopePrefix,
  StorageKey,
  StorageProvider,
  WriteOptions,
  WriteResult,
} from "../types.js";
import {
  type EmbeddingProvider,
  HashingEmbeddingProvider,
  cosineSimilarity,
} from "../embedding-provider.js";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface VectorEntry<T> {
  item: T;
  vector: readonly number[];
}

// ---------------------------------------------------------------------------
// Key encoder — mirrors InMemoryStorageProvider's encodeKey for stable keys.
// ---------------------------------------------------------------------------

function encodeKey(key: StorageKey): string {
  return `${key.tier}:${key.tenantId}:${key.botId}:${key.userId}:${key.qualifier ?? ""}`;
}

// ---------------------------------------------------------------------------
// Searchable string extraction — mirrors InMemoryStorageProvider's helper.
// ---------------------------------------------------------------------------

function extractSearchableString(item: unknown): string {
  if (item === null || item === undefined) return "";
  if (typeof item === "string") return item;

  if (typeof item === "object") {
    const obj = item as Record<string, unknown>;
    // ConversationTurn: use the content field directly.
    if (typeof obj["content"] === "string") return obj["content"];
    // KnowledgeRecord / UserFact: combine key + value.
    if (typeof obj["key"] === "string" && typeof obj["value"] === "string") {
      return `${obj["key"]} ${obj["value"]}`;
    }
    try {
      return JSON.stringify(item);
    } catch {
      return "";
    }
  }
  return String(item);
}

// ---------------------------------------------------------------------------
// VectorStorageProvider
// ---------------------------------------------------------------------------

export class VectorStorageProvider implements StorageProvider {
  private readonly embedder: EmbeddingProvider;

  /**
   * Index for list-kind data (written via append()).
   * Entries are kept in insertion order so that list() without similarityQuery
   * delegates to inner and retains the correct ordering.
   */
  private readonly lists = new Map<string, VectorEntry<unknown>[]>();

  /**
   * Index for map-kind data (written via upsert()).
   * Keyed first by encodedStorageKey, then by entryKey.
   */
  private readonly maps = new Map<string, Map<string, VectorEntry<unknown>>>();

  /**
   * @param inner   The backing StorageProvider (InMemory, Postgres, etc.).
   * @param embedder Optional EmbeddingProvider.  Defaults to
   *                 HashingEmbeddingProvider (deterministic, offline).
   */
  constructor(
    private readonly inner: StorageProvider,
    embedder?: EmbeddingProvider,
  ) {
    this.embedder = embedder ?? new HashingEmbeddingProvider();
  }

  // -------------------------------------------------------------------------
  // StorageProvider — reads (delegate to inner)
  // -------------------------------------------------------------------------

  async read<T>(key: StorageKey): Promise<T | null> {
    return this.inner.read<T>(key);
  }

  /**
   * Returns items from the backing store when similarityQuery is absent.
   *
   * When similarityQuery IS present:
   *   1. Gather all indexed entries for this key (lists + maps).
   *   2. If the vector index is empty, fall back to inner.list() so that
   *      items written before this provider was wired are still reachable
   *      (with insertion-order ranking, not vector ranking).
   *   3. Embed the query, compute cosine similarity against each stored vector.
   *   4. Filter by similarityThreshold (default 0).
   *   5. Sort descending by score; ties preserve insertion order.
   *   6. Apply options.limit.
   */
  async list<T>(key: StorageKey, options: ListOptions): Promise<T[]> {
    if (!options.similarityQuery) {
      return this.inner.list<T>(key, options);
    }

    const encoded = encodeKey(key);

    // Gather all indexed entries: list-kind then map-kind.
    const listEntries: VectorEntry<unknown>[] = this.lists.get(encoded) ?? [];
    const mapEntries: VectorEntry<unknown>[] = [
      ...(this.maps.get(encoded) ?? new Map()).values(),
    ];

    const allEntries = [...listEntries, ...mapEntries];

    // Fallback: no vector data for this key (written before wiring, or never written).
    if (allEntries.length === 0) {
      return this.inner.list<T>(key, options);
    }

    const queryVector = await this.embedder.embed(options.similarityQuery);
    const threshold = options.similarityThreshold ?? 0;

    const scored = allEntries
      .map((entry, insertionIndex) => ({
        item:           entry.item as T,
        score:          cosineSimilarity(queryVector, entry.vector),
        insertionIndex,
      }))
      .filter((s) => s.score >= threshold);

    // Sort descending by score; equal scores fall back to ascending insertion order.
    scored.sort((a, b) => {
      const diff = b.score - a.score;
      return diff !== 0 ? diff : a.insertionIndex - b.insertionIndex;
    });

    return scored.slice(0, options.limit).map((s) => s.item);
  }

  // -------------------------------------------------------------------------
  // StorageProvider — writes (forward to inner + update vector index)
  // -------------------------------------------------------------------------

  /**
   * Appends a new entry to a time-ordered list AND adds its embedding to the
   * list vector index.
   */
  async append<T>(key: StorageKey, value: T, options?: WriteOptions): Promise<WriteResult> {
    const result = await this.inner.append<T>(key, value, options);

    const encoded = encodeKey(key);
    const vector = await this.embedder.embed(extractSearchableString(value));

    const entries = this.lists.get(encoded);
    if (entries) {
      entries.push({ item: value, vector });
    } else {
      this.lists.set(encoded, [{ item: value, vector }]);
    }

    return result;
  }

  /**
   * Upserts a keyed entry within a map AND updates its embedding in the map
   * vector index.
   */
  async upsert<T>(
    key: StorageKey,
    entryKey: string,
    value: T,
    options?: WriteOptions,
  ): Promise<WriteResult> {
    const result = await this.inner.upsert<T>(key, entryKey, value, options);

    const encoded = encodeKey(key);
    const vector = await this.embedder.embed(extractSearchableString(value));

    const mapIndex = this.maps.get(encoded);
    if (mapIndex) {
      mapIndex.set(entryKey, { item: value, vector });
    } else {
      this.maps.set(encoded, new Map([[entryKey, { item: value, vector }]]));
    }

    return result;
  }

  /**
   * Single-value writes are forwarded to the inner provider unchanged.
   * Single-value keys (SessionMemory, etc.) are structured objects not
   * intended for semantic search; we do not index them.
   */
  async write<T>(key: StorageKey, value: T, options?: WriteOptions): Promise<WriteResult> {
    return this.inner.write<T>(key, value, options);
  }

  // -------------------------------------------------------------------------
  // StorageProvider — delete (delegate + clear vector index)
  // -------------------------------------------------------------------------

  /**
   * Deletes entries from the inner provider AND removes the corresponding
   * vector index entries so that the two stores remain consistent.
   *
   * Exact key delete — clears list and map indices for the encoded key.
   * ScopePrefix delete — clears all index entries whose original key matches
   *   the prefix (tenantId + botId + userId).
   */
  async delete(key: StorageKey | ScopePrefix): Promise<void> {
    await this.inner.delete(key);

    if ("tier" in key) {
      // Exact StorageKey delete.
      const encoded = encodeKey(key as StorageKey);
      this.lists.delete(encoded);
      this.maps.delete(encoded);
    } else {
      // ScopePrefix delete — erase every indexed entry matching the prefix.
      const prefix = key as ScopePrefix;
      const predicate = (encoded: string): boolean => {
        // encodedKey format: "tier:tenantId:botId:userId:qualifier"
        const parts = encoded.split(":");
        return (
          parts[1] === prefix.tenantId &&
          parts[2] === prefix.botId &&
          parts[3] === prefix.userId
        );
      };

      for (const k of [...this.lists.keys()]) {
        if (predicate(k)) this.lists.delete(k);
      }
      for (const k of [...this.maps.keys()]) {
        if (predicate(k)) this.maps.delete(k);
      }
    }
  }

  // -------------------------------------------------------------------------
  // StorageProvider — health (delegate)
  // -------------------------------------------------------------------------

  async health(): Promise<"ok" | "degraded" | "unavailable"> {
    return this.inner.health();
  }

  // -------------------------------------------------------------------------
  // Test / development helpers (not part of StorageProvider contract)
  // -------------------------------------------------------------------------

  /** Number of list-kind entries currently in the vector index for a key. */
  listIndexSize(key: StorageKey): number {
    return this.lists.get(encodeKey(key))?.length ?? 0;
  }

  /** Number of map-kind entries currently in the vector index for a key. */
  mapIndexSize(key: StorageKey): number {
    return this.maps.get(encodeKey(key))?.size ?? 0;
  }

  /** Total indexed entry count across both list and map indices. */
  totalIndexSize(): number {
    let total = 0;
    for (const v of this.lists.values()) total += v.length;
    for (const m of this.maps.values()) total += m.size;
    return total;
  }
}
