import type { ReasoningResult } from "./reasoner-types.js";

// ---------------------------------------------------------------------------
// M18 — Reasoning Engine metrics
// ---------------------------------------------------------------------------

export interface ReasonerMetricsSnapshot {
  readonly reasoning_runs: number;
  readonly inferences: number;
  readonly contradictions_detected: number;
  readonly context_optimizations: number;
}

export interface ReasonerMetricsRecorder {
  record(result: Pick<ReasoningResult, "inferences" | "contradictions" | "optimizations">): void;
}

export class ReasonerMetrics implements ReasonerMetricsRecorder {
  private runs = 0;
  private totalInferences = 0;
  private totalContradictions = 0;
  private totalOptimizations = 0;

  record(result: Pick<ReasoningResult, "inferences" | "contradictions" | "optimizations">): void {
    this.runs += 1;
    this.totalInferences += result.inferences.length;
    this.totalContradictions += result.contradictions.length;
    this.totalOptimizations += result.optimizations.length;
  }

  snapshot(): ReasonerMetricsSnapshot {
    return Object.freeze({
      reasoning_runs:          this.runs,
      inferences:              this.totalInferences,
      contradictions_detected: this.totalContradictions,
      context_optimizations:   this.totalOptimizations,
    });
  }

  reset(): void {
    this.runs = 0;
    this.totalInferences = 0;
    this.totalContradictions = 0;
    this.totalOptimizations = 0;
  }
}

export const reasonerMetrics = new ReasonerMetrics();
