import { randomUUID } from "node:crypto";
import { analyzeExecution } from "./reflection-rules.js";
import { failedReflectionResult, makeReflectionResult, successReflectionResult } from "./reflection-result.js";
import { reflectionMetrics, type ReflectionMetricsRecorder } from "./reflection-metrics.js";
import type { ExecutionReflectionInput, ReflectionResult } from "./reflection-types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ReflectionLayerConfig {
  /**
   * Injectable metrics recorder — defaults to the module singleton.
   * Counters only. No decision logic permitted here.
   */
  readonly metrics?: ReflectionMetricsRecorder;
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface ReflectionLayer {
  /**
   * Analyze one completed tool execution outcome and produce structured insights.
   *
   * CALL-SITE RULES:
   *   1. Call ONLY after execution has been observed.
   *   2. Always call as `void reflectionLayer.reflect(...)` — never await.
   *   3. Never use the return value to gate execution or modify the response.
   *
   * This method NEVER throws. All internal failures are caught, logged, and
   * reflected as `{ analyzed: false }` in the returned ReflectionResult.
   */
  reflect(input: Omit<ExecutionReflectionInput, "reflectionId" | "executionId">): Promise<ReflectionResult>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createReflectionLayer(config: ReflectionLayerConfig): ReflectionLayer {
  const metrics = config.metrics ?? reflectionMetrics;

  return {
    async reflect(input: Omit<ExecutionReflectionInput, "reflectionId" | "executionId">): Promise<ReflectionResult> {
      const reflectedAt = Date.now();
      const reflectionId = randomUUID();
      const executionId = randomUUID(); // Placeholder for now, will be passed from observer later

      // ------------------------------------------------------------------
      // ISOLATION: the entire reflect() body is wrapped in a try/catch.
      // Nothing inside this function may propagate an error to the caller.
      // ------------------------------------------------------------------
      try {
        // ---- 1. Build full input for analysis ---------------------------
        const fullInput: ExecutionReflectionInput = {
          reflectionId,
          executionId,
          ...input,
        };

        // ---- 2. Analyze execution ---------------------------------------
        const analysis = analyzeExecution(fullInput);

        // ---- 3. Record metrics (counters only — no decisions) -----------
        const qualityScore = analysis.quality === "good" ? 1 : (analysis.quality === "poor" ? -1 : 0);
        const confidenceAlignmentScore = analysis.confidenceAlignment === "high" ? 1 : (analysis.confidenceAlignment === "low" ? -1 : 0);

        metrics.record({
          analyzed: true,
          quality: qualityScore,
          confidenceAlignment: confidenceAlignmentScore,
        });

        // ---- 4. Build and return result ---------------------------------
        const result = successReflectionResult({
          reflectionId,
          executionId,
          quality: analysis.quality,
          confidenceAlignment: analysis.confidenceAlignment,
          latency: analysis.latency,
          recommendation: analysis.recommendation,
          issues: analysis.issues,
        }, reflectedAt);
        return result;

      } catch (err: unknown) {
        // ------------------------------------------------------------------
        // ISOLATION CONTRACT:
        //   Catch everything. Log without re-throwing. Return failed result.
        //   The user response is never affected by what happens here.
        // ------------------------------------------------------------------
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[ReflectionLayer] Reflection failed (non-fatal): ${message}`);

        const result = failedReflectionResult({ reflectionId, executionId }, reflectedAt);
        metrics.record({ analyzed: false });
        return result;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Production singleton
// ---------------------------------------------------------------------------

export const reflectionLayer = createReflectionLayer({
  metrics: reflectionMetrics,
});
