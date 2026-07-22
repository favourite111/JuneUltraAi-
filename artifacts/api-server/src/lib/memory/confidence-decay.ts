/**
 * Phase 3C — Confidence Decay & Memory Hygiene (ADR-005, Milestone 4)
 *
 * Implements the exponential confidence decay formula specified in ADR-005 §10:
 *
 *   decayedConfidence = storedConfidence × (0.5 ^ (daysSinceConfirmed / halfLifeDays))
 *
 * Design rules:
 *   - Decay calculations MUST NOT occur on the request path.
 *   - Only confidence and decayed are mutated; importance is never touched.
 *   - Facts are never physically deleted — they remain auditable in storage.
 *   - memory.fact_decayed is emitted only on first threshold crossing (not on repeat sweeps).
 *   - The injectable nowMs clock makes every sweep deterministic and fully testable.
 *
 * Nothing in this file touches routes, the agent runtime, or PromptManager.
 */

import {
  type ConfidenceDecayConfig,
  type MemoryScope,
  type StorageKey,
  type StorageProvider,
  type UserFact,
} from "./types.js";
import type { EventBus } from "../tools/types.js";

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/**
 * Summary returned by ConfidenceDecayService.runDecaySweep().
 * Carries enough information for the caller to log, monitor, or audit
 * the sweep without inspecting storage directly.
 */
export interface DecaySweepResult {
  /** Total number of user facts examined in this sweep. */
  readonly processed: number;
  /** Number of facts newly marked decayed: true in this sweep. */
  readonly decayed: number;
  /** Wall-clock timestamp of the sweep (the nowMs value used). */
  readonly timestamp: number;
}

// ---------------------------------------------------------------------------
// Pure formula — exported for independent unit testing
// ---------------------------------------------------------------------------

/**
 * Applies the ADR-005 §10 exponential decay formula to a stored confidence value.
 *
 * Formula:
 *   decayedConfidence = storedConfidence × (0.5 ^ (daysSinceConfirmed / halfLifeDays))
 *
 * Properties:
 *   - Returns storedConfidence unchanged when confirmedAt >= nowMs (0 days elapsed).
 *   - Returns storedConfidence × 0.5 after exactly halfLifeDays have elapsed.
 *   - Returns storedConfidence × 0.25 after 2 × halfLifeDays have elapsed.
 *   - Result is clamped to [0.0, 1.0] — never negative, never above input.
 *   - Deterministic: equal inputs always produce equal output.
 *   - Pure: no side-effects, no external state.
 *
 * @param storedConfidence   Current confidence in [0.0, 1.0].
 * @param confirmedAt        Millisecond timestamp of the last confirmation.
 * @param nowMs              Current time in milliseconds (injectable for testing).
 * @param config             Decay configuration (halfLifeDays, minimumConfidence).
 * @returns                  Decayed confidence in [0.0, storedConfidence].
 */
export function computeDecayedConfidence(
  storedConfidence: number,
  confirmedAt: number,
  nowMs: number,
  config: ConfidenceDecayConfig,
): number {
  const daysSinceConfirmed = (nowMs - confirmedAt) / (1_000 * 60 * 60 * 24);

  // No time has passed (or clock skew — treat as fresh confirmation).
  if (daysSinceConfirmed <= 0) return storedConfidence;

  const result = storedConfidence * Math.pow(0.5, daysSinceConfirmed / config.halfLifeDays);

  // Clamp to [0, storedConfidence] — floating-point should never produce negative
  // values here, but defensive clamping guards against edge-case IEEE 754 behaviour.
  return Math.max(0, Math.min(storedConfidence, result));
}

// ---------------------------------------------------------------------------
// ConfidenceDecayService
// ---------------------------------------------------------------------------

/**
 * Background sweep service that applies exponential confidence decay to all
 * user facts for a given scope.
 *
 * Responsibilities:
 *   - Read all user facts for a scope from storage.
 *   - Compute the decayed confidence for each active (non-decayed) fact.
 *   - When decayed confidence falls below minimumConfidence, mark the fact
 *     decayed: true and persist the updated confidence via provider.upsert().
 *   - Emit memory.fact_decayed exactly once per fact, on the first crossing.
 *     Already-decayed facts are skipped entirely (no update, no event).
 *
 * Must NOT be called from the request path — wire to a scheduled background
 * job or an admin-triggered sweep endpoint.
 *
 * Usage:
 *   const service = new ConfidenceDecayService(provider, DEFAULT_CONFIDENCE_DECAY, eventBus);
 *   const result = await service.runDecaySweep(scope);
 */
export class ConfidenceDecayService {
  constructor(
    private readonly provider: StorageProvider,
    private readonly config: ConfidenceDecayConfig,
    private readonly eventBus?: EventBus,
  ) {}

  /**
   * Runs one decay sweep for the given user scope.
   *
   * Algorithm:
   *   1. List all user facts from the user_profile tier (up to 10,000 — a
   *      practical upper bound; a future ADR may introduce pagination).
   *   2. For each fact where decayed !== true:
   *      a. Compute decayedConfidence using the ADR-005 formula.
   *      b. If decayedConfidence < minimumConfidence:
   *         i.  Write { ...fact, confidence: decayedConfidence, decayed: true }
   *             back to storage via provider.upsert().
   *         ii. Emit memory.fact_decayed with the final confidence value.
   *   3. Return a DecaySweepResult summary.
   *
   * @param scope   The tenant/bot/user triple identifying whose facts to sweep.
   * @param nowMs   Injectable clock — defaults to Date.now() for production use.
   *                Always pass an explicit value in tests for determinism.
   */
  async runDecaySweep(scope: MemoryScope, nowMs: number = Date.now()): Promise<DecaySweepResult> {
    const key: StorageKey = {
      tier: "user_profile",
      tenantId: scope.tenantId,
      botId: scope.botId,
      userId: scope.userId,
    };

    const facts = await this.provider.list<UserFact>(key, {
      limit: 10_000,
      order: "asc",
    });

    let newlyDecayed = 0;

    for (const fact of facts) {
      // Already decayed in a prior sweep — skip entirely (no duplicate events).
      if (fact.decayed === true) continue;

      const decayedConfidence = computeDecayedConfidence(
        fact.confidence,
        fact.confirmedAt,
        nowMs,
        this.config,
      );

      if (decayedConfidence < this.config.minimumConfidence) {
        // First threshold crossing — update the fact and emit exactly one event.
        const updatedFact: UserFact = {
          ...fact,
          confidence: decayedConfidence,
          decayed: true,
        };

        await this.provider.upsert(key, fact.key, updatedFact);

        this.eventBus?.emit({
          type: "memory.fact_decayed",
          context: null as any,
          payload: {
            factId: fact.factId,
            key: fact.key,
            finalConfidence: decayedConfidence,
            timestamp: nowMs,
          },
        });

        newlyDecayed++;
      }
    }

    return {
      processed: facts.length,
      decayed: newlyDecayed,
      timestamp: nowMs,
    };
  }
}
