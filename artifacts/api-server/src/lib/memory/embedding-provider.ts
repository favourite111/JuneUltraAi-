/**
 * Phase 3C — EmbeddingProvider abstraction (ADR-005, Milestone 8)
 *
 * Provides a deterministic, injectable text-to-vector embedding function used
 * by KnowledgeManager to coordinate vector indexing and retrieval.
 *
 * The interface is intentionally async so that future implementations backed
 * by remote services (OpenAI embeddings, pgvector, Pinecone, Weaviate) can
 * fulfil it without any interface change — preparing the architecture for
 * ADR-006 without implementing it now.
 *
 * The interface is intentionally minimal. Provider adapters translate their
 * native model response into a fixed-dimensional vector; storage and
 * orchestration policies remain outside this abstraction.
 */

import { tokenise } from "./relevance-scorer.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default output dimensionality for HashingEmbeddingProvider.
 * 128 dimensions balances sparsity, collision rate, and memory.
 * Override at construction time for different trade-offs.
 */
export const EMBEDDING_DIMENSIONS = 128;

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/**
 * Converts a text string into a fixed-length numeric vector.
 *
 * Contract:
 *   - Returns a readonly vector of exactly `dimensions` elements.
 *   - Adapter failures are explicit; callers must not interpret failures as
 *     zero vectors or successful embeddings.
 *
 * Async to accommodate remote and worker-backed providers without changing
 * consumers. Synchronous implementations resolve immediately.
 */
export interface EmbeddingProvider {
  /** Fixed number of dimensions in every vector this provider produces. */
  readonly dimensions: number;
  /** Stable adapter identity used for derived-index compatibility checks. */
  readonly providerId?: string;
  /** Stable model identity used for derived-index compatibility checks. */
  readonly modelId?: string;

  embed(text: string): Promise<readonly number[]>;
}

// ---------------------------------------------------------------------------
// Math utilities
// ---------------------------------------------------------------------------

/**
 * Computes the L2 norm (Euclidean length) of a vector.
 */
export function l2Norm(v: readonly number[]): number {
  let sum = 0;
  for (const x of v) sum += x * x;
  return Math.sqrt(sum);
}

/**
 * Returns a new L2-normalised copy of `v`.
 * Returns a zero vector if ‖v‖ = 0 (prevents division by zero).
 */
export function l2Normalize(v: readonly number[]): number[] {
  const norm = l2Norm(v);
  if (norm === 0) return new Array<number>(v.length).fill(0);
  return Array.from(v, (x) => x / norm);
}

/**
 * Computes cosine similarity between two vectors.
 *
 * The result may be negative for signed vectors. Callers that need a
 * non-negative score must define that policy at the search boundary.
 *
 * Returns 0.0 for mismatched dimensionality or zero vectors.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;

  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
  }

  // Clamp to [0, 1] to guard against floating-point rounding beyond bounds.
  return Math.min(1, Math.max(0, dot));
}

// ---------------------------------------------------------------------------
// HashingEmbeddingProvider — deterministic, offline default
// ---------------------------------------------------------------------------

/**
 * A deterministic, offline `EmbeddingProvider` based on the feature-hashing
 * trick (also known as random projection via hashing).
 *
 * Algorithm:
 *   1. Tokenise the input text (reuses `tokenise()` from relevance-scorer.ts:
 *      lowercase, split on non-alphanumeric, ≥ 2-character tokens, deduplicated).
 *   2. For each token:
 *        a. Compute a 32-bit djb2 hash.
 *        b. Map to dimension index: hash % dimensions.
 *        c. Accumulate count: vector[index] += 1.
 *   3. L2-normalise the resulting vector.
 *
 * Properties:
 *   - Deterministic:    same text → same vector (no randomness).
 *   - Offline:          pure in-process arithmetic; no network or model files.
 *   - Fixed-width:      always returns `dimensions` elements.
 *   - Non-negative:     all elements ≥ 0; cosineSimilarity() ∈ [0, 1].
 *   - Zero-safe:        empty or all-short-token text → zero vector.
 *   - Bag-of-words:     token order is ignored; only presence and frequency matter.
 *
 * Trade-offs accepted for Phase 3C:
 *   - No stemming, no IDF weighting, no positional encoding.
 *   - Hash collisions reduce precision for large vocabularies.
 *   - Future implementations (BM25, TF-IDF, dense embeddings) can replace
 *     this at composition time without changing any other interface.
 */
export class HashingEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;
  readonly providerId = "hashing";
  readonly modelId = "feature-hashing";

  constructor(dimensions: number = EMBEDDING_DIMENSIONS) {
    if (!Number.isInteger(dimensions) || dimensions < 1) {
      throw new RangeError(`dimensions must be a positive integer; got ${dimensions}`);
    }
    this.dimensions = dimensions;
  }

  async embed(text: string): Promise<number[]> {
    if (!text) return new Array<number>(this.dimensions).fill(0);

    const tokens = tokenise(text);
    if (tokens.size === 0) return new Array<number>(this.dimensions).fill(0);

    const raw = new Array<number>(this.dimensions).fill(0);

    for (const token of tokens) {
      const idx = Math.abs(djb2Hash(token)) % this.dimensions;
      raw[idx]! += 1;
    }

    return l2Normalize(raw);
  }
}

// ---------------------------------------------------------------------------
// Hash function — package-private
// ---------------------------------------------------------------------------

/**
 * djb2 hash producing a signed 32-bit integer.
 * Deterministic, fast, good distribution for short tokens.
 * Returns a value in [−2³¹, 2³¹ − 1].
 */
function djb2Hash(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
    // Keep within 32-bit signed integer range.
    hash |= 0;
  }
  return hash;
}
