/**
 * Phase 3C — Confidence Decay & Memory Hygiene tests (Milestone 4)
 *
 * Covers:
 *   computeDecayedConfidence()
 *     - returns storedConfidence unchanged when no time has elapsed
 *     - returns storedConfidence × 0.5 after exactly halfLifeDays
 *     - returns storedConfidence × 0.25 after 2 × halfLifeDays
 *     - result is never negative (clamped to 0)
 *     - very old facts approach but never go below 0
 *     - deterministic: same inputs always produce same output
 *     - clock skew (nowMs < confirmedAt) treated as fresh — no decay
 *
 *   ConfidenceDecayService.runDecaySweep()
 *     - fact above threshold → not decayed, no upsert, no event
 *     - fact below threshold → decayed: true, upsert called, event emitted
 *     - fact at exactly minimumConfidence boundary (==) → NOT decayed (strict <)
 *     - already-decayed fact → skipped: no upsert, no event (deduplication)
 *     - multiple facts: only threshold-crossers are updated
 *     - returns correct DecaySweepResult (processed, decayed, timestamp)
 *     - injectable nowMs makes sweeps deterministic
 *     - emitted event carries correct factId, key, finalConfidence, timestamp
 *     - importance is never modified
 *     - confidence in storage is updated to decayed value (not original)
 *     - runDecaySweep does not alter facts stored under other user scopes
 *
 *   MemoryManager integration
 *     - load() excludes facts marked decayed: true (existing behaviour preserved)
 *     - decayed fact updated by sweep is excluded from next load()
 *
 *   End-to-end with InMemoryStorageProvider
 *     - full sweep cycle: write facts → sweep → verify decayed in storage
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  computeDecayedConfidence,
  ConfidenceDecayService,
  type DecaySweepResult,
} from "../confidence-decay.js";
import { InMemoryStorageProvider } from "../providers/in-memory-storage-provider.js";
import { DefaultMemoryManager } from "../memory-manager.js";
import {
  DEFAULT_CONFIDENCE_DECAY,
  DEFAULT_CONTEXT_BUDGET,
  type ConfidenceDecayConfig,
  type MemoryScope,
  type StorageKey,
  type StorageProvider,
  type UserFact,
  type WriteResult,
} from "../types.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1_000;

const CONFIG: ConfidenceDecayConfig = {
  halfLifeDays: 180,
  minimumConfidence: 0.2,
  decayCheckIntervalDays: 7,
};

const SCOPE: MemoryScope = {
  tenantId: "t1",
  botId: "b1",
  userId: "u1",
  requestId: "req-1",
};

const USER_PROFILE_KEY: StorageKey = {
  tier: "user_profile",
  tenantId: SCOPE.tenantId,
  botId: SCOPE.botId,
  userId: SCOPE.userId,
};

/** A fixed reference time used across tests as "now". */
const NOW_MS = 1_700_000_000_000; // 2023-11-14T22:13:20.000Z — arbitrary but stable

function makeFact(
  key: string,
  opts: {
    confidence?: number;
    importance?: number;
    confirmedAt?: number;
    decayed?: boolean;
  } = {},
): UserFact {
  return {
    factId: `fact-${key}`,
    key,
    value: `value-of-${key}`,
    confidence: opts.confidence ?? 0.9,
    importance: opts.importance ?? 0.8,
    source: "explicit",
    createdAt: NOW_MS - DAY_MS * 400,
    confirmedAt: opts.confirmedAt ?? NOW_MS - DAY_MS * 400, // ~400 days old by default
    sensitive: false,
    decayed: opts.decayed ?? false,
  };
}

