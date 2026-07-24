/**
 * M21 — Tool Learning Metrics.
 *
 * Tracks in-process counters for the Tool Learning Layer.
 * Follows the same pattern as ToolIntelligenceMetrics (M20) and
 * OrchestratorMetrics (M19): singleton + injectable recorder interface.
 *
 * Exposed via GET /api/stats as the "tool_learning" key.
 */

// ---------------------------------------------------------------------------
// Recorder interface (injected into ToolLearningStore)
// ---------------------------------------------------------------------------

export interface ToolLearningMetricsRecorder {
  /** Called after a stats record is successfully written to StorageProvider. */
  recordStored(): void;
  /** Called when the StorageProvider write fails (best-effort). */
  storageFailed(): void;
  /** Called when getStats() finds an entry in the in-memory cache. */
  cacheHit(): void;
  /** Called when getStats() finds no entry in the in-memory cache. */
  cacheMiss(): void;
}

// ---------------------------------------------------------------------------
// Snapshot (immutable point-in-time view)
// ---------------------------------------------------------------------------

export interface ToolLearningMetricsSnapshot {
  readonly records_stored: number;
  readonly storage_failures: number;
  readonly cache_hits: number;
  readonly cache_misses: number;
  /**
   * Derived: cache_hits / (cache_hits + cache_misses).
   * 0 when no getStats() calls have been made yet.
   */
  readonly cache_hit_rate: number;
}

// ---------------------------------------------------------------------------
// ToolLearningMetrics class
// ---------------------------------------------------------------------------

export class ToolLearningMetrics implements ToolLearningMetricsRecorder {
  private _recordsStored  = 0;
  private _storageFailures = 0;
  private _cacheHits      = 0;
  private _cacheMisses    = 0;

  recordStored(): void  { this._recordsStored++;   }
  storageFailed(): void { this._storageFailures++; }
  cacheHit(): void      { this._cacheHits++;        }
  cacheMiss(): void     { this._cacheMisses++;      }

  snapshot(): Readonly<ToolLearningMetricsSnapshot> {
    const total = this._cacheHits + this._cacheMisses;
    return Object.freeze({
      records_stored:   this._recordsStored,
      storage_failures: this._storageFailures,
      cache_hits:       this._cacheHits,
      cache_misses:     this._cacheMisses,
      cache_hit_rate:   total > 0 ? this._cacheHits / total : 0,
    });
  }

  /** Reset all counters to zero. Used between test runs. */
  reset(): void {
    this._recordsStored   = 0;
    this._storageFailures = 0;
    this._cacheHits       = 0;
    this._cacheMisses     = 0;
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

/** Process-wide Tool Learning metrics singleton. Imported by stats.ts. */
export const toolLearningMetrics = new ToolLearningMetrics();
