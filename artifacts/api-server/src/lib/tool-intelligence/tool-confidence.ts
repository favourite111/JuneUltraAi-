/**
 * M20 — Tool confidence estimation.
 *
 * Estimates how well a tool matches the current request using:
 *   1. tool.score() — Phase 3A deterministic scorer (preferred)
 *   2. tool.manifest.triggers — keyword matching
 *   3. Heuristic default for legacy tools with no metadata
 *
 * Does NOT execute any tool.
 */

import { ToolRegistry } from "../tools/registry.js";
import type { CandidateTool } from "./tool-intelligence-types.js";
import type { ToolLearningStats } from "../tool-learning/tool-learning-types.js";
import { MIN_LEARNING_EXECUTIONS } from "../tool-learning/tool-learning-types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CONFIDENCE = 0.70;
const MANIFEST_TRIGGER_MATCH_CONFIDENCE = 0.85;
const MANIFEST_NO_TRIGGER_MATCH_CONFIDENCE = 0.50;
const PLANNER_NOMINATED_FLOOR = 0.90;

// ---------------------------------------------------------------------------
// Core estimators
// ---------------------------------------------------------------------------

/**
 * Estimate confidence for a single tool against the given prompt.
 * The result is deterministic — no I/O, no LLM, no tool execution.
 */
export function estimateToolConfidence(
  toolName: string,
  prompt: string,
): { confidence: number; reasoning: string[] } {
  const tool = ToolRegistry.getTool(toolName);

  if (!tool) {
    return {
      confidence: 0,
      reasoning: [`Tool "${toolName}" is not registered in ToolRegistry.`],
    };
  }

  const reasoning: string[] = [];

  // Phase 3A: use tool.score() for deterministic scoring
  if (tool.score) {
    const scored = tool.score(prompt);
    const clamped = Math.min(1, Math.max(0, scored.score));
    reasoning.push(...scored.reasoning);
    reasoning.push("Confidence derived from tool.score() deterministic scorer.");
    return { confidence: clamped, reasoning };
  }

  // Manifest-based scoring
  if (tool.manifest) {
    const promptLower = prompt.toLowerCase();
    const hasMatchingTrigger = tool.manifest.triggers.some((t) =>
      promptLower.includes(t.toLowerCase()),
    );

    if (hasMatchingTrigger) {
      reasoning.push("Prompt contains a trigger phrase from tool manifest.");
      return { confidence: MANIFEST_TRIGGER_MATCH_CONFIDENCE, reasoning };
    }

    reasoning.push(
      "Tool has a manifest but no trigger phrase matched in the prompt.",
    );
    return { confidence: MANIFEST_NO_TRIGGER_MATCH_CONFIDENCE, reasoning };
  }

  // Legacy tool — no manifest, no score method
  reasoning.push(
    "Legacy tool: no manifest or score() method available. Using default confidence.",
  );
  return { confidence: DEFAULT_CONFIDENCE, reasoning };
}

/**
 * Estimate confidence for the planner-nominated tool.
 * The Planner is authoritative — its choice receives a confidence floor.
 */
export function estimatePlannerNominatedConfidence(
  toolName: string,
  prompt: string,
): { confidence: number; reasoning: string[] } {
  const base = estimateToolConfidence(toolName, prompt);
  const confidence = Math.max(base.confidence, PLANNER_NOMINATED_FLOOR);
  return {
    confidence,
    reasoning: [
      ...base.reasoning,
      "Planner explicitly nominated this tool — confidence floor applied.",
    ],
  };
}

// ---------------------------------------------------------------------------
// Candidate builder
// ---------------------------------------------------------------------------

/**
 * Build a CandidateTool entry for a given tool name.
 * Reads from ToolRegistry only — no execution.
 */
export function buildCandidate(
  toolName: string,
  prompt: string,
  plannerNominated: boolean,
): CandidateTool {
  const tool = ToolRegistry.getTool(toolName);
  const available = tool !== undefined;

  const { confidence, reasoning } = plannerNominated
    ? estimatePlannerNominatedConfidence(toolName, prompt)
    : estimateToolConfidence(toolName, prompt);

  const estimatedCost    = tool?.manifest?.cost            ?? 1;
  const estimatedLatency = tool?.manifest?.estimatedLatency ?? 500;

  return Object.freeze({
    name: toolName,
    confidence,
    reasoning: Object.freeze([...reasoning]),
    estimatedCost,
    estimatedLatency,
    available,
  });
}

// ---------------------------------------------------------------------------
// M21 — Learning-based confidence adjustment
// ---------------------------------------------------------------------------

/** Bounded confidence boost for reliably-performing tools. */
const LEARNING_BOOST          = 0.05;
/** Bounded mild confidence penalty for moderately under-performing tools. */
const LEARNING_PENALTY_MILD   = 0.05;
/** Bounded severe confidence penalty for consistently failing tools. */
const LEARNING_PENALTY_SEVERE = 0.10;

/**
 * Apply an M21 Tool Learning confidence adjustment to a pre-computed M20 score.
 *
 * Adjustment bands (based on historical successRate):
 *   >= 0.90 → +0.05  (reliable — minor boost)
 *   >= 0.70 → ±0.00  (neutral — no systematic issue detected)
 *   >= 0.50 → −0.05  (below average — mild penalty)
 *   <  0.50 → −0.10  (poor performer — stronger penalty)
 *
 * Preconditions:
 *   - Only applied when stats.totalExecutions >= MIN_LEARNING_EXECUTIONS.
 *   - When plannerNominated=true, result is floored at PLANNER_NOMINATED_FLOOR
 *     so Planner authority is preserved even for historically under-performing tools.
 *   - Result is always clamped to [0.0, 1.0].
 *   - Synchronous and deterministic — no I/O, no randomness.
 *
 * DETERMINISM: stats passed here must reflect only executions that completed
 * BEFORE the current request (N+1 invariant). The caller (M20 evaluate()) is
 * responsible for obtaining stats from the ToolLearningReader cache, which
 * is updated post-execution, never during.
 */
export function applyLearningAdjustment(
  confidence: number,
  stats: ToolLearningStats,
  plannerNominated: boolean,
): number {
  if (stats.totalExecutions < MIN_LEARNING_EXECUTIONS) {
    return confidence; // insufficient history — no adjustment
  }

  let adjustment: number;
  if (stats.successRate >= 0.90) {
    adjustment = LEARNING_BOOST;
  } else if (stats.successRate >= 0.70) {
    adjustment = 0;
  } else if (stats.successRate >= 0.50) {
    adjustment = -LEARNING_PENALTY_MILD;
  } else {
    adjustment = -LEARNING_PENALTY_SEVERE;
  }

  const adjusted = confidence + adjustment;
  const floored  = plannerNominated
    ? Math.max(PLANNER_NOMINATED_FLOOR, adjusted) // never undercut Planner authority
    : adjusted;
  return Math.min(1.0, Math.max(0.0, floored));
}
