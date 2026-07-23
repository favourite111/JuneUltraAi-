/**
 * Phase 3C — Long-Term Knowledge Foundation tests (Milestone 7)
 *
 * Covers:
 *   KnowledgeManager.upsert()
 *     - writes a record accessible via load()
 *     - overwrites an existing record with the same key
 *     - different keys coexist independently
 *
 *   KnowledgeManager.load()
 *     - returns empty array when no records exist
 *     - returns all non-expired records
 *     - excludes records where expiresAt ≤ nowMs (expired)
 *     - includes expired records when includeExpired: true
 *     - records with no expiresAt are never expired
 *     - filters by category
 *     - filters by minConfidence
 *     - respects limit option
 *     - sorts results by importance × confidence descending
 *
 *   KnowledgeManager.remove()
 *     - returns true when record is found and removed
 *     - returns false when key does not exist
 *     - surviving records are intact after removal
 *     - removing the only record leaves storage empty
 *
 *   KnowledgeManager.removeAll()
 *     - clears all records for the scope
 *     - a different scope is unaffected
 *
 *   KnowledgeManager.merge()
 *     - returns { upserted: 0, skipped: 0 } for empty input
 *     - upserts new records (no existing match)
 *     - upserts when incoming.version > stored.version
 *     - skips when incoming.version === stored.version
 *     - skips when incoming.version < stored.version
 *     - mixed batch: some upserted, some skipped
 *     - stored state reflects the merge outcome
 *
 *   MemoryManager integration
 *     - MemoryContext.knowledgeRecords populated from long_term_knowledge tier
 *     - MemoryUpdates.knowledgeRecords persisted via record()
 *     - expired records excluded from MemoryContext
 *     - MEMORY_CONTEXT_VERSION is 2
 */

import { describe, it, expect, beforeEach } from "vitest";
import { KnowledgeManager } from "../knowledge-manager.js";
import { InMemoryStorageProvider } from "../providers/in-memory-storage-provider.js";
import { DefaultMemoryManager } from "../memory-manager.js";
import {
  MEMORY_CONTEXT_VERSION,
  type KnowledgeRecord,
  type MemoryScope,
  type KnowledgeCategory,
} from "../types.js";
import { DEFAULT_CONTEXT_BUDGET } from "../types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NOW_MS = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SCOPE: MemoryScope = {
  tenantId: "t1",
  botId:    "b1",
  userId:   "u1",
  requestId: "req-1",
};

const SCOPE_OTHER: MemoryScope = {
  ...SCOPE,
  userId: "u2",
};

