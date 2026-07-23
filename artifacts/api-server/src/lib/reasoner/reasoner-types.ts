import type { MemoryContext } from "../memory/types.js";
import type { PlanningResult } from "../planner/planner-types.js";

// ---------------------------------------------------------------------------
// M18 — Reasoning Engine types
// ---------------------------------------------------------------------------

/** How much domain knowledge the user appears to have. */
export type ExpertiseLevel = "beginner" | "intermediate" | "expert";

/** How much detail the response should contain. */
export type ExplanationDepth = "brief" | "standard" | "detailed";

/** How time-sensitive the user's current goal is. */
export type UrgencyLevel = "low" | "normal" | "high";

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/**
 * Everything the Reasoning Engine needs. It receives the already-loaded
 * MemoryContext and the PlanningResult but NEVER writes to either.
 */
export interface ReasoningInput {
  /** Raw user message, as received by the chat route. */
  readonly message: string;
  /** Immutable output of the Agent Planner (M17). */
  readonly planningResult: PlanningResult;
  /** Already-loaded memory snapshot — read-only from the reasoner's perspective. */
  readonly memoryContext: MemoryContext;
}

// ---------------------------------------------------------------------------
// Contradiction
// ---------------------------------------------------------------------------

/**
 * A potential conflict between a stored user fact and something asserted in
 * the current message. The Reasoning Engine only flags — it never resolves.
 */
export interface ReasoningContradiction {
  /** The UserFact key that may be contradicted (e.g. "occupation"). */
  readonly field: string;
  /** The value currently stored in memory. */
  readonly stored: string;
  /** The raw claim from the user message. */
  readonly claimed: string;
  /** Always true — contradictions are always flagged for downstream awareness. */
  readonly flagged: true;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/**
 * Immutable output of the Reasoning Engine.
 *
 * Rules the engine MUST obey (enforced at boundary — never violated in
 * reasoning-rules.ts):
 *   ✗ Write memory
 *   ✗ Execute tools
 *   ✗ Modify session
 *   ✗ Modify planner results
 *   ✓ Read, infer, summarise, prioritise
 */
export interface ReasoningResult {
  /**
   * False when there is no memory or the message is trivially simple.
   * Downstream consumers SHOULD skip prompt injection when false.
   */
  readonly required: boolean;

  /** Inferred user domain expertise. */
  readonly expertiseLevel: ExpertiseLevel;

  /** Preferred response depth derived from user preference facts. */
  readonly preferredDepth: ExplanationDepth;

  /** How urgently the user needs an answer right now. */
  readonly urgency: UrgencyLevel;

  /** True when the user is resuming a previous topic. */
  readonly continuity: boolean;

  /** True when the user is in an active learning / teaching session. */
  readonly learningMode: boolean;

  /** True when the user is diagnosing or fixing a problem. */
  readonly troubleshootingMode: boolean;

  /**
   * Human-readable reasoning block, ready to prepend to the LLM prompt.
   * Empty string when `required` is false.
   */
  readonly summary: string;

  /** Individual inference statements that make up the summary. */
  readonly inferences: readonly string[];

  /**
   * Flagged contradictions between stored facts and the current message.
   * The engine reports but NEVER resolves these.
   */
  readonly contradictions: readonly ReasoningContradiction[];

  /** Description of context-window optimisations applied. */
  readonly optimizations: readonly string[];
}
