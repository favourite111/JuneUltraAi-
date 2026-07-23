/**
 * M20 — Tool ranking logic.
 *
 * Ranks all registered tools against the current prompt and selects
 * the best candidate. Does NOT execute any tool.
 */

import { ToolRegistry } from "../tools/registry.js";
import { buildCandidate } from "./tool-confidence.js";
import type { CandidateTool } from "./tool-intelligence-types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Tools scoring below this threshold are excluded from the candidate list. */
const MIN_CONFIDENCE_THRESHOLD = 0.30;

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/**
 * Evaluate every registered tool against the prompt and return a sorted
 * candidate list (descending confidence, then ascending cost as tiebreaker).
 *
 * Only tools scoring at or above MIN_CONFIDENCE_THRESHOLD are included.
 * Does NOT execute any tool.
 */
export function rankTools(
  prompt: string,
  nominatedToolName?: string,
): CandidateTool[] {
  const allTools = ToolRegistry.listTools();

  const candidates: CandidateTool[] = allTools
    .map((tool) =>
      buildCandidate(tool.name, prompt, tool.name === nominatedToolName),
    )
    .filter((c) => c.confidence >= MIN_CONFIDENCE_THRESHOLD);

  // Sort: higher confidence first; break ties by lower cost
  candidates.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return a.estimatedCost - b.estimatedCost;
  });

  return candidates;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * Return the best candidate from a pre-ranked list.
 * Prefers available tools; falls back to the highest-ranked unavailable one
 * so the caller can surface a meaningful error.
 * Returns null when the list is empty.
 */
export function selectBestCandidate(
  candidates: readonly CandidateTool[],
): CandidateTool | null {
  const available = candidates.filter((c) => c.available);
  if (available.length > 0) return available[0] ?? null;
  return candidates[0] ?? null;
}

// ---------------------------------------------------------------------------
// Fallback selection
// ---------------------------------------------------------------------------

/**
 * Return names of registered tools that could act as fallbacks:
 * available, ranked by confidence, and excluding the selected tool.
 */
export function selectFallbacks(
  candidates: readonly CandidateTool[],
  selectedName: string | null,
  maxFallbacks = 3,
): string[] {
  return candidates
    .filter((c) => c.available && c.name !== selectedName)
    .slice(0, maxFallbacks)
    .map((c) => c.name);
}
