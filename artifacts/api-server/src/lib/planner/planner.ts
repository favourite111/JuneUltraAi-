import { makePlanningResult } from "./planning-result.js";
import { planRules } from "./planning-rules.js";
import { plannerMetrics } from "./planner-metrics.js";
import type { PlanningInput, PlanningResult } from "./planner-types.js";

export function createAgentPlanner(metrics = plannerMetrics) {
  return {
    plan(input: PlanningInput): PlanningResult {
      const result = makePlanningResult(planRules(input));
      metrics.record(result);
      return result;
    },
  };
}

export const agentPlanner = createAgentPlanner();