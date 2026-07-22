/**
 * Phase 3C — RelevanceScorer abstraction (ADR-005, Milestone 3)
 *
 * Provides a deterministic, injectable scoring function used by
 * InMemoryStorageProvider.list() when ListOptions.similarityQuery is set.
 *
 * The interface is intentionally minimal so that future implementations
 * (BM25, TF-IDF, embedding cosine similarity, hybrid retrieval, etc.) can
 * replace the scorer at composition time without touching MemoryManager,
 * StorageProvider, or route orchestration — preserving ADR-005 intact while
 * the architecture prepares for ADR-006.
 *
 * Design constraints:
 *   - score() must be synchronous and free of side-effects
 *   - score() must be deterministic: equal inputs yield equal scores
 *   - score() must return a value in [0.0, 1.0]
 *   - score() must return 0.0 when either argument is empty
 *   - No implementation may make network calls, read files, or call an LLM
 */

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/**
 * Scores the relevance of a content string against a query string.
 *
 * Used by InMemoryStorageProvider.list() to rank stored items when
 * ListOptions.similarityQuery is present.  The provider calls score()
 * once per item with the query and the item's searchable string, then sorts
 * descending by score (ties preserve insertion order for determinism).
 */
export interface RelevanceScorer {
  /**
   * Returns a relevance score in [0.0, 1.0].
   * 1.0 = perfect match, 0.0 = no overlap.
   * Must never throw.  Must return 0.0 for empty query or content.
   */
  score(query: string, content: string): number;
}

// ---------------------------------------------------------------------------
// Tokeniser — shared by all text-based implementations
// ---------------------------------------------------------------------------

/**
 * Splits text into a set of lowercase alphanumeric tokens (≥ 2 characters).
 * Deterministic: equal inputs always produce equal token sets.
 *
 * Examples:
 *   "Hello, World!" → Set { "hello", "world" }
 *   "user_name 123" → Set { "user", "name", "123" }
 */
export function tokenise(text: string): Set<string> {
  const tokens = new Set<string>();
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9]+/);
  for (const word of words) {
    if (word.length >= 2) {
      tokens.add(word);
    }
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// TermOverlapRelevanceScorer — default, deterministic, offline
// ---------------------------------------------------------------------------

/**
 * Scores relevance using the Jaccard coefficient over word token sets:
 *
 *   score = |queryTokens ∩ contentTokens| / |queryTokens ∪ contentTokens|
 *
 * Properties:
 *   - Range: [0.0, 1.0]
 *   - 1.0 only when query and content tokenise to identical sets
 *   - 0.0 when either produces an empty token set
 *   - Symmetric: score(a, b) === score(b, a)
 *   - Deterministic: no randomness, no external state
 *   - Offline: pure in-process computation
 *
 * Accuracy trade-offs:
 *   - Does not account for term frequency or document length
 *   - Order-insensitive (bag-of-words)
 *   - No stemming or lemmatisation
 *   These are acceptable for a Phase 3C default; a future BM25 or embedding
 *   scorer can replace this without any interface change.
 */
export class TermOverlapRelevanceScorer implements RelevanceScorer {
  score(query: string, content: string): number {
    if (!query || !content) return 0.0;

    const qTokens = tokenise(query);
    const cTokens = tokenise(content);

    if (qTokens.size === 0 || cTokens.size === 0) return 0.0;

    // Intersection: tokens present in both sets
    let intersectionSize = 0;
    for (const token of qTokens) {
      if (cTokens.has(token)) intersectionSize++;
    }

    // Union: total unique tokens across both sets
    const unionSize = qTokens.size + cTokens.size - intersectionSize;

    return unionSize === 0 ? 0.0 : intersectionSize / unionSize;
  }
}
