import { DecisionValidator, normalizeError, CircuitBreaker } from "../../tools/resilience.js";
import { ToolRegistry } from "../../tools/registry.js";
import type {
  ExecutionContext,
  EventBus,
  Tool,
  ModelProvider,
  PromptManager,
  HybridConfig,
  DEFAULT_CONFIDENCE_THRESHOLDS,
} from "../../tools/types.js";
import type { ExecutionOutput } from "../orchestrator-types.js";

// ---------------------------------------------------------------------------
// M19 — LLMExecutor
//
// Single responsibility: use the LLM to SELECT a tool when the deterministic
// router has low confidence and hybrid intelligence is enabled.
// This is the legacy fallback path — in M17+ flows the planner already
// supplies a toolName, so this executor is not triggered.
//
// Extracted verbatim from runtime.ts (lines 143-248) to give it a clean home.
//
// Contract:
//   ✗ Never executes tools (returns the resolved Tool for ToolExecutor to run)
//   ✗ Never modifies memory, planning, or reasoning results
//   ✓ Consult the LLM, validate decision, resolve the selected tool
// ---------------------------------------------------------------------------

export interface LLMExecutorConfig {
  readonly modelProvider?: ModelProvider;
  readonly promptManager?: PromptManager;
  readonly hybridConfig?: HybridConfig;
  readonly confidenceThresholds: typeof DEFAULT_CONFIDENCE_THRESHOLDS;
  readonly clock: { now(): number };
}

export interface LLMExecutorOutput extends ExecutionOutput {
  readonly executor: "llm_selection";
  /** The tool the LLM selected, if any. Null when LLM returned no usable decision. */
  readonly selectedTool: Tool | null;
}

export interface OrchestratorLLMExecutor {
  execute(input: {
    step: number;
    context: ExecutionContext;
    eventBus: EventBus;
  }): Promise<LLMExecutorOutput>;
}

export function createLLMExecutor(config: LLMExecutorConfig): OrchestratorLLMExecutor {
  const {
    modelProvider,
    promptManager,
    hybridConfig,
    confidenceThresholds,
    clock,
  } = config;

  const circuitBreaker = hybridConfig?.circuitBreaker
    ? new CircuitBreaker(hybridConfig.circuitBreaker, clock)
    : null;

  return {
    async execute(input): Promise<LLMExecutorOutput> {
      const { step, context, eventBus } = input;
      const start = clock.now();

      if (!hybridConfig?.enabled || !modelProvider || !promptManager) {
        return { step, executor: "llm_selection", success: false, durationMs: 0, selectedTool: null };
      }

      const breakerState = circuitBreaker?.getState(clock) ?? "CLOSED";
      if (breakerState === "OPEN") {
        context.metrics.record("circuit_breaker_skips");
        return { step, executor: "llm_selection", success: false, durationMs: clock.now() - start, selectedTool: null };
      }

      context.metrics.record("llm_requests");
      const availableTools = ToolRegistry.listTools();
      const llmPrompt = promptManager.renderPrompt(context, availableTools);

      eventBus.emit({
        type: "llm.request",
        context,
        payload: { prompt: llmPrompt, timestamp: clock.now() },
      });

      const retryAttempts = hybridConfig.retryAttempts ?? 1;
      let llmText: string | null = null;

      for (let attempt = 0; attempt <= retryAttempts; attempt++) {
        try {
          const response = await modelProvider.generate(llmPrompt, {
            model:   hybridConfig.model,
            timeout: hybridConfig.timeout,
          });
          circuitBreaker?.recordSuccess();
          context.metrics.record("llm_success");

          eventBus.emit({
            type: "llm.response",
            context,
            payload: { response, timestamp: clock.now() },
          });

          llmText = response.text;
          break;
        } catch (rawError: unknown) {
          const normalized = normalizeError(rawError);
          if (normalized.code === "TIMEOUT") context.metrics.record("llm_timeout");

          if (attempt < retryAttempts && normalized.isRetryable) {
            context.metrics.record("llm_retries");
            continue;
          }
          const wasOpen = circuitBreaker?.getState() === "OPEN";
          circuitBreaker?.recordFailure();
          if (circuitBreaker?.getState() === "OPEN" && !wasOpen) {
            context.metrics.record("circuit_breaker_opens");
          }
          break;
        }
      }

      if (!llmText) {
        context.metrics.record("fallback_count");
        return { step, executor: "llm_selection", success: false, durationMs: clock.now() - start, selectedTool: null };
      }

      const llmDecision = promptManager.parseResponse(llmText);
      const validation  = DecisionValidator.validate(llmDecision);

      if (!validation.isValid) {
        context.metrics.record("llm_validation_failures");
        context.metrics.record("fallback_count");
        return { step, executor: "llm_selection", success: false, durationMs: clock.now() - start, selectedTool: null };
      }

      eventBus.emit({
        type: "llm.decision",
        context,
        payload: { decision: llmDecision, timestamp: clock.now() },
      });

      if (
        llmDecision.type === "tool_selection" &&
        llmDecision.toolName &&
        llmDecision.confidence != null &&
        llmDecision.confidence >= confidenceThresholds.llmMinConfidence
      ) {
        const selected = ToolRegistry.getTool(llmDecision.toolName);
        if (selected) {
          return { step, executor: "llm_selection", success: true, durationMs: clock.now() - start, selectedTool: selected };
        }
        context.metrics.record("fallback_count");
      }

      return { step, executor: "llm_selection", success: false, durationMs: clock.now() - start, selectedTool: null };
    },
  };
}
