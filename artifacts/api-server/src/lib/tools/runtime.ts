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
import type { ToolIntelligenceResult } from "../tool-intelligence/tool-intelligence-types.js";

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
  /**
   * M20 Tool Intelligence result — wired directly to OrchestratorInput.toolIntelligence.
   * When present, the Orchestrator uses toolIntelligence.selectedTool for tool resolution
   * instead of looking up planner.toolName directly.
   */
  readonly toolIntelligenceResult?: ToolIntelligenceResult;
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

      // Derive the planner input from M17 planningDecision + plannerState.
      const ps = request.plannerState as {
        intent?:      string;
        needsMemory?: boolean;
        needsTool?:   boolean;
        plan?:        Array<{ step: number; action: string; description: string; toolName?: string }>;
      } | undefined;

      const plannerInput = {
        // Default needsTool to true when no explicit decision is present so the
        // orchestrator falls through to the deterministic router (legacy path).
        // An explicit `planningDecision.needsTool === false` is respected as-is.
        needsTool:   request.planningDecision?.needsTool   ?? ps?.needsTool   ?? true,
        toolName:    request.planningDecision?.toolName,
        toolArgs:    request.planningDecision?.toolArgs,
        intent:      ps?.intent      ?? "general_answer",
        needsMemory: ps?.needsMemory ?? false,
        plan:        ps?.plan        ?? [],
      };

      // Emit router.started then router.completed BEFORE the orchestrator runs so
      // that planner/tool events (emitted inside the orchestrator) are ordered
      // correctly in the event stream — matching the pre-M19 contract.
      eventBus.emit({
        type:    "router.started",
        context,
        payload: { prompt: request.prompt, timestamp: context.clock.now() },
      });
      eventBus.emit({
        type:    "router.completed",
        context,
        payload: {
          toolId:     plannerInput.toolName ?? null,
          confidence: plannerInput.needsTool ? 1 : 0,
          timestamp:  context.clock.now(),
        },
      });

      const result = await orchestrator.execute({
        prompt:           request.prompt,
        planner:          plannerInput,
        reasoning:        request.reasoningResult,
        // M20 — Tool Intelligence result (optional). When present the Orchestrator
        // uses toolIntelligence.selectedTool for tool resolution; falls back to
        // planner.toolName when absent (additive, non-breaking).
        toolIntelligence: request.toolIntelligenceResult,
        context,
        eventBus,
      });

      // Minimal AgentPlan stub — satisfies the response contract without
      // re-running the internal planner (the orchestrator owns plan construction).
      const minimalPlan: AgentPlan = {
        planId: context.requestId,
        goal:   request.prompt,
        steps:  [],
      };

      // Translate ExecutionResult → AgentRuntimeResponse.

      // Clarification path: LLM asked for more info — return as a failed response
      // to preserve the pre-M19 CLARIFICATION_NEEDED contract.
      const clarificationError = result.errors.find(e => e.code === "CLARIFICATION_NEEDED");
      if (clarificationError) {
        const stubTool: Tool = {
          name:        "llm_clarification",
          description: "LLM clarification sentinel",
          match:       () => null,
          execute:     async () => ({ type: "text" as const, reply: "", data: {} }),
        };
        return {
          status: "failed",
          context,
          plan:   minimalPlan,
          tool:   stubTool,
          error: {
            code:        "CLARIFICATION_NEEDED",
            message:     clarificationError.message,
            isRetryable: false,
          },
        };
      }

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
