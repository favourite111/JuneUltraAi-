import { createExecutionContext } from "./context.js";
import { AgentEventBus } from "./event-bus.js";
import { createToolExecutor } from "./executor.js";
import { createPlanner } from "./planner.js";
import { createReflectionEngine } from "./reflection.js";
import { routeTool, type RoutedTool } from "./registry.js";
import type {
  AgentPlan,
  EventBus,
  ExecutionContext,
  ExecutionContextDependencies,
  ExecutionContextInput,
  ReflectionDecision,
  ReflectionDecisionType,
  Tool,
  ToolError,
  ToolResult,
} from "./types.js";

export type CapabilityRouter = (prompt: string) => RoutedTool | null;

export interface AgentRuntimeDependencies extends ExecutionContextDependencies {
  /** A request-isolated or explicitly shared lifecycle bus. */
  readonly eventBus?: EventBus;
  /** Injectable deterministic router used by tests and alternative composition roots. */
  readonly router?: CapabilityRouter;
}

export interface AgentRuntimeRequest extends ExecutionContextInput {
  readonly prompt: string;
}

export interface CompletedRuntimeResponse {
  readonly status: "completed";
  readonly context: ExecutionContext;
  readonly plan: AgentPlan;
  readonly tool: Tool;
  readonly result: ToolResult;
}

export interface FailedRuntimeResponse {
  readonly status: "failed";
  readonly context: ExecutionContext;
  readonly plan: AgentPlan;
  readonly tool: Tool;
  readonly error: ToolError;
}

export interface NoCapabilityRuntimeResponse {
  readonly status: "no_capability";
  readonly context: ExecutionContext;
  readonly plan: AgentPlan;
}

export type AgentRuntimeResponse =
  | CompletedRuntimeResponse
  | FailedRuntimeResponse
  | NoCapabilityRuntimeResponse;

function reflectionFailure(decision: ReflectionDecision): ToolError {
  return {
    code: "REFLECTION_FAILED",
    message: "The deterministic reflection policy rejected the tool result.",
    details: { reasoning: decision.reasoning },
    isRetryable: false,
  };
}

/**
 * Composes the Phase 3A deterministic runtime:
 *
 * User Request → ExecutionContext → Capability Router → Task Planner → Tool
 * Executor → Reflection Engine → Final Response.
 *
 * This function owns no clock, random source, LLM, or autonomous re-planning
 * loop. All observable values are produced from injected dependencies, and a
 * given request plus dependency stream produces the same control flow.
 */
export function createDeterministicAgentRuntime(
  dependencies: AgentRuntimeDependencies,
) {
  const configuredEventBus = dependencies.eventBus ?? new AgentEventBus();
  const router = dependencies.router ?? routeTool;

  return {
    execute: async (request: AgentRuntimeRequest): Promise<AgentRuntimeResponse> => {
      const eventBus = request.eventBus ?? configuredEventBus;
      const context = createExecutionContext(
        { ...request, eventBus },
        dependencies,
      );

      eventBus.emit({
        type: "router.started",
        context,
        payload: { prompt: request.prompt, timestamp: context.clock.now() },
      });

      const routed = router(request.prompt);

      eventBus.emit({
        type: "router.completed",
        context,
        payload: {
          toolId: routed?.tool.name ?? null,
          confidence: routed?.confidence.score ?? 0,
          timestamp: context.clock.now(),
        },
      });

      // Supplying the router result constrains the planner to one selected tool
      // and intentionally rules out autonomous/re-planning behavior in Phase 3A.
      const planner = createPlanner(context, { selectedTool: routed });
      const plan = planner.plan(request.prompt);

      if (!routed || plan.steps.length === 0) {
        return { status: "no_capability", context, plan };
      }

      const currentStep = plan.steps[0]!;
      const tool = routed.tool;
      eventBus.emit({
        type: "tool.selected",
        context,
        payload: {
          toolId: tool.name,
          args: currentStep.inputs,
          timestamp: context.clock.now(),
        },
      });

      const executor = createToolExecutor(context);
      const reflection = createReflectionEngine(context);
      const reflectionHistory: { decision: ReflectionDecision }[] = [];

      // Reflection may authorize a bounded retry of the same deterministic
      // invocation. It cannot select a new capability or create a new plan.
      for (;;) {
        const execution = await executor.execute(tool, currentStep.inputs);
        const observation = execution.status === "completed"
          ? execution.result
          : execution.error;
        const decision = reflection.reflect(
          observation,
          currentStep,
          0,
          plan.steps.length,
          reflectionHistory,
        );
        reflectionHistory.push({ decision });

        if (decision.type === "retry") {
          continue;
        }

        if (execution.status === "completed" && decision.type === "complete") {
          return {
            status: "completed",
            context,
            plan,
            tool,
            result: execution.result,
          };
        }

        return {
          status: "failed",
          context,
          plan,
          tool,
          error: execution.status === "failed"
            ? execution.error
            : reflectionFailure(decision),
        };
      }
    },
  };
}
