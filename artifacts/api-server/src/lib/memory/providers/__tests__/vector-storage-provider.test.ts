/**
 * Phase 3C — VectorStorageProvider unit tests (Milestone 8)
 *
 * Covers:
 *   StorageProvider contract compliance
 *     - read() delegates to inner
 *     - write() delegates to inner without indexing
 *     - health() delegates to inner
 *     - list() without similarityQuery delegates to inner unchanged
 *     - list() with similarityQuery uses vector index
 *     - append() forwards to inner and updates list vector index
 *     - upsert() forwards to inner and updates map vector index
 *     - delete(StorageKey) forwards to inner and clears list + map index
 *     - delete(ScopePrefix) forwards to inner and clears all matching entries
 *
 *   Vector index — list kind (append)
 *     - listIndexSize() starts at 0
 *     - append() increments listIndexSize by 1 per call
 *     - list() with similarityQuery ranks most-relevant item first
 *     - list() with similarityQuery applies limit after ranking
 *     - items with zero similarity to query appear last
 *     - ties in score preserve insertion order (deterministic)
 *     - empty similarityQuery → delegates to inner (no ranking)
 *     - list() on an unindexed key falls back to inner
 *
 *   Vector index — map kind (upsert)
 *     - mapIndexSize() starts at 0
 *     - upsert() increments mapIndexSize by 1 (new entryKey)
 *     - re-upsert of same entryKey updates the vector (size stays same)
 *     - list() with similarityQuery ranks map entries by relevance
 *     - fact with highest KnowledgeRecord overlap ranks first
 *
 *   similarityThreshold
 *     - items below threshold are excluded
 *     - items at or above threshold are included
 *     - threshold 0 (default) includes all items
 *     - threshold 1 includes only perfect matches
 *
 *   delete()
 *     - delete(StorageKey) clears list index for that key
 *     - delete(StorageKey) clears map index for that key
 *     - delete(ScopePrefix) clears all index entries matching the prefix
 *     - delete(ScopePrefix) does not clear entries for a different user
 *
 *   Custom EmbeddingProvider injection
 *     - constructor accepts a custom EmbeddingProvider
 *     - custom embedder is called during append/upsert
 *     - custom embedder is called during list() with similarityQuery
 *     - custom embedder NOT called during list() without similarityQuery
 *
 *   totalIndexSize()
 *     - reflects combined list + map entry count
 *     - decreases after delete
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { VectorStorageProvider } from "../vector-storage-provider.js";
import { InMemoryStorageProvider } from "../in-memory-storage-provider.js";
import {
  HashingEmbeddingProvider,
  type EmbeddingProvider,
} from "../../embedding-provider.js";
import type { ConversationTurn, KnowledgeRecord, StorageKey } from "../../types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const KEY: StorageKey = {
  tier: "conversation",
  tenantId: "t1",
  botId:    "b1",
  userId:   "u1",
};

const FACTS_KEY: StorageKey = {
  tier:     "user_profile",
  tenantId: "t1",
  botId:    "b1",
  userId:   "u1",
};

const KR_KEY: StorageKey = {
  tier:     "long_term_knowledge",
  tenantId: "t1",
  botId:    "b1",
  userId:   "u1",
};

function turn(n: number, content: string): ConversationTurn {
  return {
    turnId:    `turn-${n}`,
    requestId: `req-${n}`,
    role:      n % 2 === 0 ? "assistant" : "user",
    content,
    timestamp: n * 1_000,
  };
}

function kr(key: string, value: string): KnowledgeRecord {
  return {
    recordId:   `rec-${key}`,
    key,
    value,
    category:   "preference",
    confidence: 0.9,
    importance: 0.8,
    source:     "explicit",
    tags:       [],
    createdAt:  1_000_000,
    updatedAt:  1_000_000,
    version:    1,
  };
}

// ---------------------------------------------------------------------------
// StorageProvider contract — delegation
// ---------------------------------------------------------------------------

describe("VectorStorageProvider — StorageProvider delegation", () => {
  let inner: InMemoryStorageProvider;
  let provider: VectorStorageProvider;

  beforeEach(() => {
    inner = new InMemoryStorageProvider();
    provider = new VectorStorageProvider(inner);
  });

  it("read() delegates to inner", async () => {
    await inner.write(KEY, { x: 1 });
    const result = await provider.read<{ x: number }>(KEY);
    expect(result).toEqual({ x: 1 });
  });

  it("write() delegates to inner (no indexing)", async () => {
    const result = await provider.write(KEY, { session: "data" });
    expect(result.revision).toBeGreaterThan(0);
    expect(provider.totalIndexSize()).toBe(0); // write() does not index
  });

  it("health() delegates to inner", async () => {
    expect(await provider.health()).toBe("ok");
  });

  it("list() without similarityQuery delegates to inner unchanged", async () => {
    await inner.append(KEY, turn(1, "hello world"));
    await inner.append(KEY, turn(2, "pizza pasta"));

    const results = await provider.list<ConversationTurn>(KEY, {
      limit: 10,
      order: "asc",
    });
    expect(results).toHaveLength(2);
    expect(results[0]!.turnId).toBe("turn-1");
    expect(results[1]!.turnId).toBe("turn-2");
  });
});

// ---------------------------------------------------------------------------
// Vector index — list kind (append)
// ---------------------------------------------------------------------------

describe("VectorStorageProvider — list vector index", () => {
  let provider: VectorStorageProvider;

  beforeEach(() => {
    provider = new VectorStorageProvider(new InMemoryStorageProvider());
  });

  it("listIndexSize() starts at 0", () => {
    expect(provider.listIndexSize(KEY)).toBe(0);
  });

  it("append() increments listIndexSize by 1", async () => {
    await provider.append(KEY, turn(1, "hello"));
    expect(provider.listIndexSize(KEY)).toBe(1);
    await provider.append(KEY, turn(2, "world"));
    expect(provider.listIndexSize(KEY)).toBe(2);
  });

  it("list() with similarityQuery ranks most-relevant item first", async () => {
    await provider.append(KEY, turn(1, "the weather is nice today sunshine"));
    await provider.append(KEY, turn(2, "quantum physics dark energy antimatter"));
    await provider.append(KEY, turn(3, "I love pizza pasta cooking recipes"));

    const results = await provider.list<ConversationTurn>(KEY, {
      limit: 10,
      order: "desc",
      similarityQuery: "pizza cooking food",
    });

    expect(results[0]!.turnId).toBe("turn-3");
  });

  it("list() with similarityQuery applies limit after ranking", async () => {
    await provider.append(KEY, turn(1, "weather forecast sunny"));
    await provider.append(KEY, turn(2, "pizza recipe ingredients"));
    await provider.append(KEY, turn(3, "pasta cooking sauce"));

    const results = await provider.list<ConversationTurn>(KEY, {
      limit: 1,
      order: "desc",
      similarityQuery: "pizza pasta cooking",
    });

    expect(results).toHaveLength(1);
    // Both turn-2 and turn-3 overlap; either could be first.
    // Assert it's not the completely irrelevant weather turn.
    expect(results[0]!.turnId).not.toBe("turn-1");
  });

  it("items with equal score preserve insertion order (tie-breaking determinism)", async () => {
    // Use a controlled embedder: all items return the same vector [1, 0, 0],
    // query also returns [1, 0, 0] → all cosine similarities are 1.0 (tied).
    // Insertion order must be preserved for ties.
    const allSame: EmbeddingProvider = {
      dimensions: 3,
      embed: vi.fn().mockResolvedValue([1, 0, 0]),
    };
    const p = new VectorStorageProvider(new InMemoryStorageProvider(), allSame);

    await p.append(KEY, turn(1, "first item"));
    await p.append(KEY, turn(2, "second item"));
    await p.append(KEY, turn(3, "third item"));

    const results = await p.list<ConversationTurn>(KEY, {
      limit: 10,
      order: "asc",
      similarityQuery: "anything",
    });

    // All scores tied → insertion order preserved
    expect(results.map((t) => t.turnId)).toEqual(["turn-1", "turn-2", "turn-3"]);
  });

  it("higher-scoring items rank before lower-scoring ones (deterministic custom embedder)", async () => {
    // Controlled embedder: turn-3's content maps to [0, 0, 1]; others to [1, 0, 0].
    // Query maps to [0, 0, 1] → turn-3 has cosine=1.0; turn-1 and turn-2 have cosine=0.0.
    const controlled: EmbeddingProvider = {
      dimensions: 3,
      embed: vi.fn(async (text: string) =>
        text.includes("pizza") ? [0, 0, 1] : [1, 0, 0],
      ),
    };
    const p = new VectorStorageProvider(new InMemoryStorageProvider(), controlled);

    await p.append(KEY, turn(1, "zebra xylophone quartz"));
    await p.append(KEY, turn(2, "quantum gravity photon"));
    await p.append(KEY, turn(3, "pizza pasta food"));

    const results = await p.list<ConversationTurn>(KEY, {
      limit: 10,
      order: "asc",
      similarityQuery: "pizza pasta",  // embedder returns [0, 0, 1] for this
    });

    // turn-3 first (cosine=1.0), then turn-1 and turn-2 in insertion order (cosine=0.0)
    expect(results[0]!.turnId).toBe("turn-3");
    const tailIds = results.slice(1).map((t) => t.turnId);
    expect(tailIds).toEqual(["turn-1", "turn-2"]);
  });

  it("empty similarityQuery falls back to inner (insertion order)", async () => {
    await provider.append(KEY, turn(1, "first"));
    await provider.append(KEY, turn(2, "second"));

    const withEmpty = await provider.list<ConversationTurn>(KEY, {
      limit: 10,
      order: "asc",
      similarityQuery: "",
    });

    expect(withEmpty.map((t) => t.turnId)).toEqual(["turn-1", "turn-2"]);
  });

  it("list() on an unindexed key falls back to inner", async () => {
    // Write directly to inner (bypassing VectorStorageProvider)
    const inner = new InMemoryStorageProvider();
    const vsp   = new VectorStorageProvider(inner);
    await inner.append(KEY, turn(1, "hello"));

    // No vector index for this key, so it falls back to inner list()
    const results = await vsp.list<ConversationTurn>(KEY, {
      limit: 10,
      order: "asc",
      similarityQuery: "hello",
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.turnId).toBe("turn-1");
  });
});

// ---------------------------------------------------------------------------
// Vector index — map kind (upsert)
// ---------------------------------------------------------------------------

describe("VectorStorageProvider — map vector index", () => {
  let provider: VectorStorageProvider;

  beforeEach(() => {
    provider = new VectorStorageProvider(new InMemoryStorageProvider());
  });

  it("mapIndexSize() starts at 0", () => {
    expect(provider.mapIndexSize(KR_KEY)).toBe(0);
  });

  it("upsert() increments mapIndexSize for new entryKeys", async () => {
    await provider.upsert(KR_KEY, "food",  kr("food",  "loves pizza"));
    expect(provider.mapIndexSize(KR_KEY)).toBe(1);
    await provider.upsert(KR_KEY, "hobby", kr("hobby", "enjoys reading"));
    expect(provider.mapIndexSize(KR_KEY)).toBe(2);
  });

  it("re-upsert of same entryKey updates vector without growing the index", async () => {
    await provider.upsert(KR_KEY, "food", kr("food", "loves pizza"));
    expect(provider.mapIndexSize(KR_KEY)).toBe(1);
    await provider.upsert(KR_KEY, "food", kr("food", "loves sushi now"));
    expect(provider.mapIndexSize(KR_KEY)).toBe(1); // still 1
  });

  it("list() with similarityQuery ranks map entries by relevance", async () => {
    await provider.upsert(KR_KEY, "food",     kr("food",     "loves pizza pasta cooking"));
    await provider.upsert(KR_KEY, "hobby",    kr("hobby",    "enjoys reading novels"));
    await provider.upsert(KR_KEY, "location", kr("location", "lives in London city"));

    const results = await provider.list<KnowledgeRecord>(KR_KEY, {
      limit: 10,
      order: "asc",
      similarityQuery: "pizza cooking food",
    });

    expect(results[0]!.key).toBe("food");
  });

  it("re-upsert updates the vector — new content is retrieved by updated query", async () => {
    await provider.upsert(KR_KEY, "pref", kr("pref", "loves reading books fiction"));
    // Now update with completely different content
    await provider.upsert(KR_KEY, "pref", kr("pref", "loves cooking pizza pasta"));

    const results = await provider.list<KnowledgeRecord>(KR_KEY, {
      limit: 5,
      order: "asc",
      similarityQuery: "pizza cooking",
    });

    // Should rank the pref record high (updated to pizza/cooking content)
    expect(results[0]!.key).toBe("pref");
  });
});

// ---------------------------------------------------------------------------
// similarityThreshold
// ---------------------------------------------------------------------------

describe("VectorStorageProvider — similarityThreshold", () => {
  it("excludes items with score strictly below the threshold", async () => {
    // Controlled embedder: turn-1 maps to [1,0,0] (score=0.0 vs query),
    // turn-2 maps to [0,0,1] (score=1.0 vs query).
    // Query maps to [0,0,1].
    const controlled: EmbeddingProvider = {
      dimensions: 3,
      embed: vi.fn(async (text: string) =>
        text.includes("relevant") ? [0, 0, 1] : [1, 0, 0],
      ),
    };
    const provider = new VectorStorageProvider(new InMemoryStorageProvider(), controlled);

    await provider.append(KEY, turn(1, "completely unrelated content here"));
    await provider.append(KEY, turn(2, "relevant content for this query"));

    // threshold=0.5 → turn-1 (score=0.0) excluded, turn-2 (score=1.0) included
    const results = await provider.list<ConversationTurn>(KEY, {
      limit: 10,
      order: "asc",
      similarityQuery: "relevant query",
      similarityThreshold: 0.5,
    });

    const ids = results.map((t) => t.turnId);
    expect(ids).toContain("turn-2");
    expect(ids).not.toContain("turn-1");
  });

  it("threshold 0 (default) includes all items", async () => {
    const provider = new VectorStorageProvider(new InMemoryStorageProvider());
    await provider.append(KEY, turn(1, "zero overlap xylophone quantum"));
    await provider.append(KEY, turn(2, "pizza pasta food"));

    const results = await provider.list<ConversationTurn>(KEY, {
      limit: 10,
      order: "asc",
      similarityQuery: "pizza",
      similarityThreshold: 0,
    });

    expect(results).toHaveLength(2);
  });

  it("threshold 1.0 includes only perfect-match items", async () => {
    const provider = new VectorStorageProvider(new InMemoryStorageProvider());
    const text = "pizza cooking food";
    await provider.append(KEY, turn(1, "pizza cooking food")); // identical → sim=1.0
    await provider.append(KEY, turn(2, "different content here"));

    const results = await provider.list<ConversationTurn>(KEY, {
      limit: 10,
      order: "asc",
      similarityQuery: text,
      similarityThreshold: 1.0,
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.turnId).toBe("turn-1");
  });
});

// ---------------------------------------------------------------------------
// delete()
// ---------------------------------------------------------------------------

describe("VectorStorageProvider — delete()", () => {
  it("delete(StorageKey) clears list index for that key", async () => {
    const provider = new VectorStorageProvider(new InMemoryStorageProvider());
    await provider.append(KEY, turn(1, "hello"));
    await provider.append(KEY, turn(2, "world"));
    expect(provider.listIndexSize(KEY)).toBe(2);

    await provider.delete(KEY);
    expect(provider.listIndexSize(KEY)).toBe(0);
  });

  it("delete(StorageKey) clears map index for that key", async () => {
    const provider = new VectorStorageProvider(new InMemoryStorageProvider());
    await provider.upsert(KR_KEY, "food",  kr("food",  "pizza"));
    await provider.upsert(KR_KEY, "hobby", kr("hobby", "reading"));
    expect(provider.mapIndexSize(KR_KEY)).toBe(2);

    await provider.delete(KR_KEY);
    expect(provider.mapIndexSize(KR_KEY)).toBe(0);
  });

  it("delete(ScopePrefix) clears all index entries for that user", async () => {
    const provider = new VectorStorageProvider(new InMemoryStorageProvider());
    await provider.append(KEY, turn(1, "hello"));
    await provider.upsert(FACTS_KEY, "food", kr("food", "pizza"));

    await provider.delete({ tenantId: "t1", botId: "b1", userId: "u1" });

    expect(provider.listIndexSize(KEY)).toBe(0);
    expect(provider.mapIndexSize(FACTS_KEY)).toBe(0);
  });

  it("delete(ScopePrefix) does not clear entries for a different user", async () => {
    const provider = new VectorStorageProvider(new InMemoryStorageProvider());

    const otherKey: StorageKey = { ...KEY, userId: "other-user" };
    await provider.append(KEY,      turn(1, "user-1 content"));
    await provider.append(otherKey, turn(2, "user-2 content"));

    expect(provider.listIndexSize(KEY)).toBe(1);
    expect(provider.listIndexSize(otherKey)).toBe(1);

    // Delete only user u1
    await provider.delete({ tenantId: "t1", botId: "b1", userId: "u1" });

    expect(provider.listIndexSize(KEY)).toBe(0);
    expect(provider.listIndexSize(otherKey)).toBe(1); // other user unaffected
  });
});

// ---------------------------------------------------------------------------
// Custom EmbeddingProvider injection
// ---------------------------------------------------------------------------

describe("VectorStorageProvider — custom EmbeddingProvider injection", () => {
  it("constructor accepts a custom EmbeddingProvider", () => {
    const custom: EmbeddingProvider = {
      dimensions: 4,
      embed: vi.fn().mockResolvedValue([0.5, 0.5, 0.5, 0.5]),
    };
    expect(() => new VectorStorageProvider(new InMemoryStorageProvider(), custom)).not.toThrow();
  });

  it("custom embedder is called during append()", async () => {
    const custom: EmbeddingProvider = {
      dimensions: 4,
      embed: vi.fn().mockResolvedValue([1, 0, 0, 0]),
    };
    const provider = new VectorStorageProvider(new InMemoryStorageProvider(), custom);
    await provider.append(KEY, turn(1, "hello"));
    expect(custom.embed).toHaveBeenCalledOnce();
  });

  it("custom embedder is called during upsert()", async () => {
    const custom: EmbeddingProvider = {
      dimensions: 4,
      embed: vi.fn().mockResolvedValue([1, 0, 0, 0]),
    };
    const provider = new VectorStorageProvider(new InMemoryStorageProvider(), custom);
    await provider.upsert(KR_KEY, "food", kr("food", "pizza"));
    expect(custom.embed).toHaveBeenCalledOnce();
  });

  it("custom embedder is called during list() with similarityQuery", async () => {
    const custom: EmbeddingProvider = {
      dimensions: 4,
      embed: vi.fn().mockResolvedValue([1, 0, 0, 0]),
    };
    const provider = new VectorStorageProvider(new InMemoryStorageProvider(), custom);
    await provider.append(KEY, turn(1, "hello"));

    vi.mocked(custom.embed).mockClear();
    await provider.list<ConversationTurn>(KEY, {
      limit: 10,
      order: "asc",
      similarityQuery: "hello",
    });
    expect(custom.embed).toHaveBeenCalledOnce(); // called once for the query
  });

  it("custom embedder is NOT called during list() without similarityQuery", async () => {
    const custom: EmbeddingProvider = {
      dimensions: 4,
      embed: vi.fn().mockResolvedValue([1, 0, 0, 0]),
    };
    const provider = new VectorStorageProvider(new InMemoryStorageProvider(), custom);
    await provider.append(KEY, turn(1, "hello"));

    vi.mocked(custom.embed).mockClear();
    await provider.list<ConversationTurn>(KEY, { limit: 10, order: "asc" });
    expect(custom.embed).not.toHaveBeenCalled();
  });

  it("custom embedder's return value determines the ranking", async () => {
    // Embedder: turn-2 content gets vector [0, 1]; query also gets [0, 1] → sim=1.0
    //           turn-1 content gets vector [1, 0] → sim=0.0
    const custom: EmbeddingProvider = {
      dimensions: 2,
      embed: vi.fn(async (_text: string) => {
        const calls = (custom.embed as ReturnType<typeof vi.fn>).mock.calls.length;
        // Odd calls are for item indexing: turn-1 first, then turn-2
        // Even calls are for query embedding — always return [0, 1]
        return calls % 2 === 0 ? [1, 0] : [0, 1];
      }),
    };
    // Reset: the above logic is fragile; use a simpler deterministic approach.
    // We mock the embedder to return [1,0] for "winner content" and [0,1] otherwise.
    (custom.embed as ReturnType<typeof vi.fn>).mockImplementation(async (text: string) =>
      text.includes("winner") ? [1, 0] : [0, 1],
    );

    const provider = new VectorStorageProvider(new InMemoryStorageProvider(), custom);
    await provider.append(KEY, turn(1, "loser content here"));
    await provider.append(KEY, turn(2, "winner content here"));

    const results = await provider.list<ConversationTurn>(KEY, {
      limit: 10,
      order: "asc",
      // Query gets vector [1, 0] (contains "winner")
      similarityQuery: "winner",
    });

    expect(results[0]!.turnId).toBe("turn-2"); // highest cosine similarity
  });
});

// ---------------------------------------------------------------------------
// totalIndexSize()
// ---------------------------------------------------------------------------

describe("VectorStorageProvider — totalIndexSize()", () => {
  it("starts at 0", () => {
    const provider = new VectorStorageProvider(new InMemoryStorageProvider());
    expect(provider.totalIndexSize()).toBe(0);
  });

  it("reflects combined list + map entries", async () => {
    const provider = new VectorStorageProvider(new InMemoryStorageProvider());
    await provider.append(KEY,    turn(1, "hello"));
    await provider.append(KEY,    turn(2, "world"));
    await provider.upsert(KR_KEY, "food", kr("food", "pizza"));

    expect(provider.totalIndexSize()).toBe(3);
  });

  it("decreases after delete(StorageKey)", async () => {
    const provider = new VectorStorageProvider(new InMemoryStorageProvider());
    await provider.append(KEY,    turn(1, "hello"));
    await provider.upsert(KR_KEY, "food", kr("food", "pizza"));
    expect(provider.totalIndexSize()).toBe(2);

    await provider.delete(KEY);
    expect(provider.totalIndexSize()).toBe(1);
  });
});
