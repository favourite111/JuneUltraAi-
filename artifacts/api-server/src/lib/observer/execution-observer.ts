/**
 * M22 — ExecutionObserver.
 *
 * Pipeline position (post-execution only):
 *   M19 Orchestrator → Executors → Response
 *                                      ↓  (non-blocking, fire-and-forget)
 *                               ExecutionObserver → M21 ToolLearningStore
 *
 * Single responsibility: receive a completed execution outcome, forward it
 * to M21 ToolLearningStore with real durationMs and confidenceAtSelection,
 * and emit metrics. Never influence execution. Never block the response.
 *
 * ISOLATION CONTRACT (enforced here):
 *   observe() NEVER throws. Every error is caught, logged, and swallowed.
 *   Callers invoke it as `void executionObserver.observe(...)` — non-blocking.
 *   A crashed observe() call must leave the user response completely unaffected.
 *
 *   Execution succeeds
 *         ↓
 *   Observer crashes internally
 *         ↓
 *   User still gets response   ← always happens
 */

import { makeObservationResult, failedObservationResult, successObservationResult } from "./observation-result.js";
import { observerMetrics, type ObserverMetricsRecorder } from "./observer-metrics.js";
import type { ObservationInput, ObservationResult, ObservationStore } from "./observer-types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ExecutionObserverConfig {
  /**
   * The M21 ToolLearningStore (structural type — accepts any object with
   * a record() method matching ObservationStore). Injected for testability.
   */
  readonly store: ObservationStore;
  /**
   * Injectable metrics recorder — defaults to the module singleton.
   * Counters only. No decision logic permitted here.
   */
  readonly metrics?: ObserverMetricsRecorder;
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface ExecutionObserver {
  /**
   * Record one completed tool execution outcome.
   *
   * CALL-SITE RULES:
   *   1. Call ONLY after execution has fully completed.
   *   2. Always call as `void executionObserver.observe(...)` — never await.
   *   3. Never use the return value to gate execution or modify the response.
   *
   * This method NEVER throws. All internal failures are caught, logged, and
   * reflected as `{ recorded: false }` in the returned ObservationResult.
   */
  observe(input: ObservationInput): Promise<ObservationResult>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createExecutionObserver(config: ExecutionObserverConfig): ExecutionObserver {
  const { store } = config;
  const metrics   = config.metrics ?? observerMetrics;

  return {
    async observe(input: ObservationInput): Promise<ObservationResult> {
      const storedAt = Date.now();

      // ------------------------------------------------------------------
      // ISOLATION: the entire observe() body is wrapped in a try/catch.
      // Nothing inside this function may propagate an error to the caller.
      // ------------------------------------------------------------------
      try {
        // ---- 1. Input validation ----------------------------------------
        if (!input.toolName || input.toolName.trim() === "") {
          console.warn("[Observer] Skipping observation: toolName is empty.");
          const result = failedObservationResult(input, storedAt);
          metrics.record({ recorded: false, durationMs: result.durationMs });
          return result;
        }

        // ---- 2. Clamp numeric fields ------------------------------------
        const durationMs            = Math.max(0, input.durationMs);
        const confidenceAtSelection = Math.min(1, Math.max(0, input.confidenceAtSelection));

        // ---- 3. Build CompletedToolExecution (M21 contract type) --------
        const execution = {
          toolName:             input.toolName,
          success:              input.success,
          durationMs,
          confidenceAtSelection,
          executedAt:           input.executedAt,
        };

        // ---- 4. Forward to M21 ToolLearningStore (write-only) ----------
        await store.record(input.scope, execution);

        // ---- 5. Record metrics (counters only — no decisions) ----------
        const result = successObservationResult({ durationMs, confidenceAtSelection }, storedAt);
        metrics.record({ recorded: true, durationMs });
        return result;

      } catch (err: unknown) {
        // ------------------------------------------------------------------
        // ISOLATION CONTRACT:
        //   Catch everything. Log without re-throwing. Return failed result.
        //   The user response is never affected by what happens here.
        // ------------------------------------------------------------------
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[Observer] Observation failed (non-fatal): ${message}`);

        const result = failedObservationResult(input, storedAt);
        metrics.record({ recorded: false, durationMs: result.durationMs });
        return result;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Production singleton
// ---------------------------------------------------------------------------

// Lazy import to avoid circular dependency at module evaluation time.
// The singleton is only used in production (chat.ts); tests inject their own.
import { toolLearningStore } from "../memory-singletons.js";

export const executionObserver = createExecutionObserver({
  store:   toolLearningStore,
  metrics: observerMetrics,
});
