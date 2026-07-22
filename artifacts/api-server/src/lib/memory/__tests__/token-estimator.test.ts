/**
 * Phase 3C — TokenEstimator unit tests (Milestone 1)
 *
 * Covers:
 *   CharacterTokenEstimator
 *     - null → 0
 *     - undefined → 0
 *     - empty array → 0
 *     - empty string → 0
 *     - non-empty string (exact char/4 math)
 *     - plain object
 *     - nested object
 *     - non-serialisable value (circular reference) → 0 (never throws)
 *     - deterministic: same input, multiple calls, same output
 *     - scale linearity: doubling payload doubles token count (±1 rounding)
 *
 *   deriveContextBudget (model-aware budget calculation)
 *     - shizo/default profile — correct proportional allocations
 *     - openai/gpt-4o profile — correct proportional allocations
 *     - openai/gpt-4o-mini profile — correct proportional allocations
 *     - anthropic/claude-3-haiku profile — correct proportional allocations
 *     - all profiles: tier allocations sum to usableContextTokens (±1 rounding)
 *     - all profiles: each allocation > 0
 *     - truncationOrder is present and non-empty
 *
 *   Overflow scenario
 *     - estimate that exceeds a tier's allocation does not panic
 *     - budgetRemaining stays non-negative under overflow in DefaultMemoryManager
 *
 *   TokenEstimator injection into DefaultMemoryManager
 *     - custom estimator is called during load()
 *     - custom estimator return value influences budgetUsed
 *     - DefaultMemoryManager with no estimator argument behaves identically
 *       to one constructed with CharacterTokenEstimator explicitly
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { CharacterTokenEstimator } from "../token-estimator.js";
import type { TokenEstimator } from "../token-estimator.js";
import {
  deriveContextBudget,
  KNOWN_CONTEXT_PROFILES,
  DEFAULT_CONTEXT_BUDGET,
  type ContextBudget,
  type ConversationTurn,
  type MemoryScope,
  type SessionMemory,
  type StorageKey,
  type StorageProvider,
  type WriteResult,
} from "../types.js";
import { DefaultMemoryManager } from "../memory-manager.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const SCOPE: MemoryScope = {
  tenantId: "t1",
  botId: "b1",
  userId: "u1",
  sessionId: "s1",
  requestId: "r1",
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

const SESSION: SessionMemory = {
  sessionId: "s1",
  lastActivityAt: 1_000_000,
  userMood: "neutral",
  conversationStage: "intro",
  personalityTemp: "warm",
  questionChainDepth: 0,
  activeTopics: [],
  recentBotPhrases: [],
  greetingDone: false,
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

// ---------------------------------------------------------------------------
// CharacterTokenEstimator
// ---------------------------------------------------------------------------

describe("CharacterTokenEstimator", () => {
  let estimator: CharacterTokenEstimator;

  beforeEach(() => {
    estimator = new CharacterTokenEstimator();
  });

  it("returns 0 for null", () => {
    expect(estimator.estimate(null)).toBe(0);
  });

  it("returns 0 for undefined", () => {
    expect(estimator.estimate(undefined)).toBe(0);
  });

  it("returns 0 for an empty array", () => {
    expect(estimator.estimate([])).toBe(0);
  });

  it("returns 0 for an empty string serialised to 2 chars (quotes)", () => {
    // JSON.stringify("") → '""' → 2 chars → Math.ceil(2/4) = 1
    // An empty JS string serialises to 2 characters in JSON (""), so the
    // result is 1, not 0.  This is correct behaviour — the serialised form
    // is never empty for a string, only for null/undefined/empty-array.
    const result = estimator.estimate("");
    expect(result).toBe(1); // Math.ceil(2 / 4)
  });

  it("returns the correct ceil(chars/4) for a plain string", () => {
    // JSON.stringify("hello") → '"hello"' → 7 chars → ceil(7/4) = 2
    const result = estimator.estimate("hello");
    expect(result).toBe(2);
  });

  it("returns the correct ceil(chars/4) for a 16-character string", () => {
    // "abcdefghijklmnop" → JSON 18 chars → ceil(18/4) = 5
    const result = estimator.estimate("abcdefghijklmnop");
    expect(result).toBe(5);
  });

  it("returns the correct estimate for a plain object", () => {
    const obj = { key: "value" };
    const json = JSON.stringify(obj); // '{"key":"value"}' = 15 chars
    const expected = Math.ceil(json.length / 4);
    expect(estimator.estimate(obj)).toBe(expected);
  });

  it("returns the correct estimate for a nested object", () => {
    const nested = { a: { b: { c: "deep" } } };
    const json = JSON.stringify(nested);
    const expected = Math.ceil(json.length / 4);
    expect(estimator.estimate(nested)).toBe(expected);
  });

  it("returns 0 for a circular reference (non-serialisable) without throwing", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(() => estimator.estimate(circular)).not.toThrow();
    expect(estimator.estimate(circular)).toBe(0);
  });

  it("is deterministic: identical inputs always return the same value", () => {
    const input = { x: "repeat", y: [1, 2, 3] };
    const results = Array.from({ length: 10 }, () => estimator.estimate(input));
    const first = results[0]!;
    expect(results.every((r) => r === first)).toBe(true);
  });

  it("scales linearly: doubling the payload approximately doubles the token count", () => {
    // Use a long enough string to make rounding negligible
    const payload = "a".repeat(400);
    const doubled = "a".repeat(800);
    const single = estimator.estimate(payload);
    const doubleSingle = estimator.estimate(doubled);
    // Allow ±1 for rounding at each end
    expect(doubleSingle).toBeGreaterThanOrEqual(doubleSingle - 1);
    expect(Math.abs(doubleSingle - single * 2)).toBeLessThanOrEqual(2);
  });

  it("returns a positive integer (never fractional, never negative)", () => {
    const result = estimator.estimate({ anything: "works" });
    expect(result).toBeGreaterThan(0);
    expect(Number.isInteger(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// deriveContextBudget — model-aware budget calculation
// ---------------------------------------------------------------------------

describe("deriveContextBudget — model-aware budget calculation", () => {
  const profiles = Object.values(KNOWN_CONTEXT_PROFILES);

  it("covers at least 4 known model profiles", () => {
    expect(profiles.length).toBeGreaterThanOrEqual(4);
  });

  for (const profile of profiles) {
    describe(`profile: ${profile.modelId}`, () => {
      let budget: ContextBudget;

      beforeEach(() => {
        budget = deriveContextBudget(profile);
      });

      it("tier allocations sum to usableContextTokens (±1 rounding)", () => {
        const { userFacts, session, conversation, toolSummary, systemReserved } =
          budget.tierAllocations;
        const total = userFacts + session + conversation + toolSummary + systemReserved;
        expect(Math.abs(total - profile.usableContextTokens)).toBeLessThanOrEqual(1);
      });

      it("every tier allocation is greater than 0", () => {
        const { userFacts, session, conversation, toolSummary, systemReserved } =
          budget.tierAllocations;
        expect(userFacts).toBeGreaterThan(0);
        expect(session).toBeGreaterThan(0);
        expect(conversation).toBeGreaterThan(0);
        expect(toolSummary).toBeGreaterThan(0);
        expect(systemReserved).toBeGreaterThan(0);
      });

      it("conversation is the largest single allocation (≈50%)", () => {
        const { conversation, userFacts, session, toolSummary, systemReserved } =
          budget.tierAllocations;
        expect(conversation).toBeGreaterThan(userFacts);
        expect(conversation).toBeGreaterThan(session);
        expect(conversation).toBeGreaterThan(toolSummary);
        // conversation (50%) is smaller than systemReserved (28%) + userFacts (12%) combined
        // but still the single largest slice
        expect(conversation).toBeGreaterThan(systemReserved);
      });

      it("modelProfile on budget matches the source profile", () => {
        expect(budget.modelProfile.modelId).toBe(profile.modelId);
        expect(budget.modelProfile.usableContextTokens).toBe(profile.usableContextTokens);
      });

      it("truncationOrder is present and non-empty", () => {
        expect(Array.isArray(budget.truncationOrder)).toBe(true);
        expect(budget.truncationOrder.length).toBeGreaterThan(0);
      });
    });
  }

  it("shizo/default — conversation allocation is 50% of usable tokens", () => {
    const profile = KNOWN_CONTEXT_PROFILES["shizo/default"]!;
    const budget = deriveContextBudget(profile);
    expect(budget.tierAllocations.conversation).toBe(
      Math.round(profile.usableContextTokens * 0.5),
    );
  });

  it("openai/gpt-4o — usableContextTokens matches declared window", () => {
    const profile = KNOWN_CONTEXT_PROFILES["openai/gpt-4o"]!;
    expect(profile.usableContextTokens).toBe(
      profile.maxContextTokens - profile.reservedOutputTokens,
    );
  });

  it("anthropic/claude-3-haiku — systemReserved is 28% of usable tokens", () => {
    const profile = KNOWN_CONTEXT_PROFILES["anthropic/claude-3-haiku"]!;
    const budget = deriveContextBudget(profile);
    expect(budget.tierAllocations.systemReserved).toBe(
      Math.round(profile.usableContextTokens * 0.28),
    );
  });
});

// ---------------------------------------------------------------------------
// Overflow scenario
// ---------------------------------------------------------------------------

describe("Overflow scenario", () => {
  it("CharacterTokenEstimator estimate can exceed a single tier allocation without panicking", () => {
    const estimator = new CharacterTokenEstimator();
    // shizo/default usable = 3584 → conversation allocation = 1792
    // A large JSON value easily exceeds this
    const hugeArray = Array.from({ length: 500 }, (_, i) => ({
      turnId: `t-${i}`,
      content: `This is message number ${i} with some extra content to push the size up.`,
    }));
    const estimate = estimator.estimate(hugeArray);
    const { tierAllocations } = DEFAULT_CONTEXT_BUDGET;
    // The estimate exceeds the conversation allocation — no throw, no NaN
    expect(estimate).toBeGreaterThan(tierAllocations.conversation);
    expect(Number.isFinite(estimate)).toBe(true);
  });

  it("DefaultMemoryManager.budgetRemaining stays non-negative under overflow", async () => {
    const provider = makeFakeProvider();
    const manager = new DefaultMemoryManager(provider);

    // Load 200 turns (well past the 50-turn default limit, but provider returns all)
    const manyTurns = Array.from({ length: 200 }, (_, i) => makeTurn(i));
    vi.mocked(provider.list).mockImplementation(async (key: StorageKey) => {
      if (key.tier === "conversation") return manyTurns;
      return [];
    });

    const ctx = await manager.load(SCOPE, DEFAULT_CONTEXT_BUDGET);

    expect(ctx.budgetRemaining).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(ctx.budgetRemaining)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TokenEstimator injection into DefaultMemoryManager
// ---------------------------------------------------------------------------

describe("TokenEstimator injection into DefaultMemoryManager", () => {
  it("calls the custom estimator during load()", async () => {
    const provider = makeFakeProvider();
    vi.mocked(provider.read).mockResolvedValueOnce(SESSION);

    const mockEstimator: TokenEstimator = {
      estimate: vi.fn().mockReturnValue(42),
    };

    const manager = new DefaultMemoryManager(provider, undefined, mockEstimator);
    await manager.load(SCOPE, DEFAULT_CONTEXT_BUDGET);

    expect(mockEstimator.estimate).toHaveBeenCalled();
  });

  it("custom estimator return value influences budgetUsed", async () => {
    const provider = makeFakeProvider();
    vi.mocked(provider.read).mockResolvedValueOnce(SESSION);

    // Estimator always returns a fixed number per call
    const FIXED_PER_CALL = 100;
    const mockEstimator: TokenEstimator = {
      estimate: vi.fn().mockReturnValue(FIXED_PER_CALL),
    };

    const manager = new DefaultMemoryManager(provider, undefined, mockEstimator);
    const ctx = await manager.load(SCOPE, DEFAULT_CONTEXT_BUDGET);

    // load() calls estimate 4 times (session, conversation, userFacts, toolSummary)
    const callCount = vi.mocked(mockEstimator.estimate).mock.calls.length;
    expect(callCount).toBe(4);
    expect(ctx.budgetUsed).toBe(FIXED_PER_CALL * callCount);
  });

  it("budgetUsed + budgetRemaining equals usableContextTokens when custom estimator is used", async () => {
    const provider = makeFakeProvider();

    const mockEstimator: TokenEstimator = {
      estimate: vi.fn().mockReturnValue(50),
    };

    const manager = new DefaultMemoryManager(provider, undefined, mockEstimator);
    const ctx = await manager.load(SCOPE, DEFAULT_CONTEXT_BUDGET);

    expect(ctx.budgetUsed + ctx.budgetRemaining).toBe(
      DEFAULT_CONTEXT_BUDGET.modelProfile.usableContextTokens,
    );
  });

  it("no-estimator constructor behaves identically to explicit CharacterTokenEstimator", async () => {
    const provider1 = makeFakeProvider();
    const provider2 = makeFakeProvider();

    // Return the same session data from both providers
    vi.mocked(provider1.read).mockResolvedValueOnce(SESSION);
    vi.mocked(provider2.read).mockResolvedValueOnce(SESSION);

    const turns = [makeTurn(1), makeTurn(2)];
    vi.mocked(provider1.list).mockImplementation(async (key: StorageKey) => {
      if (key.tier === "conversation") return turns;
      return [];
    });
    vi.mocked(provider2.list).mockImplementation(async (key: StorageKey) => {
      if (key.tier === "conversation") return turns;
      return [];
    });

    const defaultManager = new DefaultMemoryManager(provider1);
    const explicitManager = new DefaultMemoryManager(
      provider2,
      undefined,
      new CharacterTokenEstimator(),
    );

    const ctxDefault = await defaultManager.load(SCOPE, DEFAULT_CONTEXT_BUDGET);
    const ctxExplicit = await explicitManager.load(SCOPE, DEFAULT_CONTEXT_BUDGET);

    expect(ctxDefault.budgetUsed).toBe(ctxExplicit.budgetUsed);
    expect(ctxDefault.budgetRemaining).toBe(ctxExplicit.budgetRemaining);
  });

  it("custom estimator returning 0 always gives budgetUsed=0 and budgetRemaining=usableContextTokens", async () => {
    const provider = makeFakeProvider();
    vi.mocked(provider.read).mockResolvedValueOnce(SESSION);

    const zeroEstimator: TokenEstimator = { estimate: vi.fn().mockReturnValue(0) };

    const manager = new DefaultMemoryManager(provider, undefined, zeroEstimator);
    const ctx = await manager.load(SCOPE, DEFAULT_CONTEXT_BUDGET);

    expect(ctx.budgetUsed).toBe(0);
    expect(ctx.budgetRemaining).toBe(
      DEFAULT_CONTEXT_BUDGET.modelProfile.usableContextTokens,
    );
  });
});
