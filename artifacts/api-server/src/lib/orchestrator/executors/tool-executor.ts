import { createToolExecutor as createLowLevelExecutor } from "../../tools/executor.js";
import { createPlanner } from "../../tools/planner.js";
import { createReflectionEngine } from "../../tools/reflection.js";
import type {
  ExecutionContext,
  EventBus,
  Tool,
  ToolError,
  ReflectionDecision,
} from "../../tools/types.js";
import type { ToolExecutionOutput } from "../orchestrator-types.js";

// ---------------------------------------------------------------------------
// M19 — ToolExecutor
//
// Single responsibility: resolve tool → plan step → execute → reflect → output.
// Wraps the existing deterministic executor.ts + reflection.ts + planner.ts
// chain without modifying any of those frozen M14-M18 components.
//
// Contract:
//   ✗ Never writes memory
//   ✗ Never performs planning (uses createPlanner only to build a typed step)
//   ✗ Never selects tools independently (tool is supplied by caller)
//   ✓ Execute the supplied tool, apply reflection, report outcome
// ---------------------------------------------------------------------------

export interface ToolExecutorInput {
  readonly step: number;
  readonly prompt: string;
  readonly tool: Tool;
  readonly args: unknown;
  readonly context: ExecutionContext;
  readonly eventBus: EventBus;
}

export interface OrchestratorToolExecutor {
  execute(input: ToolExecutorInput): Promise<ToolExecutionOutput>;
}

function reflectionError(decision: ReflectionDecision): ToolError {
  return {
    code:        "REFLECTION_FAILED",
    message:     "The reflection policy rejected the tool result.",
    details:     { reasoning: decision.reasoning },
    isRetryable: false,
  };
}

export function createOrchestratorToolExecutor(): OrchestratorToolExecutor {
  return {
    async execute(input: ToolExecutorInput): Promise<ToolExecutionOutput> {
      const { step, prompt, tool, args, context, eventBus } = input;
      const start = context.clock.now();

      eventBus.emit({
        type:    "tool.selected",
        context,
        payload: { toolId: tool.name, args, timestamp: start },
      });

      // Use the existing deterministic planner to create a properly-typed AgentPlanStep.
      // This is the same call the runtime made — it constrains planning to the one selected tool.
      const planner = createPlanner(context, {
        selectedTool: {
          tool,
          args: args as Record<string, unknown>,
          confidence: { score: 1, reasoning: ["M19 orchestrator-selected tool"] },
        },
      });
      const plan       = planner.plan(prompt);
      const planStep   = plan.steps[0];

      if (!planStep) {
        return {
          step,
          executor:  "tool",
          success:   false,
          durationMs: 0,
          toolName:  tool.name,
          error: {
            code:        "PLAN_EMPTY",
            message:     "The internal planner produced no steps for the selected tool.",
            isRetryable: false,
          },
        };
      }

      const lowLevelExecutor = createLowLevelExecutor(context);
      const reflection       = createReflectionEngine(context);
      const reflectionHistory: { decision: ReflectionDecision }[] = [];

      // Bounded reflection-authorized retry (existing behaviour — not a new retry engine).
      for (;;) {
        const execution  = await lowLevelExecutor.execute(tool, planStep.inputs);
        const observation = execution.status === "completed" ? execution.result : execution.error;
        const decision   = reflection.reflect(observation, planStep, 0, plan.steps.length, reflectionHistory);
        reflectionHistory.push({ decision });

        if (decision.type === "retry") continue;

        const durationMs = context.clock.now() - start;

        if (execution.status === "completed" && decision.type === "complete") {
          return { step, executor: "tool", success: true, durationMs, toolName: tool.name, result: execution.result };
        }

        return {
          step,
          executor:  "tool",
          success:   false,
          durationMs,
          toolName:  tool.name,
          error:     execution.status === "failed" ? execution.error : reflectionError(decision),
        };
      }
    },
  };
}
