/**
 * Phase 3C — Milestone 6: Memory Metrics & Observability
 *
 * MemoryMetricsCollector passively observes the EventBus and accumulates
 * counters and latency distributions for every memory subsystem operation.
 *
 * Design constraints (all enforced here):
 *   - Zero business-logic changes — this file never imports MemoryManager,
 *     StorageProvider, or any runtime component.
 *   - No request-path decisions — metrics are read-only by the caller.
 *   - snapshot() always returns a deeply-frozen immutable value.
 *   - reset() clears all counters atomically (useful for windowed aggregation).
 *   - detach() unsubscribes from the EventBus so the collector can be GC'd.
 *   - All latency pairing uses context.requestId as the correlation key.
 *   - The clock is injectable for determinism in tests (nowMs parameter on snapshot).
 */

import type { AgentEvent, EventBus, MemoryTierId } from "../tools/types.js";

// ---------------------------------------------------------------------------
// Primitive stats bucket (latency, token budgets — any numeric series)
// ---------------------------------------------------------------------------

/**
 * Immutable statistical summary of a numeric series (latencies, token counts…).
 * `count === 0` → `minMs/maxMs/meanMs` are all 0 (not Infinity / NaN).
 */
export interface NumericStats {
  /** Number of observations. */
  readonly count:   number;
  /** Sum of all observations. */
  readonly total:   number;
  /** Minimum observed value (0 when count === 0). */
  readonly min:     number;
  /** Maximum observed value (0 when count === 0). */
  readonly max:     number;
  /** Arithmetic mean (0 when count === 0). */
  readonly mean:    number;
}

// ---------------------------------------------------------------------------
// Per-category snapshot types
// ---------------------------------------------------------------------------

export interface LoadMetricsSnapshot {
  /** Total calls to MemoryManager.load() observed via "memory.load_started". */
  readonly starts:    number;
  /** Loads that emitted "memory.load_completed". */
  readonly successes: number;
  /** Loads that emitted "memory.load_failed". */
  readonly failures:  number;
  /**
   * Wall-clock latency distribution for successful loads (ms).
   * Measured from "memory.load_started" → "memory.load_completed" using
   * context.requestId as the correlation key.
   */
  readonly latency:            NumericStats;
  /**
   * Token budget consumed per successful load (budgetUsed from the
   * "memory.load_completed" payload).
   */
  readonly budgetUtilization:  NumericStats;
  /** Number of times the budget was exceeded and tiers were dropped. */
  readonly truncations:        number;
  /** Cumulative tokens saved across all budget-truncation events. */
  readonly tokensSavedByTruncation: number;
  /**
   * Per-tier cumulative token sums across all successful loads.
   * Represents how many tokens each tier has consumed in aggregate.
   */
  readonly tierTokenSums: Readonly<Record<MemoryTierId, number>>;
}

export interface RecordMetricsSnapshot {
  readonly starts:    number;
  readonly successes: number;
  readonly failures:  number;
  /**
   * Wall-clock latency for successful record operations (ms).
   * Paired by context.requestId.
   */
  readonly latency:         NumericStats;
  /** Count of "memory.write_conflict" events seen. */
  readonly writeConflicts:  number;
  /** Count of "memory.tier_degraded" events seen. */
  readonly tierDegradations: number;
}

export interface DecayMetricsSnapshot {
  /**
   * Total individual facts that crossed the decay threshold and emitted
   * "memory.fact_decayed".  Cumulative across all scopes and sweeps.
   */
  readonly factsDecayed: number;
}

export interface ForgetMetricsSnapshot {
  /** Number of "memory.forgotten" events observed. */
  readonly count: number;
  /** Cumulative number of tiers cleared across all forget operations. */
  readonly tiersClearedTotal: number;
}

/** Immutable snapshot of all memory subsystem metrics at a point in time. */
export interface MemoryMetricsSnapshot {
  /** Timestamp (ms) when snapshot() was called. */
  readonly capturedAt: number;
  readonly load:   LoadMetricsSnapshot;
  readonly record: RecordMetricsSnapshot;
  readonly decay:  DecayMetricsSnapshot;
  readonly forget: ForgetMetricsSnapshot;
}

// ---------------------------------------------------------------------------
// Internal mutable accumulator helpers
// ---------------------------------------------------------------------------

interface MutableNumericStats {
  count:  number;
  total:  number;
  min:    number;
  max:    number;
}

function makeStats(): MutableNumericStats {
  return { count: 0, total: 0, min: Infinity, max: -Infinity };
}

function observeStats(s: MutableNumericStats, value: number): void {
  s.count  += 1;
  s.total  += value;
  if (value < s.min) s.min = value;
  if (value > s.max) s.max = value;
}

function freezeStats(s: MutableNumericStats): NumericStats {
  if (s.count === 0) {
    return Object.freeze({ count: 0, total: 0, min: 0, max: 0, mean: 0 });
  }
  return Object.freeze({
    count: s.count,
    total: s.total,
    min:   s.min,
    max:   s.max,
    mean:  s.total / s.count,
  });
}

