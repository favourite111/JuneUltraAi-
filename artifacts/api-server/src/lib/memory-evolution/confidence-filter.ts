/**
 * M24 — Confidence Filter.
 *
 * Derives a signal strength score from a ReflectionResult and decides whether
 * it is strong enough to warrant candidate extraction. Weak signals (e.g. a
 * neutral execution with no issues) are discarded early, preventing the
 * pipeline from generating low-quality knowledge records.
 *
 * Design rules:
 *   - Pure function: no I/O, no side effects.
 *   - Threshold is a module constant (not configurable at runtime) to avoid
 *     accidental drift that would flood or starve the knowledge store.
 *   - The score is an internal implementation detail; callers use
 *     passesConfidenceFilter() only.
 *
 * Signal strength scoring:
 *   analyzed === false           →  0.00  (always filtered)
 *   quality:
 *     good                       → +0.30
 *     poor                       → +0.40   (failures are strong signals)
 *     neutral                    → +0.00
 *   confidenceAlignment:
 *     high                       → +0.30
 *     low                        → +0.40   (miscalibration is a strong signal)
 *     neutral                    → +0.00
 *   latency === "high"           → +0.10   (supporting evidence)
 *   issues (capped at 3 issues)  → +0.05 per issue, max +0.15
 *
 * Typical outcomes:
 *   neutral/neutral/acceptable/[] → 0.00 → filtered
 *   good/neutral/acceptable/[]   → 0.30 → filtered (below 0.35)
 *   poor/neutral/acceptable/[]   → 0.40 → passes
 *   good/high/acceptable/[]      → 0.60 → passes  (reliable tool)
 *   good/low/acceptable/[…]      → 0.75 → passes  (under-confident success)
 *   poor/low/acceptable/[…]      → 0.85 → passes  (over-confident failure)
 */

import type { ReflectionResult } from "../reflection/reflection-types.js";

// ---------------------------------------------------------------------------
// Threshold
// ---------------------------------------------------------------------------

/**
 * Minimum signal strength required to proceed with candidate extraction.
 * Candidates below this value are silently discarded before any I/O occurs.
 */
export const CONFIDENCE_THRESHOLD = 0.35;

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Computes a signal-strength score in [0.0, 1.0] for a ReflectionResult.
 * Exported for unit-test visibility; application code should use
 * passesConfidenceFilter() instead.
 */
export function computeSignalStrength(result: ReflectionResult): number {
  if (!result.analyzed) return 0;

  let score = 0;

  // Quality contribution
  if (result.quality === "good") score += 0.30;
  else if (result.quality === "poor") score += 0.40;
  // neutral contributes 0

  // Confidence-alignment contribution
  if (result.confidenceAlignment === "high") score += 0.30;
  else if (result.confidenceAlignment === "low") score += 0.40;
  // neutral contributes 0

  // Latency as supporting evidence (weak alone, strengthens other signals)
  if (result.latency === "high") score += 0.10;

  // Issues strengthen the overall signal (each issue adds 0.05, capped at 0.15)
  score += Math.min(result.issues.length * 0.05, 0.15);

  return Math.min(score, 1.0);
}

/**
 * Returns true when the ReflectionResult carries enough signal to warrant
 * candidate extraction. Returns false for neutral / unanalyzed results.
 */
export function passesConfidenceFilter(result: ReflectionResult): boolean {
  return computeSignalStrength(result) >= CONFIDENCE_THRESHOLD;
}
