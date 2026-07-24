/**
 * M23 — Reflection Metrics.
 *
 * This module defines the metrics interfaces and implementation for the
 * Reflection Layer. Metrics are counters/averages only and are explicitly
 * forbidden from making decisions or reading stores.
 */

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export interface ReflectionMetricsSnapshot {
  /** Total number of reflection calls made. */
  reflection_calls: number;
  /** Number of reflections successfully analyzed. */
  reflections_analyzed: number;
  /** Number of reflections that failed internally or were skipped. */
  reflections_failed: number;
  /** Average quality score of successful reflections (e.g., 0-1 for good/poor/neutral mapping). */
  average_quality_score: number;
  /** Average confidence alignment score of successful reflections (e.g., -1 to 1). */
  average_confidence_alignment: number;
}

// ---------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------

export interface ReflectionMetricsRecorder {
  record(input: {
    analyzed: boolean;
    quality?: number; // Map 'good': 1, 'neutral': 0, 'poor': -1
    confidenceAlignment?: number; // Map 'high': 1, 'neutral': 0, 'low': -1
  }): void;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class ReflectionMetrics implements ReflectionMetricsRecorder {
  private _reflectionCalls: number = 0;
  private _reflectionsAnalyzed: number = 0;
  private _reflectionsFailed: number = 0;
  private _totalQualityScore: number = 0;
  private _totalConfidenceAlignment: number = 0;

  record(input: {
    analyzed: boolean;
    quality?: number;
    confidenceAlignment?: number;
  }): void {
    this._reflectionCalls++;
    if (input.analyzed) {
      this._reflectionsAnalyzed++;
      this._totalQualityScore += input.quality ?? 0;
      this._totalConfidenceAlignment += input.confidenceAlignment ?? 0;
    } else {
      this._reflectionsFailed++;
    }
  }

  snapshot(): ReflectionMetricsSnapshot {
    const reflectionsAnalyzed = this._reflectionsAnalyzed;
    return {
      reflection_calls: this._reflectionCalls,
      reflections_analyzed: reflectionsAnalyzed,
      reflections_failed: this._reflectionsFailed,
      average_quality_score: reflectionsAnalyzed > 0 ? this._totalQualityScore / reflectionsAnalyzed : 0,
      average_confidence_alignment: reflectionsAnalyzed > 0 ? this._totalConfidenceAlignment / reflectionsAnalyzed : 0,
    };
  }

  reset(): void {
    this._reflectionCalls = 0;
    this._reflectionsAnalyzed = 0;
    this._reflectionsFailed = 0;
    this._totalQualityScore = 0;
    this._totalConfidenceAlignment = 0;
  }
}

// ---------------------------------------------------------------------------
// Production singleton
// ---------------------------------------------------------------------------

export const reflectionMetrics = new ReflectionMetrics();
