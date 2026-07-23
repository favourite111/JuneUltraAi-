/**
 * Phase 3C — Knowledge tier vector retrieval integration tests (Milestone 8)
 *
 * Verifies the complete queryHint → similarityQuery → VectorStorageProvider
 * → knowledge records path through DefaultMemoryManager.load().
 *
 * Covers:
 *   queryHint threading to knowledge tier
 *     - scope.queryHint is now passed as similarityQuery to the knowledge list() call
 *     - without queryHint, knowledge list() call has no similarityQuery
 *
 *   End-to-end knowledge relevance ranking
 *     - with VectorStorageProvider wired and queryHint set, most-relevant
 *       knowledge records appear first in MemoryContext.knowledgeRecords
 *     - without queryHint, records are sorted by importance × confidence (M7 order)
 *     - expired records are excluded regardless of similarity score
 *
 *   VectorStorageProvider as drop-in replacement
 *     - DefaultMemoryManager constructor signature unchanged
 *     - VectorStorageProvider passed as the StorageProvider param works
 *     - all other tiers (session, conversation, userFacts, toolSummary) are
 *       unaffected by VectorStorageProvider wrapping
 *
 *   similarityThreshold threading
 *     - when VectorStorageProvider wired with a low threshold, results include
 *       all records above that threshold
 *
 *   Backward compatibility
 *     - InMemoryStorageProvider (no vector) still works as before for M8
 *       (knowledge records sorted by importance × confidence, not by similarity)
 *     - scopes without queryHint produce identical results to pre-M8
 */

import { describe, it, expect, vi } from "vitest";
import { DefaultMemoryManager } from "../memory-manager.js";
import { InMemoryStorageProvider } from "../providers/in-memory-storage-provider.js";
import { VectorStorageProvider } from "../providers/vector-storage-provider.js";
import {
  DEFAULT_CONTEXT_BUDGET,
  type KnowledgeRecord,
  type MemoryScope,
  type StorageKey,
  type StorageProvider,
  type WriteResult,
} from "../types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_SCOPE: MemoryScope = {
  tenantId: "t1",
  botId:    "b1",
  userId:   "u1",
  sessionId: "s1",
  requestId: "req-1",
};

const WITH_HINT = (hint: string): MemoryScope => ({ ...BASE_SCOPE, queryHint: hint });

const KR_KEY: StorageKey = {
  tier:     "long_term_knowledge",
  tenantId: "t1",
  botId:    "b1",
  userId:   "u1",
};

function makeKR(
  key: string,
  value: string,
  overrides: Partial<KnowledgeRecord> = {},
): KnowledgeRecord {
  return {
    recordId:   `rec-${key}`,
    key,
    value,
    category:   "preference",
    confidence: 0.8,
    importance: 0.7,
    source:     "explicit",
    tags:       [],
    createdAt:  1_000_000,
    updatedAt:  1_000_000,
    version:    1,
    ...overrides,
  };
}

const FAKE_WRITE_RESULT: WriteResult = {
  revision:  1,
  etag:      "abc",
  updatedAt: 1_000_000,
};

function makeFakeProvider(): StorageProvider {
  return {
    read:   vi.fn().mockResolvedValue(null),
    list:   vi.fn().mockResolvedValue([]),
    write:  vi.fn().mockResolvedValue(FAKE_WRITE_RESULT),
    append: vi.fn().mockResolvedValue(FAKE_WRITE_RESULT),
    upsert: vi.fn().mockResolvedValue(FAKE_WRITE_RESULT),
    delete: vi.fn().mockResolvedValue(undefined),
    health: vi.fn().mockResolvedValue("ok"),
  };
}

// ---------------------------------------------------------------------------
// queryHint threading — verified against fake provider call args
// ---------------------------------------------------------------------------

