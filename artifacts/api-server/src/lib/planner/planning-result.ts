import type { PlanningResult } from "./planner-types.js";

export function makePlanningResult(
  result: Omit<PlanningResult, "plan"> & { plan?: readonly PlanningResult["plan"][number][] },
): PlanningResult {
  return Object.freeze({
    ...result,
    plan: Object.freeze([...(result.plan ?? [])]),
  });
}