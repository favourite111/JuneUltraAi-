/**
 * Phase 3B — DefaultMemoryManager unit tests (Milestone 7)
 *
 * Covers:
 *   load()
 *     - empty provider → all fields null / []
 *     - session present → session field populated
 *     - conversation present (desc from provider) → chronological in context
 *     - user facts present → non-decayed only, sorted importance × confidence desc
 *     - decayed fact → excluded from userFacts
 *     - tool execution record → toolSummary populated
 *     - tool execution with error → toolSummary includes error string
 *     - one tier read throws → other tiers still present (graceful degradation)
 *     - all reads throw → returns empty context without throwing
 *     - budgetUsed > 0 when data present
 *     - budgetRemaining = usableContextTokens − budgetUsed
 *     - budgetRemaining never negative
 *     - MemoryContext version equals MEMORY_CONTEXT_VERSION
 *     - loadedAt is a recent timestamp
 *
 *   record()
 *     - session update → provider.write called with session key
 *     - conversation turn → provider.append called with conversation key
 *     - user facts → provider.upsert called per fact with fact.key as entryKey
 *     - tool outputs → provider.append called per record with tool_execution key
 *     - empty updates → no provider methods called
 *     - provider.write throws → no re-throw (best-effort)
 *     - provider.append throws → no re-throw (best-effort)
 *
 *   forget()
 *     - calls provider.delete with correct ScopePrefix
 *     - provider.delete throws → throws MemoryError
 *     - MemoryError carries operation "forget" and correct scope fields
 *
 *   health()
 *     - provider returns "ok" → status "ok", all tiers "ok"
 *     - provider returns "degraded" → status "degraded", all tiers "degraded"
 *     - provider returns "unavailable" → status "unavailable", all tiers "unavailable"
 *     - returned tiers include all six MemoryTierId values
 *
 * Strategy:
 *   Uses a hand-rolled FakeStorageProvider implementing StorageProvider.
 *   Each method is replaced by a vi.fn() stub that can be configured
 *   per test.  InMemoryStorageProvider is never imported — this file
 *   tests DefaultMemoryManager in strict isolation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { DefaultMemoryManager } from "../memory-manager.js";
import {
  MemoryError,
  MEMORY_CONTEXT_VERSION,
  DEFAULT_CONTEXT_BUDGET,
  type ConversationTurn,
  type MemoryScope,
  type MemoryTierId,
  type ScopePrefix,
  type SessionMemory,
  type StorageKey,
  type StorageProvider,
  type ToolExecutionRecord,
  type UserFact,
  type WriteResult,
} from "../types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SCOPE: MemoryScope = {
  tenantId: "t1",
  botId: "b1",
  userId: "u1",
  sessionId: "s1",
  requestId: "r1",
};

const BUDGET = DEFAULT_CONTEXT_BUDGET;

const FAKE_WRITE_RESULT: WriteResult = {
  revision: 1,
  etag: "abc123",
  updatedAt: 1_000_000,
};

const SESSION: SessionMemory = {
  sessionId: "s1",
  lastActivityAt: Date.now(),
  userMood: "neutral",
  conversationStage: "intro",
  personalityTemp: "warm",
  questionChainDepth: 0,
  activeTopics: ["weather"],
  recentBotPhrases: [],
  greetingDone: true,
};

function makeTurn(n: number): ConversationTurn {
  return {
    turnId: `turn-${n}`,
    requestId: `req-${n}`,
    role: n % 2 === 0 ? "user" : "assistant",
    content: `Message ${n}`,
    timestamp: n * 1_000,
  };
}

function makeUserFact(
  key: string,
  confidence: number,
  importance: number,
  decayed = false,
): UserFact {
  return {
    factId: `fact-${key}`,
    key,
    value: `value-${key}`,
    confidence,
    importance,
    source: "explicit",
    createdAt: 1_000_000,
    confirmedAt: 1_000_000,
    sensitive: false,
    decayed,
  };
}

function makeToolRecord(opts: { error?: string } = {}): ToolExecutionRecord {
  return {
    executionId: "exec-1",
    requestId: "req-1",
    toolName: "url_shortener",
    toolVersion: "1.0.0",
    args: { url: "https://example.com" },
    result: opts.error ? undefined : { short: "https://sho.rt/abc" },
    error: opts.error,
    reflectionDecision: opts.error ? "failed" : "success",
    durationMs: 42,
    timestamp: 1_000_000,
  };
}

// ---------------------------------------------------------------------------
// FakeStorageProvider
// ---------------------------------------------------------------------------

/**
 * Minimal hand-rolled fake implementing StorageProvider.
 * All methods are vi.fn() stubs — configure return values per test.
 */
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

