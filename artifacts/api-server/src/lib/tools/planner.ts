import { ExecutionContext, AgentPlan, AgentPlanStep } from "./types.js";
import { routeTool } from "./registry.js";

export function createPlanner(ctx: ExecutionContext) {
  return {
    plan: (goal: string): AgentPlan | null => {
      const planId = ctx.idGenerator.next();
      const steps: AgentPlanStep[] = [];

      // Prioritize multi-step planning for specific complex goals
      if (goal.includes("Shorten") && goal.includes("QR code")) {
        const urlMatch = goal.match(/https?:\/\/[^\s]+/);
        const url = urlMatch ? urlMatch[0] : "";

        if (url) {
          const shortenStepId = ctx.idGenerator.next();
          steps.push({
            stepId: shortenStepId,
            capabilityId: "url_shortener",
            inputs: { url },
            expectedOutputs: { shortUrl: "" }, // Placeholder
          });

          const qrcodeStepId = ctx.idGenerator.next();
          steps.push({
            stepId: qrcodeStepId,
            capabilityId: "qrcode",
            inputs: { url: `{${shortenStepId}.shortUrl}` }, // Reference previous step's output
            expectedOutputs: { imageUrl: "" }, // Placeholder
          });
        }
      } else if (goal.includes("QR code") && goal.includes("shorten")) {
        const urlMatch = goal.match(/https?:\/\/[^\s]+/);
        const url = urlMatch ? urlMatch[0] : "";

        if (url) {
          const qrcodeStepId = ctx.idGenerator.next();
          steps.push({
            stepId: qrcodeStepId,
            capabilityId: "qrcode",
            inputs: { url },
            expectedOutputs: { imageUrl: "" }, // Placeholder
          });

          const shortenStepId = ctx.idGenerator.next();
          steps.push({
            stepId: shortenStepId,
            capabilityId: "url_shortener",
            inputs: { url: `{${qrcodeStepId}.imageUrl}` }, // Reference previous step's output
            expectedOutputs: { shortUrl: "" }, // Placeholder
          });
        }
      } else {
        // Fallback to single-step planning if no complex plan is found
        const routed = routeTool(goal);
        if (routed) {
          const stepId = ctx.idGenerator.next();
          steps.push({
            stepId,
            capabilityId: routed.tool.name,
            inputs: routed.args as Record<string, unknown>,
            expectedOutputs: {},
          });
        }
      }

      return {
        planId,
        goal,
        steps,
      };
    },
  };
}
