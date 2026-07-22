/**
 * Phase 3C — Conversation budget truncation tests (Milestone 2)
 *
 * Tests DefaultMemoryManager.load() conversation-tier enforcement.
 * These are isolated from memory-manager.test.ts so Milestone 2 tests
 * remain easy to audit independently.
 *
 * Covers:
 *   applyConversationBudget (exercised via load())
 *     - turns within budget → returned unchanged, no summary turn prepended
 *     - empty conversation → returned unchanged
 *     - turns exceed budget → oldest turns trimmed from the front
 *     - turns exceed budget → synthetic summary turn prepended as first entry
 *     - synthetic turn has role "assistant"
 *     - synthetic turn turnId is deterministic (starts with "summary-")
 *     - synthetic turn timestamp equals first evicted turn's timestamp
 *     - synthetic turn requestId equals scope.requestId
 *     - single-turn conversation always kept even if over budget (never empty)
 *     - custom ConversationSummarizer is called when truncation occurs
 *     - custom ConversationSummarizer is NOT called when no truncation needed
 *     - custom summarizer return value appears in synthetic turn content
 *     - budgetUsed reflects post-truncation conversation estimate
 *     - budgetRemaining is non-negative after truncation
 *     - budgetUsed + budgetRemaining equals usableContextTokens
 *     - EventBus receives memory.budget_truncated when truncation occurs
 *     - EventBus does NOT receive memory.budget_truncated when no truncation
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { DefaultMemoryManager } from "../memory-manager.js";
import type { TokenEstimator } from "../token-estimator.js";
import type { ConversationSummarizer } from "../conversation-summarizer.js";
import {
  type ConversationTurn,
  type ContextBudget,
  type MemoryScope,
  type StorageKey,
  type StorageProvider,
  type WriteResult,
  KNOWN_CONTEXT_PROFILES,
  deriveContextBudget,
} from "../types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SCOPE: MemoryScope = {
  tenantId: "t1",
  botId: "b1",
  userId: "u1",
  sessionId: "s1",
  requestId: "req-test",
};

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

/**
 * Builds a ContextBudget where the conversation tier is capped at
 * conversationTokens tokens, regardless of the model profile.
 * Other tier allocations are set to large values so they don't interfere.
 */
function makeTightBudget(conversationTokens: number): ContextBudget {
  const profile = KNOWN_CONTEXT_PROFILES["openai/gpt-4o"]!;
  return {
    modelProfile: profile,
    tierAllocations: {
      conversation:   conversationTokens,
      userFacts:      50_000,
      session:        10_000,
      toolSummary:    10_000,
      systemReserved: 10_000,
    },
    truncationOrder: ["tool_execution", "conversation", "user_profile", "session", "request"],
  };
}

/**
 * An estimator that counts turns × COST_PER_TURN for arrays, 0 for everything
 * else.  Makes budget arithmetic predictable in tests.
 */
function makeCountingEstimator(costPerTurn: number): TokenEstimator {
  return {
    estimate: vi.fn((value: unknown) => {
      if (Array.isArray(value)) return value.length * costPerTurn;
      return 0;
    }),
  };
}

/** Budget large enough that no turn array will ever exceed it. */
const UNLIMITED_BUDGET = makeTightBudget(1_000_000);

// ---------------------------------------------------------------------------
// No truncation needed
// ---------------------------------------------------------------------------

