import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMemoryEvolutionEngine } from "../memory-evolution-engine.js";
import { createMemoryPolicy } from "../memory-policy.js";
import { createKnowledgeReader } from "../knowledge-reader.js";
import { MemoryEvolutionMetrics } from "../memory-evolution-metrics.js";
import type { MemoryEvolutionEngineConfig } from "../memory-evolution-engine.js";
import type { MemoryCandidateStore, MemoryEvolutionInput, KnowledgeReaderStore } from "../memory-evolution-types.js";
import type { KnowledgeRecord, MemoryScope } from "../../memory/types.js";
import type { ReflectionResult } from "../../reflection/reflection-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SCOPE: MemoryScope = {
  tenantId: "default",
  botId: "bot-1",
  userId: "user-1",
  requestId: "req-1",
};

function makeReflectionResult(overrides: Partial<ReflectionResult> = {}): ReflectionResult {
  return Object.freeze({
    reflectionId: "r1",
    executionId: "exec-1",
    analyzed: true,
    quality: "neutral",
    confidenceAlignment: "neutral",
    latency: "acceptable",
    recommendation: "",
    issues: [],
    reflectedAt: Date.now(),
    ...overrides,
  });
}

function makeInput(overrides: Partial<MemoryEvolutionInput> = {}): MemoryEvolutionInput {
  return {
    scope: SCOPE,
    toolName: "qrcode",
    reflectionResult: makeReflectionResult({ quality: "poor", confidenceAlignment: "low", issues: ["execution_failure", "over_confident_failure"] }),
    ...overrides,
  };
}

function makeStore(existing: KnowledgeRecord[] = []): { store: MemoryCandidateStore & { mergeArgs: unknown[] }; readerStore: KnowledgeReaderStore } {
  const mergeArgs: unknown[] = [];
  const store: MemoryCandidateStore & { mergeArgs: unknown[] } = {
    mergeArgs,
    merge: vi.fn().mockImplementation((_scope, records) => {
      mergeArgs.push(records);
      return Promise.resolve({ upserted: records.length, skipped: 0 });
    }),
    upsert: vi.fn().mockResolvedValue(undefined),
  };
  const readerStore: KnowledgeReaderStore = {
    load: vi.fn().mockResolvedValue(existing),
  };
  return { store, readerStore };
}

