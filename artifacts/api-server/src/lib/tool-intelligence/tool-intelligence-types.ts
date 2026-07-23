/**
 * M20 — Tool Intelligence Layer types.
 *
 * This module is the single source of truth for all Tool Intelligence contracts.
 *
 * The Tool Intelligence Layer MUST NOT:
 *   ✗ call tools
 *   ✗ call LLM
 *   ✗ modify memory
 *   ✗ modify planner
 *   ✗ modify reasoner
 *
 * It only reasons ABOUT tools — selection, ranking, availability, cost, conflicts.
 */

// ---------------------------------------------------------------------------
// Candidate
// ---------------------------------------------------------------------------

/**
 * A single tool evaluated during intelligence analysis.
 * All fields are deterministically computed — no I/O, no execution.
 */
export interface CandidateTool {
  /** Tool name as registered in ToolRegistry. */
  readonly name: string;
  /** Confidence score 0.0–1.0 that this tool is the right choice. */
  readonly confidence: number;
  /** Reasoning statements explaining the confidence score. */
  readonly reasoning: readonly string[];
  /** Relative operational cost (from manifest, or 1 as default). */
  readonly estimatedCost: number;
  /** Estimated execution latency in milliseconds (from manifest, or 500 ms default). */
  readonly estimatedLatency: number;
  /** Whether this tool is currently registered and accessible. */
  readonly available: boolean;
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

/** Whether the selected tool is reachable without executing it. */
export type ToolAvailabilityStatus = "available" | "unavailable" | "unknown";

// ---------------------------------------------------------------------------
// Conflict
// ---------------------------------------------------------------------------

/**
 * A detected conflict between two candidate tools that both scored for the
 * same intent. The layer REPORTS conflicts — it NEVER resolves them.
 */
export interface ToolConflict {
  /** Name of the first conflicting tool. */
  readonly toolA: string;
  /** Name of the second conflicting tool. */
  readonly toolB: string;
  /** Human-readable explanation of the conflict. */
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/**
 * Input consumed by the Tool Intelligence Layer.
 * Derived from the Planner's authoritative PlanningResult.
 * The layer reads these values but NEVER modifies them.
 */
export interface ToolIntelligenceInput {
  /**
   * Tool name nominated by the Planner. May be undefined when the planner
   * deferred tool selection (legacy / LLM fallback path).
   */
  readonly toolName?: string;
  /** Args from the Planner. Carried through but unused for selection logic. */
  readonly toolArgs?: unknown;
  /** Raw user prompt, used for scoring via tool.score() or manifest triggers. */
  readonly prompt: string;
  /** Whether the Planner determined a tool is needed at all. */
  readonly needsTool: boolean;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/**
 * Immutable output of the Tool Intelligence Layer.
 * Deep-frozen via makeToolIntelligenceResult() before returning.
 * No consumer may mutate this object.
 */
export interface ToolIntelligenceResult {
  /**
   * The chosen tool name after intelligence analysis, or null when
   * needsTool=false or no suitable tool was identified.
   */
  readonly selectedTool: string | null;
  /** All evaluated candidate tools, ranked by descending confidence. */
  readonly candidateTools: readonly CandidateTool[];
  /** Confidence score of the final selection decision (0.0–1.0). */
  readonly confidence: number;
  /** Estimated execution latency in milliseconds for the selected tool. */
  readonly estimatedLatency: number;
  /** Estimated relative operational cost (1=cheap, 10=expensive). */
  readonly estimatedCost: number;
  /** Availability status of the selected tool. */
  readonly availability: ToolAvailabilityStatus;
  /**
   * Names of registered tools that could serve as fallbacks if the selected
   * tool fails or is unavailable.
   */
  readonly fallbackCandidates: readonly string[];
  /** Detected conflicts among the top candidate tools. */
  readonly conflicts: readonly ToolConflict[];
  /** Non-fatal diagnostic warnings (e.g. missing manifest metadata). */
  readonly warnings: readonly string[];
}
