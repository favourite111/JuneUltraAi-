import { ToolRegistry } from "../tools/registry.js";
import { routeTool } from "../tools/registry.js";
import { noCapabilityResult } from "./execution-result.js";
import { orchestratorMetrics, type OrchestratorMetricsRecorder } from "./orchestrator-metrics.js";
import { assembleExecutionResult } from "./executors/response-assembler.js";
import {
  createOrchestratorToolExecutor,
  type OrchestratorToolExecutor,
} from "./executors/tool-executor.js";
import {
  createLLMExecutor,
  type LLMExecutorConfig,
  type LLMExecutorOutput,
  type OrchestratorLLMExecutor,
} from "./executors/llm-executor.js";
import {
  createMemoryExecutor,
  type OrchestratorMemoryExecutor,
} from "./executors/memory-executor.js";
import type {
  ExecutionError,
  ExecutionOutput,
  ExecutionPath,
  ExecutionResult,
  OrchestratorInput,
  OrchestratorPlanStep,
  ToolExecutionOutput,
} from "./orchestrator-types.js";
import type {
  DEFAULT_CONFIDENCE_THRESHOLDS,
  HybridConfig,
  ModelProvider,
  PromptManager,
  Tool,
  ToolError,
  ToolResult,
} from "../tools/types.js";

// ---------------------------------------------------------------------------
// M19 — ExecutionOrchestrator
//
// Pipeline position:
//   Planner (M17) → Reasoner (M18) → ExecutionOrchestrator (M19) → Runtime
//
// Responsibilities:
//   ✓ Receive immutable PlanningResult (via OrchestratorInput.planner)
//   ✓ Receive immutable ReasoningResult (via OrchestratorInput.reasoning)
//   ✓ Coordinate executors sequentially (M19-D: no concurrency)
//   ✓ Preserve deterministic behaviour
//   ✓ Return immutable ExecutionResult
//
// Non-responsibilities (enforced at boundary):
//   ✗ Perform planning
//   ✗ Perform reasoning
//   ✗ Mutate memory
//   ✗ Choose tools independently of the planner
//   ✗ Bypass planner decisions
//
// Design — injectable executors:
//   Default executors wrap the existing M14-M18 components. Tests inject
//   mocks via OrchestratorExecutors to remain fast and deterministic.
// ---------------------------------------------------------------------------

export interface OrchestratorConfig extends LLMExecutorConfig {
  readonly router?: typeof routeTool;
  readonly metrics?: OrchestratorMetricsRecorder;
}

/** Injectable executor overrides (used by tests). */
export interface OrchestratorExecutors {
  readonly tool?:   OrchestratorToolExecutor;
  readonly llm?:    OrchestratorLLMExecutor;
  readonly memory?: OrchestratorMemoryExecutor;
}

