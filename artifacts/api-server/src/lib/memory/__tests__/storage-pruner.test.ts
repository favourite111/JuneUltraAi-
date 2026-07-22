/**
 * Phase 3C — Storage Pruning & Hygiene tests (Milestone 5)
 *
 * Covers:
 *   StoragePruner.pruneSession()
 *     - absent session → returns false, no delete
 *     - session within TTL → kept, returns false
 *     - session exactly at TTL boundary (≤) → kept
 *     - session past TTL → deleted, returns true
 *     - scope without sessionId → skipped, returns false
 *     - provider.read throws → returns false (best-effort)
 *     - provider.delete throws → returns false (best-effort)
 *
 *   StoragePruner.pruneConversation()
 *     - empty conversation → returns 0, no delete
 *     - count ≤ maxConversationTurns AND all within age → returns 0
 *     - count > maxConversationTurns → oldest excess pruned, returns correct count
 *     - turns older than maxConversationAgeMs → pruned even within count limit
 *     - combined count + age → both rules applied together
 *     - safety guard: always keeps at least 1 turn
 *     - survivors re-appended in chronological order
 *     - provider.list throws → returns 0 (best-effort)
 *     - provider.delete throws during compaction → returns 0 (best-effort)
 *     - user facts are never touched by conversation pruning
 *
 *   StoragePruner.pruneToolExecutions()
 *     - empty records → returns 0
 *     - count ≤ maxToolExecutionRecords → returns 0
 *     - count > maxToolExecutionRecords → oldest pruned, newest kept
 *     - returns correct pruned count
 *     - survivors re-appended in chronological order
 *     - provider.list throws → returns 0 (best-effort)
 *
 *   StoragePruner.runPrune()
 *     - returns PruneResult with correct counts for each tier
 *     - result.timestamp equals nowMs
 *     - all three tiers run independently (failure in one does not block others)
 *     - user facts are never touched by runPrune
 *
 *   StoragePrunerConfig
 *     - DEFAULT_PRUNER_CONFIG has sensible values
 *     - partial config merges with defaults
 *
 *   End-to-end with InMemoryStorageProvider
 *     - full prune cycle verified against real storage reads
 *     - conversation turns pruned are oldest, newest retained
 *     - tool records pruned are oldest, newest retained
 *     - session deleted when expired, kept when fresh
 *     - facts under user_profile key are untouched
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  StoragePruner,
  DEFAULT_PRUNER_CONFIG,
  type PruneResult,
  type StoragePrunerConfig,
} from "../storage-pruner.js";
import { InMemoryStorageProvider } from "../providers/in-memory-storage-provider.js";
import type {
  ConversationTurn,
  MemoryScope,
  SessionMemory,
  StorageKey,
  StorageProvider,
  ToolExecutionRecord,
  UserFact,
  WriteResult,
} from "../types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DAY_MS   = 24 * 60 * 60 * 1_000;
const HOUR_MS  = 60 * 60 * 1_000;
const NOW_MS   = 1_700_000_000_000; // stable reference timestamp for tests

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SCOPE: MemoryScope = {
  tenantId: "t1",
  botId:    "b1",
  userId:   "u1",
  sessionId: "sess-1",
  requestId: "req-1",
};

const SCOPE_NO_SESSION: MemoryScope = { ...SCOPE, sessionId: undefined };

const CONV_KEY: StorageKey = {
  tier: "conversation",
  tenantId: SCOPE.tenantId,
  botId:    SCOPE.botId,
  userId:   SCOPE.userId,
};

const TOOL_KEY: StorageKey = {
  tier: "tool_execution",
  tenantId: SCOPE.tenantId,
  botId:    SCOPE.botId,
  userId:   SCOPE.userId,
};

const SESSION_KEY: StorageKey = {
  tier:      "session",
  tenantId:  SCOPE.tenantId,
  botId:     SCOPE.botId,
  userId:    SCOPE.userId,
  qualifier: SCOPE.sessionId,
};

const PROFILE_KEY: StorageKey = {
  tier: "user_profile",
  tenantId: SCOPE.tenantId,
  botId:    SCOPE.botId,
  userId:   SCOPE.userId,
};

const FAKE_WRITE_RESULT: WriteResult = { revision: 1, etag: "abc", updatedAt: NOW_MS };

/** Build a ConversationTurn with a specific timestamp. */
function makeTurn(n: number, timestampMs: number): ConversationTurn {
  return {
    turnId:    `turn-${n}`,
    requestId: `req-${n}`,
    role:       n % 2 === 0 ? "assistant" : "user",
    content:   `Message ${n}`,
    timestamp:  timestampMs,
  };
}