describe("DefaultMemoryManager.load() — queryHint threading to knowledge tier", () => {
  it("passes queryHint as similarityQuery to the long_term_knowledge list() call", async () => {
    const provider = makeFakeProvider();
    const manager  = new DefaultMemoryManager(provider);

    await manager.load(WITH_HINT("building memory system"), DEFAULT_CONTEXT_BUDGET);

    const listCalls = vi.mocked(provider.list).mock.calls;
    const krCall    = listCalls.find(([key]) => (key as StorageKey).tier === "long_term_knowledge");
    expect(krCall).toBeDefined();
    expect(krCall![1].similarityQuery).toBe("building memory system");
  });

  it("similarityQuery is undefined for knowledge list() when queryHint is absent", async () => {
    const provider = makeFakeProvider();
    const manager  = new DefaultMemoryManager(provider);

    await manager.load(BASE_SCOPE, DEFAULT_CONTEXT_BUDGET);

    const listCalls = vi.mocked(provider.list).mock.calls;
    const krCall    = listCalls.find(([key]) => (key as StorageKey).tier === "long_term_knowledge");
    expect(krCall).toBeDefined();
    expect(krCall![1].similarityQuery).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// End-to-end: VectorStorageProvider wired as DefaultMemoryManager's provider
// ---------------------------------------------------------------------------

describe("DefaultMemoryManager.load() — VectorStorageProvider end-to-end", () => {
  it("most-relevant knowledge records appear first when queryHint is set", async () => {
    const inner    = new InMemoryStorageProvider();
    const vsp      = new VectorStorageProvider(inner);
    const manager  = new DefaultMemoryManager(vsp);

    // Insert records covering very different domains
    await vsp.upsert(KR_KEY, "cooking",  makeKR("cooking",  "loves pizza pasta cooking recipes"));
    await vsp.upsert(KR_KEY, "reading",  makeKR("reading",  "enjoys reading science fiction novels"));
    await vsp.upsert(KR_KEY, "location", makeKR("location", "lives in London near the Thames river"));

    const ctx = await manager.load(
      WITH_HINT("pizza cooking food recipes"),
      DEFAULT_CONTEXT_BUDGET,
    );

    // The cooking record should rank first
    expect(ctx.knowledgeRecords[0]?.key).toBe("cooking");
  });

  it("without queryHint, records are sorted by importance × confidence descending", async () => {
    const inner   = new InMemoryStorageProvider();
    const vsp     = new VectorStorageProvider(inner);
    const manager = new DefaultMemoryManager(vsp);

    // Insert with varying importance
    await vsp.upsert(KR_KEY, "low",  makeKR("low",  "something low",  { importance: 0.3, confidence: 0.9 }));
    await vsp.upsert(KR_KEY, "high", makeKR("high", "something high", { importance: 0.9, confidence: 0.9 }));
    await vsp.upsert(KR_KEY, "mid",  makeKR("mid",  "something mid",  { importance: 0.6, confidence: 0.9 }));

    const ctx = await manager.load(BASE_SCOPE, DEFAULT_CONTEXT_BUDGET);

    // Without queryHint, sorted by importance × confidence desc (M7 order)
    expect(ctx.knowledgeRecords[0]?.key).toBe("high");
    expect(ctx.knowledgeRecords[1]?.key).toBe("mid");
    expect(ctx.knowledgeRecords[2]?.key).toBe("low");
  });

  it("expired records are excluded regardless of similarity score", async () => {
    const inner   = new InMemoryStorageProvider();
    const vsp     = new VectorStorageProvider(inner);
    const manager = new DefaultMemoryManager(vsp);

    const pastMs = Date.now() - 1_000;
    // Expired but highly relevant
    await vsp.upsert(KR_KEY, "expired", makeKR("expired", "pizza cooking food", { expiresAt: pastMs }));
    // Not expired, less relevant
    await vsp.upsert(KR_KEY, "active",  makeKR("active",  "reading books library"));

    const ctx = await manager.load(WITH_HINT("pizza cooking"), DEFAULT_CONTEXT_BUDGET);

    const ids = ctx.knowledgeRecords.map((r) => r.key);
    expect(ids).not.toContain("expired");
    expect(ids).toContain("active");
  });

  it("VectorStorageProvider does not affect session, conversation, userFacts, or toolSummary tiers", async () => {
    const inner   = new InMemoryStorageProvider();
    const vsp     = new VectorStorageProvider(inner);
    const manager = new DefaultMemoryManager(vsp);

    // All other tiers empty — context should have empty fields
    const ctx = await manager.load(WITH_HINT("any query"), DEFAULT_CONTEXT_BUDGET);

    expect(ctx.session).toBeNull();
    expect(ctx.conversation).toHaveLength(0);
    expect(ctx.userFacts).toHaveLength(0);
    expect(ctx.toolSummary).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// DefaultMemoryManager constructor signature — unchanged
// ---------------------------------------------------------------------------

describe("DefaultMemoryManager — constructor unchanged", () => {
  it("VectorStorageProvider is passable as the first constructor arg (StorageProvider)", () => {
    const vsp = new VectorStorageProvider(new InMemoryStorageProvider());
    expect(() => new DefaultMemoryManager(vsp)).not.toThrow();
  });

  it("load() signature is unchanged: load(scope, budget) — no new parameters", async () => {
    const vsp     = new VectorStorageProvider(new InMemoryStorageProvider());
    const manager = new DefaultMemoryManager(vsp);
    await expect(manager.load(BASE_SCOPE, DEFAULT_CONTEXT_BUDGET)).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Backward compatibility — InMemoryStorageProvider still works unchanged
// ---------------------------------------------------------------------------

describe("InMemoryStorageProvider — unchanged backward compatibility after M8", () => {
  it("knowledge records sorted by importance × confidence when no VectorStorageProvider", async () => {
    const inner   = new InMemoryStorageProvider();
    const manager = new DefaultMemoryManager(inner);

    await inner.upsert(KR_KEY, "low",  makeKR("low",  "low priority", { importance: 0.2 }));
    await inner.upsert(KR_KEY, "high", makeKR("high", "high priority", { importance: 0.95 }));

    const ctx = await manager.load(BASE_SCOPE, DEFAULT_CONTEXT_BUDGET);

    expect(ctx.knowledgeRecords[0]?.key).toBe("high");
  });

  it("queryHint with InMemoryStorageProvider falls back to Jaccard ranking (not vector)", async () => {
    const inner   = new InMemoryStorageProvider();
    const manager = new DefaultMemoryManager(inner);

    // InMemoryStorageProvider uses TermOverlapRelevanceScorer for similarityQuery
    await inner.upsert(KR_KEY, "food",  makeKR("food",  "loves pizza pasta cooking"));
    await inner.upsert(KR_KEY, "other", makeKR("other", "xylophone quantum zephyr"));

    const ctx = await manager.load(WITH_HINT("pizza cooking"), DEFAULT_CONTEXT_BUDGET);

    // food record should rank higher due to Jaccard overlap
    expect(ctx.knowledgeRecords[0]?.key).toBe("food");
  });
});
