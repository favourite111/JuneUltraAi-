import { createExecutionContext } from "./context.js";
import { AgentEventBus } from "./event-bus.js";
import { routeTool, type RoutedTool } from "./registry.js";
import { createExecutionOrchestrator } from "../orchestrator/execution-orchestrator.js";
import { DEFAULT_CONFIDENCE_THRESHOLDS } from "./types.js";
import type {
  AgentPlan,
  EventBus,
  ExecutionContext,
  ExecutionContextDependencies,
  ExecutionContextInput,
  HybridConfig,
  ModelProvider,
  PromptManager,
  Tool,
  ToolResult,
  ToolError,
} from "./types.js";
import type { ReasoningResult } from "../reasoner/reasoner-types.js";

// ---------------------------------------------------------------------------
// M19 — Runtime (thin adapter)
//
// Before M19: Runtime owned tool selection, execution, retry, and formatting.
// After  M19: Runtime creates the ExecutionContext, builds the OrchestratorInput,
//             delegates all execution to ExecutionOrchestrator, and translates
//             the immutable ExecutionResult back to AgentRuntimeResponse.
//
// The AgentRuntimeResponse contract is unchanged — chat.ts continues to work
// with CompletedRuntimeResponse | FailedRuntimeResponse | NoCapabilityRuntimeResponse.
// ---------------------------------------------------------------------------

export type CapabilityRouter = (prompt: string) => RoutedTool | null;

export interface AgentRuntimeDependencies extends ExecutionContextDependencies {
  readonly eventBus?:             EventBus;
  readonly router?:               CapabilityRouter;
  readonly modelProvider?:        ModelProvider;
  readonly promptManager?:        PromptManager;
  readonly confidenceThresholds?: typeof DEFAULT_CONFIDENCE_THRESHOLDS;
  readonly hybridConfig?:         HybridConfig;
  readonly memoryManager?:        import("../memory/types.js").MemoryManager;
}

export interface AgentRuntimeRequest extends ExecutionContextInput {
  readonly prompt: string;
  /** M17 planning decision — when present the planner is authoritative. */
  readonly planningDecision?: {
    readonly needsTool:  boolean;
    readonly toolName?:  string;
    readonly toolArgs?:  unknown;
  };
  /** M18 reasoning result — advisory, passed through to the Orchestrator. */
  readonly reasoningResult?: ReasoningResult;
}

// ---------------------------------------------------------------------------
// Response types (unchanged from pre-M19 — backward-compatible contract)
// ---------------------------------------------------------------------------

export interface CompletedRuntimeResponse {
  readonly status:  "completed";
  readonly context: ExecutionContext;
  readonly plan:    AgentPlan;
  readonly tool:    Tool;
  readonly result:  ToolResult;
}

export interface FailedRuntimeResponse {
  readonly status:  "failed";
  readonly context: ExecutionContext;
  readonly plan:    AgentPlan;
  readonly tool:    Tool;
  readonly error:   ToolError;
}

export interface NoCapabilityRuntimeResponse {
  readonly status:  "no_capability";
  readonly context: ExecutionContext;
  readonly plan:    AgentPlan;
}

export type AgentRuntimeResponse =
  | CompletedRuntimeResponse
  | FailedRuntimeResponse
  | NoCapabilityRuntimeResponse;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDeterministicAgentRuntime(
  dependencies: AgentRuntimeDependencies,
) {
  const configuredEventBus = dependencies.eventBus ?? new AgentEventBus();

  // Build the orchestrator once — stateless, shared across requests.
  const orchestrator = createExecutionOrchestrator({
    router:               dependencies.router ?? routeTool,
    modelProvider:        dependencies.modelProvider,
    promptManager:        dependencies.promptManager,
    hybridConfig:         dependencies.hybridConfig,
    confidenceThresholds: dependencies.confidenceThresholds ?? DEFAULT_CONFIDENCE_THRESHOLDS,
    clock:                dependencies.clock,
  });

  return {
    execute: async (request: AgentRuntimeRequest): Promise<AgentRuntimeResponse> => {
      const eventBus = request.eventBus ?? configuredEventBus;
      const context  = createExecutionContext({ ...request, eventBus }, dependencies);

      eventBus.emit({
        type:    "router.started",
        context,
        payload: { prompt: request.prompt, timestamp: context.clock.now() },
      });

      // Derive the planner input from M17 planningDecision + plannerState.
      const ps = request.plannerState as {
        intent?:      string;
        needsMemory?: boolean;
        needsTool?:   boolean;
        plan?:        Array<{ step: number; action: string; description: string; toolName?: string }>;
      } | undefined;

      const result = await orchestrator.execute({
        prompt: request.prompt,
        planner: {
          needsTool:   request.planningDecision?.needsTool   ?? ps?.needsTool   ?? false,
          toolName:    request.planningDecision?.toolName,
          toolArgs:    request.planningDecision?.toolArgs,
          intent:      ps?.intent      ?? "general_answer",
          needsMemory: ps?.needsMemory ?? false,
          plan:        ps?.plan        ?? [],
        },
        reasoning: request.reasoningResult,
        context,
        eventBus,
      });

      // Emit router.completed to preserve the pre-M19 event contract.
      eventBus.emit({
        type:    "router.completed",
        context,
        payload: {
          toolId:     result.bridgeTool?.name ?? null,
          confidence: result.handledBy === "tool" ? 1 : 0,
          timestamp:  context.clock.now(),
        },
      });

      // Minimal AgentPlan stub — satisfies the response contract without
      // re-running the internal planner (the orchestrator owns plan construction).
      const minimalPlan: AgentPlan = {
        planId: context.requestId,
        goal:   request.prompt,
        steps:  [],
      };

      // Translate ExecutionResult → AgentRuntimeResponse.
      if (result.handledBy === "tool") {
        if (result.success && result.bridgeTool && result.bridgeToolResult) {
          return {
            status: "completed",
            context,
            plan:   minimalPlan,
            tool:   result.bridgeTool,
            result: result.bridgeToolResult,
          };
        }
        if (result.bridgeTool && result.bridgeToolError) {
          return {
            status: "failed",
            context,
            plan:  minimalPlan,
            tool:  result.bridgeTool,
            error: result.bridgeToolError,
          };
        }
      }

      return { status: "no_capability", context, plan: minimalPlan };
    },
  };
}
