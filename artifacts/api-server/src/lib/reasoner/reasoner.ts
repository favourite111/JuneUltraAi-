import { makeReasoningResult } from "./reasoning-result.js";
import { reasoningRules } from "./reasoning-rules.js";
import { reasonerMetrics, type ReasonerMetricsRecorder } from "./reasoner-metrics.js";
import type { ReasoningInput, ReasoningResult } from "./reasoner-types.js";

// ---------------------------------------------------------------------------
// M18 — Reasoning Engine
//
// Sits between the Planner (M17) and the Runtime in the agent pipeline:
//
//   Planner → Reasoning Engine → Runtime → Memory + Tools → Prompt → LLM
//
// Contract:
//   ✗ Never writes memory
//   ✗ Never executes tools
//   ✗ Never modifies the planner result or session
//   ✓ Reads, infers, summarises, prioritises
// ---------------------------------------------------------------------------

export function createAgentReasoner(metrics: ReasonerMetricsRecorder = reasonerMetrics) {
  return {
    reason(input: ReasoningInput): ReasoningResult {
      const result = makeReasoningResult(reasoningRules(input));
      metrics.record(result);
      return result;
    },
  };
}

/** Default singleton — shared across requests (stateless, thread-safe). */
export const agentReasoner = createAgentReasoner();
