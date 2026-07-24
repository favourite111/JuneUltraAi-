import { describe, expect, it, vi, beforeEach } from "vitest";
import { createExecutionObserver } from "../execution-observer.js";
import { ObserverMetrics } from "../observer-metrics.js";
import { makeObservationResult } from "../observation-result.js";
import type { ObservationInput, ObservationStore } from "../observer-types.js";
import type { CompletedToolExecution, ToolLearningScope } from "../../tool-learning/tool-learning-types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeStore(overrides: Partial<ObservationStore> = {}): ObservationStore & {
  calls: Array<{ scope: ToolLearningScope; execution: CompletedToolExecution }>;
} {
  const calls: Array<{ scope: ToolLearningScope; execution: CompletedToolExecution }> = [];
  return {
    calls,
    record: vi.fn().mockImplementation(async (scope, execution) => {
      calls.push({ scope, execution });
    }),
    ...overrides,
  };
}

function baseInput(overrides: Partial<ObservationInput> = {}): ObservationInput {
  return {
    scope:                 { tenantId: "tenant-1", botId: "bot-1" },
    toolName:              "weather",
    success:               true,
    durationMs:            120,
    confidenceAtSelection: 0.85,
    executedAt:            1_000_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// M22-A Test 1 — Success path
// ---------------------------------------------------------------------------

describe("M22 ExecutionObserver — success path", () => {
  it("calls store.record() once with correct fields", async () => {
    const store   = makeStore();
    const metrics = new ObserverMetrics();
    const observer = createExecutionObserver({ store, metrics });

    await observer.observe(baseInput());

    expect(store.record).toHaveBeenCalledOnce();
    const [scope, execution] = (store.record as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(scope).toEqual({ tenantId: "tenant-1", botId: "bot-1" });
    expect(execution.toolName).toBe("weather");
    expect(execution.success).toBe(true);
    expect(execution.durationMs).toBe(120);
    expect(execution.confidenceAtSelection).toBe(0.85);
    expect(execution.executedAt).toBe(1_000_000);
  });

  it("returns recorded=true on success", async () => {
    const observer = createExecutionObserver({ store: makeStore(), metrics: new ObserverMetrics() });
    const result   = await observer.observe(baseInput());

    expect(result.recorded).toBe(true);
  });

  it("returns clamped durationMs and confidenceAtSelection", async () => {
    const observer = createExecutionObserver({ store: makeStore(), metrics: new ObserverMetrics() });
    const result   = await observer.observe(baseInput({ durationMs: 200, confidenceAtSelection: 0.9 }));

    expect(result.durationMs).toBe(200);
    expect(result.confidenceAtSelection).toBe(0.9);
  });

  it("passes success=false through to store correctly", async () => {
    const store    = makeStore();
    const observer = createExecutionObserver({ store, metrics: new ObserverMetrics() });

    await observer.observe(baseInput({ success: false, toolName: "qr_code" }));

    expect(store.calls[0]!.execution.success).toBe(false);
    expect(store.calls[0]!.execution.toolName).toBe("qr_code");
  });
});

// ---------------------------------------------------------------------------
// M22-A Test 2 — Isolation contract (never throws, never blocks)
// ---------------------------------------------------------------------------

describe("M22 ExecutionObserver — isolation contract", () => {
  it("does NOT throw when store.record() throws", async () => {
    const failingStore: ObservationStore = {
      record: vi.fn().mockRejectedValue(new Error("Postgres connection failed")),
    };
    const observer = createExecutionObserver({ store: failingStore, metrics: new ObserverMetrics() });

    // Must not throw
    await expect(observer.observe(baseInput())).resolves.not.toThrow();
  });

  it("returns recorded=false when store.record() throws", async () => {
    const failingStore: ObservationStore = {
      record: vi.fn().mockRejectedValue(new Error("Storage error")),
    };
    const observer = createExecutionObserver({ store: failingStore, metrics: new ObserverMetrics() });
    const result   = await observer.observe(baseInput());

    expect(result.recorded).toBe(false);
  });

  it("returns recorded=false when store.record() rejects with a non-Error value", async () => {
    const failingStore: ObservationStore = {
      record: vi.fn().mockRejectedValue("string rejection"),
    };
    const observer = createExecutionObserver({ store: failingStore, metrics: new ObserverMetrics() });
    const result   = await observer.observe(baseInput());

    expect(result.recorded).toBe(false);
  });

  it("subsequent calls succeed even after a previous failure", async () => {
    let callCount = 0;
    const flakyStore: ObservationStore = {
      record: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) throw new Error("Transient error");
      }),
    };
    const observer = createExecutionObserver({ store: flakyStore, metrics: new ObserverMetrics() });

    const r1 = await observer.observe(baseInput());
    const r2 = await observer.observe(baseInput());

    expect(r1.recorded).toBe(false);
    expect(r2.recorded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// M22-A Test 3 — Input validation
// ---------------------------------------------------------------------------

describe("M22 ExecutionObserver — input validation", () => {
  it("returns recorded=false for empty toolName string", async () => {
    const store    = makeStore();
    const observer = createExecutionObserver({ store, metrics: new ObserverMetrics() });
    const result   = await observer.observe(baseInput({ toolName: "" }));

    expect(result.recorded).toBe(false);
    expect(store.record).not.toHaveBeenCalled();
  });

  it("returns recorded=false for whitespace-only toolName", async () => {
    const store    = makeStore();
    const observer = createExecutionObserver({ store, metrics: new ObserverMetrics() });
    const result   = await observer.observe(baseInput({ toolName: "   " }));

    expect(result.recorded).toBe(false);
    expect(store.record).not.toHaveBeenCalled();
  });

  it("clamps negative durationMs to 0", async () => {
    const store    = makeStore();
    const observer = createExecutionObserver({ store, metrics: new ObserverMetrics() });
    const result   = await observer.observe(baseInput({ durationMs: -50 }));

    expect(result.durationMs).toBe(0);
    expect(store.calls[0]!.execution.durationMs).toBe(0);
  });

  it("clamps confidenceAtSelection above 1.0 to 1.0", async () => {
    const store    = makeStore();
    const observer = createExecutionObserver({ store, metrics: new ObserverMetrics() });
    const result   = await observer.observe(baseInput({ confidenceAtSelection: 1.5 }));

    expect(result.confidenceAtSelection).toBe(1.0);
    expect(store.calls[0]!.execution.confidenceAtSelection).toBe(1.0);
  });

  it("clamps confidenceAtSelection below 0.0 to 0.0", async () => {
    const store    = makeStore();
    const observer = createExecutionObserver({ store, metrics: new ObserverMetrics() });
    const result   = await observer.observe(baseInput({ confidenceAtSelection: -0.2 }));

    expect(result.confidenceAtSelection).toBe(0.0);
    expect(store.calls[0]!.execution.confidenceAtSelection).toBe(0.0);
  });
});

// ---------------------------------------------------------------------------
// M22-A Test 4 — Immutability
// ---------------------------------------------------------------------------

describe("M22 ExecutionObserver — immutability", () => {
  it("returns a frozen ObservationResult", async () => {
    const observer = createExecutionObserver({ store: makeStore(), metrics: new ObserverMetrics() });
    const result   = await observer.observe(baseInput());

    expect(Object.isFrozen(result)).toBe(true);
  });

  it("returns a frozen result even when store.record() throws", async () => {
    const failingStore: ObservationStore = {
      record: vi.fn().mockRejectedValue(new Error("fail")),
    };
    const observer = createExecutionObserver({ store: failingStore, metrics: new ObserverMetrics() });
    const result   = await observer.observe(baseInput());

    expect(Object.isFrozen(result)).toBe(true);
  });

  it("makeObservationResult produces a frozen object", () => {
    const result = makeObservationResult({
      recorded: true, durationMs: 100, confidenceAtSelection: 0.9, storedAt: 1000,
    });
    expect(Object.isFrozen(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// M22-A Test 5 — Metrics
// ---------------------------------------------------------------------------

describe("M22 ExecutionObserver — metrics (counters only)", () => {
  let metrics: ObserverMetrics;

  beforeEach(() => { metrics = new ObserverMetrics(); });

  it("increments observation_calls once per observe() call", async () => {
    const observer = createExecutionObserver({ store: makeStore(), metrics });

    await observer.observe(baseInput());
    await observer.observe(baseInput());

    expect(metrics.snapshot().observation_calls).toBe(2);
  });

  it("increments observations_recorded on success", async () => {
    const observer = createExecutionObserver({ store: makeStore(), metrics });

    await observer.observe(baseInput());

    expect(metrics.snapshot().observations_recorded).toBe(1);
    expect(metrics.snapshot().observations_failed).toBe(0);
  });

  it("increments observations_failed on store error", async () => {
    const failingStore: ObservationStore = {
      record: vi.fn().mockRejectedValue(new Error("fail")),
    };
    const observer = createExecutionObserver({ store: failingStore, metrics });

    await observer.observe(baseInput());

    expect(metrics.snapshot().observations_failed).toBe(1);
    expect(metrics.snapshot().observations_recorded).toBe(0);
  });

  it("increments observations_failed on invalid input", async () => {
    const observer = createExecutionObserver({ store: makeStore(), metrics });

    await observer.observe(baseInput({ toolName: "" }));

    expect(metrics.snapshot().observations_failed).toBe(1);
  });

  it("computes average_duration_ms from recorded observations only", async () => {
    const observer = createExecutionObserver({ store: makeStore(), metrics });

    await observer.observe(baseInput({ durationMs: 100 }));
    await observer.observe(baseInput({ durationMs: 200 }));

    expect(metrics.snapshot().average_duration_ms).toBeCloseTo(150);
  });

  it("average_duration_ms is 0 when no observations recorded", () => {
    expect(metrics.snapshot().average_duration_ms).toBe(0);
  });

  it("snapshot is immutable", () => {
    const snap = metrics.snapshot();
    expect(Object.isFrozen(snap)).toBe(true);
  });

  it("reset() clears all counters", async () => {
    const observer = createExecutionObserver({ store: makeStore(), metrics });

    await observer.observe(baseInput());
    metrics.reset();

    const snap = metrics.snapshot();
    expect(snap.observation_calls).toBe(0);
    expect(snap.observations_recorded).toBe(0);
    expect(snap.observations_failed).toBe(0);
    expect(snap.average_duration_ms).toBe(0);
  });

  it("record() is called exactly once per observe() invocation", async () => {
    const recordSpy = vi.fn();
    const proxyMetrics: ObserverMetrics = Object.assign(new ObserverMetrics(), {
      record: recordSpy,
    });
    const observer = createExecutionObserver({ store: makeStore(), metrics: proxyMetrics });

    await observer.observe(baseInput());

    expect(recordSpy).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// M22-A Test 6 — Determinism: Observer is write-only, never reads from store
// ---------------------------------------------------------------------------

describe("M22 ExecutionObserver — write-only determinism", () => {
  it("never calls any read method on the store", async () => {
    const store = {
      record:   vi.fn().mockResolvedValue(undefined),
      getStats: vi.fn(),           // M21 reader method — must NOT be called
      loadAll:  vi.fn(),           // M21 load method — must NOT be called
    };
    // Provide only the ObservationStore interface subset to the observer
    const observer = createExecutionObserver({
      store:   { record: store.record },
      metrics: new ObserverMetrics(),
    });

    await observer.observe(baseInput());

    expect(store.getStats).not.toHaveBeenCalled();
    expect(store.loadAll).not.toHaveBeenCalled();
    expect(store.record).toHaveBeenCalledOnce();
  });

  it("does not perform any tool selection or ranking", async () => {
    // Verify the observer's store type has no scoring/ranking surface
    // by confirming only `record` is called — structural type guarantee
    const recordedMethods: string[] = [];
    const tracingStore = new Proxy<ObservationStore>(
      { record: async () => {} },
      {
        get(target, prop) {
          recordedMethods.push(String(prop));
          return (target as unknown as Record<string, unknown>)[String(prop)];
        },
      },
    );

    const observer = createExecutionObserver({ store: tracingStore, metrics: new ObserverMetrics() });
    await observer.observe(baseInput());

    // Only "record" should have been accessed
    const nonRecord = recordedMethods.filter((m) => m !== "record" && m !== "then");
    expect(nonRecord).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// M22-A Test 7 — Scope forwarding
// ---------------------------------------------------------------------------

describe("M22 ExecutionObserver — scope forwarding", () => {
  it("forwards the exact tenantId and botId to the store", async () => {
    const store    = makeStore();
    const observer = createExecutionObserver({ store, metrics: new ObserverMetrics() });

    await observer.observe(baseInput({
      scope: { tenantId: "my-tenant", botId: "my-bot" },
    }));

    expect(store.calls[0]!.scope.tenantId).toBe("my-tenant");
    expect(store.calls[0]!.scope.botId).toBe("my-bot");
  });

  it("supports multiple distinct scopes in sequence", async () => {
    const store    = makeStore();
    const observer = createExecutionObserver({ store, metrics: new ObserverMetrics() });

    await observer.observe(baseInput({ scope: { tenantId: "t1", botId: "b1" }, toolName: "tool-a" }));
    await observer.observe(baseInput({ scope: { tenantId: "t2", botId: "b2" }, toolName: "tool-b" }));

    expect(store.calls[0]!.scope.tenantId).toBe("t1");
    expect(store.calls[1]!.scope.tenantId).toBe("t2");
  });
});
