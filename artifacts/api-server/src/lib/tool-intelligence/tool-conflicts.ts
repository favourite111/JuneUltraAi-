/**
 * M20 — Conflict detection between candidate tools.
 *
 * Conflicts are REPORTED — never resolved. Resolution is the Orchestrator's concern.
 * Does NOT execute any tool.
 */

import type { CandidateTool, ToolConflict } from "./tool-intelligence-types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Two tools with confidence scores within this band are considered to conflict —
 * both are plausible and the intent is ambiguous.
 */
const CONFLICT_CONFIDENCE_WINDOW = 0.15;

/** Only inspect the top-N candidates to bound conflict detection cost. */
const MAX_CANDIDATES_FOR_CONFLICT = 5;

// ---------------------------------------------------------------------------
// Confidence-based conflict detection
// ---------------------------------------------------------------------------

/**
 * Detect conflicts among the top candidates: two tools with similar confidence
 * scores are flagged as ambiguous.
 *
 * The layer REPORTS conflicts — it NEVER resolves them.
 */
export function detectConflicts(candidates: readonly CandidateTool[]): ToolConflict[] {
  const conflicts: ToolConflict[] = [];
  const top = candidates.slice(0, MAX_CANDIDATES_FOR_CONFLICT);

  for (let i = 0; i < top.length; i++) {
    for (let j = i + 1; j < top.length; j++) {
      const a = top[i]!;
      const b = top[j]!;
      const delta = Math.abs(a.confidence - b.confidence);

      if (delta <= CONFLICT_CONFIDENCE_WINDOW) {
        conflicts.push({
          toolA: a.name,
          toolB: b.name,
          reason:
            `Both tools score within ${CONFLICT_CONFIDENCE_WINDOW} confidence of each other ` +
            `(${a.confidence.toFixed(2)} vs ${b.confidence.toFixed(2)}) — intent is ambiguous.`,
        });
      }
    }
  }

  return conflicts;
}

// ---------------------------------------------------------------------------
// Availability-based conflict detection
// ---------------------------------------------------------------------------

/**
 * Detect a conflict when the nominated tool is unavailable.
 * If fallbacks exist, the first one is mentioned as an alternative.
 */
export function detectUnavailabilityConflict(
  nominatedName: string,
  isAvailable: boolean,
  fallbackNames: readonly string[],
): ToolConflict[] {
  if (isAvailable) return [];

  const toolB = fallbackNames.length > 0 ? fallbackNames[0]! : "(none)";
  const reason =
    fallbackNames.length > 0
      ? `Nominated tool "${nominatedName}" is unavailable. Fallback "${toolB}" is suggested.`
      : `Nominated tool "${nominatedName}" is unavailable and no fallback tools were found.`;

  return [{ toolA: nominatedName, toolB, reason }];
}
