/**
 * Phase 3C — Memory Metrics & Observability tests (Milestone 6)
 *
 * Covers:
 *   MemoryMetricsCollector constructor
 *     - subscribes to all 11 memory event types on construction
 *
 *   Load metrics
 *     - starts counter increments on "memory.load_started"
 *     - successes counter increments on "memory.load_completed"
 *     - failures counter increments on "memory.load_failed"
 *     - latency measured from started.timestamp → completed.timestamp using requestId
 *     - latency not recorded when completion has no matching start
 *     - latency not recorded for failed loads (no start/completion pairing on failure)
 *     - budget utilization tracked from budgetUsed on completion
 *     - per-tier token sums accumulated correctly across multiple loads
 *     - truncations count incremented on "memory.budget_truncated"
 *     - tokensSavedByTruncation accumulates from multiple truncation events
 *     - multiple concurrent loads paired independently by requestId
 *
 *   Record metrics
 *     - starts counter increments on "memory.record_started"
 *     - successes counter increments on "memory.record_completed"
 *     - failures counter increments on "memory.record_failed"
 *     - latency measured from started.timestamp → completed.timestamp using requestId
 *     - writeConflicts increments on "memory.write_conflict"
 *     - tierDegradations increments on "memory.tier_degraded"
 *
 *   Decay metrics
 *     - factsDecayed increments on each "memory.fact_decayed" event
 *
 *   Forget metrics
 *     - count increments on "memory.forgotten"
 *     - tiersClearedTotal accumulates payload.tiersCleared.length across events
 *
 *   NumericStats helpers
 *     - zero case → count/total/min/max/mean all 0
 *     - single observation → min === max === mean === value
 *     - multiple observations → correct min, max, mean
 *
 *   snapshot()
 *     - capturedAt equals the injected nowMs
 *     - returns deeply frozen (immutable) object
 *     - all five top-level keys present
 *     - snapshot after zero events → all counts 0, all stats zeroed
 *
 *   reset()
 *     - clears all counters and stats
 *     - clears pending-start maps (no stale latency pairing after reset)
 *     - calling reset on empty collector is a no-op (no throw)
 *
 *   detach()
 *     - unsubscribes all listeners; events fired after detach are not counted
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  MemoryMetricsCollector,
  type MemoryMetricsSnapshot,
} from "../memory-metrics-collector.js";
import type { AgentEvent, EventBus, MemoryTierId } from "../../tools/types.js";
import type { ExecutionContext } from "../../tools/types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NOW_MS = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// Minimal in-process EventBus for testing
// ---------------------------------------------------------------------------

class SimpleEventBus implements EventBus {
  private readonly _listeners = new Map<string, Set<(e: AgentEvent) => void>>();

  emit(event: AgentEvent): void {
    const set = this._listeners.get(event.type);
    if (!set) return;
    for (const fn of [...set]) fn(event);
  }

  on(type: AgentEvent["type"], fn: (e: AgentEvent) => void): void {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type)!.add(fn);
  }

  once(type: AgentEvent["type"], fn: (e: AgentEvent) => void): void {
    const wrapper = (e: AgentEvent) => {
      fn(e);
      this.off(type, wrapper);
    };
    this.on(type, wrapper);
  }

  off(type: AgentEvent["type"], fn: (e: AgentEvent) => void): void {
    this._listeners.get(type)?.delete(fn);
  }

  /** How many listeners are registered for a given event type. */
  listenerCount(type: AgentEvent["type"]): number {
    return this._listeners.get(type)?.size ?? 0;
  }
}

// ---------------------------------------------------------------------------
// Minimal fake ExecutionContext (only requestId is used by the collector)
// ---------------------------------------------------------------------------

function fakeCtx(requestId: string): ExecutionContext {
  return {
    requestId,
    correlationId: requestId,
    userId: "u1",
    metadata: { requestId, correlationId: requestId, timestamp: NOW_MS },
    user: { id: "u1", botId: "b1" },
    conversation: { key: "conv-1", state: {} },
    history: [],
    memory: { facts: [], history: [] },
    abortSignal: new AbortController().signal,
    logger: null,
    metrics: {} as never,
    clock: { now: () => NOW_MS },
    idGenerator: { generate: () => requestId },
  } as unknown as ExecutionContext;
}

// ---------------------------------------------------------------------------
// AgentEvent builders
// ---------------------------------------------------------------------------

