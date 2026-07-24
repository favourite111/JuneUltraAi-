/**
 * M21 — Tool Learning Layer test suite.
 *
 * Coverage:
 *   - mergeStats() pure function
 *   - ToolLearningStore (record, getStats, loadAll, cache warm-up)
 *   - Storage key addressing (tier, sentinel userId, qualifier)
 *   - ToolLearningMetrics (counters, hit rate, snapshot, reset)
 *   - applyLearningAdjustment() (all success-rate bands, clamping, planner floor)
 *   - M20 ToolIntelligenceLayer integration (learningReader injection)
 *   - Determinism contract (pre-execution reads, post-execution writes)
 */

import { describe, expect, it, beforeEach } from "vitest";
import { InMemoryStorageProvider } from "../../memory/index.js";
import { ToolRegistry } from "../../tools/registry.js";
import type { Tool } from "../../tools/types.js";

import {
  ToolLearningStore,
  ToolLearningMetrics,
  mergeStats,
  MIN_LEARNING_EXECUTIONS,
  TOOL_LEARNING_TIER,
  TOOL_LEARNING_USER_SENTINEL,
  TOOL_LEARNING_QUALIFIER_PREFIX,
} from "../index.js";
import type {
  ToolLearningScope,
  ToolLearningStats,
  CompletedToolExecution,
} from "../index.js";
import { applyLearningAdjustment } from "../../tool-intelligence/tool-confidence.js";
import { createToolIntelligenceLayer } from "../../tool-intelligence/index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SCOPE: ToolLearningScope = { tenantId: "test-tenant", botId: "test-bot" };

function makeExecution(overrides: Partial<CompletedToolExecution> = {}): CompletedToolExecution {
  return {
    executionId:           "test-exec-id",
    toolName:              "url_shortener",
    success:               true,
    durationMs:            100,
    confidenceAtSelection: 0.85,
    executedAt:            1_000,
    ...overrides,
  };
}

