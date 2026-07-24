/**
 * M24 — MemoryEvolution metrics.
 *
 * Counters-only — no decision logic. Follows the same pattern as
 * ReflectionMetrics (M23) and ObserverMetrics (M22).
 */

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export interface MemoryEvolutionMetricsSnapshot {
  /** Total calls to evolve(), including filtered-out and failed ones. */
  readonly evolution_calls: number;
  /** Calls that completed the full pipeline (even if 0 records were written). */
  readonly evolutions_succeeded: number;
  /** Calls discarded by the ConfidenceFilter before candidate extraction. */
  readonly evolutions_filtered: number;
  /** Calls that failed internally (error caught, non-fatal). */
  readonly evolutions_failed: number;
  /** Total MemoryCandidates extracted across all successful runs. */
  readonly total_candidates_extracted: number;
  /** Total KnowledgeRecords written (promoted, updated, replaced, decayed). */
  readonly total_records_written: number;
  /** Total candidates skipped (ignored by policy or blocked by version guard). */
  readonly total_records_skipped: number;
}

// ---------------------------------------------------------------------------
// Recorder interface
// ---------------------------------------------------------------------------

export interface MemoryEvolutionMetricsRecorder {
  record(event: {
    succeeded?: boolean;
    filtered?: boolean;
    failed?: boolean;
    candidatesExtracted?: number;
    written?: number;
    skipped?: number;
  }): void;
  snapshot(): MemoryEvolutionMetricsSnapshot;
  reset(): void;
}

// ---------------------------------------------------------------------------
// Concrete class
// ---------------------------------------------------------------------------

export class MemoryEvolutionMetrics implements MemoryEvolutionMetricsRecorder {
  private calls = 0;
  private succeeded = 0;
  private filtered = 0;
  private failed = 0;
  private candidatesExtracted = 0;
  private written = 0;
  private skipped = 0;

  record(event: {
    succeeded?: boolean;
    filtered?: boolean;
    failed?: boolean;
    candidatesExtracted?: number;
    written?: number;
    skipped?: number;
  }): void {
    this.calls += 1;
    if (event.succeeded) this.succeeded += 1;
    if (event.filtered) this.filtered += 1;
    if (event.failed) this.failed += 1;
    if (event.candidatesExtracted !== undefined) this.candidatesExtracted += event.candidatesExtracted;
    if (event.written !== undefined) this.written += event.written;
    if (event.skipped !== undefined) this.skipped += event.skipped;
  }

  snapshot(): MemoryEvolutionMetricsSnapshot {
    return Object.freeze({
      evolution_calls: this.calls,
      evolutions_succeeded: this.succeeded,
      evolutions_filtered: this.filtered,
      evolutions_failed: this.failed,
      total_candidates_extracted: this.candidatesExtracted,
      total_records_written: this.written,
      total_records_skipped: this.skipped,
    });
  }

  reset(): void {
    this.calls = 0;
    this.succeeded = 0;
    this.filtered = 0;
    this.failed = 0;
    this.candidatesExtracted = 0;
    this.written = 0;
    this.skipped = 0;
  }
}

/** Module-level singleton — used by the production MemoryEvolutionEngine. */
export const memoryEvolutionMetrics = new MemoryEvolutionMetrics();