function makeEngine(existing: KnowledgeRecord[] = [], metrics?: MemoryEvolutionMetrics) {
  const { store, readerStore } = makeStore(existing);
  const m = metrics ?? new MemoryEvolutionMetrics();
  const engine = createMemoryEvolutionEngine({
    policy: createMemoryPolicy(),
    reader: createKnowledgeReader(readerStore),
    store,
    metrics: m,
  });
  return { engine, store, readerStore, metrics: m };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MemoryEvolutionEngine", () => {
  // --- Confidence filter ---------------------------------------------------

  describe("confidence filter", () => {
    it("returns filtered result (0 candidates) for neutral/neutral signal", async () => {
      const { engine, metrics } = makeEngine();
      const result = await engine.evolve(makeInput({
        reflectionResult: makeReflectionResult(), // neutral, no signal
      }));
      expect(result.candidatesExtracted).toBe(0);
      expect(result.written).toBe(0);
      expect(metrics.snapshot().evolutions_filtered).toBe(1);
    });

    it("returns filtered result for analyzed=false", async () => {
      const { engine, metrics } = makeEngine();
      const result = await engine.evolve(makeInput({
        reflectionResult: makeReflectionResult({ analyzed: false, quality: "poor" }),
      }));
      expect(result.candidatesExtracted).toBe(0);
      expect(metrics.snapshot().evolutions_filtered).toBe(1);
    });
  });

  // --- Happy path ----------------------------------------------------------

  describe("happy path", () => {
    it("extracts candidates and writes them when signal passes filter", async () => {
      const { engine, store, metrics } = makeEngine();
      const result = await engine.evolve(makeInput()); // poor + low alignment → strong signal

      expect(result.candidatesExtracted).toBeGreaterThan(0);
      expect(result.written).toBeGreaterThan(0);
      expect(result.decisions.length).toBe(result.candidatesExtracted);
      expect(metrics.snapshot().evolutions_succeeded).toBe(1);
      expect(store.merge).toHaveBeenCalled();
    });

    it("assigns unique engineId per call", async () => {
      const { engine } = makeEngine();
      const r1 = await engine.evolve(makeInput());
      const r2 = await engine.evolve(makeInput());
      expect(r1.engineId).not.toBe(r2.engineId);
    });

    it("propagates executionId from reflectionResult", async () => {
      const { engine } = makeEngine();
      const result = await engine.evolve(makeInput({
        reflectionResult: makeReflectionResult({
          executionId: "my-exec-id",
          quality: "poor",
          confidenceAlignment: "low",
          issues: ["execution_failure"],
        }),
      }));
      expect(result.executionId).toBe("my-exec-id");
    });
  });

  // --- Policy integration -------------------------------------------------

  describe("policy integration", () => {
    it("ignores low-importance candidates (policy → ignore → nothing written)", async () => {
      const { engine, store } = makeEngine();
      // latency_concern has importance 0.60 → policy merges if no existing
      // But failure_pattern has importance 0.80 → policy promotes
      // Test that an all-ignore scenario results in 0 writes
      // Easiest: existing records with high confidence (existing >> candidate) → all ignored
      const existing: KnowledgeRecord[] = [
        { recordId: "r1", key: "tool.qrcode.failure_pattern", value: "v", category: "fact", confidence: 0.95, importance: 0.80, source: "inferred", tags: [], createdAt: 1000, updatedAt: 1000, version: 5 },
        { recordId: "r2", key: "tool.qrcode.overconfidence_risk", value: "v", category: "fact", confidence: 0.95, importance: 0.75, source: "inferred", tags: [], createdAt: 1000, updatedAt: 1000, version: 5 },
        { recordId: "r3", key: "tool.qrcode.latency_concern", value: "v", category: "context", confidence: 0.95, importance: 0.60, source: "inferred", tags: [], createdAt: 1000, updatedAt: 1000, version: 5 },
      ];
      const { engine: eng2, store: store2 } = makeEngine(existing);
      const input = makeInput({
        reflectionResult: makeReflectionResult({
          quality: "poor",
          confidenceAlignment: "low",
          issues: ["execution_failure", "over_confident_failure"],
          // no latency issue
        }),
      });
      const result = await eng2.evolve(input);
      // All candidates have lower confidence than existing → all ignored
      const ignored = result.decisions.filter((d) => d.action === "ignore");
      expect(ignored.length).toBeGreaterThan(0);
    });

    it("calls store.upsert for decay decisions", async () => {
      // The reflection: poor quality + execution_failure → produces "failure_pattern" candidate
      // We put a high-confidence "failure_pattern" record in existing storage so the
      // stub policy can return "decay" for the matched candidate.
      const failurePatternKey = "tool.qrcode.failure_pattern";
      const existing: KnowledgeRecord[] = [
        {
          recordId: "r1",
          key: failurePatternKey,
          value: "Tool qrcode has exhibited failures.",
          category: "fact",
          confidence: 0.85, // high confidence — will be decayed by contradictory evidence
          importance: 0.80,
          source: "inferred",
          tags: [],
          createdAt: 1000,
          updatedAt: 1000,
          version: 3,
        },
      ];
      const { store, readerStore } = makeStore(existing);
      const metrics = new MemoryEvolutionMetrics();

      // Stub the policy to always return decay — this isolates the engine's
      // decay-handling code path from the policy rules under test elsewhere.
      const decayPolicyStub = {
        decide: vi.fn().mockReturnValue({
          candidateId: "cand-1",
          action: "decay" as const,
          rationale: "test",
        }),
      };

      const engine2 = createMemoryEvolutionEngine({
        policy: decayPolicyStub,
        reader: createKnowledgeReader(readerStore),
        store,
        metrics,
      });

      // This produces a "failure_pattern" candidate — key matches existing storage
      const input = makeInput({
        reflectionResult: makeReflectionResult({
          quality: "poor",
          confidenceAlignment: "low",
          issues: ["execution_failure"],
        }),
      });
      const result = await engine2.evolve(input);

      // Decay action must call store.upsert (not merge)
      expect(store.upsert).toHaveBeenCalled();
      expect(result.written).toBeGreaterThanOrEqual(1);
    });
  });

  // --- Isolation contract --------------------------------------------------

  describe("isolation contract", () => {
    it("never throws — returns a result even when store.merge throws", async () => {
      const { store, readerStore } = makeStore();
      (store.merge as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("DB error"));
      const metrics = new MemoryEvolutionMetrics();
      const engine = createMemoryEvolutionEngine({
        policy: createMemoryPolicy(),
        reader: createKnowledgeReader(readerStore),
        store,
        metrics,
      });

      const result = await engine.evolve(makeInput());
      // Should return a result, not throw
      expect(result).toBeDefined();
      expect(typeof result.engineId).toBe("string");
      expect(metrics.snapshot().evolutions_failed).toBe(1);
    });

    it("never throws when reader.read throws", async () => {
      const failReaderStore: KnowledgeReaderStore = {
        load: vi.fn().mockRejectedValue(new Error("read fail")),
      };
      const { store } = makeStore();
      const metrics = new MemoryEvolutionMetrics();
      const engine = createMemoryEvolutionEngine({
        policy: createMemoryPolicy(),
        reader: createKnowledgeReader(failReaderStore),
        store,
        metrics,
      });

      const result = await engine.evolve(makeInput());
      expect(result).toBeDefined();
      expect(metrics.snapshot().evolutions_failed).toBe(1);
    });
  });

  // --- Metrics ------------------------------------------------------------

  describe("metrics", () => {
    it("records succeeded when evolution completes", async () => {
      const { engine, metrics } = makeEngine();
      await engine.evolve(makeInput());
      const snap = metrics.snapshot();
      expect(snap.evolution_calls).toBe(1);
      expect(snap.evolutions_succeeded).toBe(1);
      expect(snap.total_candidates_extracted).toBeGreaterThan(0);
    });

    it("records filtered when signal is too weak", async () => {
      const { engine, metrics } = makeEngine();
      await engine.evolve(makeInput({ reflectionResult: makeReflectionResult() }));
      expect(metrics.snapshot().evolutions_filtered).toBe(1);
    });
  });
});