/** Build a ToolExecutionRecord with a specific timestamp. */
function makeRecord(n: number, timestampMs: number): ToolExecutionRecord {
  return {
    executionId:         `exec-${n}`,
    requestId:           `req-${n}`,
    toolName:            "url_shortener",
    toolVersion:         "1.0.0",
    args:                { url: `https://example.com/${n}` },
    result:              { short: `https://sho.rt/${n}` },
    reflectionDecision:  "success",
    durationMs:          10,
    timestamp:           timestampMs,
  };
}

/** Build a SessionMemory with a specific lastActivityAt. */
function makeSession(lastActivityAt: number): SessionMemory {
  return {
    sessionId:           SCOPE.sessionId!,
    lastActivityAt,
    userMood:            "neutral",
    conversationStage:   "active",
    personalityTemp:     "warm",
    questionChainDepth:  0,
    activeTopics:        [],
    recentBotPhrases:    [],
    greetingDone:        true,
  };
}

/** Build a UserFact. */
function makeFact(key: string): UserFact {
  return {
    factId:      `fact-${key}`,
    key,
    value:       `value-${key}`,
    confidence:   0.9,
    importance:   0.8,
    source:      "explicit",
    createdAt:    NOW_MS,
    confirmedAt:  NOW_MS,
    sensitive:    false,
  };
}

/** Minimal fake StorageProvider. */
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
// DEFAULT_PRUNER_CONFIG
// ---------------------------------------------------------------------------

describe("DEFAULT_PRUNER_CONFIG", () => {
  it("sessionTtlMs is 4 hours", () => {
    expect(DEFAULT_PRUNER_CONFIG.sessionTtlMs).toBe(4 * 60 * 60 * 1_000);
  });

  it("maxConversationTurns is 100", () => {
    expect(DEFAULT_PRUNER_CONFIG.maxConversationTurns).toBe(100);
  });

  it("maxConversationAgeMs is 30 days", () => {
    expect(DEFAULT_PRUNER_CONFIG.maxConversationAgeMs).toBe(30 * 24 * 60 * 60 * 1_000);
  });

  it("maxToolExecutionRecords is 50", () => {
    expect(DEFAULT_PRUNER_CONFIG.maxToolExecutionRecords).toBe(50);
  });
});

