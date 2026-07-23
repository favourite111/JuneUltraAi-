// ---------------------------------------------------------------------------
// M19 — Execution Orchestrator metrics
// ---------------------------------------------------------------------------

export interface OrchestratorMetricsSnapshot {
  readonly execution_runs: number;
  readonly successful_runs: number;
  readonly failed_runs: number;
  readonly average_execution_steps: number;
  readonly average_execution_time_ms: number;
}

export interface OrchestratorMetricsRecorder {
  record(result: { success: boolean; stepsCount: number; executionTimeMs: number }): void;
}

export class OrchestratorMetrics implements OrchestratorMetricsRecorder {
  private runs = 0;
  private successfulRuns = 0;
  private failedRuns = 0;
  private totalSteps = 0;
  private totalTimeMs = 0;

  record(result: { success: boolean; stepsCount: number; executionTimeMs: number }): void {
    this.runs += 1;
    this.totalSteps += result.stepsCount;
    this.totalTimeMs += result.executionTimeMs;
    if (result.success) this.successfulRuns += 1;
    else this.failedRuns += 1;
  }

  snapshot(): OrchestratorMetricsSnapshot {
    return Object.freeze({
      execution_runs:           this.runs,
      successful_runs:          this.successfulRuns,
      failed_runs:              this.failedRuns,
      average_execution_steps:  this.runs === 0 ? 0 : this.totalSteps / this.runs,
      average_execution_time_ms: this.runs === 0 ? 0 : this.totalTimeMs / this.runs,
    });
  }

  reset(): void {
    this.runs = 0;
    this.successfulRuns = 0;
    this.failedRuns = 0;
    this.totalSteps = 0;
    this.totalTimeMs = 0;
  }
}

export const orchestratorMetrics = new OrchestratorMetrics();