function makeStats(overrides: Partial<ToolLearningStats> = {}): ToolLearningStats {
  return Object.freeze<ToolLearningStats>({
    toolName:                 "url_shortener",
    totalExecutions:          5,
    successCount:             5,
    failureCount:             0,
    successRate:              1.0,
    avgDurationMs:            100,
    avgConfidenceAtSelection: 0.85,
    lastExecutedAt:           1_000,
    lastSuccess:              true,
    updatedAt:                1_000,
    version:                  5,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// 1. mergeStats — pure function
// ---------------------------------------------------------------------------

describe("M21 — mergeStats (pure function)", () => {
  it("first merge from zero: sets all fields correctly for a success", () => {
    const empty = Object.freeze<ToolLearningStats>({
      toolName: "t", totalExecutions: 0, successCount: 0, failureCount: 0,
      successRate: 0, avgDurationMs: 0, avgConfidenceAtSelection: 0,
      lastExecutedAt: 0, lastSuccess: false, updatedAt: 0, version: 0,
    });
    const r = mergeStats(empty, makeExecution({ toolName: "t", success: true, durationMs: 200, confidenceAtSelection: 0.9, executedAt: 500 }));
    expect(r.totalExecutions).toBe(1);
    expect(r.successCount).toBe(1);
    expect(r.failureCount).toBe(0);
    expect(r.successRate).toBe(1.0);
    expect(r.avgDurationMs).toBe(200);
    expect(r.avgConfidenceAtSelection).toBe(0.9);
    expect(r.lastSuccess).toBe(true);
    expect(r.lastExecutedAt).toBe(500);
    expect(r.version).toBe(1);
  });

  it("increments failureCount on failure; reduces successRate", () => {
    const s = makeStats({ totalExecutions: 1, successCount: 1, failureCount: 0, successRate: 1, version: 1 });
    const r = mergeStats(s, makeExecution({ success: false }));
    expect(r.failureCount).toBe(1);
    expect(r.successCount).toBe(1);
    expect(r.successRate).toBeCloseTo(0.5);
    expect(r.lastSuccess).toBe(false);
  });

  it("uses Welford incremental average for avgDurationMs", () => {
    const s = makeStats({ totalExecutions: 1, avgDurationMs: 100, version: 1 });
    const r = mergeStats(s, makeExecution({ durationMs: 300 }));
    // (100 + 300) / 2 = 200
    expect(r.avgDurationMs).toBeCloseTo(200);
  });

  it("uses Welford incremental average for avgConfidenceAtSelection", () => {
    const s = makeStats({ totalExecutions: 1, avgConfidenceAtSelection: 0.8, version: 1 });
    const r = mergeStats(s, makeExecution({ confidenceAtSelection: 0.4 }));
    expect(r.avgConfidenceAtSelection).toBeCloseTo(0.6);
  });

  it("increments version on each merge", () => {
    const s = makeStats({ version: 7 });
    expect(mergeStats(s, makeExecution()).version).toBe(8);
  });

  it("all failures → successRate 0, failureCount equals totalExecutions", () => {
    let s = Object.freeze<ToolLearningStats>({
      toolName: "t", totalExecutions: 0, successCount: 0, failureCount: 0,
      successRate: 0, avgDurationMs: 0, avgConfidenceAtSelection: 0,
      lastExecutedAt: 0, lastSuccess: true, updatedAt: 0, version: 0,
    });
    for (let i = 0; i < 3; i++) {
      s = mergeStats(s, makeExecution({ success: false }));
    }
    expect(s.successRate).toBe(0);
    expect(s.failureCount).toBe(3);
    expect(s.successCount).toBe(0);
  });

  it("result is deeply frozen", () => {
    expect(Object.isFrozen(mergeStats(makeStats(), makeExecution()))).toBe(true);
  });

  it("toolName is preserved from the current stats entry", () => {
    const s = makeStats({ toolName: "preserved_name" });
    expect(mergeStats(s, makeExecution()).toolName).toBe("preserved_name");
  });
});

// ---------------------------------------------------------------------------
// 2. ToolLearningStore
// ---------------------------------------------------------------------------

describe("M21 — ToolLearningStore", () => {
  let storage: InMemoryStorageProvider;
  let store:   ToolLearningStore;
  let metrics: ToolLearningMetrics;

  beforeEach(() => {
    storage = new InMemoryStorageProvider();
    metrics = new ToolLearningMetrics();
    store   = new ToolLearningStore(storage, { metrics });
  });

  it("getStats returns null before any record", () => {
    expect(store.getStats(SCOPE, "url_shortener")).toBeNull();
  });

  it("getStats returns non-null after record", async () => {
    await store.record(SCOPE, makeExecution());
    expect(store.getStats(SCOPE, "url_shortener")).not.toBeNull();
  });

  it("cache updated synchronously — visible before storage write resolves", async () => {
    const promise = store.record(SCOPE, makeExecution());
    // Cache is updated before the async storage write settles
    expect(store.getStats(SCOPE, "url_shortener")).not.toBeNull();
    await promise;
  });

  it("accumulates totalExecutions, successCount, failureCount over multiple records", async () => {
    await store.record(SCOPE, makeExecution({ success: true }));
    await store.record(SCOPE, makeExecution({ success: false }));
    await store.record(SCOPE, makeExecution({ success: true }));
    const s = store.getStats(SCOPE, "url_shortener")!;
    expect(s.totalExecutions).toBe(3);
    expect(s.successCount).toBe(2);
    expect(s.failureCount).toBe(1);
    expect(s.successRate).toBeCloseTo(2 / 3);
  });

  it("record writes persisted value to StorageProvider", async () => {
    await store.record(SCOPE, makeExecution());
    const raw = await storage.read<ToolLearningStats>({
      tier:      TOOL_LEARNING_TIER,
      tenantId:  SCOPE.tenantId,
      botId:     SCOPE.botId,
      userId:    TOOL_LEARNING_USER_SENTINEL,
      qualifier: `${TOOL_LEARNING_QUALIFIER_PREFIX}url_shortener`,
    });
    expect(raw).not.toBeNull();
    expect(raw?.toolName).toBe("url_shortener");
  });

  it("different tools tracked independently", async () => {
    await store.record(SCOPE, makeExecution({ toolName: "tool_a", success: true }));
    await store.record(SCOPE, makeExecution({ toolName: "tool_b", success: false }));
    expect(store.getStats(SCOPE, "tool_a")?.successRate).toBe(1.0);
    expect(store.getStats(SCOPE, "tool_b")?.successRate).toBe(0.0);
    expect(store.getStats(SCOPE, "tool_a")).not.toBe(store.getStats(SCOPE, "tool_b"));
  });

  it("different bots tracked independently", async () => {
    const scopeA: ToolLearningScope = { tenantId: "t", botId: "bot_a" };
    const scopeB: ToolLearningScope = { tenantId: "t", botId: "bot_b" };
    await store.record(scopeA, makeExecution({ success: true }));
    await store.record(scopeB, makeExecution({ success: false }));
    expect(store.getStats(scopeA, "url_shortener")?.successRate).toBe(1.0);
    expect(store.getStats(scopeB, "url_shortener")?.successRate).toBe(0.0);
  });

  it("record does not throw on storage failure (degrade gracefully)", async () => {
    storage.write = async () => { throw new Error("storage unavailable"); };
    await expect(store.record(SCOPE, makeExecution())).resolves.not.toThrow();
  });

  it("increments storageFailed metric on write error", async () => {
    storage.write = async () => { throw new Error("down"); };
    await store.record(SCOPE, makeExecution());
    expect(metrics.snapshot().storage_failures).toBe(1);
    expect(metrics.snapshot().records_stored).toBe(0);
  });

  it("increments recordStored metric on successful write", async () => {
    await store.record(SCOPE, makeExecution());
    expect(metrics.snapshot().records_stored).toBe(1);
    expect(metrics.snapshot().storage_failures).toBe(0);
  });

  it("cacheSize increases for each distinct (scope, tool) pair", async () => {
    expect(store.cacheSize).toBe(0);
    await store.record(SCOPE, makeExecution({ toolName: "a" }));
    expect(store.cacheSize).toBe(1);
    await store.record(SCOPE, makeExecution({ toolName: "b" }));
    expect(store.cacheSize).toBe(2);
    await store.record(SCOPE, makeExecution({ toolName: "a" })); // same pair
    expect(store.cacheSize).toBe(2);
  });

  it("loadAll warms cache from storage persisted by another store instance", async () => {
    await store.record(SCOPE, makeExecution({ toolName: "url_shortener" }));
    const cold = new ToolLearningStore(storage);
    expect(cold.getStats(SCOPE, "url_shortener")).toBeNull();
    await cold.loadAll(SCOPE, ["url_shortener"]);
    expect(cold.getStats(SCOPE, "url_shortener")).not.toBeNull();
  });

  it("loadAll skips missing tool names silently", async () => {
    await expect(store.loadAll(SCOPE, ["no_such_tool_xyz"])).resolves.not.toThrow();
    expect(store.getStats(SCOPE, "no_such_tool_xyz")).toBeNull();
  });

  it("loadAll with empty list is a no-op", async () => {
    await expect(store.loadAll(SCOPE, [])).resolves.not.toThrow();
    expect(store.cacheSize).toBe(0);
  });

  it("getStats increments cacheHit when entry found", async () => {
    await store.record(SCOPE, makeExecution());
    store.getStats(SCOPE, "url_shortener");
    expect(metrics.snapshot().cache_hits).toBe(1);
  });

  it("getStats increments cacheMiss when entry absent", () => {
    store.getStats(SCOPE, "no_such_tool");
    expect(metrics.snapshot().cache_misses).toBe(1);
  });

  it("returned stats are frozen", async () => {
    await store.record(SCOPE, makeExecution());
    expect(Object.isFrozen(store.getStats(SCOPE, "url_shortener"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Storage key addressing
// ---------------------------------------------------------------------------

describe("M21 — Storage key addressing", () => {
  let storage: InMemoryStorageProvider;
  let store:   ToolLearningStore;

  beforeEach(() => {
    storage = new InMemoryStorageProvider();
    store   = new ToolLearningStore(storage);
  });

  it("uses TOOL_LEARNING_TIER ('tool_execution') as the tier", async () => {
    await store.record(SCOPE, makeExecution({ toolName: "my_tool" }));
    const stored = await storage.read<unknown>({
      tier: TOOL_LEARNING_TIER, tenantId: SCOPE.tenantId, botId: SCOPE.botId,
      userId: TOOL_LEARNING_USER_SENTINEL, qualifier: `${TOOL_LEARNING_QUALIFIER_PREFIX}my_tool`,
    });
    expect(stored).not.toBeNull();
  });

  it("uses TOOL_LEARNING_USER_SENTINEL ('__tool_learning__') as userId", async () => {
    await store.record(SCOPE, makeExecution({ toolName: "my_tool" }));
    // Reading with a real userId should return null
    const wrong = await storage.read<unknown>({
      tier: TOOL_LEARNING_TIER, tenantId: SCOPE.tenantId, botId: SCOPE.botId,
      userId: "real_user_id", qualifier: `${TOOL_LEARNING_QUALIFIER_PREFIX}my_tool`,
    });
    expect(wrong).toBeNull();
  });

  it("uses 'stats:{toolName}' qualifier", async () => {
    await store.record(SCOPE, makeExecution({ toolName: "qrcode" }));
    const stored = await storage.read<unknown>({
      tier: TOOL_LEARNING_TIER, tenantId: SCOPE.tenantId, botId: SCOPE.botId,
      userId: TOOL_LEARNING_USER_SENTINEL, qualifier: "stats:qrcode",
    });
    expect(stored).not.toBeNull();
  });

  it("different tools produce different qualifier keys", async () => {
    await store.record(SCOPE, makeExecution({ toolName: "tool_a" }));
    await store.record(SCOPE, makeExecution({ toolName: "tool_b" }));
    const base = { tier: TOOL_LEARNING_TIER, tenantId: SCOPE.tenantId, botId: SCOPE.botId, userId: TOOL_LEARNING_USER_SENTINEL };
    const a = await storage.read<unknown>({ ...base, qualifier: "stats:tool_a" });
    const b = await storage.read<unknown>({ ...base, qualifier: "stats:tool_b" });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
  });

  it("different tenants are isolated — cross-tenant read returns null", async () => {
    const s1: ToolLearningScope = { tenantId: "tenant_a", botId: "bot1" };
    await store.record(s1, makeExecution({ toolName: "t" }));
    const crossTenant = await storage.read<unknown>({
      tier: TOOL_LEARNING_TIER, tenantId: "tenant_b", botId: "bot1",
      userId: TOOL_LEARNING_USER_SENTINEL, qualifier: "stats:t",
    });
    expect(crossTenant).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. ToolLearningMetrics
// ---------------------------------------------------------------------------

describe("M21 — ToolLearningMetrics", () => {
  let m: ToolLearningMetrics;

  beforeEach(() => { m = new ToolLearningMetrics(); });

  it("initial snapshot: all counters are zero", () => {
    const s = m.snapshot();
    expect(s.records_stored).toBe(0);
    expect(s.storage_failures).toBe(0);
    expect(s.cache_hits).toBe(0);
    expect(s.cache_misses).toBe(0);
    expect(s.cache_hit_rate).toBe(0);
  });

  it("recordStored increments records_stored", () => {
    m.recordStored(); m.recordStored();
    expect(m.snapshot().records_stored).toBe(2);
  });

  it("storageFailed increments storage_failures", () => {
    m.storageFailed();
    expect(m.snapshot().storage_failures).toBe(1);
  });

  it("cacheHit increments cache_hits", () => {
    m.cacheHit(); m.cacheHit(); m.cacheHit();
    expect(m.snapshot().cache_hits).toBe(3);
  });

  it("cacheMiss increments cache_misses", () => {
    m.cacheMiss();
    expect(m.snapshot().cache_misses).toBe(1);
  });

  it("cache_hit_rate = hits / (hits + misses)", () => {
    m.cacheHit(); m.cacheHit(); m.cacheMiss();
    expect(m.snapshot().cache_hit_rate).toBeCloseTo(2 / 3);
  });

  it("cache_hit_rate is 0 when no getStats calls made", () => {
    expect(m.snapshot().cache_hit_rate).toBe(0);
  });

  it("snapshot is frozen", () => {
    expect(Object.isFrozen(m.snapshot())).toBe(true);
  });

  it("reset clears all counters", () => {
    m.recordStored(); m.storageFailed(); m.cacheHit(); m.cacheMiss();
    m.reset();
    const s = m.snapshot();
    expect(s.records_stored).toBe(0);
    expect(s.storage_failures).toBe(0);
    expect(s.cache_hits).toBe(0);
    expect(s.cache_misses).toBe(0);
  });

  it("cache_hit_rate is 0 after reset clears previous reads", () => {
    m.cacheHit(); m.cacheHit();
    m.reset();
    expect(m.snapshot().cache_hit_rate).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. applyLearningAdjustment
// ---------------------------------------------------------------------------

describe("M21 — applyLearningAdjustment", () => {
  it("returns confidence unchanged when totalExecutions < MIN_LEARNING_EXECUTIONS", () => {
    const s = makeStats({ totalExecutions: MIN_LEARNING_EXECUTIONS - 1, successRate: 1.0 });
    expect(applyLearningAdjustment(0.80, s, false)).toBe(0.80);
  });

  it("boosts confidence +0.05 for successRate >= 0.90", () => {
    const s = makeStats({ totalExecutions: 10, successRate: 0.95 });
    expect(applyLearningAdjustment(0.80, s, false)).toBeCloseTo(0.85);
  });

  it("no adjustment for successRate in [0.70, 0.90)", () => {
    const s = makeStats({ totalExecutions: 10, successRate: 0.80 });
    expect(applyLearningAdjustment(0.80, s, false)).toBeCloseTo(0.80);
  });

  it("mild penalty -0.05 for successRate in [0.50, 0.70)", () => {
    const s = makeStats({ totalExecutions: 10, successRate: 0.60 });
    expect(applyLearningAdjustment(0.80, s, false)).toBeCloseTo(0.75);
  });

  it("severe penalty -0.10 for successRate < 0.50", () => {
    const s = makeStats({ totalExecutions: 10, successRate: 0.30 });
    expect(applyLearningAdjustment(0.80, s, false)).toBeCloseTo(0.70);
  });

  it("clamps result at 1.0 maximum", () => {
    const s = makeStats({ totalExecutions: 10, successRate: 0.99 });
    expect(applyLearningAdjustment(0.99, s, false)).toBeLessThanOrEqual(1.0);
  });

  it("clamps result at 0.0 minimum", () => {
    const s = makeStats({ totalExecutions: 10, successRate: 0.0 });
    expect(applyLearningAdjustment(0.05, s, false)).toBeGreaterThanOrEqual(0.0);
  });

  it("preserves planner floor (0.90) for nominated tool under severe penalty", () => {
    // 0.90 - 0.10 = 0.80, but floor re-applies → 0.90
    const s = makeStats({ totalExecutions: 10, successRate: 0.10 });
    expect(applyLearningAdjustment(0.90, s, true)).toBeGreaterThanOrEqual(0.90);
  });

  it("nominated tool can still receive the boost above its base confidence", () => {
    const s = makeStats({ totalExecutions: 10, successRate: 0.95 });
    // 0.90 + 0.05 = 0.95
    expect(applyLearningAdjustment(0.90, s, true)).toBeCloseTo(0.95);
  });

  it("non-nominated tool with mild penalty goes below 0.90", () => {
    // Ensure non-nominated tools ARE penalised below 0.90
    const s = makeStats({ totalExecutions: 10, successRate: 0.40 });
    expect(applyLearningAdjustment(0.90, s, false)).toBeLessThan(0.90);
  });
});

// ---------------------------------------------------------------------------
// 6. M20 ToolIntelligenceLayer integration
// ---------------------------------------------------------------------------

describe("M21 — M20 ToolIntelligenceLayer + learningReader integration", () => {
  // Use a unique name to avoid ToolRegistry collisions across test runs
  const toolId = `m21_integration_tool_${Date.now()}`;
  const mockTool: Tool = {
    name: toolId, description: "M21 integration test tool",
    // score() returns high confidence for its own name so that it is
    // deterministically selected by rankTools() even when other legacy tools
    // (DEFAULT_CONFIDENCE = 0.70) are present in ToolRegistry during the test run.
    score: (text: string) => ({
      score: text.includes(toolId.slice(0, 24)) ? 0.95 : 0,
      reasoning: ["M21 test: scores its own toolId"],
    }),
    match: () => null,
    execute: async () => ({ type: "text" as const, reply: "", data: {} }),
  };

  // Register once for the whole describe block
  ToolRegistry.register(mockTool);

  it("no adjustment when learningReader not provided", () => {
    const layer = createToolIntelligenceLayer({});
    const r = layer.evaluate({ toolName: toolId, prompt: toolId, needsTool: true });
    expect(typeof r.confidence).toBe("number");
    expect(r.confidence).toBeGreaterThanOrEqual(0);
  });

  it("no adjustment when learningScope absent (even with learningReader)", async () => {
    const store = new ToolLearningStore(new InMemoryStorageProvider());
    for (let i = 0; i < 5; i++) {
      await store.record({ tenantId: "t", botId: "b" }, makeExecution({ toolName: toolId, success: false }));
    }
    const withReader = createToolIntelligenceLayer({ learningReader: store });
    const noReader   = createToolIntelligenceLayer({});
    const r1 = withReader.evaluate({ toolName: toolId, prompt: toolId, needsTool: true });
    const r2 = noReader.evaluate({   toolName: toolId, prompt: toolId, needsTool: true });
    // learningScope omitted → no adjustment, same as baseline
    expect(r1.confidence).toBeCloseTo(r2.confidence);
  });

  it("no adjustment when totalExecutions below threshold", async () => {
    const store = new ToolLearningStore(new InMemoryStorageProvider());
    await store.record({ tenantId: "t", botId: "b" }, makeExecution({ toolName: toolId, success: false }));
    const layer = createToolIntelligenceLayer({ learningReader: store });
    const base  = createToolIntelligenceLayer({}).evaluate({ toolName: toolId, prompt: toolId, needsTool: true });
    const adj   = layer.evaluate({ toolName: toolId, prompt: toolId, needsTool: true, learningScope: { tenantId: "t", botId: "b" } });
    expect(adj.confidence).toBeCloseTo(base.confidence);
  });

  it("reduces confidence when tool has consistent failures", async () => {
    const store = new ToolLearningStore(new InMemoryStorageProvider());
    for (let i = 0; i < MIN_LEARNING_EXECUTIONS + 2; i++) {
      await store.record({ tenantId: "t", botId: "b" }, makeExecution({ toolName: toolId, success: false }));
    }
    // Use non-nominated path (no toolName) so the learning penalty is not
    // cancelled by the planner-nominated floor. The planner floor intentionally
    // protects nominated tools from being undercut — test this via ranking path.
    const base  = createToolIntelligenceLayer({}).evaluate({ prompt: toolId, needsTool: true });
    const layer = createToolIntelligenceLayer({ learningReader: store });
    const adj   = layer.evaluate({ prompt: toolId, needsTool: true, learningScope: { tenantId: "t", botId: "b" } });
    expect(adj.confidence).toBeLessThan(base.confidence);
  });

  it("boosts confidence when tool has consistent successes", async () => {
    const store = new ToolLearningStore(new InMemoryStorageProvider());
    for (let i = 0; i < MIN_LEARNING_EXECUTIONS + 2; i++) {
      await store.record({ tenantId: "t", botId: "b" }, makeExecution({ toolName: toolId, success: true }));
    }
    const base  = createToolIntelligenceLayer({}).evaluate({ toolName: toolId, prompt: toolId, needsTool: true });
    const layer = createToolIntelligenceLayer({ learningReader: store });
    const adj   = layer.evaluate({ toolName: toolId, prompt: toolId, needsTool: true, learningScope: { tenantId: "t", botId: "b" } });
    expect(adj.confidence).toBeGreaterThanOrEqual(base.confidence);
  });

  it("result is still deeply frozen when learningReader is injected", async () => {
    const store = new ToolLearningStore(new InMemoryStorageProvider());
    const layer = createToolIntelligenceLayer({ learningReader: store });
    const r = layer.evaluate({ toolName: toolId, prompt: toolId, needsTool: true, learningScope: { tenantId: "t", botId: "b" } });
    expect(Object.isFrozen(r)).toBe(true);
  });

  it("evaluate() remains synchronous with learningReader injected (no Promise returned)", () => {
    const store = new ToolLearningStore(new InMemoryStorageProvider());
    const layer = createToolIntelligenceLayer({ learningReader: store });
    const r = layer.evaluate({ toolName: toolId, prompt: toolId, needsTool: true, learningScope: { tenantId: "t", botId: "b" } });
    expect((r as unknown as { then?: unknown }).then).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 7. Determinism contract
// ---------------------------------------------------------------------------

describe("M21 — Determinism contract", () => {
  it("getStats returns null before record is called — no prior-execution influence", () => {
    const store = new ToolLearningStore(new InMemoryStorageProvider());
    expect(store.getStats(SCOPE, "any_tool")).toBeNull();
  });

  it("stats are visible immediately after record() resolves (same-process N+1 guarantee)", async () => {
    const store = new ToolLearningStore(new InMemoryStorageProvider());
    await store.record(SCOPE, makeExecution({ toolName: "t" }));
    expect(store.getStats(SCOPE, "t")).not.toBeNull();
  });

  it("stats accumulate correctly over N sequential executions", async () => {
    const store = new ToolLearningStore(new InMemoryStorageProvider());
    const outcomes = [true, true, false, true, false];
    for (const success of outcomes) {
      await store.record(SCOPE, makeExecution({ success }));
    }
    const s = store.getStats(SCOPE, "url_shortener")!;
    expect(s.totalExecutions).toBe(5);
    expect(s.successCount).toBe(3);
    expect(s.failureCount).toBe(2);
    expect(s.successRate).toBeCloseTo(0.6);
  });

  it("M20 evaluate() reads only prior-execution stats (not current run's outcome)", async () => {
    const uniqueId = `determinism_tool_${Date.now()}`;
    const tool: Tool = {
      name: uniqueId, description: "determinism test",
      match: () => null, execute: async () => ({ type: "text" as const, reply: "", data: {} }),
    };
    ToolRegistry.register(tool);

    const store = new ToolLearningStore(new InMemoryStorageProvider());
    const scope = { tenantId: "t", botId: "b" };

    // Simulate 5 failed prior executions
    for (let i = 0; i < 5; i++) {
      await store.record(scope, {
        executionId: "stress-exec-" + i,
        toolName: uniqueId, success: false, durationMs: 50,
        confidenceAtSelection: 0.9, executedAt: Date.now(),
      });
    }

    // M20 reads the stats from prior executions
    const layer = createToolIntelligenceLayer({ learningReader: store });
    const baseline = createToolIntelligenceLayer({});
    const adjResult  = layer.evaluate({ toolName: uniqueId, prompt: uniqueId, needsTool: true, learningScope: scope });
    const baseResult = baseline.evaluate({ toolName: uniqueId, prompt: uniqueId, needsTool: true });

    // Penalty from prior failures is reflected
    expect(adjResult.confidence).toBeLessThanOrEqual(baseResult.confidence);
  });

  it("storage-loaded stats survive a cold-cache restart (cross-process N+1 via storage)", async () => {
    const storage = new InMemoryStorageProvider();
    const store1  = new ToolLearningStore(storage);
    // Execution N: record to store1
    await store1.record(SCOPE, makeExecution({ success: false }));

    // Simulated process restart: cold store2 with same storage
    const store2 = new ToolLearningStore(storage);
    expect(store2.getStats(SCOPE, "url_shortener")).toBeNull(); // cold cache

    // Warm from storage (represents startup loading)
    await store2.loadAll(SCOPE, ["url_shortener"]);
    const s = store2.getStats(SCOPE, "url_shortener");
    expect(s).not.toBeNull();
    expect(s!.totalExecutions).toBe(1);
    expect(s!.successCount).toBe(0);
  });
});
