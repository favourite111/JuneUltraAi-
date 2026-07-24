/**
 * M22 — Execution Observer Layer types.
 *
 * The Observer is telemetry infrastructure, not execution infrastructure.
 *
 * Hard boundaries — the Observer MUST NOT:
 *   ✗ execute tools
 *   ✗ call the LLM
 *   ✗ read from ToolLearningStore (write-only path — reads belong to M20)
 *   ✗ influence tool selection, routing, or execution path
 *   ✗ perform ranking, scoring, or confidence adjustment
 *   ✗ propagate errors to the caller (all failures are swallowed internally)
 *
 * The Observer MUST:
 *   ✓ accept completed execution outcomes (post-execution only)
 *   ✓ forward outcomes to ToolLearningStore with real durationMs and confidenceAtSelection
 *   ✓ return an ObservationResult regardless of internal storage outcome
 *   ✓ never block the user-facing response on any observation failure
 */

import type {
  CompletedToolExecution,
  ToolLearningScope,
} from "../tool-learning/tool-learning-types.js";

// Re-export for convenience — observers build these, not callers.
export type { CompletedToolExecution, ToolLearningScope };

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/** (tenantId, botId) pair scoping the observation. Matches ToolLearningScope. */
export type ObservationScope = ToolLearningScope;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/**
 * One completed execution outcome to be observed and forwarded to M21.
 *
 * CALL-SITE CONTRACT:
 *   observe() MUST be called only AFTER execution has fully completed.
 *   It MUST be called as `void executionObserver.observe(...)` (non-blocking).
 *   Never `await` observe() on the request-response path.
 *
 * Values supplied here should come from:
 *   - durationMs:            ExecutionResult.executionTimeMs  (from M19)
 *   - confidenceAtSelection: ToolIntelligenceResult.confidence (from M20)
 */
export interface ObservationInput {
  /** (tenantId, botId) that scopes this observation's M21 storage entry. */
  readonly scope: ObservationScope;
  /** Tool name as registered in ToolRegistry. */
  readonly toolName: string;
  /** Whether the tool execution succeeded. */
  readonly success: boolean;
  /**
   * Actual wall-clock execution duration in milliseconds.
   * Supplied from M19 ExecutionResult.executionTimeMs.
   * Negative values are clamped to 0 internally.
   */
  readonly durationMs?: number;
  /**
   * Confidence score assigned by M20 ToolIntelligenceLayer before execution.
   * Allows M21 to track systematic over/under-confidence in M20's estimates.
   * Pass 0 when M20 was not consulted (should not occur after M22-B wiring).
   * Clamped to [0.0, 1.0] internally.
   */
  readonly confidenceAtSelection: number;
  /** Epoch milliseconds when the execution completed. */
  readonly executedAt: number;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/**
 * Immutable output of ExecutionObserver.observe().
 * Deep-frozen by makeObservationResult() — no consumer may mutate this object.
 *
 * ISOLATION GUARANTEE:
 *   observe() always returns an ObservationResult, even when internal
 *   storage fails. Callers inspect `recorded` to determine success.
 *   No field of this object affects execution or tool selection.
 */
export interface ObservationResult {
  /**
   * true  — M21 ToolLearningStore.record() was dispatched successfully.
   * false — observation was skipped or failed internally (logged, not thrown).
   */
  readonly recorded: boolean;
  /** durationMs from input, clamped to [0, ∞). */
  readonly durationMs: number;
  /** confidenceAtSelection from input, clamped to [0.0, 1.0]. */
  readonly confidenceAtSelection: number;
  /** Epoch ms when the ObservationResult was assembled (not when storage confirmed). */
  readonly storedAt: number;
}

// ---------------------------------------------------------------------------
// Store interface (structural — avoids importing ToolLearningStore class)
// ---------------------------------------------------------------------------

/**
 * The subset of ToolLearningStore that ExecutionObserver requires.
 * Structural typing keeps the Observer decoupled from M21 internals
 * and makes injection in tests trivial.
 */
export interface ObservationStore {
  record(scope: ToolLearningScope, execution: CompletedToolExecution): Promise<void>;
}