// All MemoryTierId values — used to initialise per-tier maps.
const ALL_TIERS: readonly MemoryTierId[] = [
  "request",
  "session",
  "conversation",
  "user_profile",
  "tool_execution",
] as const;

function zeroTierMap(): Record<MemoryTierId, number> {
  return Object.fromEntries(ALL_TIERS.map((t) => [t, 0])) as Record<MemoryTierId, number>;
}

// ---------------------------------------------------------------------------
// MemoryMetricsCollector
// ---------------------------------------------------------------------------

/**
 * Subscribes to an EventBus and accumulates memory subsystem metrics.
 *
 * Usage:
 *   const collector = new MemoryMetricsCollector(eventBus);
 *   // …after requests run…
 *   const snap = collector.snapshot();
 *   // …reset counters for next time window…
 *   collector.reset();
 *   // …when shutting down…
 *   collector.detach(eventBus);
 */
export class MemoryMetricsCollector {
  // ----- Load -----
  private _loadStarts    = 0;
  private _loadSuccesses = 0;
  private _loadFailures  = 0;
  private _loadLatency         = makeStats();
  private _loadBudget          = makeStats();
  private _loadTruncations     = 0;
  private _tokensSaved         = 0;
  private _tierTokenSums       = zeroTierMap();
  /** Pending load start timestamps keyed by context.requestId. */
  private readonly _pendingLoads = new Map<string, number>();

  // ----- Record -----
  private _recordStarts    = 0;
  private _recordSuccesses = 0;
  private _recordFailures  = 0;
  private _recordLatency        = makeStats();
  private _writeConflicts       = 0;
  private _tierDegradations     = 0;
  /** Pending record start timestamps keyed by context.requestId. */
  private readonly _pendingRecords = new Map<string, number>();

  // ----- Decay -----
  private _factsDecayed = 0;

  // ----- Forget -----
  private _forgetCount       = 0;
  private _tiersClearedTotal = 0;

  // ----- Bound listener references (needed for detach()) -----
  private readonly _listeners: {
    type: AgentEvent["type"];
    fn:   (e: AgentEvent) => void;
  }[];

  constructor(eventBus: EventBus) {
    // Bind all handlers once so the same reference can be passed to off().
    const onLoadStarted    = (e: AgentEvent) => this._handleLoadStarted(e);
    const onLoadCompleted  = (e: AgentEvent) => this._handleLoadCompleted(e);
    const onLoadFailed     = (e: AgentEvent) => this._handleLoadFailed(e);
    const onRecordStarted  = (e: AgentEvent) => this._handleRecordStarted(e);
    const onRecordCompleted= (e: AgentEvent) => this._handleRecordCompleted(e);
    const onRecordFailed   = (e: AgentEvent) => this._handleRecordFailed(e);
    const onBudgetTruncated= (e: AgentEvent) => this._handleBudgetTruncated(e);
    const onTierDegraded   = (e: AgentEvent) => this._handleTierDegraded(e);
    const onWriteConflict  = (e: AgentEvent) => this._handleWriteConflict(e);
    const onFactDecayed    = (e: AgentEvent) => this._handleFactDecayed(e);
    const onForgotten      = (e: AgentEvent) => this._handleForgotten(e);

    this._listeners = [
      { type: "memory.load_started",    fn: onLoadStarted    },
      { type: "memory.load_completed",  fn: onLoadCompleted  },
      { type: "memory.load_failed",     fn: onLoadFailed     },
      { type: "memory.record_started",  fn: onRecordStarted  },
      { type: "memory.record_completed",fn: onRecordCompleted},
      { type: "memory.record_failed",   fn: onRecordFailed   },
      { type: "memory.budget_truncated",fn: onBudgetTruncated},
      { type: "memory.tier_degraded",   fn: onTierDegraded   },
      { type: "memory.write_conflict",  fn: onWriteConflict  },
      { type: "memory.fact_decayed",    fn: onFactDecayed    },
      { type: "memory.forgotten",       fn: onForgotten      },
    ];

    for (const { type, fn } of this._listeners) {
      eventBus.on(type, fn);
    }
  }

  // ---------------------------------------------------------------------------
  // Event handlers (private)
  // ---------------------------------------------------------------------------

  private _handleLoadStarted(e: AgentEvent): void {
    if (e.type !== "memory.load_started") return;
    this._loadStarts += 1;
    this._pendingLoads.set(e.context.requestId, e.payload.timestamp);
  }

  private _handleLoadCompleted(e: AgentEvent): void {
    if (e.type !== "memory.load_completed") return;
    this._loadSuccesses += 1;

    // Latency
    const startMs = this._pendingLoads.get(e.context.requestId);
    if (startMs !== undefined) {
      this._pendingLoads.delete(e.context.requestId);
      observeStats(this._loadLatency, e.payload.timestamp - startMs);
    }

    // Budget utilization
    observeStats(this._loadBudget, e.payload.budgetUsed);

    // Per-tier token sums
    for (const [tier, tokens] of Object.entries(e.payload.tiersSummary)) {
      if (tier in this._tierTokenSums) {
        this._tierTokenSums[tier as MemoryTierId] += tokens;
      }
    }
  }

