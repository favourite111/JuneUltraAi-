/**
 * M20 — Tool Intelligence Layer metrics.
 *
 * Pattern mirrors OrchestratorMetrics from M19 for consistency.
 * Exposed as a singleton (`toolIntelligenceMetrics`) and added to /api/stats.
 */

// ---------------------------------------------------------------------------
// Snapshot & recorder contracts
// ---------------------------------------------------------------------------

export interface ToolIntelligenceMetricsSnapshot {
  readonly evaluations:        number;
  readonly conflicts_detected: number;
  readonly fallbacks_used:     number;
  readonly average_confidence: number;
  readonly average_candidates: number;
}

export interface ToolIntelligenceMetricsRecorder {
  record(result: {
    confidence:     number;
    candidateCount: number;
    conflictCount:  number;
    fallbacksUsed:  boolean;
  }): void;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class ToolIntelligenceMetrics implements ToolIntelligenceMetricsRecorder {
  private evaluations       = 0;
  private conflictsDetected = 0;
  private fallbacksUsed     = 0;
  private totalConfidence   = 0;
  private totalCandidates   = 0;

  record(result: {
    confidence:     number;
    candidateCount: number;
    conflictCount:  number;
    fallbacksUsed:  boolean;
  }): void {
    this.evaluations       += 1;
    this.totalConfidence   += result.confidence;
    this.totalCandidates   += result.candidateCount;
    this.conflictsDetected += result.conflictCount;
    if (result.fallbacksUsed) this.fallbacksUsed += 1;
  }

  snapshot(): ToolIntelligenceMetricsSnapshot {
    const n = this.evaluations;
    return Object.freeze({
      evaluations:        n,
      conflicts_detected: this.conflictsDetected,
      fallbacks_used:     this.fallbacksUsed,
      average_confidence: n === 0 ? 0 : this.totalConfidence   / n,
      average_candidates: n === 0 ? 0 : this.totalCandidates   / n,
    });
  }

  reset(): void {
    this.evaluations       = 0;
    this.conflictsDetected = 0;
    this.fallbacksUsed     = 0;
    this.totalConfidence   = 0;
    this.totalCandidates   = 0;
  }
}

// ---------------------------------------------------------------------------
// Singleton — injected into /api/stats
// ---------------------------------------------------------------------------

export const toolIntelligenceMetrics = new ToolIntelligenceMetrics();
