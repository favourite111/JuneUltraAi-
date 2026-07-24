/**
 * M24 — MemoryPolicy.
 *
 * Pure decision engine. Given a MemoryCandidate and the set of existing
 * KnowledgeRecords already loaded from storage (by KnowledgeReader), decides
 * what action the MemoryEvolutionEngine should take.
 *
 * Hard constraints:
 *   ✗ MUST NOT perform any I/O (no storage reads, no network calls)
 *   ✗ MUST NOT import any StorageProvider, database driver, or HTTP client
 *   ✗ MUST NOT access KnowledgeManager directly — existing memory is passed in
 *   ✓ MUST be a synchronous pure function for every decision
 *   ✓ MUST return a PolicyDecision for every candidate
 *
 * Decision rules (evaluated in order):
 *
 *   1. No existing record:
 *      - importance ≥ 0.70 → promote   (high-signal, no prior knowledge)
 *      - importance < 0.40 → ignore    (weak signal, not worth recording)
 *      - otherwise         → merge     (moderate signal, accumulate)
 *
 *   2. Existing record found — conflict resolution:
 *      - existing.confidence ≥ candidate.confidence + 0.20
 *          → ignore  (stored knowledge has meaningfully higher certainty)
 *      - existing.confidence ≤ 0.30
 *          → replace (stored record is low-confidence; new evidence wins)
 *      - candidate.confidence > existing.confidence + 0.10
 *          → update  (new evidence meaningfully improves certainty)
 *      - existing.confidence > 0.70 AND candidate.confidence < 0.50
 *          → decay   (contradictory evidence; reduce existing confidence)
 *      - otherwise
 *          → merge   (reinforcing; let KnowledgeManager.merge() version-guard it)
 */

import type { KnowledgeRecord } from "../memory/types.js";
import type { MemoryCandidate, PolicyDecision, PolicyAction } from "./memory-evolution-types.js";

// ---------------------------------------------------------------------------
// Thresholds (module constants — never runtime-configurable)
// ---------------------------------------------------------------------------

const IGNORE_EXISTING_ADVANTAGE  = 0.20; // existing beats candidate by this margin → ignore
const REPLACE_LOW_CONFIDENCE     = 0.30; // existing below this → replace
const UPDATE_IMPROVEMENT_MARGIN  = 0.10; // candidate beats existing by this → update
const DECAY_EXISTING_THRESHOLD   = 0.70; // existing above this + contradictory signal → decay
const DECAY_CANDIDATE_THRESHOLD  = 0.50; // candidate below this (contradiction signal)
const PROMOTE_IMPORTANCE_MIN     = 0.70; // no-existing: importance at or above → promote
const IGNORE_IMPORTANCE_MAX      = 0.40; // no-existing: importance below → ignore

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/** M24 MemoryPolicy — synchronous pure decision function. */
export interface MemoryPolicy {
  /**
   * Decides what the engine should do with a candidate given all existing
   * knowledge already loaded from storage.
   *
   * @param candidate      - The proposed knowledge mutation.
   * @param existingMemory - All KnowledgeRecords loaded for this scope.
   *                         Only the record matching candidate.key is relevant;
   *                         the full set is passed for future policy extensions.
   */
  decide(
    candidate: MemoryCandidate,
    existingMemory: readonly KnowledgeRecord[],
  ): PolicyDecision;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Creates a MemoryPolicy instance with the standard rule set. */
export function createMemoryPolicy(): MemoryPolicy {
  return { decide };
}

// ---------------------------------------------------------------------------
// Production singleton
// ---------------------------------------------------------------------------

export const memoryPolicy = createMemoryPolicy();

// ---------------------------------------------------------------------------
// Decision logic (pure — no I/O)
// ---------------------------------------------------------------------------

function decide(
  candidate: MemoryCandidate,
  existingMemory: readonly KnowledgeRecord[],
): PolicyDecision {
  const existing = existingMemory.find((r) => r.key === candidate.key);

  if (existing === undefined) {
    return decideForNewCandidate(candidate);
  }

  return decideForExistingCandidate(candidate, existing);
}

function decideForNewCandidate(candidate: MemoryCandidate): PolicyDecision {
  if (candidate.importance >= PROMOTE_IMPORTANCE_MIN) {
    return decision(candidate.candidateId, "promote",
      `High-importance candidate (${candidate.importance.toFixed(2)}) with no existing record — promoting immediately.`);
  }

  if (candidate.importance < IGNORE_IMPORTANCE_MAX) {
    return decision(candidate.candidateId, "ignore",
      `Low-importance candidate (${candidate.importance.toFixed(2)}) with no existing record — discarding.`);
  }

  return decision(candidate.candidateId, "merge",
    `Moderate-importance candidate (${candidate.importance.toFixed(2)}) with no existing record — accumulating.`);
}

function decideForExistingCandidate(
  candidate: MemoryCandidate,
  existing: KnowledgeRecord,
): PolicyDecision {
  // Contradictory evidence check comes FIRST — a low-confidence candidate
  // against a high-confidence existing record signals that the stored knowledge
  // may no longer be accurate. Decay takes priority over the ignore guard so
  // that contradictions are not silently discarded.
  if (
    existing.confidence > DECAY_EXISTING_THRESHOLD &&
    candidate.confidence < DECAY_CANDIDATE_THRESHOLD
  ) {
    return decision(candidate.candidateId, "decay",
      `Contradictory evidence (existing confidence ${existing.confidence.toFixed(2)}, candidate ${candidate.confidence.toFixed(2)}) — decaying existing record.`);
  }

  // Existing is significantly more confident — preserve it.
  if (existing.confidence >= candidate.confidence + IGNORE_EXISTING_ADVANTAGE) {
    return decision(candidate.candidateId, "ignore",
      `Existing record has higher confidence (${existing.confidence.toFixed(2)} vs ${candidate.confidence.toFixed(2)}) — preserving stored knowledge.`);
  }

  // Existing is low-confidence — replace with new evidence.
  if (existing.confidence <= REPLACE_LOW_CONFIDENCE) {
    return decision(candidate.candidateId, "replace",
      `Existing record has low confidence (${existing.confidence.toFixed(2)}) — replacing with new evidence.`);
  }

  // New evidence meaningfully improves confidence — update.
  if (candidate.confidence > existing.confidence + UPDATE_IMPROVEMENT_MARGIN) {
    return decision(candidate.candidateId, "update",
      `New evidence improves confidence (${existing.confidence.toFixed(2)} → ${candidate.confidence.toFixed(2)}) — updating.`);
  }

  // Default: reinforce existing knowledge.
  return decision(candidate.candidateId, "merge",
    `Reinforcing existing record (${existing.confidence.toFixed(2)}) — merging.`);
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function decision(
  candidateId: string,
  action: PolicyAction,
  rationale: string,
): PolicyDecision {
  return Object.freeze({ candidateId, action, rationale });
}