  private _handleLoadFailed(e: AgentEvent): void {
    if (e.type !== "memory.load_failed") return;
    this._loadFailures += 1;
    // Best-effort latency — may have no matching start if the bus missed it.
    const startMs = this._pendingLoads.get(e.context.requestId);
    if (startMs !== undefined) {
      this._pendingLoads.delete(e.context.requestId);
    }
  }

  private _handleRecordStarted(e: AgentEvent): void {
    if (e.type !== "memory.record_started") return;
    this._recordStarts += 1;
    this._pendingRecords.set(e.context.requestId, e.payload.timestamp);
  }

  private _handleRecordCompleted(e: AgentEvent): void {
    if (e.type !== "memory.record_completed") return;
    this._recordSuccesses += 1;

    const startMs = this._pendingRecords.get(e.context.requestId);
    if (startMs !== undefined) {
      this._pendingRecords.delete(e.context.requestId);
      observeStats(this._recordLatency, e.payload.timestamp - startMs);
    }
  }

  private _handleRecordFailed(e: AgentEvent): void {
    if (e.type !== "memory.record_failed") return;
    this._recordFailures += 1;
    const startMs = this._pendingRecords.get(e.context.requestId);
    if (startMs !== undefined) {
      this._pendingRecords.delete(e.context.requestId);
    }
  }

  private _handleBudgetTruncated(e: AgentEvent): void {
    if (e.type !== "memory.budget_truncated") return;
    this._loadTruncations += 1;
    this._tokensSaved     += e.payload.tokensSaved;
  }

  private _handleTierDegraded(e: AgentEvent): void {
    if (e.type !== "memory.tier_degraded") return;
    this._tierDegradations += 1;
  }

  private _handleWriteConflict(e: AgentEvent): void {
    if (e.type !== "memory.write_conflict") return;
    this._writeConflicts += 1;
  }

  private _handleFactDecayed(e: AgentEvent): void {
    if (e.type !== "memory.fact_decayed") return;
    this._factsDecayed += 1;
  }

  private _handleForgotten(e: AgentEvent): void {
    if (e.type !== "memory.forgotten") return;
    this._forgetCount       += 1;
    this._tiersClearedTotal += e.payload.tiersCleared.length;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Returns an immutable snapshot of all accumulated metrics.
   *
   * @param nowMs Injectable wall-clock timestamp (defaults to Date.now()).
   *              Pass a fixed value in tests for determinism.
   */
  snapshot(nowMs: number = Date.now()): MemoryMetricsSnapshot {
    const load: LoadMetricsSnapshot = Object.freeze({
      starts:    this._loadStarts,
      successes: this._loadSuccesses,
      failures:  this._loadFailures,
      latency:            freezeStats(this._loadLatency),
      budgetUtilization:  freezeStats(this._loadBudget),
      truncations:        this._loadTruncations,
      tokensSavedByTruncation: this._tokensSaved,
      tierTokenSums: Object.freeze({ ...this._tierTokenSums }),
    });

    const record: RecordMetricsSnapshot = Object.freeze({
      starts:    this._recordStarts,
      successes: this._recordSuccesses,
      failures:  this._recordFailures,
      latency:          freezeStats(this._recordLatency),
      writeConflicts:   this._writeConflicts,
      tierDegradations: this._tierDegradations,
    });

    const decay: DecayMetricsSnapshot = Object.freeze({
      factsDecayed: this._factsDecayed,
    });

    const forget: ForgetMetricsSnapshot = Object.freeze({
      count:            this._forgetCount,
      tiersClearedTotal: this._tiersClearedTotal,
    });

    return Object.freeze({
      capturedAt: nowMs,
      load,
      record,
      decay,
      forget,
    });
  }

  /**
   * Resets all accumulators to zero.  Pending (unmatched) start events are
   * also cleared, so latency tracking begins fresh after this call.
   *
   * Useful for windowed (per-minute / per-request-batch) aggregation.
   */
  reset(): void {
    this._loadStarts    = 0;
    this._loadSuccesses = 0;
    this._loadFailures  = 0;
    this._loadLatency   = makeStats();
    this._loadBudget    = makeStats();
    this._loadTruncations = 0;
    this._tokensSaved     = 0;
    this._tierTokenSums   = zeroTierMap();
    this._pendingLoads.clear();

    this._recordStarts    = 0;
    this._recordSuccesses = 0;
    this._recordFailures  = 0;
    this._recordLatency   = makeStats();
    this._writeConflicts  = 0;
    this._tierDegradations = 0;
    this._pendingRecords.clear();

    this._factsDecayed = 0;

    this._forgetCount       = 0;
    this._tiersClearedTotal = 0;
  }

  /**
   * Unsubscribes all listeners from the EventBus.
   * Call when the collector is no longer needed to prevent memory leaks.
   */
  detach(eventBus: EventBus): void {
    for (const { type, fn } of this._listeners) {
      eventBus.off(type, fn);
    }
  }
}