// ---------------------------------------------------------------------------
// Key shape helpers for assertion
// ---------------------------------------------------------------------------

function expectKeyShape(
  key: StorageKey,
  tier: MemoryTierId,
  qualifier?: string,
): void {
  expect(key.tier).toBe(tier);
  expect(key.tenantId).toBe(SCOPE.tenantId);
  expect(key.botId).toBe(SCOPE.botId);
  expect(key.userId).toBe(SCOPE.userId);
  if (qualifier !== undefined) expect(key.qualifier).toBe(qualifier);
}

// ---------------------------------------------------------------------------
// load() tests
// ---------------------------------------------------------------------------

describe("DefaultMemoryManager.load()", () => {
  let provider: StorageProvider;
  let manager: DefaultMemoryManager;

  beforeEach(() => {
    provider = makeFakeProvider();
    manager = new DefaultMemoryManager(provider);
  });

  it("returns an empty context when the provider has no data", async () => {
    const ctx = await manager.load(SCOPE, BUDGET);

    expect(ctx.version).toBe(MEMORY_CONTEXT_VERSION);
    expect(ctx.session).toBeNull();
    expect(ctx.conversation).toEqual([]);
    expect(ctx.userFacts).toEqual([]);
    expect(ctx.toolSummary).toBeNull();
  });

  it("sets budgetRemaining to full usableContextTokens when no data", async () => {
    const ctx = await manager.load(SCOPE, BUDGET);

    expect(ctx.budgetUsed).toBe(0);
    expect(ctx.budgetRemaining).toBe(BUDGET.modelProfile.usableContextTokens);
  });

  it("records a recent loadedAt timestamp", async () => {
    const before = Date.now();
    const ctx = await manager.load(SCOPE, BUDGET);
    const after = Date.now();

    expect(ctx.loadedAt).toBeGreaterThanOrEqual(before);
    expect(ctx.loadedAt).toBeLessThanOrEqual(after);
  });

  it("MemoryContext version equals MEMORY_CONTEXT_VERSION", async () => {
    const ctx = await manager.load(SCOPE, BUDGET);
    expect(ctx.version).toBe(MEMORY_CONTEXT_VERSION);
  });

  it("populates session when provider.read returns a SessionMemory", async () => {
    const freshSession = { ...SESSION, lastActivityAt: Date.now() };
    vi.mocked(provider.read).mockResolvedValueOnce(freshSession);

    const ctx = await manager.load(SCOPE, BUDGET);

    expect(ctx.session).toEqual(freshSession);
  });

  it("reads session with tier 'session' and sessionId qualifier", async () => {
    await manager.load(SCOPE, BUDGET);

    const readCall = vi.mocked(provider.read).mock.calls[0]!;
    expectKeyShape(readCall[0] as StorageKey, "session", SCOPE.sessionId);
  });

  it("reverses provider's desc list to produce chronological conversation", async () => {
    const turns = [makeTurn(3), makeTurn(2), makeTurn(1)]; // desc from provider
    vi.mocked(provider.list).mockImplementation(async (key: StorageKey) => {
      if (key.tier === "conversation") return turns;
      return [];
    });

    const ctx = await manager.load(SCOPE, BUDGET);

    expect(ctx.conversation.map((t) => t.turnId)).toEqual([
      "turn-1",
      "turn-2",
      "turn-3",
    ]);
  });

  it("lists conversation with tier 'conversation', order 'desc'", async () => {
    await manager.load(SCOPE, BUDGET);

    const listCalls = vi.mocked(provider.list).mock.calls;
    const convCall = listCalls.find(
      ([key]) => (key as StorageKey).tier === "conversation",
    );
    expect(convCall).toBeDefined();
    expect(convCall![1].order).toBe("desc");
  });

  it("excludes decayed facts from userFacts", async () => {
    const active = makeUserFact("name", 0.9, 1.0);
    const decayed = makeUserFact("city", 0.1, 0.8, /* decayed */ true);
    vi.mocked(provider.list).mockImplementation(async (key: StorageKey) => {
      if (key.tier === "user_profile") return [active, decayed];
      return [];
    });

    const ctx = await manager.load(SCOPE, BUDGET);

    expect(ctx.userFacts).toHaveLength(1);
    expect(ctx.userFacts[0]!.key).toBe("name");
  });

  it("sorts userFacts by importance × confidence descending", async () => {
    // low importance × high confidence vs high importance × low confidence
    const highScore = makeUserFact("name", 0.9, 1.0);    // 0.9
    const midScore  = makeUserFact("city", 0.5, 0.8);    // 0.4
    const lowScore  = makeUserFact("pref", 0.3, 0.15);   // 0.045
    // provider returns in arbitrary order
    vi.mocked(provider.list).mockImplementation(async (key: StorageKey) => {
      if (key.tier === "user_profile") return [lowScore, highScore, midScore];
      return [];
    });

    const ctx = await manager.load(SCOPE, BUDGET);

    expect(ctx.userFacts.map((f) => f.key)).toEqual(["name", "city", "pref"]);
  });

  it("populates toolSummary from the most recent tool execution record", async () => {
    const record = makeToolRecord();
    vi.mocked(provider.list).mockImplementation(async (key: StorageKey) => {
      if (key.tier === "tool_execution") return [record];
      return [];
    });

    const ctx = await manager.load(SCOPE, BUDGET);

    expect(ctx.toolSummary).toContain("url_shortener");
    expect(ctx.toolSummary).toContain("success");
    expect(ctx.toolSummary).toContain("42ms");
  });

  it("includes error string in toolSummary when record has error", async () => {
    const record = makeToolRecord({ error: "timeout" });
    vi.mocked(provider.list).mockImplementation(async (key: StorageKey) => {
      if (key.tier === "tool_execution") return [record];
      return [];
    });

    const ctx = await manager.load(SCOPE, BUDGET);

    expect(ctx.toolSummary).toContain("timeout");
  });

  it("lists tool_execution with limit 1 and order 'desc'", async () => {
    await manager.load(SCOPE, BUDGET);

    const listCalls = vi.mocked(provider.list).mock.calls;
    const toolCall = listCalls.find(
      ([key]) => (key as StorageKey).tier === "tool_execution",
    );
    expect(toolCall).toBeDefined();
    expect(toolCall![1].limit).toBe(1);
    expect(toolCall![1].order).toBe("desc");
  });

  it("budgetUsed > 0 and budgetRemaining < total when data is present", async () => {
    vi.mocked(provider.read).mockResolvedValueOnce(SESSION);

    const ctx = await manager.load(SCOPE, BUDGET);

    expect(ctx.budgetUsed).toBeGreaterThan(0);
    expect(ctx.budgetRemaining).toBeLessThan(
      BUDGET.modelProfile.usableContextTokens,
    );
    expect(ctx.budgetUsed + ctx.budgetRemaining).toBe(
      BUDGET.modelProfile.usableContextTokens,
    );
  });

  it("budgetRemaining is never negative", async () => {
    // Flood with a very large conversation to exceed the budget
    const manyTurns = Array.from({ length: 200 }, (_, i) => makeTurn(i));
    vi.mocked(provider.list).mockImplementation(async (key: StorageKey) => {
      if (key.tier === "conversation") return manyTurns;
      return [];
    });

    const ctx = await manager.load(SCOPE, BUDGET);

    expect(ctx.budgetRemaining).toBeGreaterThanOrEqual(0);
  });

  it("returns empty context when one tier read throws (graceful degradation)", async () => {
    vi.mocked(provider.read).mockRejectedValue(new Error("db error"));
    // list still succeeds for conversation tier
    const turns = [makeTurn(1)];
    vi.mocked(provider.list).mockImplementation(async (key: StorageKey) => {
      if (key.tier === "conversation") return turns;
      return [];
    });

    const ctx = await manager.load(SCOPE, BUDGET);

    // session degraded to null; conversation still present
    expect(ctx.session).toBeNull();
    expect(ctx.conversation).toHaveLength(1);
  });

  it("returns empty context without throwing when all reads throw", async () => {
    vi.mocked(provider.read).mockRejectedValue(new Error("storage down"));
    vi.mocked(provider.list).mockRejectedValue(new Error("storage down"));

    await expect(manager.load(SCOPE, BUDGET)).resolves.toMatchObject({
      session: null,
      conversation: [],
      userFacts: [],
      toolSummary: null,
    });
  });
});