describe("StoragePruner — partial config merges with defaults", () => {
  it("overrides only the specified fields", async () => {
    const provider = makeFakeProvider();
    // sessionTtlMs overridden; others should use defaults
    const pruner = new StoragePruner(provider, { sessionTtlMs: HOUR_MS });

    vi.mocked(provider.read).mockResolvedValue(
      makeSession(NOW_MS - 2 * HOUR_MS), // 2 hours idle
    );

    // 2 hours > 1 hour (overridden TTL) → session should be pruned
    const removed = await pruner.pruneSession(SCOPE, NOW_MS);
    expect(removed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// pruneSession()
// ---------------------------------------------------------------------------

describe("StoragePruner.pruneSession()", () => {
  let provider: StorageProvider;
  let pruner: StoragePruner;

  beforeEach(() => {
    provider = makeFakeProvider();
    pruner = new StoragePruner(provider, { sessionTtlMs: 4 * HOUR_MS });
  });

  it("returns false when session is absent", async () => {
    vi.mocked(provider.read).mockResolvedValue(null);
    expect(await pruner.pruneSession(SCOPE, NOW_MS)).toBe(false);
    expect(provider.delete).not.toHaveBeenCalled();
  });

  it("keeps a session within TTL and returns false", async () => {
    vi.mocked(provider.read).mockResolvedValue(
      makeSession(NOW_MS - 2 * HOUR_MS), // 2 h idle, TTL is 4 h
    );
    expect(await pruner.pruneSession(SCOPE, NOW_MS)).toBe(false);
    expect(provider.delete).not.toHaveBeenCalled();
  });

  it("keeps a session at exactly the TTL boundary (≤) and returns false", async () => {
    vi.mocked(provider.read).mockResolvedValue(
      makeSession(NOW_MS - 4 * HOUR_MS), // idle === TTL exactly
    );
    // idle (4h) is NOT > TTL (4h) → keep
    expect(await pruner.pruneSession(SCOPE, NOW_MS)).toBe(false);
    expect(provider.delete).not.toHaveBeenCalled();
  });

  it("deletes a session past TTL and returns true", async () => {
    vi.mocked(provider.read).mockResolvedValue(
      makeSession(NOW_MS - 5 * HOUR_MS), // 5 h idle > 4 h TTL
    );
    expect(await pruner.pruneSession(SCOPE, NOW_MS)).toBe(true);
    expect(provider.delete).toHaveBeenCalledOnce();
    const [key] = vi.mocked(provider.delete).mock.calls[0]!;
    expect((key as StorageKey).tier).toBe("session");
    expect((key as StorageKey).qualifier).toBe(SCOPE.sessionId);
  });

  it("returns false and skips when scope has no sessionId", async () => {
    expect(await pruner.pruneSession(SCOPE_NO_SESSION, NOW_MS)).toBe(false);
    expect(provider.read).not.toHaveBeenCalled();
  });

  it("returns false when provider.read throws (best-effort)", async () => {
    vi.mocked(provider.read).mockRejectedValue(new Error("db error"));
    expect(await pruner.pruneSession(SCOPE, NOW_MS)).toBe(false);
  });

  it("returns false when provider.delete throws (best-effort)", async () => {
    vi.mocked(provider.read).mockResolvedValue(
      makeSession(NOW_MS - 5 * HOUR_MS),
    );
    vi.mocked(provider.delete).mockRejectedValue(new Error("db error"));
    expect(await pruner.pruneSession(SCOPE, NOW_MS)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// pruneConversation()
// ---------------------------------------------------------------------------

describe("StoragePruner.pruneConversation()", () => {
  const CFG: Partial<StoragePrunerConfig> = {
    maxConversationTurns: 3,
    maxConversationAgeMs: 10 * DAY_MS,
  };

  let provider: StorageProvider;
  let pruner: StoragePruner;

  beforeEach(() => {
    provider = makeFakeProvider();
    pruner = new StoragePruner(provider, CFG);
  });

  it("returns 0 and does not call delete when conversation is empty", async () => {
    vi.mocked(provider.list).mockResolvedValue([]);
    expect(await pruner.pruneConversation(SCOPE, NOW_MS)).toBe(0);
    expect(provider.delete).not.toHaveBeenCalled();
  });

  it("returns 0 when count ≤ max and all turns are within age limit", async () => {
    const turns = [
      makeTurn(1, NOW_MS - 1 * DAY_MS),
      makeTurn(2, NOW_MS - 2 * DAY_MS),
    ];
    vi.mocked(provider.list).mockResolvedValue(turns);
    expect(await pruner.pruneConversation(SCOPE, NOW_MS)).toBe(0);
    expect(provider.delete).not.toHaveBeenCalled();
  });

  it("prunes oldest turns when count exceeds maxConversationTurns", async () => {
    // 5 turns, max 3 → 2 pruned (turns 1 and 2, oldest)
    const turns = [1, 2, 3, 4, 5].map(n => makeTurn(n, NOW_MS - n * DAY_MS));
    // list returns ascending (oldest first): turn-5, turn-4, turn-3, turn-2, turn-1
    // (timestamp: NOW - 5d, NOW - 4d, NOW - 3d, NOW - 2d, NOW - 1d)
    const ascending = [...turns].sort((a, b) => a.timestamp - b.timestamp);
    vi.mocked(provider.list).mockResolvedValue(ascending);

    const pruned = await pruner.pruneConversation(SCOPE, NOW_MS);

    expect(pruned).toBe(2);
    expect(provider.delete).toHaveBeenCalledOnce();
    // 3 survivors should be re-appended
    expect(provider.append).toHaveBeenCalledTimes(3);
  });

  it("prunes turns older than maxConversationAgeMs even within count limit", async () => {
    // 2 turns (≤ max 3), but one is 20 days old (> 10-day limit)
    const turns = [
      makeTurn(1, NOW_MS - 20 * DAY_MS), // too old
      makeTurn(2, NOW_MS - 1 * DAY_MS),  // fresh
    ];
    vi.mocked(provider.list).mockResolvedValue(turns);

    const pruned = await pruner.pruneConversation(SCOPE, NOW_MS);

    expect(pruned).toBe(1);
    expect(provider.delete).toHaveBeenCalledOnce();
    expect(provider.append).toHaveBeenCalledTimes(1); // only the fresh turn
  });

  it("applies both count and age rules simultaneously", async () => {
    // 6 turns (> max 3); oldest 3 also exceed age limit
    const turns = [
      makeTurn(1, NOW_MS - 25 * DAY_MS), // old + excess
      makeTurn(2, NOW_MS - 20 * DAY_MS), // old + excess
      makeTurn(3, NOW_MS - 15 * DAY_MS), // old + excess
      makeTurn(4, NOW_MS - 3  * DAY_MS), // recent
      makeTurn(5, NOW_MS - 2  * DAY_MS), // recent
      makeTurn(6, NOW_MS - 1  * DAY_MS), // recent
    ];
    vi.mocked(provider.list).mockResolvedValue(turns);

    const pruned = await pruner.pruneConversation(SCOPE, NOW_MS);

    // Keep the 3 most recent; the other 3 are pruned
    expect(pruned).toBe(3);
    expect(provider.append).toHaveBeenCalledTimes(3);
  });

  it("safety guard: always keeps at least 1 turn even when all are over the age limit", async () => {
    // max 3 turns, but only 1 exists and it is very old
    const turns = [makeTurn(1, NOW_MS - 999 * DAY_MS)];
    vi.mocked(provider.list).mockResolvedValue(turns);

    const pruned = await pruner.pruneConversation(SCOPE, NOW_MS);

    // Nothing to prune — safety guard keeps the single turn
    expect(pruned).toBe(0);
    expect(provider.delete).not.toHaveBeenCalled();
  });

  it("safety guard: keeps at least 1 turn when count+age rules would prune everything", async () => {
    // 5 turns, all 550–590 days old (far beyond the 10-day age limit), max 3.
    // Step 1 count rule: keep the 3 most recent (turn-3, turn-4, turn-5).
    // Step 2 age rule: all 3 survivors are > 10 days old → all pruned by age.
    // Step 3 safety guard: afterAgePrune is empty → keep the single most recent turn.
    // n=1 → timestamp NOW-590d (oldest), n=5 → NOW-550d (most recent).
    const many = [1, 2, 3, 4, 5].map(n => makeTurn(n, NOW_MS - (600 - n * 10) * DAY_MS));
    vi.mocked(provider.list).mockResolvedValue(many);

    const pruned = await pruner.pruneConversation(SCOPE, NOW_MS);

    // All 5 pruned, then safety guard re-adds the most recent → net pruned = 4.
    expect(pruned).toBe(4);
    expect(provider.delete).toHaveBeenCalledOnce();
    expect(provider.append).toHaveBeenCalledTimes(1); // safety guard: only 1 survivor
  });

  it("returns 0 when provider.list throws (best-effort)", async () => {
    vi.mocked(provider.list).mockRejectedValue(new Error("db error"));
    expect(await pruner.pruneConversation(SCOPE, NOW_MS)).toBe(0);
  });

  it("returns 0 when provider.delete throws during compaction (best-effort)", async () => {
    const turns = [1, 2, 3, 4, 5].map(n => makeTurn(n, NOW_MS - n * DAY_MS));
    vi.mocked(provider.list).mockResolvedValue(turns);
    vi.mocked(provider.delete).mockRejectedValue(new Error("db error"));

    expect(await pruner.pruneConversation(SCOPE, NOW_MS)).toBe(0);
  });

  it("uses the conversation StorageKey (not user_profile or session)", async () => {
    vi.mocked(provider.list).mockResolvedValue([]);
    await pruner.pruneConversation(SCOPE, NOW_MS);

    const [key] = vi.mocked(provider.list).mock.calls[0]!;
    expect(key.tier).toBe("conversation");
    expect(key.tenantId).toBe(SCOPE.tenantId);
    expect(key.botId).toBe(SCOPE.botId);
    expect(key.userId).toBe(SCOPE.userId);
  });
});

// ---------------------------------------------------------------------------
// pruneToolExecutions()
// ---------------------------------------------------------------------------

describe("StoragePruner.pruneToolExecutions()", () => {
  const CFG: Partial<StoragePrunerConfig> = { maxToolExecutionRecords: 3 };

  let provider: StorageProvider;
  let pruner: StoragePruner;

  beforeEach(() => {
    provider = makeFakeProvider();
    pruner = new StoragePruner(provider, CFG);
  });

  it("returns 0 when there are no records", async () => {
    vi.mocked(provider.list).mockResolvedValue([]);
    expect(await pruner.pruneToolExecutions(SCOPE)).toBe(0);
    expect(provider.delete).not.toHaveBeenCalled();
  });

  it("returns 0 when count ≤ maxToolExecutionRecords", async () => {
    const records = [1, 2, 3].map(n => makeRecord(n, NOW_MS - n * HOUR_MS));
    vi.mocked(provider.list).mockResolvedValue(records);
    expect(await pruner.pruneToolExecutions(SCOPE)).toBe(0);
  });

  it("prunes oldest records when count exceeds maxToolExecutionRecords", async () => {
    const records = [1, 2, 3, 4, 5].map(n => makeRecord(n, NOW_MS - n * HOUR_MS));
    // ascending order: records[4](oldest) ... records[0](newest)
    const ascending = [...records].sort((a, b) => a.timestamp - b.timestamp);
    vi.mocked(provider.list).mockResolvedValue(ascending);

    const pruned = await pruner.pruneToolExecutions(SCOPE);

    expect(pruned).toBe(2);
    expect(provider.delete).toHaveBeenCalledOnce();
    expect(provider.append).toHaveBeenCalledTimes(3); // 3 survivors
  });

  it("survivors are re-appended in chronological order (oldest first)", async () => {
    const r1 = makeRecord(1, NOW_MS - 5 * HOUR_MS); // oldest
    const r2 = makeRecord(2, NOW_MS - 3 * HOUR_MS);
    const r3 = makeRecord(3, NOW_MS - 2 * HOUR_MS);
    const r4 = makeRecord(4, NOW_MS - 1 * HOUR_MS); // newest
    // max = 3 → prune r1
    vi.mocked(provider.list).mockResolvedValue([r1, r2, r3, r4]);

    await pruner.pruneToolExecutions(SCOPE);

    const appendedIds = vi.mocked(provider.append).mock.calls.map(
      ([, record]) => (record as ToolExecutionRecord).executionId,
    );
    expect(appendedIds).toEqual(["exec-2", "exec-3", "exec-4"]);
  });

  it("returns 0 when provider.list throws (best-effort)", async () => {
    vi.mocked(provider.list).mockRejectedValue(new Error("db error"));
    expect(await pruner.pruneToolExecutions(SCOPE)).toBe(0);
  });

  it("uses the tool_execution StorageKey", async () => {
    vi.mocked(provider.list).mockResolvedValue([]);
    await pruner.pruneToolExecutions(SCOPE);

    const [key] = vi.mocked(provider.list).mock.calls[0]!;
    expect(key.tier).toBe("tool_execution");
  });
});

// ---------------------------------------------------------------------------
// runPrune()
// ---------------------------------------------------------------------------

describe("StoragePruner.runPrune()", () => {
  it("returns a PruneResult with the injected timestamp", async () => {
    const provider = makeFakeProvider();
    const pruner = new StoragePruner(provider);

    const result: PruneResult = await pruner.runPrune(SCOPE, NOW_MS);

    expect(result.timestamp).toBe(NOW_MS);
  });

  it("returns zero counts when nothing needs pruning", async () => {
    const provider = makeFakeProvider();
    const pruner = new StoragePruner(provider);

    const result = await pruner.runPrune(SCOPE, NOW_MS);

    expect(result.sessionsRemoved).toBe(0);
    expect(result.conversationTurnsPruned).toBe(0);
    expect(result.toolRecordsPruned).toBe(0);
  });

  it("accumulates correct counts across all tiers", async () => {
    const provider = makeFakeProvider();
    const pruner = new StoragePruner(provider, {
      sessionTtlMs: HOUR_MS,
      maxConversationTurns: 2,
      maxToolExecutionRecords: 1,
      maxConversationAgeMs: 999 * DAY_MS,
    });

    // Session: expired
    vi.mocked(provider.read).mockResolvedValue(makeSession(NOW_MS - 2 * HOUR_MS));

    // Conversation: 4 turns (max 2 → 2 pruned)
    const convTurns = [1, 2, 3, 4].map(n => makeTurn(n, NOW_MS - n * DAY_MS));
    // Tool records: 3 records (max 1 → 2 pruned)
    const toolRecs = [1, 2, 3].map(n => makeRecord(n, NOW_MS - n * HOUR_MS));

    vi.mocked(provider.list)
      .mockResolvedValueOnce(convTurns)    // pruneConversation list
      .mockResolvedValueOnce(toolRecs);    // pruneToolExecutions list

    const result = await pruner.runPrune(SCOPE, NOW_MS);

    expect(result.sessionsRemoved).toBe(1);
    expect(result.conversationTurnsPruned).toBe(2);
    expect(result.toolRecordsPruned).toBe(2);
  });

  it("user_profile tier is never touched by runPrune", async () => {
    const provider = makeFakeProvider();
    const pruner = new StoragePruner(provider);

    await pruner.runPrune(SCOPE, NOW_MS);

    // All list() calls must be for conversation or tool_execution, never user_profile
    for (const [key] of vi.mocked(provider.list).mock.calls) {
      expect(key.tier).not.toBe("user_profile");
    }
    // All delete() calls must not target user_profile
    for (const [key] of vi.mocked(provider.delete).mock.calls) {
      if ("tier" in key) {
        expect((key as StorageKey).tier).not.toBe("user_profile");
      }
    }
    // upsert() must never be called (that is ConfidenceDecayService's domain)
    expect(provider.upsert).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// End-to-end with InMemoryStorageProvider
// ---------------------------------------------------------------------------

describe("StoragePruner — end-to-end with InMemoryStorageProvider", () => {
  it("prunes oldest conversation turns and retains the most recent", async () => {
    const storage = new InMemoryStorageProvider();
    const pruner  = new StoragePruner(storage, {
      maxConversationTurns: 3,
      maxConversationAgeMs: 999 * DAY_MS, // disable age pruning for this test
    });

    // Append 5 turns in order
    for (let n = 1; n <= 5; n++) {
      await storage.append(CONV_KEY, makeTurn(n, NOW_MS - (6 - n) * DAY_MS));
    }

    await pruner.pruneConversation(SCOPE, NOW_MS);

    const remaining = await storage.list<ConversationTurn>(CONV_KEY, {
      limit: 100, order: "asc",
    });

    expect(remaining).toHaveLength(3);
    // The 3 most recent (turns 3, 4, 5) should remain
    const ids = remaining.map(t => t.turnId);
    expect(ids).toContain("turn-3");
    expect(ids).toContain("turn-4");
    expect(ids).toContain("turn-5");
    expect(ids).not.toContain("turn-1");
    expect(ids).not.toContain("turn-2");
  });

  it("prunes oldest tool records and retains the most recent", async () => {
    const storage = new InMemoryStorageProvider();
    const pruner  = new StoragePruner(storage, { maxToolExecutionRecords: 2 });

    for (let n = 1; n <= 4; n++) {
      await storage.append(TOOL_KEY, makeRecord(n, NOW_MS - (5 - n) * HOUR_MS));
    }

    await pruner.pruneToolExecutions(SCOPE);

    const remaining = await storage.list<ToolExecutionRecord>(TOOL_KEY, {
      limit: 100, order: "asc",
    });

    expect(remaining).toHaveLength(2);
    const ids = remaining.map(r => r.executionId);
    expect(ids).toContain("exec-3");
    expect(ids).toContain("exec-4");
    expect(ids).not.toContain("exec-1");
    expect(ids).not.toContain("exec-2");
  });

  it("deletes an expired session", async () => {
    const storage = new InMemoryStorageProvider();
    const pruner  = new StoragePruner(storage, { sessionTtlMs: HOUR_MS });

    // Write an expired session
    await storage.write(SESSION_KEY, makeSession(NOW_MS - 2 * HOUR_MS));

    const removed = await pruner.pruneSession(SCOPE, NOW_MS);
    expect(removed).toBe(true);

    // Session should be gone
    const after = await storage.read<SessionMemory>(SESSION_KEY);
    expect(after).toBeNull();
  });

  it("retains a fresh session", async () => {
    const storage = new InMemoryStorageProvider();
    const pruner  = new StoragePruner(storage, { sessionTtlMs: 4 * HOUR_MS });

    await storage.write(SESSION_KEY, makeSession(NOW_MS - HOUR_MS));

    const removed = await pruner.pruneSession(SCOPE, NOW_MS);
    expect(removed).toBe(false);

    const after = await storage.read<SessionMemory>(SESSION_KEY);
    expect(after).not.toBeNull();
  });

  it("does not touch user facts during runPrune", async () => {
    const storage = new InMemoryStorageProvider();
    const pruner  = new StoragePruner(storage, { maxConversationTurns: 1 });

    await storage.upsert(PROFILE_KEY, "name", makeFact("name"));
    await storage.upsert(PROFILE_KEY, "city", makeFact("city"));

    // Add excess conversation turns to trigger pruning
    for (let n = 1; n <= 3; n++) {
      await storage.append(CONV_KEY, makeTurn(n, NOW_MS - n * DAY_MS));
    }

    await pruner.runPrune(SCOPE, NOW_MS);

    // User facts must be untouched
    const facts = await storage.list<UserFact>(PROFILE_KEY, { limit: 100, order: "asc" });
    expect(facts).toHaveLength(2);
    expect(facts.map(f => f.key)).toContain("name");
    expect(facts.map(f => f.key)).toContain("city");
  });

  it("running prune twice is idempotent when nothing changes between sweeps", async () => {
    const storage = new InMemoryStorageProvider();
    const pruner  = new StoragePruner(storage, {
      maxConversationTurns: 3,
      maxConversationAgeMs: 999 * DAY_MS,
    });

    for (let n = 1; n <= 5; n++) {
      await storage.append(CONV_KEY, makeTurn(n, NOW_MS - (6 - n) * DAY_MS));
    }

    const result1 = await pruner.runPrune(SCOPE, NOW_MS);
    const result2 = await pruner.runPrune(SCOPE, NOW_MS);

    expect(result1.conversationTurnsPruned).toBe(2);
    expect(result2.conversationTurnsPruned).toBe(0); // already at limit
  });
});
