/**
 * Phase 3B — InMemoryStorageProvider (ADR-005, Milestone 6)
 *
 * A fully in-memory implementation of StorageProvider backed by Map.
 * Intended for:
 *   - Unit and integration tests (zero infrastructure required)
 *   - Local development without a Postgres/Redis connection
 *
 * Supports the full StorageProvider contract:
 *   read, list, write, append, upsert, delete, health
 *
 * Features:
 *   - Integer revision tracking (monotonically increasing per-provider counter)
 *   - ETag derived from revision + content hash (djb2)
 *   - Optimistic concurrency via WriteOptions.expectedRevision / expectedEtag
 *   - TTL expiry checked lazily on read
 *   - ScopePrefix-scoped bulk delete (forget() support)
 *
 * Must NOT be used in production — wire PostgresStorageProvider instead.
 */

import {
  type ListOptions,
  type ScopePrefix,
  type StorageKey,
  type StorageProvider,
  type WriteOptions,
  type WriteResult,
  WriteConflictError,
} from "../types.js";
import {
  type RelevanceScorer,
  TermOverlapRelevanceScorer,
} from "../relevance-scorer.js";

// ---------------------------------------------------------------------------
// Internal record shape
// ---------------------------------------------------------------------------

type RecordKind = "single" | "list" | "map";

interface InternalRecord {
  kind: RecordKind;
  /** single → T | list → T[] | map → Map<string, T> */
  value: unknown;
  revision: number;
  etag: string;
  updatedAt: number;
  /** Undefined means no TTL (persists forever). */
  expiresAt: number | undefined;
  /** Original StorageKey kept for ScopePrefix matching during delete. */
  originalKey: StorageKey;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Encode a StorageKey to a stable string map key. */
function encodeKey(key: StorageKey): string {
  return `${key.tier}:${key.tenantId}:${key.botId}:${key.userId}:${key.qualifier ?? ""}`;
}

/**
 * djb2-style non-cryptographic hash — good enough for etag discrimination.
 * Output is a hex string.
 */
function djb2Hash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
  }
  // >>> 0 converts to unsigned 32-bit int
  return (hash >>> 0).toString(16);
}

function makeEtag(revision: number, value: unknown): string {
  let serialised: string;
  try {
    serialised = JSON.stringify(value) ?? "";
  } catch {
    serialised = String(value);
  }
  return `${revision}-${djb2Hash(serialised)}`;
}

function toWriteResult(record: InternalRecord): WriteResult {
  return {
    revision: record.revision,
    etag: record.etag,
    updatedAt: record.updatedAt,
  };
}

function isExpired(record: InternalRecord, now: number): boolean {
  return record.expiresAt !== undefined && now >= record.expiresAt;
}

// ---------------------------------------------------------------------------
// Searchable string extraction
// ---------------------------------------------------------------------------

/**
 * Extracts a human-readable string from a stored value for relevance scoring.
 *
 * Priority heuristic (first match wins):
 *   1. ConversationTurn  → turn.content
 *   2. UserFact          → "<key> <value>"
 *   3. Plain string      → the string itself
 *   4. Any other object  → JSON.stringify (graceful fallback)
 *
 * Never throws — the RelevanceScorer must also be safe against bad input.
 */
function extractSearchableString(item: unknown): string {
  if (item === null || item === undefined) return "";
  if (typeof item === "string") return item;

  if (typeof item === "object") {
    const obj = item as Record<string, unknown>;

    // ConversationTurn: use the content field directly.
    if (typeof obj["content"] === "string") {
      return obj["content"];
    }

    // UserFact: combine key + value for richer matching.
    if (typeof obj["key"] === "string" && typeof obj["value"] === "string") {
      return `${obj["key"]} ${obj["value"]}`;
    }

    // Generic fallback: serialise the whole object.
    try {
      return JSON.stringify(item);
    } catch {
      return "";
    }
  }

  return String(item);
}

// ---------------------------------------------------------------------------
// InMemoryStorageProvider
// ---------------------------------------------------------------------------

export class InMemoryStorageProvider implements StorageProvider {
  private readonly store = new Map<string, InternalRecord>();
  /** Global monotonically-increasing revision counter shared across all keys. */
  private revision = 0;
  private readonly scorer: RelevanceScorer;