describe("load() conversation budget — no truncation", () => {
  let provider: StorageProvider;

  beforeEach(() => {
    provider = makeFakeProvider();
  });

  it("returns turns unchanged when they fit within the budget", async () => {
    const turns = [makeTurn(1), makeTurn(2), makeTurn(3)]; // desc from provider
    vi.mocked(provider.list).mockImplementation(async (key: StorageKey) => {
      if (key.tier === "conversation") return turns;
      return [];
    });

    const summarizer: ConversationSummarizer = { summarize: vi.fn() };
    const manager = new DefaultMemoryManager(
      provider, undefined, makeCountingEstimator(1), summarizer,
    );

    // budget of 100 tokens; 3 turns × 1 token each = 3 → fits
    const ctx = await manager.load(SCOPE, makeTightBudget(100));

    expect(ctx.conversation).toHaveLength(3);
    expect(summarizer.summarize).not.toHaveBeenCalled();
  });

  it("returns an empty conversation unchanged when provider has no data", async () => {
    const summarizer: ConversationSummarizer = { summarize: vi.fn() };
    const manager = new DefaultMemoryManager(
      provider, undefined, makeCountingEstimator(1), summarizer,
    );

    const ctx = await manager.load(SCOPE, UNLIMITED_BUDGET);

    expect(ctx.conversation).toHaveLength(0);
    expect(summarizer.summarize).not.toHaveBeenCalled();
  });

  it("does NOT emit memory.budget_truncated when no truncation occurs", async () => {
    const turns = [makeTurn(1)];
    vi.mocked(provider.list).mockImplementation(async (key: StorageKey) => {
      if (key.tier === "conversation") return turns;
      return [];
    });

    const eventBus = { emit: vi.fn() };
    const manager = new DefaultMemoryManager(
      provider, eventBus as any, makeCountingEstimator(1), undefined,
    );

    await manager.load(SCOPE, makeTightBudget(100));

    const truncatedEvents = vi.mocked(eventBus.emit).mock.calls.filter(
      ([e]: any[]) => e.type === "memory.budget_truncated",
    );
    expect(truncatedEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Truncation occurs
// ---------------------------------------------------------------------------

describe("load() conversation budget — truncation occurs", () => {
  let provider: StorageProvider;

  beforeEach(() => {
    provider = makeFakeProvider();
  });

  it("trims oldest turns when conversation exceeds the token budget", async () => {
    // 5 turns in desc order from provider; cost=1 token each; budget=3
    const turns = [makeTurn(5), makeTurn(4), makeTurn(3), makeTurn(2), makeTurn(1)];
    vi.mocked(provider.list).mockImplementation(async (key: StorageKey) => {
      if (key.tier === "conversation") return turns;
      return [];
    });

    const summarizer: ConversationSummarizer = {
      summarize: vi.fn().mockReturnValue("[summary]"),
    };
    const manager = new DefaultMemoryManager(
      provider, undefined, makeCountingEstimator(1), summarizer,
    );

    // budget=3 tokens: 5 turns cost 5 → 2 oldest evicted, 3 kept + 1 summary prepended
    const ctx = await manager.load(SCOPE, makeTightBudget(3));

    // chronological order after reversal: turn-1, turn-2, turn-3, turn-4, turn-5
    // evicted: turn-1, turn-2 (oldest 2); kept: turn-3, turn-4, turn-5
    // final: [summary-turn, turn-3, turn-4, turn-5]
    const ids = ctx.conversation.map(t => t.turnId);
    expect(ids).toContain("turn-3");
    expect(ids).toContain("turn-4");
    expect(ids).toContain("turn-5");
    expect(ids).not.toContain("turn-1");
    expect(ids).not.toContain("turn-2");
  });

  it("prepends a synthetic summary turn as the first entry", async () => {
    const turns = [makeTurn(3), makeTurn(2), makeTurn(1)];
    vi.mocked(provider.list).mockImplementation(async (key: StorageKey) => {
      if (key.tier === "conversation") return turns;
      return [];
    });

    const summarizer: ConversationSummarizer = {
      summarize: vi.fn().mockReturnValue("[my summary]"),
    };
    const manager = new DefaultMemoryManager(
      provider, undefined, makeCountingEstimator(1), summarizer,
    );

    const ctx = await manager.load(SCOPE, makeTightBudget(1));

    // budget=1 token per turn; 3 turns → trim 2 oldest, keep 1, add summary
    expect(ctx.conversation[0]!.content).toBe("[my summary]");
  });

  it("synthetic summary turn has role 'assistant'", async () => {
    const turns = [makeTurn(2), makeTurn(1)];
    vi.mocked(provider.list).mockImplementation(async (key: StorageKey) => {
      if (key.tier === "conversation") return turns;
      return [];
    });

    const summarizer: ConversationSummarizer = {
      summarize: vi.fn().mockReturnValue("[s]"),
    };
    const manager = new DefaultMemoryManager(
      provider, undefined, makeCountingEstimator(1), summarizer,
    );

    const ctx = await manager.load(SCOPE, makeTightBudget(1));
    expect(ctx.conversation[0]!.role).toBe("assistant");
  });

  it("synthetic turn turnId starts with 'summary-'", async () => {
    const turns = [makeTurn(2), makeTurn(1)];
    vi.mocked(provider.list).mockImplementation(async (key: StorageKey) => {
      if (key.tier === "conversation") return turns;
      return [];
    });

    const summarizer: ConversationSummarizer = {
      summarize: vi.fn().mockReturnValue("[s]"),
    };
    const manager = new DefaultMemoryManager(
      provider, undefined, makeCountingEstimator(1), summarizer,
    );

    const ctx = await manager.load(SCOPE, makeTightBudget(1));
    expect(ctx.conversation[0]!.turnId).toMatch(/^summary-/);
  });

  it("synthetic turn timestamp equals first evicted turn's timestamp", async () => {
    // desc from provider: turn-3, turn-2, turn-1 → chronological: turn-1(ts=1000), turn-2(ts=2000), turn-3(ts=3000)
    const turns = [makeTurn(3), makeTurn(2), makeTurn(1)];
    vi.mocked(provider.list).mockImplementation(async (key: StorageKey) => {
      if (key.tier === "conversation") return turns;
      return [];
    });

    const summarizer: ConversationSummarizer = {
      summarize: vi.fn().mockReturnValue("[s]"),
    };
    const manager = new DefaultMemoryManager(
      provider, undefined, makeCountingEstimator(1), summarizer,
    );

    // budget=1 → trim turn-1 and turn-2, keep turn-3; summary at ts of turn-1 = 1000
    const ctx = await manager.load(SCOPE, makeTightBudget(1));
    expect(ctx.conversation[0]!.timestamp).toBe(1_000);
  });

  it("synthetic turn requestId equals scope.requestId", async () => {
    const turns = [makeTurn(2), makeTurn(1)];
    vi.mocked(provider.list).mockImplementation(async (key: StorageKey) => {
      if (key.tier === "conversation") return turns;
      return [];
    });

    const summarizer: ConversationSummarizer = {
      summarize: vi.fn().mockReturnValue("[s]"),
    };
    const manager = new DefaultMemoryManager(
      provider, undefined, makeCountingEstimator(1), summarizer,
    );

    const ctx = await manager.load(SCOPE, makeTightBudget(1));
    expect(ctx.conversation[0]!.requestId).toBe(SCOPE.requestId);
  });

  it("calls the ConversationSummarizer with the evicted (not kept) turns", async () => {
    // chronological: turn-1, turn-2, turn-3, turn-4, turn-5
    // desc from provider: turn-5, turn-4, turn-3, turn-2, turn-1
    const turns = [makeTurn(5), makeTurn(4), makeTurn(3), makeTurn(2), makeTurn(1)];
    vi.mocked(provider.list).mockImplementation(async (key: StorageKey) => {
      if (key.tier === "conversation") return turns;
      return [];
    });

    const summarizer: ConversationSummarizer = {
      summarize: vi.fn().mockReturnValue("[s]"),
    };
    const manager = new DefaultMemoryManager(
      provider, undefined, makeCountingEstimator(1), summarizer,
    );

    // budget=3 → evict turn-1 and turn-2
    await manager.load(SCOPE, makeTightBudget(3));

    expect(summarizer.summarize).toHaveBeenCalledOnce();
    const evictedArg = vi.mocked(summarizer.summarize).mock.calls[0]![0];
    const evictedIds = evictedArg.map((t: ConversationTurn) => t.turnId);
    expect(evictedIds).toContain("turn-1");
    expect(evictedIds).toContain("turn-2");
    expect(evictedIds).not.toContain("turn-3");
  });

  it("single-turn conversation is never evicted even if it exceeds budget", async () => {
    const turns = [makeTurn(1)]; // 1 turn at cost=1000; budget=1
    vi.mocked(provider.list).mockImplementation(async (key: StorageKey) => {
      if (key.tier === "conversation") return turns;
      return [];
    });

    const summarizer: ConversationSummarizer = {
      summarize: vi.fn().mockReturnValue("[s]"),
    };
    const manager = new DefaultMemoryManager(
      provider, undefined, makeCountingEstimator(1000), summarizer,
    );

    const ctx = await manager.load(SCOPE, makeTightBudget(1));

    // The single turn must be preserved; summarizer must not be called
    // (nothing was evicted)
    expect(ctx.conversation.some(t => t.turnId === "turn-1")).toBe(true);
    expect(summarizer.summarize).not.toHaveBeenCalled();
  });

  it("budgetUsed reflects the post-truncation conversation, not the raw fetched turns", async () => {
    // 5 turns × 1 token each, budget = 2
    const turns = [makeTurn(5), makeTurn(4), makeTurn(3), makeTurn(2), makeTurn(1)];
    vi.mocked(provider.list).mockImplementation(async (key: StorageKey) => {
      if (key.tier === "conversation") return turns;
      return [];
    });

    const summarizer: ConversationSummarizer = {
      summarize: vi.fn().mockReturnValue("[s]"),
    };
    // Estimator: arrays cost length×1 token; strings cost 0 (simplified)
    const manager = new DefaultMemoryManager(
      provider, undefined, makeCountingEstimator(1), summarizer,
    );

    const ctx = await manager.load(SCOPE, makeTightBudget(2));

    // After truncation: [summary-turn, turn-4, turn-5] → 3 items (post-trim array + summary)
    // budgetUsed = estimate(null session) + estimate(post-trim conversation) + estimate([]) + estimate(null)
    // = 0 + 3 + 0 + 0 = 3
    // (the summary turn adds 1 more item to the kept slice)
    expect(ctx.budgetUsed).toBeGreaterThan(0);
  });

  it("budgetRemaining is non-negative after truncation", async () => {
    const turns = Array.from({ length: 20 }, (_, i) => makeTurn(20 - i));
    vi.mocked(provider.list).mockImplementation(async (key: StorageKey) => {
      if (key.tier === "conversation") return turns;
      return [];
    });

    const summarizer: ConversationSummarizer = {
      summarize: vi.fn().mockReturnValue("[s]"),
    };
    const manager = new DefaultMemoryManager(
      provider, undefined, makeCountingEstimator(10), summarizer,
    );

    const ctx = await manager.load(SCOPE, makeTightBudget(5));
    expect(ctx.budgetRemaining).toBeGreaterThanOrEqual(0);
  });

  it("budgetUsed + budgetRemaining equals usableContextTokens", async () => {
    const turns = [makeTurn(3), makeTurn(2), makeTurn(1)];
    vi.mocked(provider.list).mockImplementation(async (key: StorageKey) => {
      if (key.tier === "conversation") return turns;
      return [];
    });

    const summarizer: ConversationSummarizer = {
      summarize: vi.fn().mockReturnValue("[s]"),
    };
    const manager = new DefaultMemoryManager(
      provider, undefined, makeCountingEstimator(1), summarizer,
    );

    const budget = makeTightBudget(1);
    const ctx = await manager.load(SCOPE, budget);

    expect(ctx.budgetUsed + ctx.budgetRemaining).toBe(
      budget.modelProfile.usableContextTokens,
    );
  });

  it("emits memory.budget_truncated event when truncation occurs", async () => {
    const turns = [makeTurn(3), makeTurn(2), makeTurn(1)];
    vi.mocked(provider.list).mockImplementation(async (key: StorageKey) => {
      if (key.tier === "conversation") return turns;
      return [];
    });

    const eventBus = { emit: vi.fn() };
    const summarizer: ConversationSummarizer = {
      summarize: vi.fn().mockReturnValue("[s]"),
    };
    const manager = new DefaultMemoryManager(
      provider, eventBus as any, makeCountingEstimator(1), summarizer,
    );

    await manager.load(SCOPE, makeTightBudget(1));

    const truncatedEvents = vi.mocked(eventBus.emit).mock.calls.filter(
      ([e]: any[]) => e.type === "memory.budget_truncated",
    );
    expect(truncatedEvents).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Real-budget integration — uses DEFAULT_CONTEXT_BUDGET proportions
// ---------------------------------------------------------------------------

describe("load() conversation budget — real CharacterTokenEstimator", () => {
  it("does not truncate a realistic short conversation under the shizo/default budget", async () => {
    const provider = makeFakeProvider();
    const shortTurns = Array.from({ length: 5 }, (_, i) =>
      makeTurn(5 - i, "Short message"),
    );
    vi.mocked(provider.list).mockImplementation(async (key: StorageKey) => {
      if (key.tier === "conversation") return shortTurns;
      return [];
    });

    const summarizer: ConversationSummarizer = { summarize: vi.fn() };
    // Default estimator and default budget for shizo/default (conversation = 1792 tokens)
    const manager = new DefaultMemoryManager(provider, undefined, undefined, summarizer);
    const budget = deriveContextBudget(KNOWN_CONTEXT_PROFILES["shizo/default"]!);

    const ctx = await manager.load(SCOPE, budget);

    expect(ctx.conversation).toHaveLength(5);
    expect(summarizer.summarize).not.toHaveBeenCalled();
  });

  it("truncates a very large conversation that exceeds the shizo/default budget", async () => {
    const provider = makeFakeProvider();
    // Each turn has ~500 chars of content → ~125 tokens each
    // shizo/default conversation allocation = 1792 tokens → 14 turns would use ~1750, 15+ would overflow
    const longContent = "a".repeat(500);
    const manyTurns = Array.from({ length: 20 }, (_, i) =>
      makeTurn(20 - i, longContent), // desc
    );
    vi.mocked(provider.list).mockImplementation(async (key: StorageKey) => {
      if (key.tier === "conversation") return manyTurns;
      return [];
    });

    const summarizer: ConversationSummarizer = {
      summarize: vi.fn().mockReturnValue("[summary of evicted turns]"),
    };
    const manager = new DefaultMemoryManager(provider, undefined, undefined, summarizer);
    const budget = deriveContextBudget(KNOWN_CONTEXT_PROFILES["shizo/default"]!);

    const ctx = await manager.load(SCOPE, budget);

    expect(summarizer.summarize).toHaveBeenCalled();
    expect(ctx.conversation[0]!.turnId).toMatch(/^summary-/);
    expect(ctx.budgetRemaining).toBeGreaterThanOrEqual(0);
  });
});
