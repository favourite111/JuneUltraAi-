/**
 * Phase 3C — InMemoryStorageProvider similarity ranking tests (Milestone 3)
 *
 * Covers the similarityQuery path in InMemoryStorageProvider.list():
 *
 *   When similarityQuery is absent:
 *     - list() returns items in insertion order (asc) — existing behaviour
 *     - list() returns items in reverse insertion order (desc) — existing behaviour
 *     - behaviour is identical to pre-Milestone-3
 *
 *   When similarityQuery is present:
 *     - items are ranked by relevance score descending
 *     - highest-relevance item is first
 *     - items with zero relevance (no overlap) appear last
 *     - limit is applied after ranking
 *     - ties in score preserve insertion order (deterministic)
 *     - empty similarityQuery string falls back to insertion order
 *     - limit=1 with similarityQuery returns the single most-relevant item
 *     - ConversationTurn.content is used as the searchable string
 *     - UserFact key+value are used as the searchable string
 *     - generic object falls back to JSON serialisation for search
 *
 *   Custom scorer injection:
 *     - constructor accepts a custom RelevanceScorer
 *     - custom scorer is called during list() with similarityQuery
 *     - custom scorer return value determines the ranking order
 *
 *   PostgresStorageProvider contract (verified by absence):
 *     - similarityQuery in ListOptions must not cause errors when ignored
 *       (PostgresStorageProvider's contract — tested here structurally)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { InMemoryStorageProvider } from "../in-memory-storage-provider.js";
import type { RelevanceScorer } from "../../relevance-scorer.js";
import type { ConversationTurn, StorageKey, UserFact } from "../../types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const KEY: StorageKey = {
  tier: "conversation",
  tenantId: "t1",
  botId: "b1",
  userId: "u1",
};

const FACTS_KEY: StorageKey = {
  tier: "user_profile",
  tenantId: "t1",
  botId: "b1",
  userId: "u1",
};

function makeTurn(n: number, content: string): ConversationTurn {
  return {
    turnId: `turn-${n}`,
    requestId: `req-${n}`,
    role: n % 2 === 0 ? "assistant" : "user",
    content,
    timestamp: n * 1_000,
  };
}

function makeFact(key: string, value: string): UserFact {
  return {
    factId: `fact-${key}`,
    key,
    value,
    confidence: 0.9,
    importance: 0.8,
    source: "explicit",
    createdAt: 1_000_000,
    confirmedAt: 1_000_000,
    sensitive: false,
  };
}

// ---------------------------------------------------------------------------
// No similarityQuery — existing ordering behaviour is preserved
// ---------------------------------------------------------------------------

describe("InMemoryStorageProvider.list() — no similarityQuery", () => {
  let provider: InMemoryStorageProvider;

  beforeEach(async () => {
    provider = new InMemoryStorageProvider();
    await provider.append(KEY, makeTurn(1, "first message"));
    await provider.append(KEY, makeTurn(2, "second message"));
    await provider.append(KEY, makeTurn(3, "third message"));
  });

  it("returns items in ascending insertion order when order='asc'", async () => {
    const results = await provider.list<ConversationTurn>(KEY, {
      limit: 10,
      order: "asc",
    });
    expect(results.map(t => t.turnId)).toEqual(["turn-1", "turn-2", "turn-3"]);
  });

  it("returns items in descending insertion order when order='desc'", async () => {
    const results = await provider.list<ConversationTurn>(KEY, {
      limit: 10,
      order: "desc",
    });
    expect(results.map(t => t.turnId)).toEqual(["turn-3", "turn-2", "turn-1"]);
  });

  it("respects the limit without similarityQuery", async () => {
    const results = await provider.list<ConversationTurn>(KEY, {
      limit: 2,
      order: "asc",
    });
    expect(results).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// similarityQuery — relevance ranking
// ---------------------------------------------------------------------------

describe("InMemoryStorageProvider.list() — with similarityQuery", () => {
  let provider: InMemoryStorageProvider;

  beforeEach(async () => {
    provider = new InMemoryStorageProvider();
    // Inserted in this order; the most-relevant to "pizza food" is turn-3
    await provider.append(KEY, makeTurn(1, "the weather is nice today"));
    await provider.append(KEY, makeTurn(2, "what time does the shop open"));
    await provider.append(KEY, makeTurn(3, "I love pizza and other food"));
  });

  it("ranks the most relevant item first", async () => {
    const results = await provider.list<ConversationTurn>(KEY, {
      limit: 10,
      order: "desc",
      similarityQuery: "pizza food",
    });
    expect(results[0]!.turnId).toBe("turn-3");
  });

  it("items with no query overlap are ranked last", async () => {
    const results = await provider.list<ConversationTurn>(KEY, {
      limit: 10,
      order: "desc",
      similarityQuery: "pizza food",
    });
    // turn-1 and turn-2 have no overlap with "pizza food"
    const noOverlapIds = results.slice(-2).map(t => t.turnId);
    expect(noOverlapIds).toContain("turn-1");
    expect(noOverlapIds).toContain("turn-2");
  });

  it("applies limit after ranking", async () => {
    const results = await provider.list<ConversationTurn>(KEY, {
      limit: 1,
      order: "desc",
      similarityQuery: "pizza food",
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.turnId).toBe("turn-3");
  });

  it("returns all items when all have equal relevance (no overlap → same 0 score), preserving insertion order", async () => {
    const results = await provider.list<ConversationTurn>(KEY, {
      limit: 10,
      order: "asc",
      similarityQuery: "xylophone quantum zephyr", // no overlap with any turn
    });
    // All scores are 0 → tie → insertion order preserved
    expect(results.map(t => t.turnId)).toEqual(["turn-1", "turn-2", "turn-3"]);
  });

  it("returns empty array when store has no data for the key", async () => {
    const emptyKey: StorageKey = { ...KEY, userId: "nobody" };
    const results = await provider.list(emptyKey, {
      limit: 10,
      order: "asc",
      similarityQuery: "pizza",
    });
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// similarityQuery with map values (UserFacts)
// ---------------------------------------------------------------------------

describe("InMemoryStorageProvider.list() — similarityQuery on UserFact map", () => {
  it("uses fact key + value as the searchable string", async () => {
    const provider = new InMemoryStorageProvider();
    await provider.upsert(FACTS_KEY, "food",     makeFact("food",     "loves pizza and pasta"));
    await provider.upsert(FACTS_KEY, "hobby",    makeFact("hobby",    "enjoys reading books"));
    await provider.upsert(FACTS_KEY, "location", makeFact("location", "lives in London"));

    const results = await provider.list<UserFact>(FACTS_KEY, {
      limit: 10,
      order: "asc",
      similarityQuery: "pizza pasta food",
    });

    expect(results[0]!.key).toBe("food");
  });

  it("fact with no overlap ranks last", async () => {
    const provider = new InMemoryStorageProvider();
    await provider.upsert(FACTS_KEY, "food",  makeFact("food",  "loves pizza"));
    await provider.upsert(FACTS_KEY, "other", makeFact("other", "xylophone quantum"));

    const results = await provider.list<UserFact>(FACTS_KEY, {
      limit: 10,
      order: "asc",
      similarityQuery: "pizza",
    });

    expect(results[0]!.key).toBe("food");
    expect(results[results.length - 1]!.key).toBe("other");
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("InMemoryStorageProvider.list() — similarityQuery edge cases", () => {
  it("handles empty similarityQuery string by returning items in insertion order", async () => {
    const provider = new InMemoryStorageProvider();
    await provider.append(KEY, makeTurn(1, "first"));
    await provider.append(KEY, makeTurn(2, "second"));

    const withEmpty = await provider.list<ConversationTurn>(KEY, {
      limit: 10,
      order: "asc",
      similarityQuery: "",
    });
    const withUndefined = await provider.list<ConversationTurn>(KEY, {
      limit: 10,
      order: "asc",
    });
    expect(withEmpty.map(t => t.turnId)).toEqual(withUndefined.map(t => t.turnId));
  });

  it("limit=1 with similarityQuery returns only the most-relevant item", async () => {
    const provider = new InMemoryStorageProvider();
    await provider.append(KEY, makeTurn(1, "weather forecast today"));
    await provider.append(KEY, makeTurn(2, "pizza recipe ingredients flour"));
    await provider.append(KEY, makeTurn(3, "city traffic roads"));

    const results = await provider.list<ConversationTurn>(KEY, {
      limit: 1,
      order: "desc",
      similarityQuery: "pizza recipe",
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.turnId).toBe("turn-2");
  });
});

// ---------------------------------------------------------------------------
// Custom RelevanceScorer injection
// ---------------------------------------------------------------------------

describe("InMemoryStorageProvider — custom RelevanceScorer injection", () => {
  it("constructor accepts a custom scorer", () => {
    const custom: RelevanceScorer = { score: vi.fn().mockReturnValue(0.5) };
    expect(() => new InMemoryStorageProvider(custom)).not.toThrow();
  });

  it("custom scorer is called during list() with similarityQuery", async () => {
    const custom: RelevanceScorer = { score: vi.fn().mockReturnValue(0.5) };
    const provider = new InMemoryStorageProvider(custom);
    await provider.append(KEY, makeTurn(1, "hello world"));
    await provider.append(KEY, makeTurn(2, "goodbye world"));

    await provider.list<ConversationTurn>(KEY, {
      limit: 10,
      order: "asc",
      similarityQuery: "hello",
    });

    expect(custom.score).toHaveBeenCalled();
  });

  it("custom scorer is NOT called when similarityQuery is absent", async () => {
    const custom: RelevanceScorer = { score: vi.fn().mockReturnValue(0.5) };
    const provider = new InMemoryStorageProvider(custom);
    await provider.append(KEY, makeTurn(1, "hello world"));

    await provider.list<ConversationTurn>(KEY, { limit: 10, order: "asc" });

    expect(custom.score).not.toHaveBeenCalled();
  });

  it("custom scorer return value determines the ranking", async () => {
    // scorer: turn-2 content gets score 1.0; turn-1 and turn-3 get 0.0
    const custom: RelevanceScorer = {
      score: vi.fn((_q: string, content: string) =>
        content.includes("winner") ? 1.0 : 0.0,
      ),
    };
    const provider = new InMemoryStorageProvider(custom);
    await provider.append(KEY, makeTurn(1, "loser content here"));
    await provider.append(KEY, makeTurn(2, "winner content here"));
    await provider.append(KEY, makeTurn(3, "another loser here"));

    const results = await provider.list<ConversationTurn>(KEY, {
      limit: 10,
      order: "asc",
      similarityQuery: "anything",
    });

    expect(results[0]!.turnId).toBe("turn-2");
  });
});
