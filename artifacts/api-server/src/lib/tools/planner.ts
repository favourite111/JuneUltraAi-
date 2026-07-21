import type { AgentPlan, AgentPlanStep, ExecutionContext } from "./types.js";
import { routeTool, type RoutedTool } from "./registry.js";

/**
 * A supplied route is authoritative for the runtime pipeline. Omitting it
 * preserves the standalone planner's existing deterministic routing behavior.
 */
export interface PlannerOptions {
  readonly selectedTool?: RoutedTool | null;
}

function emitPlannerStarted(ctx: ExecutionContext, goal: string): void {
  ctx.eventBus?.emit({
    type: "planner.started",
    context: ctx,
    payload: { goal, timestamp: ctx.clock.now() },
  });
}

function emitPlannerCompleted(ctx: ExecutionContext, plan: AgentPlan): void {
  ctx.eventBus?.emit({
    type: "planner.completed",
    context: ctx,
    payload: { plan, timestamp: ctx.clock.now() },
  });
}

function createStep(ctx: ExecutionContext, routed: RoutedTool): AgentPlanStep {
  return {
    stepId: ctx.idGenerator.next(),
    capabilityId: routed.tool.name,
    inputs: routed.args as Record<string, unknown>,
    expectedOutputs: {},
  };
}

/**
 * Creates the deterministic Phase 3A task planner.
 *
 * When the pipeline supplies `selectedTool`, planning is deliberately limited
 * to the selected capability. This prevents autonomous or re-planning behavior
 * while preserving the prior standalone deterministic planner for legacy code.
 */
export function createPlanner(ctx: ExecutionContext, options: PlannerOptions = {}) {
  return {
    plan: (goal: string): AgentPlan => {
      emitPlannerStarted(ctx, goal);

      const planId = ctx.idGenerator.next();
      const steps: AgentPlanStep[] = [];

      if (options.selectedTool !== undefined) {
        if (options.selectedTool) {
          steps.push(createStep(ctx, options.selectedTool));
        }
      } else if (goal.includes("Shorten") && goal.includes("QR code")) {
        // Retained legacy deterministic planning behavior for callers that use
        // the planner directly rather than the Phase 3A runtime pipeline.
        const urlMatch = goal.match(/https?:\/\/[^\s]+/);
        const url = urlMatch ? urlMatch[0] : "";

        if (url) {
          const shortenStepId = ctx.idGenerator.next();
          steps.push({
            stepId: shortenStepId,
            capabilityId: "url_shortener",
            inputs: { url },
            expectedOutputs: { shortUrl: "" },
          });

          const qrcodeStepId = ctx.idGenerator.next();
          steps.push({
            stepId: qrcodeStepId,
            capabilityId: "qrcode",
            inputs: { url: `{${shortenStepId}.shortUrl}` },
            expectedOutputs: { imageUrl: "" },
          });
        }
      } else if (goal.includes("QR code") && goal.includes("shorten")) {
        // Retained legacy deterministic planning behavior for callers that use
        // the planner directly rather than the Phase 3A runtime pipeline.
        const urlMatch = goal.match(/https?:\/\/[^\s]+/);
        const url = urlMatch ? urlMatch[0] : "";

        if (url) {
          const qrcodeStepId = ctx.idGenerator.next();
          steps.push({
            stepId: qrcodeStepId,
            capabilityId: "qrcode",
            inputs: { url },
            expectedOutputs: { imageUrl: "" },
          });

          const shortenStepId = ctx.idGenerator.next();
          steps.push({
            stepId: shortenStepId,
            capabilityId: "url_shortener",
            inputs: { url: `{${qrcodeStepId}.imageUrl}` },
            expectedOutputs: { shortUrl: "" },
          });
        }
      } else {
        const routed = routeTool(goal);
        if (routed) {
          steps.push(createStep(ctx, routed));
        }
      }

      const plan: AgentPlan = { planId, goal, steps };
      emitPlannerCompleted(ctx, plan);
      return plan;
    },
  };
}