  /**
   * @param scorer Optional relevance scorer used when ListOptions.similarityQuery
   *   is present.  Defaults to TermOverlapRelevanceScorer (Jaccard coefficient).
   *   Pass a custom implementation to substitute BM25, embeddings, etc. without
   *   changing any other interface.
   */
  constructor(scorer?: RelevanceScorer) {
    this.scorer = scorer ?? new TermOverlapRelevanceScorer();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private nextRevision(): number {
    return ++this.revision;
  }

  /**
   * Retrieve an unexpired record, or null.
   * Lazily evicts expired records.
   */
  private getActive(encodedKey: string): InternalRecord | null {
    const record = this.store.get(encodedKey);
    if (!record) return null;
    if (isExpired(record, Date.now())) {
      this.store.delete(encodedKey);
      return null;
    }
    return record;
  }

  /**
   * Validate optimistic concurrency guards before any write.
   * Throws WriteConflictError when the guard fails.
   * - If no record exists yet, only `ifNotExists` guards are meaningful;
   *   revision/etag guards against a missing record always pass (first write).
   */
  private checkConcurrency(
    existing: InternalRecord | null,
    key: StorageKey,
    options: WriteOptions | undefined,
  ): void {
    if (!options) return;

    if (options.expectedRevision !== undefined) {
      const actual = existing?.revision ?? 0;
      if (actual !== options.expectedRevision) {
        throw new WriteConflictError(key, options.expectedRevision, actual);
      }
    } else if (options.expectedEtag !== undefined) {
      const actual = existing?.etag ?? "";
      if (actual !== options.expectedEtag) {
        // Provide the actual revision even for etag-based conflicts.
        throw new WriteConflictError(key, undefined, existing?.revision ?? 0);
      }
    }
  }

  // -------------------------------------------------------------------------
  // StorageProvider — reads
  // -------------------------------------------------------------------------

  async read<T>(key: StorageKey): Promise<T | null> {
    const record = this.getActive(encodeKey(key));
    if (!record) return null;

    switch (record.kind) {
      case "single":
        return record.value as T;
      case "map":
        // Return the map's entries as a plain object so callers typing
        // T as Record<string, V> get a usable value.
        return Object.fromEntries(record.value as Map<string, unknown>) as T;
      case "list":
        // Lists are read via list(), not read(). Return null.
        return null;
    }
  }

  async list<T>(key: StorageKey, options: ListOptions): Promise<T[]> {
    const record = this.getActive(encodeKey(key));
    if (!record) return [];

    let items: T[];

    switch (record.kind) {
      case "list":
        items = record.value as T[];
        break;
      case "map":
        // Return map values as an array — useful for reading all UserFacts.
        items = Array.from((record.value as Map<string, T>).values());
        break;
      case "single":
        return [];
    }

    // Apply before / after timestamp filters.
    // Assumes T may have an optional numeric `timestamp` field.
    if (options.before !== undefined || options.after !== undefined) {
      items = items.filter((item) => {
        const ts = (item as Record<string, unknown>)["timestamp"];
        if (typeof ts !== "number") return true; // pass through items without timestamps
        if (options.after !== undefined && ts <= options.after) return false;
        if (options.before !== undefined && ts >= options.before) return false;
        return true;
      });
    }

    // Relevance ranking (ADR-005 §13.1).
    // When similarityQuery is present, score each item and sort descending.
    // Ties preserve the current (insertion) order — Array.sort is stable in
    // V8/Node.js ≥ 11, so equal-scored items retain their relative positions.
    // When similarityQuery is absent, insertion-order behaviour is unchanged.
    if (options.similarityQuery) {
      const query = options.similarityQuery;
      const scored = items.map((item, insertionIndex) => ({
        item,
        insertionIndex,
        score: this.scorer.score(query, extractSearchableString(item)),
      }));
      // Sort descending by score; ties fall back to ascending insertion order.
      scored.sort((a, b) => {
        const diff = b.score - a.score;
        return diff !== 0 ? diff : a.insertionIndex - b.insertionIndex;
      });
      items = scored.map(({ item }) => item);
    } else {
      // Ordering: items are stored in insertion order (ascending).
      if (options.order === "desc") {
        items = [...items].reverse();
      }
    }

    return items.slice(0, options.limit);
  }

  // -------------------------------------------------------------------------
  // StorageProvider — writes
  // -------------------------------------------------------------------------

  async write<T>(key: StorageKey, value: T, options?: WriteOptions): Promise<WriteResult> {
    const encodedKey = encodeKey(key);
    const existing = this.getActive(encodedKey);

    // ifNotExists: return current record without writing if key already present.
    if (options?.ifNotExists && existing) {
      return toWriteResult(existing);
    }

    this.checkConcurrency(existing, key, options);

    const rev = this.nextRevision();
    const now = Date.now();
    const record: InternalRecord = {
      kind: "single",
      value,
      revision: rev,
      etag: makeEtag(rev, value),
      updatedAt: now,
      expiresAt: options?.ttlMs !== undefined ? now + options.ttlMs : undefined,
      originalKey: key,
    };
    this.store.set(encodedKey, record);
    return toWriteResult(record);
  }

  async append<T>(key: StorageKey, value: T, options?: WriteOptions): Promise<WriteResult> {
    const encodedKey = encodeKey(key);
    const existing = this.getActive(encodedKey);

    this.checkConcurrency(existing, key, options);

    // Preserve the previous list; if the existing record is not a list, start fresh.
    const currentList: T[] =
      existing?.kind === "list" ? (existing.value as T[]) : [];

    const newList = [...currentList, value];
    const rev = this.nextRevision();
    const now = Date.now();
    const record: InternalRecord = {
      kind: "list",
      value: newList,
      revision: rev,
      // Hash only the new list length + new item to keep hashing fast.
      etag: makeEtag(rev, newList.length),
      updatedAt: now,
      expiresAt: options?.ttlMs !== undefined ? now + options.ttlMs : undefined,
      originalKey: key,
    };
    this.store.set(encodedKey, record);
    return toWriteResult(record);
  }

  async upsert<T>(
    key: StorageKey,
    entryKey: string,
    value: T,
    options?: WriteOptions,
  ): Promise<WriteResult> {
    const encodedKey = encodeKey(key);
    const existing = this.getActive(encodedKey);

    this.checkConcurrency(existing, key, options);

    // Preserve the previous map; if the existing record is not a map, start fresh.
    const currentMap: Map<string, T> =
      existing?.kind === "map"
        ? new Map(existing.value as Map<string, T>)
        : new Map<string, T>();

    currentMap.set(entryKey, value);

    const rev = this.nextRevision();
    const now = Date.now();
    const record: InternalRecord = {
      kind: "map",
      value: currentMap,
      revision: rev,
      etag: makeEtag(rev, currentMap.size),
      updatedAt: now,
      expiresAt: options?.ttlMs !== undefined ? now + options.ttlMs : undefined,
      originalKey: key,
    };
    this.store.set(encodedKey, record);
    return toWriteResult(record);
  }

  async delete(key: StorageKey | ScopePrefix): Promise<void> {
    if ("tier" in key) {
      // Exact key delete.
      this.store.delete(encodeKey(key as StorageKey));
    } else {
      // Scope-prefix delete — erase every key belonging to this user.
      const prefix = key as ScopePrefix;
      const keysToDelete: string[] = [];
      for (const [encodedKey, record] of this.store) {
        const k = record.originalKey;
        if (
          k.tenantId === prefix.tenantId &&
          k.botId === prefix.botId &&
          k.userId === prefix.userId
        ) {
          keysToDelete.push(encodedKey);
        }
      }
      for (const k of keysToDelete) {
        this.store.delete(k);
      }
    }
  }

  async health(): Promise<"ok" | "degraded" | "unavailable"> {
    return "ok";
  }

  // -------------------------------------------------------------------------
  // Test / development helpers (not part of StorageProvider contract)
  // -------------------------------------------------------------------------

  /** Remove all records and reset the revision counter. */
  clear(): void {
    this.store.clear();
    this.revision = 0;
  }

  /** Total number of stored records (including potentially expired ones). */
  size(): number {
    return this.store.size;
  }

  /** Current global revision counter value. */
  currentRevision(): number {
    return this.revision;
  }
}
