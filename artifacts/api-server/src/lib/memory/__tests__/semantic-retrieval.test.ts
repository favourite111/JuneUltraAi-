/**
 * Phase 3C — Semantic retrieval integration tests (Milestone 3)
 *
 * Verifies that DefaultMemoryManager.load() correctly threads scope.queryHint
 * into ListOptions.similarityQuery for the conversation and user_profile tiers,
 * and that the returned MemoryContext reflects relevance-ranked results.
 *
 * Uses a hand-rolled FakeStorageProvider (same pattern as memory-manager.test.ts)
 * so the test verifies the DefaultMemoryManager wiring in strict isolation from
 * InMemoryStorageProvider's implementation.
 *
 * Covers:
 *   queryHint threading
 *     - scope.queryHint is passed as similarityQuery to conversation list()
 *     - scope.queryHint is passed as similarityQuery to user_profile list()
 *     - scope.queryHint is NOT passed to tool_execution list()
 *     - session read() is never given a similarityQuery (read, not list)
 *     - when queryHint is absent, similarityQuery is undefined in all list calls
 *
 *   End-to-end with InMemoryStorageProvider
 *     - queryHint causes more-relevant turns to appear first in context
 *     - queryHint causes more-relevant facts to appear first in context
 *     - without queryHint, turns appear in chronological (insertion-reversed) order
 *     - MemoryManager.load() signature is unchanged: load(scope, budget)
 *     - PostgresStorageProvider ignores similarityQuery without error
 *       (structural — verified via the StorageProvider interface contract)
 *
 *   MemoryScope
 *     - queryHint is optional (absent scopes work identically to pre-M3)
 *     - queryHint does not affect record(), forget(), or health()
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { DefaultMemoryManager } from "../memory-manager.js";
import { InMemoryStorageProvider } from "../providers/in-memory-storage-provider.js";
import {
  DEFAULT_CONTEXT_BUDGET,
  type ConversationTurn,
  type MemoryScope,
  type StorageKey,
  type StorageProvider,
  type UserFact,
  type WriteResult,
} from "../types.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const BASE_SCOPE: MemoryScope = {
  tenantId: "t1",
  botId: "b1",
  userId: "u1",
  sessionId: "s1",
  requestId: "req-1",
  // queryHint intentionally absent — added per-test where needed
};

const SCOPE_WITH_HINT = (hint: string): MemoryScope => ({
  ...BASE_SCOPE,
  queryHint: hint,
});

const FAKE_WRITE_RESULT: WriteResult = {
  revision: 1,
  etag: "abc",
  updatedAt: 1_000_000,
};

function makeFakeProvider(): StorageProvider {
  return {
    read: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue([]),
    write: vi.fn().mockResolvedValue(FAKE_WRITE_RESULT),
    append: vi.fn().mockResolvedValue(FAKE_WRITE_RESULT),
    upsert: vi.fn().mockResolvedValue(FAKE_WRITE_RESULT),
    delete: vi.fn().mockResolvedValue(undefined),
    health: vi.fn().mockResolvedValue("ok"),
  };
}

function makeTurn(n: number, content = `Message ${n}`): ConversationTurn {
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
// queryHint threading — verified against the fake provider's list() call args
// ---------------------------------------------------------------------------

describe("DefaultMemoryManager.load() — queryHint threading", () => {
  let provider: StorageProvider;
  let manager: DefaultMemoryManager;

  beforeEach(() => {
    provider = makeFakeProvider();
    manager = new DefaultMemoryManager(provider);
  });

  it("passes queryHint as similarityQuery in the conversation list() call", async () => {
    await manager.load(SCOPE_WITH_HINT("pizza recipes"), DEFAULT_CONTEXT_BUDGET);

    const listCalls = vi.mocked(provider.list).mock.calls;
    const convCall = listCalls.find(([key]) => (key as StorageKey).tier === "conversation");
    expect(convCall).toBeDefined();
    expect(convCall![1].similarityQuery).toBe("pizza recipes");
  });

  it("passes queryHint as similarityQuery in the user_profile list() call", async () => {
    await manager.load(SCOPE_WITH_HINT("pizza recipes"), DEFAULT_CONTEXT_BUDGET);

    const listCalls = vi.mocked(provider.list).mock.calls;
    const profileCall = listCalls.find(([key]) => (key as StorageKey).tier === "user_profile");
    expect(profileCall).toBeDefined();
    expect(profileCall![1].similarityQuery).toBe("pizza recipes");
  });

  it("does NOT pass similarityQuery to the tool_execution list() call", async () => {
    await manager.load(SCOPE_WITH_HINT("pizza recipes"), DEFAULT_CONTEXT_BUDGET);

    const listCalls = vi.mocked(provider.list).mock.calls;
    const toolCall = listCalls.find(([key]) => (key as StorageKey).tier === "tool_execution");
    expect(toolCall).toBeDefined();
    expect(toolCall![1].similarityQuery).toBeUndefined();
  });

  it("similarityQuery is undefined in all list() calls when queryHint is absent", async () => {
    await manager.load(BASE_SCOPE, DEFAULT_CONTEXT_BUDGET);

    const listCalls = vi.mocked(provider.list).mock.calls;
    for (const [, options] of listCalls) {
      expect(options.similarityQuery).toBeUndefined();
    }
  });

  it("session uses read(), not list() — no similarityQuery involved", async () => {
    await manager.load(SCOPE_WITH_HINT("any query"), DEFAULT_CONTEXT_BUDGET);

    const readCalls = vi.mocked(provider.read).mock.calls;
    expect(readCalls.length).toBeGreaterThan(0);
    // read() takes only a StorageKey — no options argument at all
    for (const call of readCalls) {
      expect(call.length).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// End-to-end with InMemoryStorageProvider
// ---------------------------------------------------------------------------

describe("DefaultMemoryManager.load() — end-to-end semantic retrieval", () => {
  it("more-relevant turns appear first in context when queryHint is set", async () => {
    const storage = new InMemoryStorageProvider();
    const manager = new DefaultMemoryManager(storage);

    const convKey: StorageKey = {
      tier: "conversation",
      tenantId: BASE_SCOPE.tenantId,
      botId: BASE_SCOPE.botId,
      userId: BASE_SCOPE.userId,
    };

    // Insert turns in chronological order — turn-1 is most recent when reversed
    await storage.append(convKey, makeTurn(3, "the weather is nice today sunshine"));
    await storage.append(convKey, makeTurn(2, "what time does the pizza shop open"));
    await storage.append(convKey, makeTurn(1, "I love cooking pizza and pasta dishes"));

    const ctx = await manager.load(
      SCOPE_WITH_HINT("pizza cooking food"),
      DEFAULT_CONTEXT_BUDGET,
    );

    // With queryHint, turns relevant to "pizza cooking food" should rank higher.
    // Both turn-1 and turn-2 overlap "pizza"; turn-1 also overlaps "cooking" → highest score.
    const ids = ctx.conversation.map(t => t.turnId);
    // The most relevant turn must appear before the least relevant (weather)
    const pizzaTurnIdx = ids.findIndex(id => id === "turn-1" || id === "turn-2");
    const weatherTurnIdx = ids.findIndex(id => id === "turn-3");
    expect(pizzaTurnIdx).toBeLessThan(weatherTurnIdx);
  });

  it("more-relevant facts appear first in context when queryHint is set", async () => {
    const storage = new InMemoryStorageProvider();
    const manager = new DefaultMemoryManager(storage);

    const factsKey: StorageKey = {
      tier: "user_profile",
      tenantId: BASE_SCOPE.tenantId,
      botId: BASE_SCOPE.botId,
      userId: BASE_SCOPE.userId,
    };

    await storage.upsert(factsKey, "hobby",    makeFact("hobby",    "enjoys reading books"));
    await storage.upsert(factsKey, "food",     makeFact("food",     "loves pizza pasta cooking"));
    await storage.upsert(factsKey, "location", makeFact("location", "lives in London"));

    const ctx = await manager.load(
      SCOPE_WITH_HINT("pizza cooking"),
      DEFAULT_CONTEXT_BUDGET,
    );

    // "food" fact overlaps "pizza" and "cooking" → should appear first
    const firstFact = ctx.userFacts[0];
    expect(firstFact?.key).toBe("food");
  });

  it("without queryHint, conversation appears in chronological order (insertion-reversed)", async () => {
    const storage = new InMemoryStorageProvider();
    const manager = new DefaultMemoryManager(storage);

    const convKey: StorageKey = {
      tier: "conversation",
      tenantId: BASE_SCOPE.tenantId,
      botId: BASE_SCOPE.botId,
      userId: BASE_SCOPE.userId,
    };

    // Appended in chronological order; provider returns desc, manager reverses to asc
    await storage.append(convKey, makeTurn(1, "first"));
    await storage.append(convKey, makeTurn(2, "second"));
    await storage.append(convKey, makeTurn(3, "third"));

    const ctx = await manager.load(BASE_SCOPE, DEFAULT_CONTEXT_BUDGET);

    expect(ctx.conversation.map(t => t.turnId)).toEqual(["turn-1", "turn-2", "turn-3"]);
  });

  it("load() signature is unchanged — takes only (scope, budget)", async () => {
    const storage = new InMemoryStorageProvider();
    const manager = new DefaultMemoryManager(storage);
    // This must compile and run without any third argument
    await expect(manager.load(BASE_SCOPE, DEFAULT_CONTEXT_BUDGET)).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// MemoryScope backward compatibility
// ---------------------------------------------------------------------------

describe("MemoryScope — queryHint is optional", () => {
  it("scope without queryHint is valid and produces identical behaviour to pre-M3", async () => {
    const storage = new InMemoryStorageProvider();
    const manager = new DefaultMemoryManager(storage);

    // BASE_SCOPE has no queryHint — must not throw
    await expect(manager.load(BASE_SCOPE, DEFAULT_CONTEXT_BUDGET)).resolves.toMatchObject({
      session: null,
      conversation: [],
      userFacts: [],
    });
  });

  it("queryHint does not affect record()", async () => {
    const provider = makeFakeProvider();
    const manager = new DefaultMemoryManager(provider);

    await expect(
      manager.record(SCOPE_WITH_HINT("any hint"), {
        conversationTurn: makeTurn(1),
      }),
    ).resolves.toBeUndefined();

    // record() only calls append/write/upsert — no list()
    expect(provider.list).not.toHaveBeenCalled();
  });

  it("queryHint does not affect forget()", async () => {
    const provider = makeFakeProvider();
    const manager = new DefaultMemoryManager(provider);

    await expect(
      manager.forget(SCOPE_WITH_HINT("any hint")),
    ).resolves.toBeUndefined();

    expect(provider.delete).toHaveBeenCalledOnce();
    expect(provider.list).not.toHaveBeenCalled();
  });

  it("queryHint does not affect health()", async () => {
    const provider = makeFakeProvider();
    const manager = new DefaultMemoryManager(provider);

    // health() doesn't even take a scope
    const result = await manager.health();
    expect(result.status).toBe("ok");
  });
});
