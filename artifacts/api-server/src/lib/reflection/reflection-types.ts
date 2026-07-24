/**
 * M23 — Execution Reflection Layer types.
 *
 * The Reflection Layer is an analysis layer that reviews completed executions
 * and produces structured insights. It is strictly read-only and never changes
 * execution, memory, planner decisions, tool selection, or learning updates.
 *
 * Hard boundaries — the Reflection Layer MUST NOT:
 *   ✗ execute tools
 *   ✗ call the LLM
 *   ✗ read from any StorageProvider (memory, database, tool history, learning stats)
 *   ✗ influence tool selection, routing, or execution path
 *   ✗ perform ranking, scoring, or confidence adjustment (beyond its own analysis)
 *   ✗ propagate errors to the caller (all failures are swallowed internally)
 *
 * The Reflection Layer MUST:
 *   ✓ accept completed execution outcomes (post-execution only)
 *   ✓ produce a structured ReflectionResult
 *   ✓ return a ReflectionResult regardless of internal analysis outcome
 *   ✓ never block the user-facing response on any reflection failure
 */

import type {
  ObservationInput,
  ObservationResult,
  ObservationScope,
} from "../observer/observer-types.js";

// Re-export for convenience — reflection builds on observation.
export type { ObservationScope };

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/**
 * Input for the Reflection Layer, derived from an ObservationResult.
 * Renamed from generic 'ReflectionInput' to 'ExecutionReflectionInput'
 * to allow for future reflection on other aspects (conversations, memory, etc.).
 */
export interface ExecutionReflectionInput {
  /** Unique ID for this reflection event. */
  readonly reflectionId: string;
  /** Unique ID of the execution that this reflection is analyzing. */
  readonly executionId: string;
  /** The scope of the observation (tenantId, botId). */
  readonly scope: ObservationScope;
  /** The name of the tool that was executed. */
  readonly toolName: string;
  /** Whether the tool execution succeeded. */
  readonly success: boolean;
  /** Actual wall-clock execution duration in milliseconds. */
  readonly durationMs: number;
  /** Confidence score assigned by M20 ToolIntelligenceLayer before execution. */
  readonly confidenceAtSelection: number;
  /** Epoch milliseconds when the execution completed. */
  readonly executedAt: number;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/**
 * Immutable output of the Reflection Layer.
 * Deep-frozen by makeReflectionResult() — no consumer may mutate this object.
 */
export interface ReflectionResult {
  /** Unique ID for this reflection event. */
  readonly reflectionId: string;
  /** Unique ID of the execution that this reflection is analyzing. */
  readonly executionId: string;
  /**
   * true  — Reflection analysis was dispatched successfully.
   * false — reflection was skipped or failed internally (logged, not thrown).
   */
  readonly analyzed: boolean;
  /** Overall quality assessment of the execution. */
  readonly quality: "good" | "poor" | "neutral";
  /** How well the predicted confidence aligned with the actual outcome. */
  readonly confidenceAlignment: "high" | "low" | "neutral";
  /** Latency assessment. */
  readonly latency: "acceptable" | "high";
  /** Recommendations based on the reflection. */
  readonly recommendation: string;
  /** List of issues identified during reflection. */
  readonly issues: string[];
  /** Epoch ms when the ReflectionResult was assembled. */
  readonly reflectedAt: number;
}

/**
 * M23 — Reflection Layer interface.
 * Analyzes completed executions to produce structured insights.
 */
export interface ReflectionLayer {
  /**
   * Analyze one completed tool execution outcome and produce structured insights.
   *
   * CALL-SITE RULES:
   *   1. Call ONLY after execution has been observed.
   *   2. Always call as `void reflectionLayer.reflect(...)` — never await.
   *   3. Never use the return value to gate execution or modify the response.
   */
  reflect(input: Omit<ExecutionReflectionInput, "reflectionId">): Promise<ReflectionResult>;
}

// ---------------------------------------------------------------------------
// Store interface (structural — avoids importing ToolLearningStore class)
// ---------------------------------------------------------------------------

/**
 * The subset of ToolLearningStore that Reflection might eventually require
 * if it were to influence learning (which it currently does not).
 * This is a placeholder to illustrate the boundary.
 */
export interface ReflectionOutputStore {
  recordReflection(scope: ObservationScope, result: ReflectionResult): Promise<void>;
}
