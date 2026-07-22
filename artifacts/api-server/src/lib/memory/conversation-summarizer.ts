/**
 * Phase 3C — ConversationSummarizer abstraction (ADR-005, Milestone 2)
 *
 * Provides a deterministic, injectable seam for extractive conversation
 * summarisation inside DefaultMemoryManager.load().
 *
 * When the fetched conversation history exceeds the token budget allocated
 * to the conversation tier, the oldest turns are evicted and this interface
 * is called to produce a single replacement summary turn that preserves the
 * semantic gist of the dropped context without exceeding the budget.
 *
 * Design constraints (ADR-005 §9.4):
 *   - summarize() must be synchronous and free of side-effects
 *   - summarize() must be deterministic: equal inputs yield equal outputs
 *   - No implementation may make network calls or call the LLM
 *   - The summary string will be wrapped in a ConversationTurn by the caller;
 *     this interface returns the raw content string only
 *   - An empty turns array must be handled gracefully (returns empty string)
 */

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

import type { ConversationTurn } from "./types.js";

/**
 * Produces a single extractive summary string representing a slice of
 * conversation turns that have been evicted from the context window.
 *
 * Called exclusively by DefaultMemoryManager.load() when the conversation
 * tier budget is exceeded and the oldest turns must be dropped.
 * The returned string becomes the `content` of a synthetic ConversationTurn
 * prepended to the trimmed conversation before it is frozen into MemoryContext.
 */
export interface ConversationSummarizer {
  /**
   * Summarises the given turns into a single descriptive string.
   * Must return an empty string when turns is empty.
   * Must never throw.
   */
  summarize(turns: readonly ConversationTurn[]): string;
}

// ---------------------------------------------------------------------------
// Stop-word list (minimal, English-only)
// ---------------------------------------------------------------------------

/**
 * Common English words excluded from keyword extraction.
 * Kept intentionally small — the goal is to surface content words, not
 * produce perfect NLP.  Deterministic and offline.
 */
const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "in", "on", "at", "to",
  "for", "of", "with", "by", "from", "up", "about", "into", "through",
  "is", "are", "was", "were", "be", "been", "being", "have", "has", "had",
  "do", "does", "did", "will", "would", "could", "should", "may", "might",
  "shall", "can", "need", "dare", "ought", "used", "it", "its", "this",
  "that", "these", "those", "i", "you", "he", "she", "we", "they", "me",
  "him", "her", "us", "them", "my", "your", "his", "our", "their",
  "what", "which", "who", "whom", "when", "where", "why", "how",
  "not", "no", "nor", "so", "yet", "both", "either", "neither",
  "just", "also", "very", "too", "quite", "rather", "well", "now",
  "then", "there", "here", "more", "most", "much", "many", "some", "any",
  "all", "each", "every", "few", "less", "other", "such", "own", "same",
]);

/** Maximum number of topic keywords to include in the summary. */
const MAX_KEYWORDS = 5;

/** Minimum word length to consider as a potential keyword. */
const MIN_KEYWORD_LENGTH = 3;

// ---------------------------------------------------------------------------
// ExtractiveConversationSummarizer — default, deterministic, offline
// ---------------------------------------------------------------------------

/**
 * Produces a compact, human-readable summary of evicted conversation turns
 * using deterministic extractive compression.
 *
 * Algorithm:
 *   1. Count turns and split by role.
 *   2. Derive timestamp range from first and last turns.
 *   3. Tokenise all turn content into lowercase words; remove stop words
 *      and short words; count frequency.
 *   4. Pick the top-N words by frequency (ties broken alphabetically for
 *      determinism) as topic keywords.
 *   5. Format into a stable bracketed summary string.
 *
 * Output example:
 *   [Context summary: 6 turns (user×3, assistant×3) | topics: food, plans,
 *    weather]
 *
 * The output is stable: given the same input array the output is always
 * identical, regardless of execution environment or call order.
 */
export class ExtractiveConversationSummarizer implements ConversationSummarizer {
  summarize(turns: readonly ConversationTurn[]): string {
    if (turns.length === 0) return "";

    // -- Role distribution ------------------------------------------------
    let userCount = 0;
    let assistantCount = 0;
    for (const t of turns) {
      if (t.role === "user") userCount++;
      else assistantCount++;
    }

    // -- Timestamp range --------------------------------------------------
    // turns are in chronological order when this is called
    const firstTs = turns[0]!.timestamp;
    const lastTs  = turns[turns.length - 1]!.timestamp;
    const rangeStr = firstTs === lastTs
      ? `t=${firstTs}`
      : `t=${firstTs}–${lastTs}`;

    // -- Keyword extraction -----------------------------------------------
    const freq = new Map<string, number>();
    for (const turn of turns) {
      const words = turn.content
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/);
      for (const word of words) {
        if (word.length >= MIN_KEYWORD_LENGTH && !STOP_WORDS.has(word)) {
          freq.set(word, (freq.get(word) ?? 0) + 1);
        }
      }
    }

    // Sort: descending frequency, then ascending alpha for determinism
    const keywords = [...freq.entries()]
      .sort(([a, fa], [b, fb]) => fb - fa || a.localeCompare(b))
      .slice(0, MAX_KEYWORDS)
      .map(([word]) => word);

    // -- Format -----------------------------------------------------------
    const rolePart = `user×${userCount}, assistant×${assistantCount}`;
    const topicPart = keywords.length > 0 ? ` | topics: ${keywords.join(", ")}` : "";
    return `[Context summary: ${turns.length} turns (${rolePart}), ${rangeStr}${topicPart}]`;
  }
}
