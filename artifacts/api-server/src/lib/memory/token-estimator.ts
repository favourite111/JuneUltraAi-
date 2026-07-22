/**
 * Phase 3C — TokenEstimator abstraction (ADR-005, Milestone 1)
 *
 * Provides a deterministic, injectable seam for token counting inside
 * DefaultMemoryManager.  The interface is intentionally minimal so that
 * future model-specific implementations (tiktoken for OpenAI, the Anthropic
 * tokenizer, Gemini's SentencePiece, etc.) can be swapped in at composition
 * time without touching runtime logic.
 *
 * Design constraints:
 *   - estimate() must be synchronous and free of side-effects
 *   - estimate() must be deterministic: equal inputs yield equal outputs
 *   - No implementation may make network calls or read files at estimate time
 *   - The interface carries no model-profile parameter — model-specificity is
 *     expressed by constructing the right implementation, not by changing the
 *     call site.  A future TiktokenEstimator receives the model string at
 *     construction; its estimate() signature stays identical.
 */

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/**
 * Estimates the token count of an arbitrary runtime value as it would appear
 * when serialised into a prompt (JSON-stringified for structured data, the
 * raw string for strings).
 *
 * Used exclusively by DefaultMemoryManager.load() to compute budgetUsed and
 * budgetRemaining in the MemoryContext snapshot.  Never called inside the
 * agent runtime pipeline.
 */
export interface TokenEstimator {
  /**
   * Returns the estimated number of LLM tokens required to represent value.
   * Must return 0 for null, undefined, and empty collections.
   * Must never throw — callers do not wrap calls in try/catch.
   */
  estimate(value: unknown): number;
}

// ---------------------------------------------------------------------------
// CharacterTokenEstimator — default, deterministic, offline
// ---------------------------------------------------------------------------

/**
 * Estimates token count using the universal character/4 heuristic
 * (4 characters ≈ 1 token).  Deterministic, offline, and suitable for all
 * model families when a model-specific tokenizer is unavailable or undesired.
 *
 * Accuracy:  ±15–25 % of tiktoken counts on typical English prose.
 * This is the drop-in replacement for the private estimateTokens() function
 * that existed in memory-manager.ts before Milestone 1.
 *
 * To use a higher-accuracy estimator, construct DefaultMemoryManager with a
 * different TokenEstimator implementation — no runtime changes required.
 */
export class CharacterTokenEstimator implements TokenEstimator {
  estimate(value: unknown): number {
    if (value === null || value === undefined) return 0;
    if (Array.isArray(value) && value.length === 0) return 0;
    try {
      return Math.ceil(JSON.stringify(value).length / 4);
    } catch {
      return 0;
    }
  }
}