function evLoadStarted(requestId: string, timestamp: number): AgentEvent {
  return {
    type: "memory.load_started",
    context: fakeCtx(requestId),
    payload: {
      scope: { tenantId: "t1", botId: "b1", userId: "u1", sessionId: "s1" },
      timestamp,
    },
  };
}

function evLoadCompleted(
  requestId: string,
  timestamp: number,
  budgetUsed = 100,
  tiersSummary: Partial<Record<MemoryTierId, number>> = {},
): AgentEvent {
  return {
    type: "memory.load_completed",
    context: fakeCtx(requestId),
    payload: {
      version: 1,
      budgetUsed,
      tiersSummary: {
        request: 0,
        session: 0,
        conversation: 0,
        user_profile: 0,
        tool_execution: 0,
        ...tiersSummary,
      } as Record<MemoryTierId, number>,
      timestamp,
    },
  };
}

function evLoadFailed(requestId: string, timestamp: number): AgentEvent {
  return {
    type: "memory.load_failed",
    context: fakeCtx(requestId),
    payload: { error: "db timeout", timestamp },
  };
}

function evRecordStarted(requestId: string, timestamp: number): AgentEvent {
  return {
    type: "memory.record_started",
    context: fakeCtx(requestId),
    payload: {
      scope: { tenantId: "t1", botId: "b1", userId: "u1", sessionId: "s1" },
      timestamp,
    },
  };
}

function evRecordCompleted(requestId: string, timestamp: number): AgentEvent {
  return {
    type: "memory.record_completed",
    context: fakeCtx(requestId),
    payload: { tiersWritten: ["conversation"] as MemoryTierId[], timestamp },
  };
}

function evRecordFailed(requestId: string, timestamp: number): AgentEvent {
  return {
    type: "memory.record_failed",
    context: fakeCtx(requestId),
    payload: { error: "write error", timestamp },
  };
}

function evBudgetTruncated(
  requestId: string,
  removedTiers: MemoryTierId[],
  tokensSaved: number,
): AgentEvent {
  return {
    type: "memory.budget_truncated",
    context: fakeCtx(requestId),
    payload: { removedTiers, tokensSaved, timestamp: NOW_MS },
  };
}

function evTierDegraded(requestId: string, tier: MemoryTierId): AgentEvent {
  return {
    type: "memory.tier_degraded",
    context: fakeCtx(requestId),
    payload: { tier, reason: "provider unavailable", timestamp: NOW_MS },
  };
}

function evWriteConflict(requestId: string): AgentEvent {
  return {
    type: "memory.write_conflict",
    context: fakeCtx(requestId),
    payload: { tier: "conversation", retrying: true, timestamp: NOW_MS },
  };
}

function evFactDecayed(requestId: string, factId: string): AgentEvent {
  return {
    type: "memory.fact_decayed",
    context: fakeCtx(requestId),
    payload: { factId, key: "name", finalConfidence: 0.05, timestamp: NOW_MS },
  };
}

