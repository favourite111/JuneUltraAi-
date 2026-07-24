/**
 * M22 — Execution Observer metrics.
 *
 * Pure telemetry accumulator — counters and timing averages only.
 *
 * STRICTLY PROHIBITED in this class:
 *   ✗ Tool ranking or scoring
 *   ✗ Confidence adjustment or decision thresholds
 *   ✗ Any read from ToolLearningStore or ToolLearningReader
 *   ✗ Memory reads or writes
 *   ✗ StorageProvider calls
 *   ✗ Any logic that influences execution path or tool selection
 *
 * Flow:
 *   Observer → ObserverMetrics (counts only)
 *            → ToolLearningStore (persists — M21's responsibility)
 *
 * ObserverMetrics is NOT a decision engine.
 */

// ---------------------------------------------------------------------------
// Snapshot (immutable point-in-time view)
// ---------------------------------------------------------------------------

export interface ObserverMetricsSnapshot {
  /** Total number of observe() invocations (recorded + failed). */
  readonly observation_calls: number;
  /** Calls where ToolLearningStore.record() completed without error. */
  readonly observations_recorded: number;
  /** Calls where recorded=false for any reason (invalid input, storage error, etc.). */
  readonly observations_failed: number;
  /**
   * Rolling average of durationMs values received via ObservationInput.
   * Reflects only observations that were successfully recorded.
   * 0 when observations_recorded === 0.
   */
  readonly average_duration_ms: number;
}

// ---------------------------------------------------------------------------
// Recorder interface (injectable in tests)
// ---------------------------------------------------------------------------

export interface ObserverMetricsRecorder {
  record(result: { recorded: boolean; durationMs: number }): void;
}

// ---------------------------------------------------------------------------
// ObserverMetrics
// ---------------------------------------------------------------------------

export class ObserverMetrics implements ObserverMetricsRecorder {
  private calls        = 0;
  private recorded     = 0;
  private failed       = 0;
  private totalDurMs   = 0;

  /**
   * Record the outcome of one observe() call.
   * Called exactly once per observe() invocation, from inside ExecutionObserver.
   *
   * @param result.recorded   - Whether ToolLearningStore.record() succeeded.
   * @param result.durationMs - The durationMs from ObservationInput (clamped value).
   */
  record(result: { recorded: boolean; durationMs: number }): void {
    this.calls += 1;
    if (result.recorded) {
      this.recorded  += 1;
      this.totalDurMs += result.durationMs;
    } else {
      this.failed += 1;
    }
  }

  /** Returns an immutable point-in-time snapshot. */
  snapshot(): ObserverMetricsSnapshot {
    return Object.freeze<ObserverMetricsSnapshot>({
      observation_calls:      this.calls,
      observations_recorded:  this.recorded,
      observations_failed:    this.failed,
      average_duration_ms:
        this.recorded === 0 ? 0 : this.totalDurMs / this.recorded,
    });
  }

  /** Resets all counters to zero. Useful between test runs. */
  reset(): void {
    this.calls      = 0;
    this.recorded   = 0;
    this.failed     = 0;
    this.totalDurMs = 0;
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

export const observerMetrics = new ObserverMetrics();
