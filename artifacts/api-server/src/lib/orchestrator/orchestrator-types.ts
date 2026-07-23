import type {
  ExecutionContext,
  EventBus,
  Tool,
  ToolResult,
  ToolError,
} from "../tools/types.js";
import type { ReasoningResult } from "../reasoner/reasoner-types.js";
import type { ToolIntelligenceResult } from "../tool-intelligence/tool-intelligence-types.js";

// ---------------------------------------------------------------------------
// M19 — Execution Orchestrator types
// ---------------------------------------------------------------------------

/**
 * Which executor handled a given step.
 * "llm_selection" = hybrid intelligence chose the tool via LLM (legacy path).
 */
export type ExecutionPath = "tool" | "llm_selection" | "memory" | "no_capability";

// ---------------------------------------------------------------------------
// Planner input (derived from M17 PlanningResult + plannerState)
// ---------------------------------------------------------------------------

/** One step from the M17 planner's plan array, re-typed for the Orchestrator. */
export interface OrchestratorPlanStep {
  readonly step: number;
  readonly action: string;
  readonly description: string;
  readonly toolName?: string;
}

/**
 * The subset of M17 PlanningResult the Orchestrator cares about.
 * Constructed by the thin Runtime adapter from planningDecision + plannerState.
 * The planner is authoritative — the Orchestrator never overrides these flags.
 */
export interface OrchestratorPlannerInput {
  readonly needsTool: boolean;
  readonly toolName?: string;
  readonly toolArgs?: unknown;
  readonly intent: string;
  readonly needsMemory: boolean;
  readonly plan: readonly OrchestratorPlanStep[];
}

// ---------------------------------------------------------------------------
// Orchestrator input
// ---------------------------------------------------------------------------

/**
 * Everything the Orchestrator needs to coordinate one request.
 *
 * Invariants:
 *   - `planner` is authoritative (Planner decides WHAT to do)
 *   - `reasoning` is advisory only (Reasoner decides HOW to think — never changes execution path)
 *   - `toolIntelligence` is advisory for WHICH tool — the Orchestrator uses its selectedTool
 *     when present but always falls back to planner.toolName
 *   - The Orchestrator never writes memory, performs planning, or bypasses planner decisions
 */
export interface OrchestratorInput {
  readonly prompt: string;
  /** Authoritative planning decision from M17. */
  readonly planner: OrchestratorPlannerInput;
  /** Advisory reasoning context from M18. Never alters the execution path. */
  readonly reasoning?: ReasoningResult;
  /**
   * M20 Tool Intelligence result. Optional — when present, the Orchestrator
   * uses toolIntelligence.selectedTool to resolve the tool instead of looking
   * up planner.toolName directly. Falls back to planner.toolName if absent or
   * if selectedTool is null.
   */
  readonly toolIntelligence?: ToolIntelligenceResult;
  readonly context: ExecutionContext;
  readonly eventBus: EventBus;
}

// ---------------------------------------------------------------------------
// Execution outputs
// ---------------------------------------------------------------------------

/** Base output produced by any executor for a single plan step. */
export interface ExecutionOutput {
  readonly step: number;
  readonly executor: ExecutionPath;
  readonly success: boolean;
  readonly durationMs: number;
}

/** Output produced by the ToolExecutor. */
export interface ToolExecutionOutput extends ExecutionOutput {
  readonly executor: "tool";
  readonly toolName: string;
  readonly result?: ToolResult;
  readonly error?: ToolError;
}

/** Output produced by the MemoryExecutor. */
export interface MemoryExecutionOutput extends ExecutionOutput {
  readonly executor: "memory";
}

export interface ExecutionError {
  readonly step: number;
  readonly executor: ExecutionPath;
  readonly code: string;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// ExecutionResult  (spec: { success, outputs, toolResults, executionTime, errors })
// ---------------------------------------------------------------------------

/**
 * Immutable output of the ExecutionOrchestrator.
 *
 * Bridge fields (bridge*) allow the thin Runtime adapter to reconstruct
 * the legacy AgentRuntimeResponse without re-querying the tool registry.
 *
 * Contract (same as Reasoning Engine):
 *   ✗ Never writes memory
 *   ✗ Never performs planning
 *   ✗ Never modifies planner or reasoner results
 *   ✓ Coordinate, execute, assemble, report
 */
export interface ExecutionResult {
  readonly success: boolean;
  readonly handledBy: ExecutionPath;
  readonly outputs: readonly ExecutionOutput[];
  readonly toolResults: readonly ToolExecutionOutput[];
  readonly executionTimeMs: number;
  readonly errors: readonly ExecutionError[];
  // --- Bridge fields for the thin Runtime adapter ---
  /** Present when handledBy === "tool". */
  readonly bridgeTool?: Tool;
  readonly bridgeToolResult?: ToolResult;
  readonly bridgeToolError?: ToolError;
}