function evForgotten(requestId: string, tiersCleared: MemoryTierId[]): AgentEvent {
  return {
    type: "memory.forgotten",
    context: fakeCtx(requestId),
    payload: {
      scope: { tenantId: "t1", botId: "b1", userId: "u1" },
      tiersCleared,
      timestamp: NOW_MS,
    },
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let bus: SimpleEventBus;
let collector: MemoryMetricsCollector;

beforeEach(() => {
  bus = new SimpleEventBus();
  collector = new MemoryMetricsCollector(bus);
});

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

describe("MemoryMetricsCollector — constructor", () => {
  it("subscribes a listener for each of the 11 memory event types", () => {
    const types: AgentEvent["type"][] = [
      "memory.load_started",
      "memory.load_completed",
      "memory.load_failed",
      "memory.record_started",
      "memory.record_completed",
      "memory.record_failed",
      "memory.budget_truncated",
      "memory.tier_degraded",
      "memory.write_conflict",
      "memory.fact_decayed",
      "memory.forgotten",
    ];
    for (const t of types) {
      expect(bus.listenerCount(t), `listener for ${t}`).toBeGreaterThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Load metrics
// ---------------------------------------------------------------------------

describe("Load metrics", () => {
  it("increments starts on load_started", () => {
    bus.emit(evLoadStarted("r1", NOW_MS));
    expect(collector.snapshot(NOW_MS).load.starts).toBe(1);
  });

  it("increments successes on load_completed", () => {
    bus.emit(evLoadStarted("r1", NOW_MS));
    bus.emit(evLoadCompleted("r1", NOW_MS + 50));
    expect(collector.snapshot(NOW_MS).load.successes).toBe(1);
  });

  it("increments failures on load_failed", () => {
    bus.emit(evLoadStarted("r1", NOW_MS));
    bus.emit(evLoadFailed("r1", NOW_MS + 10));
    expect(collector.snapshot(NOW_MS).load.failures).toBe(1);
  });

  it("measures load latency as completed.timestamp − started.timestamp", () => {
    bus.emit(evLoadStarted("r1", NOW_MS));
    bus.emit(evLoadCompleted("r1", NOW_MS + 80));
    const snap = collector.snapshot(NOW_MS);
    expect(snap.load.latency.count).toBe(1);
    expect(snap.load.latency.mean).toBe(80);
    expect(snap.load.latency.min).toBe(80);
    expect(snap.load.latency.max).toBe(80);
  });

  it("accumulates latency correctly across multiple successful loads", () => {
    bus.emit(evLoadStarted("r1", NOW_MS));
    bus.emit(evLoadCompleted("r1", NOW_MS + 40));   // 40ms
    bus.emit(evLoadStarted("r2", NOW_MS));
    bus.emit(evLoadCompleted("r2", NOW_MS + 120));  // 120ms
    const snap = collector.snapshot(NOW_MS);
    expect(snap.load.latency.count).toBe(2);
    expect(snap.load.latency.min).toBe(40);
    expect(snap.load.latency.max).toBe(120);
    expect(snap.load.latency.mean).toBe(80);
    expect(snap.load.latency.total).toBe(160);
  });

  it("does not record latency when completion has no matching start (orphan)", () => {
    // Emit a completion without a prior start (e.g. collector attached mid-flight)
    bus.emit(evLoadCompleted("r1", NOW_MS + 50));
    const snap = collector.snapshot(NOW_MS);
    expect(snap.load.latency.count).toBe(0);
  });

  it("does not corrupt latency when different requestIds are interleaved", () => {
    bus.emit(evLoadStarted("r1", NOW_MS + 0));
    bus.emit(evLoadStarted("r2", NOW_MS + 10));
    bus.emit(evLoadCompleted("r2", NOW_MS + 60));   // r2 latency = 50ms
    bus.emit(evLoadCompleted("r1", NOW_MS + 100));  // r1 latency = 100ms
    const snap = collector.snapshot(NOW_MS);
    expect(snap.load.latency.count).toBe(2);
    expect(snap.load.latency.min).toBe(50);
    expect(snap.load.latency.max).toBe(100);
  });

  it("tracks budget utilization from budgetUsed on completion", () => {
    bus.emit(evLoadStarted("r1", NOW_MS));
    bus.emit(evLoadCompleted("r1", NOW_MS + 10, 250));
    const snap = collector.snapshot(NOW_MS);
    expect(snap.load.budgetUtilization.count).toBe(1);
    expect(snap.load.budgetUtilization.mean).toBe(250);
  });

  it("accumulates per-tier token sums across multiple loads", () => {
    bus.emit(evLoadStarted("r1", NOW_MS));
    bus.emit(evLoadCompleted("r1", NOW_MS + 10, 300, {
      conversation: 200,
      user_profile: 80,
    }));
    bus.emit(evLoadStarted("r2", NOW_MS));
    bus.emit(evLoadCompleted("r2", NOW_MS + 20, 150, {
      conversation: 100,
      session: 50,
    }));
    const sums = collector.snapshot(NOW_MS).load.tierTokenSums;
    expect(sums.conversation).toBe(300);   // 200 + 100
    expect(sums.user_profile).toBe(80);
    expect(sums.session).toBe(50);
    expect(sums.request).toBe(0);          // never appeared → still 0
    expect(sums.tool_execution).toBe(0);
  });

  it("all five tier keys are always present in tierTokenSums", () => {
    const sums = collector.snapshot(NOW_MS).load.tierTokenSums;
    const keys: MemoryTierId[] = [
      "request", "session", "conversation", "user_profile", "tool_execution",
    ];
    for (const k of keys) {
      expect(k in sums, `key ${k} missing`).toBe(true);
    }
  });

  it("increments truncations and tokensSavedByTruncation", () => {
    bus.emit(evBudgetTruncated("r1", ["tool_execution"], 120));
    bus.emit(evBudgetTruncated("r2", ["tool_execution", "session"], 80));
    const snap = collector.snapshot(NOW_MS);
    expect(snap.load.truncations).toBe(2);
    expect(snap.load.tokensSavedByTruncation).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Record metrics
// ---------------------------------------------------------------------------

describe("Record metrics", () => {
  it("increments starts on record_started", () => {
    bus.emit(evRecordStarted("r1", NOW_MS));
    expect(collector.snapshot(NOW_MS).record.starts).toBe(1);
  });

  it("increments successes on record_completed", () => {
    bus.emit(evRecordStarted("r1", NOW_MS));
    bus.emit(evRecordCompleted("r1", NOW_MS + 30));
    expect(collector.snapshot(NOW_MS).record.successes).toBe(1);
  });

  it("increments failures on record_failed", () => {
    bus.emit(evRecordStarted("r1", NOW_MS));
    bus.emit(evRecordFailed("r1", NOW_MS + 5));
    expect(collector.snapshot(NOW_MS).record.failures).toBe(1);
  });

  it("measures record latency correctly", () => {
    bus.emit(evRecordStarted("r1", NOW_MS));
    bus.emit(evRecordCompleted("r1", NOW_MS + 35));
    const snap = collector.snapshot(NOW_MS);
    expect(snap.record.latency.count).toBe(1);
    expect(snap.record.latency.mean).toBe(35);
  });

  it("does not record latency when completion has no matching start", () => {
    bus.emit(evRecordCompleted("r1", NOW_MS + 50));
    expect(collector.snapshot(NOW_MS).record.latency.count).toBe(0);
  });

  it("pairs record latency by requestId independently", () => {
    bus.emit(evRecordStarted("r1", NOW_MS));
    bus.emit(evRecordStarted("r2", NOW_MS + 5));
    bus.emit(evRecordCompleted("r2", NOW_MS + 25));   // r2: 20ms
    bus.emit(evRecordCompleted("r1", NOW_MS + 60));   // r1: 60ms
    const snap = collector.snapshot(NOW_MS);
    expect(snap.record.latency.count).toBe(2);
    expect(snap.record.latency.min).toBe(20);
    expect(snap.record.latency.max).toBe(60);
  });

  it("increments writeConflicts on write_conflict", () => {
    bus.emit(evWriteConflict("r1"));
    bus.emit(evWriteConflict("r1"));
    expect(collector.snapshot(NOW_MS).record.writeConflicts).toBe(2);
  });

  it("increments tierDegradations on tier_degraded", () => {
    bus.emit(evTierDegraded("r1", "conversation"));
    bus.emit(evTierDegraded("r2", "session"));
    expect(collector.snapshot(NOW_MS).record.tierDegradations).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Decay metrics
// ---------------------------------------------------------------------------

describe("Decay metrics", () => {
  it("increments factsDecayed on each fact_decayed event", () => {
    bus.emit(evFactDecayed("r1", "fact-1"));
    bus.emit(evFactDecayed("r1", "fact-2"));
    bus.emit(evFactDecayed("r2", "fact-3"));
    expect(collector.snapshot(NOW_MS).decay.factsDecayed).toBe(3);
  });

  it("starts at 0 with no events", () => {
    expect(collector.snapshot(NOW_MS).decay.factsDecayed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Forget metrics
// ---------------------------------------------------------------------------

describe("Forget metrics", () => {
  it("increments count on memory.forgotten", () => {
    bus.emit(evForgotten("r1", ["conversation", "session"]));
    expect(collector.snapshot(NOW_MS).forget.count).toBe(1);
  });

  it("accumulates tiersClearedTotal from each event's tiersCleared.length", () => {
    bus.emit(evForgotten("r1", ["conversation", "session", "user_profile"]));
    bus.emit(evForgotten("r2", ["session"]));
    const snap = collector.snapshot(NOW_MS);
    expect(snap.forget.count).toBe(2);
    expect(snap.forget.tiersClearedTotal).toBe(4); // 3 + 1
  });
});

// ---------------------------------------------------------------------------
// NumericStats edge cases
// ---------------------------------------------------------------------------

describe("NumericStats", () => {
  it("returns all zeros when no observations recorded (zero case)", () => {
    const snap = collector.snapshot(NOW_MS);
    const s = snap.load.latency;
    expect(s.count).toBe(0);
    expect(s.total).toBe(0);
    expect(s.min).toBe(0);
    expect(s.max).toBe(0);
    expect(s.mean).toBe(0);
  });

  it("for a single observation: min === max === mean === value", () => {
    bus.emit(evLoadStarted("r1", NOW_MS));
    bus.emit(evLoadCompleted("r1", NOW_MS + 75));
    const s = collector.snapshot(NOW_MS).load.latency;
    expect(s.min).toBe(75);
    expect(s.max).toBe(75);
    expect(s.mean).toBe(75);
    expect(s.total).toBe(75);
    expect(s.count).toBe(1);
  });

  it("computes correct min, max, mean across multiple observations", () => {
    const latencies = [10, 50, 30, 90, 20];
    for (let i = 0; i < latencies.length; i++) {
      bus.emit(evLoadStarted(`r${i}`, NOW_MS));
      bus.emit(evLoadCompleted(`r${i}`, NOW_MS + latencies[i]!));
    }
    const s = collector.snapshot(NOW_MS).load.latency;
    expect(s.count).toBe(5);
    expect(s.min).toBe(10);
    expect(s.max).toBe(90);
    expect(s.total).toBe(200);
    expect(s.mean).toBe(40);
  });
});

// ---------------------------------------------------------------------------
// snapshot()
// ---------------------------------------------------------------------------

describe("snapshot()", () => {
  it("capturedAt equals the injected nowMs", () => {
    expect(collector.snapshot(12345).capturedAt).toBe(12345);
  });

  it("returns an object with load, record, decay, forget keys", () => {
    const snap = collector.snapshot(NOW_MS);
    expect(snap).toHaveProperty("load");
    expect(snap).toHaveProperty("record");
    expect(snap).toHaveProperty("decay");
    expect(snap).toHaveProperty("forget");
  });

  it("is frozen at the top level", () => {
    const snap = collector.snapshot(NOW_MS);
    expect(Object.isFrozen(snap)).toBe(true);
  });

  it("load, record, decay, forget sub-objects are also frozen", () => {
    const snap = collector.snapshot(NOW_MS);
    expect(Object.isFrozen(snap.load)).toBe(true);
    expect(Object.isFrozen(snap.record)).toBe(true);
    expect(Object.isFrozen(snap.decay)).toBe(true);
    expect(Object.isFrozen(snap.forget)).toBe(true);
  });

  it("latency and budgetUtilization NumericStats are frozen", () => {
    bus.emit(evLoadStarted("r1", NOW_MS));
    bus.emit(evLoadCompleted("r1", NOW_MS + 50));
    const snap = collector.snapshot(NOW_MS);
    expect(Object.isFrozen(snap.load.latency)).toBe(true);
    expect(Object.isFrozen(snap.load.budgetUtilization)).toBe(true);
    expect(Object.isFrozen(snap.record.latency)).toBe(true);
  });

  it("tierTokenSums is frozen", () => {
    const snap = collector.snapshot(NOW_MS);
    expect(Object.isFrozen(snap.load.tierTokenSums)).toBe(true);
  });

  it("snapshot after zero events has all counts 0 and stats zeroed", () => {
    const snap = collector.snapshot(NOW_MS);
    expect(snap.load.starts).toBe(0);
    expect(snap.load.successes).toBe(0);
    expect(snap.load.failures).toBe(0);
    expect(snap.load.truncations).toBe(0);
    expect(snap.load.tokensSavedByTruncation).toBe(0);
    expect(snap.load.latency.count).toBe(0);
    expect(snap.record.starts).toBe(0);
    expect(snap.record.writeConflicts).toBe(0);
    expect(snap.decay.factsDecayed).toBe(0);
    expect(snap.forget.count).toBe(0);
  });

  it("successive snapshots are independent value objects (no shared mutation)", () => {
    bus.emit(evLoadStarted("r1", NOW_MS));
    bus.emit(evLoadCompleted("r1", NOW_MS + 50));
    const snap1 = collector.snapshot(NOW_MS);

    // Fire more events
    bus.emit(evLoadStarted("r2", NOW_MS));
    bus.emit(evLoadCompleted("r2", NOW_MS + 100));
    const snap2 = collector.snapshot(NOW_MS);

    // snap1 must not be mutated by events fired after it was taken
    expect((snap1 as MemoryMetricsSnapshot).load.successes).toBe(1);
    expect((snap2 as MemoryMetricsSnapshot).load.successes).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// reset()
// ---------------------------------------------------------------------------

describe("reset()", () => {
  it("clears all counters to zero", () => {
    bus.emit(evLoadStarted("r1", NOW_MS));
    bus.emit(evLoadCompleted("r1", NOW_MS + 50, 200, { conversation: 100 }));
    bus.emit(evBudgetTruncated("r1", ["session"], 50));
    bus.emit(evRecordStarted("r1", NOW_MS));
    bus.emit(evRecordCompleted("r1", NOW_MS + 20));
    bus.emit(evWriteConflict("r1"));
    bus.emit(evTierDegraded("r1", "session"));
    bus.emit(evFactDecayed("r1", "fact-1"));
    bus.emit(evForgotten("r1", ["conversation"]));

    collector.reset();
    const snap = collector.snapshot(NOW_MS);

    expect(snap.load.starts).toBe(0);
    expect(snap.load.successes).toBe(0);
    expect(snap.load.failures).toBe(0);
    expect(snap.load.truncations).toBe(0);
    expect(snap.load.tokensSavedByTruncation).toBe(0);
    expect(snap.load.latency.count).toBe(0);
    expect(snap.load.budgetUtilization.count).toBe(0);
    expect(snap.load.tierTokenSums.conversation).toBe(0);
    expect(snap.record.starts).toBe(0);
    expect(snap.record.successes).toBe(0);
    expect(snap.record.writeConflicts).toBe(0);
    expect(snap.record.tierDegradations).toBe(0);
    expect(snap.record.latency.count).toBe(0);
    expect(snap.decay.factsDecayed).toBe(0);
    expect(snap.forget.count).toBe(0);
    expect(snap.forget.tiersClearedTotal).toBe(0);
  });

  it("clears pending-start maps so no stale latency pairing occurs after reset", () => {
    // Fire a start without a completion, then reset
    bus.emit(evLoadStarted("r1", NOW_MS));
    collector.reset();

    // Now fire a completion for the SAME requestId after reset
    bus.emit(evLoadCompleted("r1", NOW_MS + 200));

    // Latency should NOT be recorded (start was cleared by reset)
    expect(collector.snapshot(NOW_MS).load.latency.count).toBe(0);
  });

  it("calling reset on an empty collector does not throw", () => {
    expect(() => collector.reset()).not.toThrow();
  });

  it("continues counting correctly after reset", () => {
    bus.emit(evLoadStarted("r1", NOW_MS));
    bus.emit(evLoadCompleted("r1", NOW_MS + 50));
    collector.reset();

    bus.emit(evLoadStarted("r2", NOW_MS));
    bus.emit(evLoadCompleted("r2", NOW_MS + 70));
    const snap = collector.snapshot(NOW_MS);

    expect(snap.load.starts).toBe(1);
    expect(snap.load.successes).toBe(1);
    expect(snap.load.latency.count).toBe(1);
    expect(snap.load.latency.mean).toBe(70);
  });
});

// ---------------------------------------------------------------------------
// detach()
// ---------------------------------------------------------------------------

describe("detach()", () => {
  it("unsubscribes all listeners so events fired after detach are not counted", () => {
    collector.detach(bus);

    bus.emit(evLoadStarted("r1", NOW_MS));
    bus.emit(evLoadCompleted("r1", NOW_MS + 50));
    bus.emit(evRecordStarted("r1", NOW_MS));
    bus.emit(evRecordCompleted("r1", NOW_MS + 20));
    bus.emit(evFactDecayed("r1", "fact-1"));
    bus.emit(evForgotten("r1", ["session"]));

    const snap = collector.snapshot(NOW_MS);
    expect(snap.load.starts).toBe(0);
    expect(snap.load.successes).toBe(0);
    expect(snap.record.starts).toBe(0);
    expect(snap.decay.factsDecayed).toBe(0);
    expect(snap.forget.count).toBe(0);
  });

  it("events received before detach are preserved in the snapshot", () => {
    bus.emit(evLoadStarted("r1", NOW_MS));
    bus.emit(evLoadCompleted("r1", NOW_MS + 60));
    bus.emit(evFactDecayed("r1", "fact-1"));

    collector.detach(bus);

    // Events fired after detach are ignored; pre-detach counts remain
    bus.emit(evLoadStarted("r2", NOW_MS));
    bus.emit(evLoadCompleted("r2", NOW_MS + 30));

    const snap = collector.snapshot(NOW_MS);
    expect(snap.load.successes).toBe(1); // only the pre-detach load
    expect(snap.decay.factsDecayed).toBe(1);
  });

  it("calling detach twice does not throw", () => {
    expect(() => {
      collector.detach(bus);
      collector.detach(bus);
    }).not.toThrow();
  });
});