function makeRecord(
  n: number,
  overrides: Partial<KnowledgeRecord> = {},
): KnowledgeRecord {
  return {
    recordId:    `rec-${n}`,
    key:         `preference.item_${n}`,
    value:       `User prefers thing ${n}`,
    category:    "preference" as KnowledgeCategory,
    confidence:  0.8,
    importance:  0.7,
    source:      "conversation",
    tags:        [],
    createdAt:   NOW_MS,
    updatedAt:   NOW_MS,
    version:     1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let storage: InMemoryStorageProvider;
let km: KnowledgeManager;

beforeEach(() => {
  storage = new InMemoryStorageProvider();
  km = new KnowledgeManager(storage, { nowFn: () => NOW_MS });
});

// ---------------------------------------------------------------------------
// upsert()
// ---------------------------------------------------------------------------

describe("KnowledgeManager.upsert()", () => {
  it("writes a record that is then returned by load()", async () => {
    await km.upsert(SCOPE, makeRecord(1));
    const records = await km.load(SCOPE);
    expect(records).toHaveLength(1);
    expect(records[0]!.recordId).toBe("rec-1");
  });

  it("overwrites a record with the same key", async () => {
    await km.upsert(SCOPE, makeRecord(1, { value: "original" }));
    await km.upsert(SCOPE, makeRecord(1, { value: "updated", version: 2 }));
    const records = await km.load(SCOPE);
    expect(records).toHaveLength(1);
    expect(records[0]!.value).toBe("updated");
  });

  it("two records with different keys coexist", async () => {
    await km.upsert(SCOPE, makeRecord(1));
    await km.upsert(SCOPE, makeRecord(2, { key: "preference.item_2" }));
    const records = await km.load(SCOPE);
    expect(records).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// load()
// ---------------------------------------------------------------------------

describe("KnowledgeManager.load()", () => {
  it("returns empty array when no records exist", async () => {
    expect(await km.load(SCOPE)).toEqual([]);
  });

  it("returns all non-expired records", async () => {
    await km.upsert(SCOPE, makeRecord(1));
    await km.upsert(SCOPE, makeRecord(2, { key: "pref.2" }));
    expect(await km.load(SCOPE)).toHaveLength(2);
  });

  it("excludes records where expiresAt ≤ nowMs", async () => {
    await km.upsert(SCOPE, makeRecord(1, { expiresAt: NOW_MS - 1 }));  // expired
    await km.upsert(SCOPE, makeRecord(2, { key: "pref.2", expiresAt: NOW_MS + DAY_MS })); // fresh
    const records = await km.load(SCOPE);
    expect(records).toHaveLength(1);
    expect(records[0]!.recordId).toBe("rec-2");
  });

  it("treats expiresAt === nowMs as expired", async () => {
    await km.upsert(SCOPE, makeRecord(1, { expiresAt: NOW_MS })); // exactly at boundary → expired
    expect(await km.load(SCOPE)).toHaveLength(0);
  });

  it("includes expired records when includeExpired: true", async () => {
    await km.upsert(SCOPE, makeRecord(1, { expiresAt: NOW_MS - 1_000 }));
    const records = await km.load(SCOPE, { includeExpired: true });
    expect(records).toHaveLength(1);
  });

  it("records with no expiresAt are never filtered out", async () => {
    await km.upsert(SCOPE, makeRecord(1, { expiresAt: undefined }));
    await km.upsert(SCOPE, makeRecord(2, { key: "pref.2" /* expiresAt absent */ }));
    expect(await km.load(SCOPE)).toHaveLength(2);
  });

  it("filters by category", async () => {
    await km.upsert(SCOPE, makeRecord(1, { category: "preference" }));
    await km.upsert(SCOPE, makeRecord(2, { key: "f.2", category: "fact" }));
    await km.upsert(SCOPE, makeRecord(3, { key: "g.3", category: "goal" }));
    const prefs = await km.load(SCOPE, { categories: ["preference"] });
    expect(prefs).toHaveLength(1);
    expect(prefs[0]!.category).toBe("preference");
  });

  it("filters by minConfidence (inclusive)", async () => {
    await km.upsert(SCOPE, makeRecord(1, { confidence: 0.9 }));
    await km.upsert(SCOPE, makeRecord(2, { key: "pref.2", confidence: 0.5 }));
    await km.upsert(SCOPE, makeRecord(3, { key: "pref.3", confidence: 0.8 }));
    const records = await km.load(SCOPE, { minConfidence: 0.8 });
    expect(records).toHaveLength(2);
    for (const r of records) {
      expect(r.confidence).toBeGreaterThanOrEqual(0.8);
    }
  });

  it("respects the limit option", async () => {
    for (let i = 1; i <= 5; i++) {
      await km.upsert(SCOPE, makeRecord(i, { key: `pref.${i}` }));
    }
    const records = await km.load(SCOPE, { limit: 3 });
    expect(records.length).toBeLessThanOrEqual(3);
  });

  it("sorts results by importance × confidence descending", async () => {
    // rec-A: importance 0.9 × confidence 0.9 = 0.81
    // rec-B: importance 0.5 × confidence 0.5 = 0.25
    // rec-C: importance 0.8 × confidence 0.8 = 0.64
    await km.upsert(SCOPE, makeRecord(1, { key: "a", importance: 0.9, confidence: 0.9 }));
    await km.upsert(SCOPE, makeRecord(2, { key: "b", importance: 0.5, confidence: 0.5 }));
    await km.upsert(SCOPE, makeRecord(3, { key: "c", importance: 0.8, confidence: 0.8 }));

    const records = await km.load(SCOPE);
    expect(records[0]!.key).toBe("a"); // 0.81
    expect(records[1]!.key).toBe("c"); // 0.64
    expect(records[2]!.key).toBe("b"); // 0.25
  });
});

// ---------------------------------------------------------------------------
// remove()
// ---------------------------------------------------------------------------

describe("KnowledgeManager.remove()", () => {
  it("returns true when the record is found and removed", async () => {
    await km.upsert(SCOPE, makeRecord(1));
    expect(await km.remove(SCOPE, "preference.item_1")).toBe(true);
  });

  it("returns false when the key does not exist", async () => {
    expect(await km.remove(SCOPE, "no-such-key")).toBe(false);
  });

  it("surviving records remain intact after removal", async () => {
    await km.upsert(SCOPE, makeRecord(1));
    await km.upsert(SCOPE, makeRecord(2, { key: "pref.2" }));
    await km.upsert(SCOPE, makeRecord(3, { key: "pref.3" }));

    await km.remove(SCOPE, "pref.2");

    const remaining = await km.load(SCOPE);
    expect(remaining).toHaveLength(2);
    const keys = remaining.map((r) => r.key);
    expect(keys).toContain("preference.item_1");
    expect(keys).toContain("pref.3");
    expect(keys).not.toContain("pref.2");
  });

  it("removing the only record leaves storage empty", async () => {
    await km.upsert(SCOPE, makeRecord(1));
    await km.remove(SCOPE, "preference.item_1");
    expect(await km.load(SCOPE)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// removeAll()
// ---------------------------------------------------------------------------

describe("KnowledgeManager.removeAll()", () => {
  it("clears all records for the scope", async () => {
    await km.upsert(SCOPE, makeRecord(1));
    await km.upsert(SCOPE, makeRecord(2, { key: "pref.2" }));
    await km.removeAll(SCOPE);
    expect(await km.load(SCOPE)).toHaveLength(0);
  });

  it("does not affect a different scope", async () => {
    await km.upsert(SCOPE, makeRecord(1));
    await km.upsert(SCOPE_OTHER, makeRecord(2, { key: "pref.other" }));

    await km.removeAll(SCOPE);

    expect(await km.load(SCOPE)).toHaveLength(0);
    expect(await km.load(SCOPE_OTHER)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// merge()
// ---------------------------------------------------------------------------

describe("KnowledgeManager.merge()", () => {
  it("returns { upserted: 0, skipped: 0 } for an empty input array", async () => {
    const result = await km.merge(SCOPE, []);
    expect(result).toEqual({ upserted: 0, skipped: 0 });
  });

  it("upserts new records (no existing match)", async () => {
    const result = await km.merge(SCOPE, [makeRecord(1), makeRecord(2, { key: "pref.2" })]);
    expect(result.upserted).toBe(2);
    expect(result.skipped).toBe(0);
    expect(await km.load(SCOPE)).toHaveLength(2);
  });

  it("upserts when incoming.version > stored.version", async () => {
    await km.upsert(SCOPE, makeRecord(1, { version: 1, value: "old" }));
    const result = await km.merge(SCOPE, [makeRecord(1, { version: 2, value: "new" })]);
    expect(result.upserted).toBe(1);
    expect(result.skipped).toBe(0);
    const records = await km.load(SCOPE);
    expect(records[0]!.value).toBe("new");
  });

  it("skips when incoming.version === stored.version", async () => {
    await km.upsert(SCOPE, makeRecord(1, { version: 3, value: "current" }));
    const result = await km.merge(SCOPE, [makeRecord(1, { version: 3, value: "same-version" })]);
    expect(result.upserted).toBe(0);
    expect(result.skipped).toBe(1);
    const records = await km.load(SCOPE);
    expect(records[0]!.value).toBe("current"); // unchanged
  });

  it("skips when incoming.version < stored.version", async () => {
    await km.upsert(SCOPE, makeRecord(1, { version: 5, value: "newer" }));
    const result = await km.merge(SCOPE, [makeRecord(1, { version: 3, value: "older" })]);
    expect(result.upserted).toBe(0);
    expect(result.skipped).toBe(1);
    const records = await km.load(SCOPE);
    expect(records[0]!.value).toBe("newer"); // unchanged
  });

  it("handles a mixed batch (some upserted, some skipped)", async () => {
    await km.upsert(SCOPE, makeRecord(1, { version: 2, key: "k1" }));
    await km.upsert(SCOPE, makeRecord(2, { version: 5, key: "k2" }));

    const result = await km.merge(SCOPE, [
      makeRecord(1, { version: 3, key: "k1", value: "updated" }),  // v3 > v2 → upsert
      makeRecord(2, { version: 4, key: "k2", value: "stale" }),    // v4 < v5 → skip
      makeRecord(3, { version: 1, key: "k3", value: "brand new" }), // new → upsert
    ]);

    expect(result.upserted).toBe(2);
    expect(result.skipped).toBe(1);

    const records = await km.load(SCOPE);
    const byKey = new Map(records.map((r) => [r.key, r]));
    expect(byKey.get("k1")!.value).toBe("updated");
    expect(byKey.get("k2")!.value).not.toBe("stale");
    expect(byKey.get("k3")!.value).toBe("brand new");
  });
});

// ---------------------------------------------------------------------------
// MemoryManager integration (DefaultMemoryManager ↔ long_term_knowledge tier)
// ---------------------------------------------------------------------------

describe("MemoryManager integration", () => {
  const BUDGET = DEFAULT_CONTEXT_BUDGET;

  it("MEMORY_CONTEXT_VERSION is 2 (bumped for knowledgeRecords addition)", () => {
    expect(MEMORY_CONTEXT_VERSION).toBe(2);
  });

  it("MemoryContext.knowledgeRecords is populated from the long_term_knowledge tier", async () => {
    const provider = new InMemoryStorageProvider();
    const manager  = new DefaultMemoryManager(provider);
    const localKm  = new KnowledgeManager(provider, { nowFn: () => NOW_MS });

    await localKm.upsert(SCOPE, makeRecord(1, { importance: 0.9, confidence: 0.9 }));
    await localKm.upsert(SCOPE, makeRecord(2, { key: "fact.school", category: "fact", importance: 0.8, confidence: 0.8 }));

    const ctx = await manager.load(SCOPE, BUDGET);

    expect(ctx.knowledgeRecords).toHaveLength(2);
    // Sorted by importance × confidence desc: rec-1 (0.81) before fact.school (0.64)
    expect(ctx.knowledgeRecords[0]!.recordId).toBe("rec-1");
  });

  it("MemoryUpdates.knowledgeRecords persisted via DefaultMemoryManager.record()", async () => {
    const provider = new InMemoryStorageProvider();
    const manager  = new DefaultMemoryManager(provider);
    const localKm  = new KnowledgeManager(provider, { nowFn: () => NOW_MS });

    await manager.record(SCOPE, {
      knowledgeRecords: [
        makeRecord(1),
        makeRecord(2, { key: "context.project" }),
      ],
    });

    const stored = await localKm.load(SCOPE);
    expect(stored).toHaveLength(2);
  });

  it("expired records are excluded from MemoryContext.knowledgeRecords", async () => {
    const provider = new InMemoryStorageProvider();
    const manager  = new DefaultMemoryManager(provider);
    const localKm  = new KnowledgeManager(provider);

    // expiresAt = 1 second in the past (always expired regardless of when the test runs)
    const pastExpiry = Date.now() - 1_000;
    // expiresAt = 10 years in the future (always fresh)
    const futureExpiry = Date.now() + 10 * 365 * DAY_MS;

    await localKm.upsert(SCOPE, makeRecord(1, { expiresAt: pastExpiry }));
    await localKm.upsert(SCOPE, makeRecord(2, { key: "fresh", expiresAt: futureExpiry }));

    const ctx = await manager.load(SCOPE, BUDGET);

    const ids = ctx.knowledgeRecords.map((r) => r.recordId);
    expect(ids).not.toContain("rec-1");
    expect(ids).toContain("rec-2");
  });

  it("MemoryContext always contains a knowledgeRecords array (even when empty)", async () => {
    const provider = new InMemoryStorageProvider();
    const manager  = new DefaultMemoryManager(provider);
    const ctx = await manager.load(SCOPE, BUDGET);
    expect(Array.isArray(ctx.knowledgeRecords)).toBe(true);
    expect(ctx.knowledgeRecords).toHaveLength(0);
  });
});