const FAKE_WRITE_RESULT: WriteResult = {
  revision: 1,
  etag: "abc",
  updatedAt: NOW_MS,
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

// ---------------------------------------------------------------------------
// computeDecayedConfidence() — pure formula
// ---------------------------------------------------------------------------

describe("computeDecayedConfidence()", () => {
  it("returns storedConfidence unchanged when no time has elapsed (0 days)", () => {
    const result = computeDecayedConfidence(0.9, NOW_MS, NOW_MS, CONFIG);
    expect(result).toBe(0.9);
  });

  it("returns storedConfidence unchanged when nowMs === confirmedAt", () => {
    const result = computeDecayedConfidence(0.7, NOW_MS, NOW_MS, CONFIG);
    expect(result).toBeCloseTo(0.7, 10);
  });

  it("returns storedConfidence × 0.5 after exactly halfLifeDays have elapsed", () => {
    const confirmedAt = NOW_MS - CONFIG.halfLifeDays * DAY_MS;
    const result = computeDecayedConfidence(1.0, confirmedAt, NOW_MS, CONFIG);
    expect(result).toBeCloseTo(0.5, 10);
  });

  it("returns storedConfidence × 0.5 for non-unit confidence after one half-life", () => {
    const confirmedAt = NOW_MS - CONFIG.halfLifeDays * DAY_MS;
    const result = computeDecayedConfidence(0.8, confirmedAt, NOW_MS, CONFIG);
    expect(result).toBeCloseTo(0.4, 10);
  });

  it("returns storedConfidence × 0.25 after 2 × halfLifeDays", () => {
    const confirmedAt = NOW_MS - 2 * CONFIG.halfLifeDays * DAY_MS;
    const result = computeDecayedConfidence(1.0, confirmedAt, NOW_MS, CONFIG);
    expect(result).toBeCloseTo(0.25, 10);
  });

  it("returns storedConfidence × 0.125 after 3 × halfLifeDays", () => {
    const confirmedAt = NOW_MS - 3 * CONFIG.halfLifeDays * DAY_MS;
    const result = computeDecayedConfidence(1.0, confirmedAt, NOW_MS, CONFIG);
    expect(result).toBeCloseTo(0.125, 10);
  });

  it("result is never negative — clamped to 0 for extremely old facts", () => {
    const confirmedAt = NOW_MS - 1_000 * CONFIG.halfLifeDays * DAY_MS; // 1000 half-lives
    const result = computeDecayedConfidence(0.9, confirmedAt, NOW_MS, CONFIG);
    expect(result).toBeGreaterThanOrEqual(0);
  });

  it("result never exceeds storedConfidence", () => {
    const confirmedAt = NOW_MS - CONFIG.halfLifeDays * DAY_MS;
    const result = computeDecayedConfidence(0.6, confirmedAt, NOW_MS, CONFIG);
    expect(result).toBeLessThanOrEqual(0.6);
  });

  it("is deterministic — same inputs always produce same output", () => {
    const confirmedAt = NOW_MS - 50 * DAY_MS;
    const runs = Array.from({ length: 20 }, () =>
      computeDecayedConfidence(0.85, confirmedAt, NOW_MS, CONFIG),
    );
    const first = runs[0]!;
    expect(runs.every(r => r === first)).toBe(true);
  });

  it("treats clock skew (nowMs < confirmedAt) as zero elapsed days — no decay", () => {
    // confirmedAt is in the future relative to nowMs
    const result = computeDecayedConfidence(0.9, NOW_MS + DAY_MS, NOW_MS, CONFIG);
    expect(result).toBe(0.9);
  });

  it("produces monotonically decreasing confidence as time increases", () => {
    const confirmedAt = NOW_MS - 0;
    const scores = [0, 30, 90, 180, 360, 720].map(days =>
      computeDecayedConfidence(1.0, confirmedAt, confirmedAt + days * DAY_MS, CONFIG),
    );
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]!).toBeLessThanOrEqual(scores[i - 1]!);
    }
  });

  it("uses halfLifeDays from config — different configs produce different results", () => {
    const fastDecay: ConfidenceDecayConfig = { ...CONFIG, halfLifeDays: 30 };
    const slowDecay: ConfidenceDecayConfig = { ...CONFIG, halfLifeDays: 360 };
    const confirmedAt = NOW_MS - 90 * DAY_MS;

    const fast = computeDecayedConfidence(1.0, confirmedAt, NOW_MS, fastDecay);
    const slow = computeDecayedConfidence(1.0, confirmedAt, NOW_MS, slowDecay);

    expect(fast).toBeLessThan(slow);
  });
});