export function createExecutionOrchestrator(
  config: OrchestratorConfig,
  inject?: OrchestratorExecutors,
) {
  const toolExec   = inject?.tool   ?? createOrchestratorToolExecutor();
  const llmExec    = inject?.llm    ?? createLLMExecutor(config);
  const memExec    = inject?.memory ?? createMemoryExecutor();
  const metrics    = config.metrics ?? orchestratorMetrics;
  const router     = config.router  ?? routeTool;

  return {
    /**
     * Execute the request described by `input` using the sequential step queue.
     * Steps are processed one at a time in plan order — no concurrency (M19-D).
     */
    async execute(input: OrchestratorInput): Promise<ExecutionResult> {
      const startMs = input.context.clock.now();
      const { prompt, planner, context, eventBus } = input;

      // Note: reasoning is advisory — we log it but never use it to change the
      // execution path. Only the planner flags are authoritative.
      const _ = input.reasoning; // referenced to satisfy linter; never acted upon

      const outputs:     ExecutionOutput[]     = [];
      const toolResults: ToolExecutionOutput[] = [];
      const errors:      ExecutionError[]      = [];

      let handledBy:       ExecutionPath  = "no_capability";
      let bridgeTool:      Tool     | undefined;
      let bridgeToolResult: ToolResult | undefined;
      let bridgeToolError:  ToolError  | undefined;

      // Effective step list — always at least one step so the loop fires once.
      const steps: readonly OrchestratorPlanStep[] =
        planner.plan.length > 0
          ? planner.plan
          : [{ step: 1, action: "direct", description: "Direct response" }];

      // -----------------------------------------------------------------------
      // M19-D — Sequential queue: no Promise.all, no dependency graph.
      // Each step is awaited before the next begins.
      // -----------------------------------------------------------------------
      for (const planStep of steps) {
        // ---- Tool path -------------------------------------------------------
        if (planner.needsTool) {
          let tool: Tool | null = null;
          let toolArgs: unknown = planner.toolArgs ?? {};

          // M20: use Tool Intelligence selectedTool when provided, falling back
          // to the Planner's nomination. Both paths end in a registry lookup —
          // no execution happens here.
          const resolvedToolName =
            input.toolIntelligence?.selectedTool ?? planner.toolName;

          if (resolvedToolName) {
            // Planner authority (possibly refined by Tool Intelligence): look up
            // the tool by the resolved name. Tool Intelligence decides WHICH
            // tool; the Orchestrator still executes via ToolRegistry.
            tool = ToolRegistry.getTool(resolvedToolName) ?? null;
          } else {
            // Legacy / non-M17 path: try deterministic router then LLM fallback.
            const deterministicRouted = router(prompt);
            if (deterministicRouted) {
              tool     = deterministicRouted.tool;
              toolArgs = deterministicRouted.args;
            } else {
              // LLM tool selection (hybrid intelligence path).
              const llmOutput = await llmExec.execute({ step: planStep.step, context, eventBus });
              // Push only the base ExecutionOutput fields — LLMExecutorOutput.selectedTool
              // contains a Tool with function properties that cannot be structuredClone'd.
              outputs.push({
                step:      llmOutput.step,
                executor:  llmOutput.executor,
                success:   llmOutput.success,
                durationMs: llmOutput.durationMs,
              });
              if (!llmOutput.success || !llmOutput.selectedTool) {
                // Propagate clarification requests so the runtime can translate them
                // into a CLARIFICATION_NEEDED failed response.
                const clarQ = (llmOutput as LLMExecutorOutput).clarificationQuestion;
                errors.push({
                  step:     planStep.step,
                  executor: "llm_selection",
                  code:     clarQ ? "CLARIFICATION_NEEDED" : "NO_TOOL_SELECTED",
                  message:  clarQ ?? "Neither the deterministic router nor the LLM could select a tool.",
                });
                break;
              }
              tool = llmOutput.selectedTool;
            }
          }

          if (!tool) {
            errors.push({
              step:     planStep.step,
              executor: "tool",
              code:     "TOOL_NOT_FOUND",
              message:  `Tool "${resolvedToolName ?? planner.toolName ?? "unknown"}" is not registered.`,
            });
            outputs.push({ step: planStep.step, executor: "tool", success: false, durationMs: 0 });
            break;
          }

          const toolOutput = await toolExec.execute({
            step: planStep.step, prompt, tool, args: toolArgs, context, eventBus,
          });
          outputs.push(toolOutput);
          toolResults.push(toolOutput);
          handledBy = "tool";

          if (toolOutput.success && toolOutput.result) {
            bridgeTool       = tool;
            bridgeToolResult = toolOutput.result;
          } else if (toolOutput.error) {
            errors.push({
              step:     planStep.step,
              executor: "tool",
              code:     toolOutput.error.code,
              message:  toolOutput.error.message,
            });
            bridgeTool      = tool;
            bridgeToolError = toolOutput.error;
          }

          if (!toolOutput.success) break; // Stop sequential queue on first failure

        // ---- Memory path -----------------------------------------------------
        } else if (planner.needsMemory) {
          const memOutput = await memExec.execute({
            step: planStep.step, prompt, intent: planner.intent, context,
          });
          outputs.push(memOutput);
          handledBy = "memory";
          if (!memOutput.success) {
            errors.push({
              step:    planStep.step,
              executor: "memory",
              code:    "MEMORY_UNAVAILABLE",
              message: "Memory executor reported failure.",
            });
            break;
          }

        // ---- No-capability path ---------------------------------------------
        } else {
          outputs.push({ step: planStep.step, executor: "no_capability", success: true, durationMs: 0 });
          handledBy = "no_capability";
        }
      }

      const endMs = input.context.clock.now();

      const result = assembleExecutionResult({
        outputs,
        toolResults,
        errors,
        handledBy,
        startMs,
        endMs,
        bridgeTool,
        bridgeToolResult,
        bridgeToolError,
      });

      metrics.record({
        success:        result.success,
        stepsCount:     outputs.length,
        executionTimeMs: result.executionTimeMs,
      });

      return result;
    },
  };
}