// ---------------------------------------------------------------------------
// record() tests
// ---------------------------------------------------------------------------

describe("DefaultMemoryManager.record()", () => {
  let provider: StorageProvider;
  let manager: DefaultMemoryManager;

  beforeEach(() => {
    provider = makeFakeProvider();
    manager = new DefaultMemoryManager(provider);
  });

  it("calls provider.write for session update", async () => {
    await manager.record(SCOPE, { session: { userMood: "happy" } });

    expect(provider.write).toHaveBeenCalledOnce();
    const [key, value] = vi.mocked(provider.write).mock.calls[0]!;
    expectKeyShape(key as StorageKey, "session", SCOPE.sessionId);
    expect(value).toMatchObject({ userMood: "happy" });
  });

  it("calls provider.append for conversation turn", async () => {
    const turn = makeTurn(1);
    await manager.record(SCOPE, { conversationTurn: turn });

    expect(provider.append).toHaveBeenCalledOnce();
    const [key, value] = vi.mocked(provider.append).mock.calls[0]!;
    expectKeyShape(key as StorageKey, "conversation");
    expect(value).toEqual(turn);
  });

  it("calls provider.upsert once per user fact, keyed by fact.key", async () => {
    const facts = [
      makeUserFact("name", 0.9, 1.0),
      makeUserFact("city", 0.8, 0.8),
    ];
    await manager.record(SCOPE, { userFacts: facts });

    expect(provider.upsert).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(provider.upsert).mock.calls;

    // Both calls should target the user_profile tier
    expectKeyShape(calls[0]![0] as StorageKey, "user_profile");
    expectKeyShape(calls[1]![0] as StorageKey, "user_profile");

    // Entry keys must match the fact key
    expect(calls[0]![1]).toBe("name");
    expect(calls[1]![1]).toBe("city");
  });

  it("calls provider.append once per tool output", async () => {
    const records = [makeToolRecord(), makeToolRecord()];
    await manager.record(SCOPE, { toolOutputs: records });

    expect(provider.append).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(provider.append).mock.calls;
    expectKeyShape(calls[0]![0] as StorageKey, "tool_execution");
    expectKeyShape(calls[1]![0] as StorageKey, "tool_execution");
  });

  it("calls all provider methods when updates contains all fields", async () => {
    await manager.record(SCOPE, {
      session: { userMood: "calm" },
      conversationTurn: makeTurn(1),
      userFacts: [makeUserFact("name", 0.9, 1.0)],
      toolOutputs: [makeToolRecord()],
    });

    expect(provider.write).toHaveBeenCalledOnce();
    expect(provider.append).toHaveBeenCalledTimes(2); // turn + tool output
    expect(provider.upsert).toHaveBeenCalledOnce();
  });

  it("calls no provider methods when updates is empty", async () => {
    await manager.record(SCOPE, {});

    expect(provider.write).not.toHaveBeenCalled();
    expect(provider.append).not.toHaveBeenCalled();
    expect(provider.upsert).not.toHaveBeenCalled();
  });

  it("does not throw when provider.write rejects (best-effort)", async () => {
    vi.mocked(provider.write).mockRejectedValue(new Error("write failed"));

    await expect(
      manager.record(SCOPE, { session: { userMood: "sad" } }),
    ).resolves.toBeUndefined();
  });

  it("does not throw when provider.append rejects (best-effort)", async () => {
    vi.mocked(provider.append).mockRejectedValue(new Error("append failed"));

    await expect(
      manager.record(SCOPE, { conversationTurn: makeTurn(1) }),
    ).resolves.toBeUndefined();
  });

  it("does not throw when provider.upsert rejects (best-effort)", async () => {
    vi.mocked(provider.upsert).mockRejectedValue(new Error("upsert failed"));

    await expect(
      manager.record(SCOPE, { userFacts: [makeUserFact("name", 0.9, 1.0)] }),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// forget() tests
// ---------------------------------------------------------------------------

describe("DefaultMemoryManager.forget()", () => {
  let provider: StorageProvider;
  let manager: DefaultMemoryManager;

  beforeEach(() => {
    provider = makeFakeProvider();
    manager = new DefaultMemoryManager(provider);
  });

  it("calls provider.delete with the correct ScopePrefix", async () => {
    await manager.forget(SCOPE);

    expect(provider.delete).toHaveBeenCalledOnce();
    const arg = vi.mocked(provider.delete).mock.calls[0]![0] as ScopePrefix;
    expect(arg).toMatchObject({
      tenantId: SCOPE.tenantId,
      botId: SCOPE.botId,
      userId: SCOPE.userId,
    });
    // ScopePrefix must NOT include tier (that would be a StorageKey)
    expect(arg).not.toHaveProperty("tier");
  });

  it("throws MemoryError when provider.delete rejects", async () => {
    vi.mocked(provider.delete).mockRejectedValue(new Error("db error"));

    await expect(manager.forget(SCOPE)).rejects.toBeInstanceOf(MemoryError);
  });

  it("MemoryError carries operation 'forget'", async () => {
    vi.mocked(provider.delete).mockRejectedValue(new Error("db error"));

    const err = await manager.forget(SCOPE).catch((e: unknown) => e);

    expect((err as MemoryError).operation).toBe("forget");
  });

  it("MemoryError carries correct scope fields", async () => {
    vi.mocked(provider.delete).mockRejectedValue(new Error("db error"));

    const err = await manager.forget(SCOPE).catch((e: unknown) => e);

    expect((err as MemoryError).scope.tenantId).toBe(SCOPE.tenantId);
    expect((err as MemoryError).scope.botId).toBe(SCOPE.botId);
    expect((err as MemoryError).scope.userId).toBe(SCOPE.userId);
  });

  it("MemoryError wraps the original cause", async () => {
    const cause = new Error("storage failure");
    vi.mocked(provider.delete).mockRejectedValue(cause);

    const err = await manager.forget(SCOPE).catch((e: unknown) => e);

    expect((err as MemoryError).cause).toBe(cause);
  });
});

// ---------------------------------------------------------------------------
// health() tests
// ---------------------------------------------------------------------------

describe("DefaultMemoryManager.health()", () => {
  const ALL_TIERS: MemoryTierId[] = [
    "request",
    "session",
    "conversation",
    "user_profile",
    "tool_execution",
    "long_term_knowledge",
  ];

  let provider: StorageProvider;
  let manager: DefaultMemoryManager;

  beforeEach(() => {
    provider = makeFakeProvider();
    manager = new DefaultMemoryManager(provider);
  });

  it("returns status 'ok' when provider is healthy", async () => {
    vi.mocked(provider.health).mockResolvedValue("ok");

    const result = await manager.health();

    expect(result.status).toBe("ok");
  });

  it("sets all tier statuses to 'ok' when provider is healthy", async () => {
    vi.mocked(provider.health).mockResolvedValue("ok");

    const result = await manager.health();

    for (const tier of ALL_TIERS) {
      expect(result.tiers[tier]).toBe("ok");
    }
  });

  it("returns status 'degraded' when provider is degraded", async () => {
    vi.mocked(provider.health).mockResolvedValue("degraded");

    const result = await manager.health();

    expect(result.status).toBe("degraded");
    for (const tier of ALL_TIERS) {
      expect(result.tiers[tier]).toBe("degraded");
    }
  });

  it("returns status 'unavailable' when provider is unavailable", async () => {
    vi.mocked(provider.health).mockResolvedValue("unavailable");

    const result = await manager.health();

    expect(result.status).toBe("unavailable");
    for (const tier of ALL_TIERS) {
      expect(result.tiers[tier]).toBe("unavailable");
    }
  });

  it("MemoryHealthStatus.tiers contains exactly the six MemoryTierId values", async () => {
    const result = await manager.health();

    expect(Object.keys(result.tiers).sort()).toEqual([...ALL_TIERS].sort());
  });
});