// ---------------------------------------------------------------------------
// ConfidenceDecayService.runDecaySweep() — unit tests with fake provider
// ---------------------------------------------------------------------------

describe("ConfidenceDecayService.runDecaySweep() — unit", () => {
  let provider: StorageProvider;
  let eventBus: { emit: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    provider = makeFakeProvider();
    eventBus = { emit: vi.fn() };
  });

  // -- Fact above threshold —------------------------------------------------

  it("does not update or emit for a fact whose decayed confidence stays above threshold", async () => {
    // confirmedAt = NOW_MS (just confirmed) → no decay at all
    const freshFact = makeFact("name", { confidence: 0.9, confirmedAt: NOW_MS });
    vi.mocked(provider.list).mockResolvedValue([freshFact]);

    const service = new ConfidenceDecayService(provider, CONFIG, eventBus as any);
    const result = await service.runDecaySweep(SCOPE, NOW_MS);

    expect(provider.upsert).not.toHaveBeenCalled();
    expect(eventBus.emit).not.toHaveBeenCalled();
    expect(result.processed).toBe(1);
    expect(result.decayed).toBe(0);
  });

  // -- Fact below threshold —-------------------------------------------------

  it("marks a sufficiently old fact as decayed, calls upsert, emits event", async () => {
    // 400 days old → confidence 0.9 × 0.5^(400/180) ≈ 0.171 < 0.2 threshold
    const oldFact = makeFact("city", { confidence: 0.9, confirmedAt: NOW_MS - 400 * DAY_MS });
    vi.mocked(provider.list).mockResolvedValue([oldFact]);

    const service = new ConfidenceDecayService(provider, CONFIG, eventBus as any);
    const result = await service.runDecaySweep(SCOPE, NOW_MS);

    // Upsert must have been called with the updated fact
    expect(provider.upsert).toHaveBeenCalledOnce();
    const [upsertKey, entryKey, updatedFact] = vi.mocked(provider.upsert).mock.calls[0]!;
    expect(upsertKey.tier).toBe("user_profile");
    expect(entryKey).toBe("city");
    expect((updatedFact as UserFact).decayed).toBe(true);
    expect((updatedFact as UserFact).confidence).toBeLessThan(CONFIG.minimumConfidence);

    // Event must have been emitted
    expect(eventBus.emit).toHaveBeenCalledOnce();
    const event = eventBus.emit.mock.calls[0]![0];
    expect(event.type).toBe("memory.fact_decayed");
    expect(event.payload.factId).toBe(oldFact.factId);
    expect(event.payload.key).toBe("city");
    expect(event.payload.finalConfidence).toBeLessThan(CONFIG.minimumConfidence);
    expect(event.payload.timestamp).toBe(NOW_MS);

    expect(result.processed).toBe(1);
    expect(result.decayed).toBe(1);
  });

  // -- Threshold boundary — strict < ----------------------------------------

  it("does NOT decay a fact whose decayed confidence equals minimumConfidence exactly", async () => {
    // Craft a fact where decayed confidence lands exactly at minimumConfidence.
    // At exactly halfLife × log2(conf / minConf) days, the result equals minConf.
    // Use a simpler approach: set confirmedAt so decayed == 0.2 exactly.
    // conf × 0.5^(d / 180) = 0.2 → d = 180 × log2(conf / 0.2)
    const storedConf = 0.4;
    // 0.4 × 0.5^(days/180) = 0.2 → 0.5^(days/180) = 0.5 → days = 180
    const daysToExact = CONFIG.halfLifeDays * Math.log2(storedConf / CONFIG.minimumConfidence);
    const confirmedAt = NOW_MS - daysToExact * DAY_MS;

    const fact = makeFact("lang", { confidence: storedConf, confirmedAt });
    vi.mocked(provider.list).mockResolvedValue([fact]);

    const service = new ConfidenceDecayService(provider, CONFIG, eventBus as any);
    await service.runDecaySweep(SCOPE, NOW_MS);

    // Decayed confidence is exactly 0.2, which is NOT < 0.2 → no decay
    expect(provider.upsert).not.toHaveBeenCalled();
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  // -- Already-decayed deduplication ----------------------------------------

  it("skips already-decayed facts — no upsert, no event", async () => {
    const alreadyDecayed = makeFact("occupation", { decayed: true });
    vi.mocked(provider.list).mockResolvedValue([alreadyDecayed]);

    const service = new ConfidenceDecayService(provider, CONFIG, eventBus as any);
    const result = await service.runDecaySweep(SCOPE, NOW_MS);

    expect(provider.upsert).not.toHaveBeenCalled();
    expect(eventBus.emit).not.toHaveBeenCalled();
    // Fact is counted as processed but not as newly decayed
    expect(result.processed).toBe(1);
    expect(result.decayed).toBe(0);
  });

  it("does not emit duplicate events when runDecaySweep is called twice on same data", async () => {
    // Simulate: first sweep sets decayed: true, second sweep sees decayed: true and skips.
    const oldFact = makeFact("city", { confidence: 0.9, confirmedAt: NOW_MS - 400 * DAY_MS });
    // First call returns the active fact; second call returns it with decayed: true.
    const updatedFact: UserFact = {
      ...oldFact,
      confidence: computeDecayedConfidence(0.9, oldFact.confirmedAt, NOW_MS, CONFIG),
      decayed: true,
    };
    vi.mocked(provider.list)
      .mockResolvedValueOnce([oldFact])
      .mockResolvedValueOnce([updatedFact]);

    const service = new ConfidenceDecayService(provider, CONFIG, eventBus as any);

    await service.runDecaySweep(SCOPE, NOW_MS);
    await service.runDecaySweep(SCOPE, NOW_MS);

    // Event emitted only once (first sweep), not twice
    expect(eventBus.emit).toHaveBeenCalledOnce();
  });

  // -- Multiple facts --------------------------------------------------------

  it("processes multiple facts and decays only those below threshold", async () => {
    const freshFact = makeFact("name", { confidence: 0.9, confirmedAt: NOW_MS });
    const oldFact1 = makeFact("city", { confidence: 0.9, confirmedAt: NOW_MS - 400 * DAY_MS });
    const oldFact2 = makeFact("country", { confidence: 0.9, confirmedAt: NOW_MS - 500 * DAY_MS });
    const alreadyDecayed = makeFact("hobby", { confidence: 0.05, decayed: true });

    vi.mocked(provider.list).mockResolvedValue([freshFact, oldFact1, oldFact2, alreadyDecayed]);

    const service = new ConfidenceDecayService(provider, CONFIG, eventBus as any);
    const result = await service.runDecaySweep(SCOPE, NOW_MS);

    // 2 facts newly decayed (city + country); name is fresh; hobby already decayed
    expect(result.processed).toBe(4);
    expect(result.decayed).toBe(2);
    expect(provider.upsert).toHaveBeenCalledTimes(2);
    expect(eventBus.emit).toHaveBeenCalledTimes(2);
  });

  // -- DecaySweepResult —-----------------------------------------------------

  it("result.timestamp equals the nowMs argument", async () => {
    vi.mocked(provider.list).mockResolvedValue([]);

    const service = new ConfidenceDecayService(provider, CONFIG);
    const result = await service.runDecaySweep(SCOPE, NOW_MS);

    expect(result.timestamp).toBe(NOW_MS);
  });

  it("result.processed equals total fact count regardless of decay status", async () => {
    const facts = [
      makeFact("a", { confirmedAt: NOW_MS }),
      makeFact("b", { confirmedAt: NOW_MS - 400 * DAY_MS }),
      makeFact("c", { decayed: true }),
    ];
    vi.mocked(provider.list).mockResolvedValue(facts);

    const service = new ConfidenceDecayService(provider, CONFIG);
    const result = await service.runDecaySweep(SCOPE, NOW_MS);

    expect(result.processed).toBe(3);
  });

  it("result.decayed is 0 when no facts cross the threshold", async () => {
    const facts = [makeFact("a", { confirmedAt: NOW_MS }), makeFact("b", { confirmedAt: NOW_MS })];
    vi.mocked(provider.list).mockResolvedValue(facts);

    const service = new ConfidenceDecayService(provider, CONFIG);
    const result = await service.runDecaySweep(SCOPE, NOW_MS);

    expect(result.decayed).toBe(0);
  });

  // -- importance is never modified -----------------------------------------

  it("does not modify importance when decaying a fact", async () => {
    const fact = makeFact("city", { importance: 0.75, confirmedAt: NOW_MS - 400 * DAY_MS });
    vi.mocked(provider.list).mockResolvedValue([fact]);

    const service = new ConfidenceDecayService(provider, CONFIG, eventBus as any);
    await service.runDecaySweep(SCOPE, NOW_MS);

    const [, , updatedFact] = vi.mocked(provider.upsert).mock.calls[0]!;
    expect((updatedFact as UserFact).importance).toBe(0.75);
  });

  // -- Stored confidence is updated value ------------------------------------

  it("stores the decayed confidence value, not the original", async () => {
    const fact = makeFact("city", { confidence: 0.9, confirmedAt: NOW_MS - 400 * DAY_MS });
    const expectedDecayedConf = computeDecayedConfidence(0.9, fact.confirmedAt, NOW_MS, CONFIG);
    vi.mocked(provider.list).mockResolvedValue([fact]);

    const service = new ConfidenceDecayService(provider, CONFIG, eventBus as any);
    await service.runDecaySweep(SCOPE, NOW_MS);

    const [, , updatedFact] = vi.mocked(provider.upsert).mock.calls[0]!;
    expect((updatedFact as UserFact).confidence).toBeCloseTo(expectedDecayedConf, 10);
  });

  // -- Works without an EventBus --------------------------------------------

  it("completes successfully when no EventBus is provided", async () => {
    const fact = makeFact("city", { confidence: 0.9, confirmedAt: NOW_MS - 400 * DAY_MS });
    vi.mocked(provider.list).mockResolvedValue([fact]);

    const service = new ConfidenceDecayService(provider, CONFIG /* no eventBus */);
    await expect(service.runDecaySweep(SCOPE, NOW_MS)).resolves.toMatchObject({
      processed: 1,
      decayed: 1,
    });
  });

  // -- Scope isolation -------------------------------------------------------

  it("uses the correct user_profile StorageKey for the provided scope", async () => {
    vi.mocked(provider.list).mockResolvedValue([]);

    const service = new ConfidenceDecayService(provider, CONFIG);
    await service.runDecaySweep(SCOPE, NOW_MS);

    const [key] = vi.mocked(provider.list).mock.calls[0]!;
    expect(key.tier).toBe("user_profile");
    expect(key.tenantId).toBe(SCOPE.tenantId);
    expect(key.botId).toBe(SCOPE.botId);
    expect(key.userId).toBe(SCOPE.userId);
  });
});

// ---------------------------------------------------------------------------
// End-to-end with InMemoryStorageProvider
// ---------------------------------------------------------------------------

describe("ConfidenceDecayService — end-to-end with InMemoryStorageProvider", () => {
  it("decays an old fact and persists the update", async () => {
    const storage = new InMemoryStorageProvider();
    const oldFact = makeFact("city", { confidence: 0.9, confirmedAt: NOW_MS - 400 * DAY_MS });
    await storage.upsert(USER_PROFILE_KEY, "city", oldFact);

    const service = new ConfidenceDecayService(storage, CONFIG);
    await service.runDecaySweep(SCOPE, NOW_MS);

    // Read back — the fact must be marked decayed and have lower confidence
    const facts = await storage.list<UserFact>(USER_PROFILE_KEY, { limit: 10, order: "asc" });
    const cityFact = facts.find(f => f.key === "city");
    expect(cityFact?.decayed).toBe(true);
    expect(cityFact?.confidence).toBeLessThan(CONFIG.minimumConfidence);
  });

  it("does not alter a freshly confirmed fact", async () => {
    const storage = new InMemoryStorageProvider();
    const freshFact = makeFact("name", { confidence: 0.95, confirmedAt: NOW_MS });
    await storage.upsert(USER_PROFILE_KEY, "name", freshFact);

    const service = new ConfidenceDecayService(storage, CONFIG);
    await service.runDecaySweep(SCOPE, NOW_MS);

    const facts = await storage.list<UserFact>(USER_PROFILE_KEY, { limit: 10, order: "asc" });
    const nameFact = facts.find(f => f.key === "name");
    expect(nameFact?.decayed).toBeFalsy();
    expect(nameFact?.confidence).toBe(0.95);
  });

  it("does not touch facts belonging to a different scope", async () => {
    const storage = new InMemoryStorageProvider();

    // Other user's old fact
    const otherKey: StorageKey = { ...USER_PROFILE_KEY, userId: "u2" };
    const otherFact = makeFact("city", { confidence: 0.9, confirmedAt: NOW_MS - 400 * DAY_MS });
    await storage.upsert(otherKey, "city", otherFact);

    const service = new ConfidenceDecayService(storage, CONFIG);
    // Sweep only scope u1, not u2
    await service.runDecaySweep(SCOPE, NOW_MS);

    // u2's fact must be untouched
    const u2Facts = await storage.list<UserFact>(otherKey, { limit: 10, order: "asc" });
    const u2City = u2Facts.find(f => f.key === "city");
    expect(u2City?.decayed).toBeFalsy();
  });

  it("running the sweep twice does not double-decay or emit duplicate events", async () => {
    const storage = new InMemoryStorageProvider();
    const oldFact = makeFact("city", { confidence: 0.9, confirmedAt: NOW_MS - 400 * DAY_MS });
    await storage.upsert(USER_PROFILE_KEY, "city", oldFact);

    const eventBus = { emit: vi.fn() };
    const service = new ConfidenceDecayService(storage, CONFIG, eventBus as any);

    const result1 = await service.runDecaySweep(SCOPE, NOW_MS);
    const result2 = await service.runDecaySweep(SCOPE, NOW_MS);

    expect(result1.decayed).toBe(1);
    expect(result2.decayed).toBe(0); // already decayed on first sweep
    expect(eventBus.emit).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// MemoryManager integration — decayed facts excluded from load()
// ---------------------------------------------------------------------------

describe("DefaultMemoryManager.load() — decayed facts excluded", () => {
  it("excludes facts marked decayed: true from the context", async () => {
    const storage = new InMemoryStorageProvider();
    const manager = new DefaultMemoryManager(storage);

    const activeFact = makeFact("name", { confidence: 0.9, confirmedAt: NOW_MS });
    const decayedFact = makeFact("city", { confidence: 0.05, decayed: true });
    await storage.upsert(USER_PROFILE_KEY, "name", activeFact);
    await storage.upsert(USER_PROFILE_KEY, "city", decayedFact);

    const ctx = await manager.load(SCOPE, DEFAULT_CONTEXT_BUDGET);

    const keys = ctx.userFacts.map(f => f.key);
    expect(keys).toContain("name");
    expect(keys).not.toContain("city");
  });

  it("excludes a fact that was decayed by the sweep service", async () => {
    const storage = new InMemoryStorageProvider();
    const manager = new DefaultMemoryManager(storage);

    const oldFact = makeFact("city", { confidence: 0.9, confirmedAt: NOW_MS - 400 * DAY_MS });
    await storage.upsert(USER_PROFILE_KEY, "city", oldFact);

    // Run the sweep — should mark city as decayed
    const service = new ConfidenceDecayService(storage, CONFIG);
    await service.runDecaySweep(SCOPE, NOW_MS);

    // Subsequent load must exclude the now-decayed fact
    const ctx = await manager.load(SCOPE, DEFAULT_CONTEXT_BUDGET);
    expect(ctx.userFacts.map(f => f.key)).not.toContain("city");
  });
});
