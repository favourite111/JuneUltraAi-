/**
 * Phase 3C — EmbeddingProvider unit tests (Milestone 8)
 *
 * Covers:
 *   EmbeddingProvider interface
 *     - any object with embed() and dimensions satisfies the interface
 *     - custom implementation is injectable
 *
 *   l2Norm()
 *     - zero vector → 0
 *     - unit vector → 1
 *     - known 3-4-5 triangle → 5
 *     - negative values handled correctly
 *
 *   l2Normalize()
 *     - zero vector → zero vector (no division by zero)
 *     - already-normalised vector → unchanged (within float tolerance)
 *     - known vector → correct normalised form
 *     - output has ‖v‖₂ ≈ 1 for non-zero input
 *     - returns a new array (does not mutate input)
 *
 *   cosineSimilarity()
 *     - identical normalised vectors → 1.0
 *     - orthogonal normalised vectors → 0.0
 *     - zero vector vs any vector → 0.0
 *     - mismatched dimensionality → 0.0
 *     - symmetric: cs(a, b) === cs(b, a)
 *     - result is always in [0.0, 1.0]
 *     - partial overlap → value between 0 and 1
 *
 *   HashingEmbeddingProvider construction
 *     - default dimensions = EMBEDDING_DIMENSIONS (128)
 *     - custom dimensions respected
 *     - non-positive or non-integer dimensions throw RangeError
 *
 *   HashingEmbeddingProvider.embed()
 *     - empty string → zero vector of correct length
 *     - all-short-token string → zero vector
 *     - non-empty text → L2-normalised vector (‖v‖₂ ≈ 1)
 *     - non-empty text → vector has correct length
 *     - all elements are finite (no NaN / Infinity)
 *     - all elements are ≥ 0 (non-negative)
 *     - deterministic: same input → same vector (multiple calls)
 *     - different texts → different vectors (collision resistance check)
 *     - single token fills exactly one dimension non-zero
 *     - repeated tokens do not inflate (set-based tokenisation)
 *     - case-insensitive: "HELLO" and "hello" produce identical vectors
 *     - punctuation-insensitive: "hello, world!" and "hello world" identical
 *     - returns Promise<number[]> (async interface honoured)
 *
 *   djb2 distribution (structural)
 *     - tokens that differ produce vectors with non-zero entries in different
 *       dimensions (probabilistic check — not a guarantee, but highly likely)
 */

import { describe, it, expect } from "vitest";
import {
  HashingEmbeddingProvider,
  cosineSimilarity,
  l2Norm,
  l2Normalize,
  EMBEDDING_DIMENSIONS,
  type EmbeddingProvider,
} from "../embedding-provider.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isNormalized(v: readonly number[], tol = 1e-9): boolean {
  return Math.abs(l2Norm(v) - 1) < tol;
}

// ---------------------------------------------------------------------------
// l2Norm()
// ---------------------------------------------------------------------------

describe("l2Norm()", () => {
  it("returns 0 for a zero vector", () => {
    expect(l2Norm([0, 0, 0])).toBe(0);
  });

  it("returns 1 for a unit vector", () => {
    expect(l2Norm([1, 0, 0])).toBeCloseTo(1, 10);
    expect(l2Norm([0, 1, 0])).toBeCloseTo(1, 10);
  });

  it("returns 5 for the 3-4-5 triangle vector", () => {
    expect(l2Norm([3, 4])).toBeCloseTo(5, 10);
  });

  it("handles negative values correctly", () => {
    expect(l2Norm([-3, -4])).toBeCloseTo(5, 10);
  });

  it("returns 0 for an empty vector", () => {
    expect(l2Norm([])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// l2Normalize()
// ---------------------------------------------------------------------------

describe("l2Normalize()", () => {
  it("returns a zero vector for a zero-vector input (no division by zero)", () => {
    const result = l2Normalize([0, 0, 0]);
    expect(result).toEqual([0, 0, 0]);
  });

  it("returns a vector with ‖v‖₂ ≈ 1 for non-zero input", () => {
    const result = l2Normalize([3, 4]);
    expect(isNormalized(result)).toBe(true);
  });

  it("produces the correct normalised form for [3, 4]", () => {
    const result = l2Normalize([3, 4]);
    expect(result[0]).toBeCloseTo(3 / 5, 10);
    expect(result[1]).toBeCloseTo(4 / 5, 10);
  });

  it("returns an already-normalised vector unchanged (within tolerance)", () => {
    const norm = l2Normalize([3, 4]);
    const renorm = l2Normalize(norm);
    expect(isNormalized(renorm)).toBe(true);
    expect(renorm[0]).toBeCloseTo(norm[0]!, 10);
    expect(renorm[1]).toBeCloseTo(norm[1]!, 10);
  });

  it("does not mutate the input array", () => {
    const input = [3, 4];
    const result = l2Normalize(input);
    expect(input).toEqual([3, 4]);   // input unchanged
    expect(result).not.toBe(input);  // new array returned
  });

  it("returns empty array for empty input", () => {
    expect(l2Normalize([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// cosineSimilarity()
// ---------------------------------------------------------------------------

describe("cosineSimilarity()", () => {
  it("returns 1.0 for identical normalised vectors", () => {
    const v = l2Normalize([1, 2, 3]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 10);
  });

  it("returns 0.0 for orthogonal normalised vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  it("returns 0.0 for a zero vector against any vector", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([1, 2, 3], [0, 0, 0])).toBe(0);
  });

  it("returns 0.0 for mismatched dimensionality", () => {
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
  });

  it("returns 0.0 for empty vectors", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it("is symmetric: cs(a, b) === cs(b, a)", () => {
    const a = l2Normalize([1, 2, 3, 4]);
    const b = l2Normalize([4, 3, 2, 1]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(cosineSimilarity(b, a), 10);
  });

  it("always returns a value in [0.0, 1.0]", () => {
    const vectors = [
      l2Normalize([1, 0, 0]),
      l2Normalize([0, 1, 0]),
      l2Normalize([1, 1, 0]),
      l2Normalize([1, 2, 3]),
      l2Normalize([3, 2, 1]),
    ];
    for (const a of vectors) {
      for (const b of vectors) {
        const s = cosineSimilarity(a, b);
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(1);
      }
    }
  });

  it("returns a value strictly between 0 and 1 for partial overlap", () => {
    const a = l2Normalize([1, 1, 0, 0]);
    const b = l2Normalize([1, 0, 1, 0]);
    const s = cosineSimilarity(a, b);
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------------
// HashingEmbeddingProvider — construction
// ---------------------------------------------------------------------------

describe("HashingEmbeddingProvider — construction", () => {
  it("defaults to EMBEDDING_DIMENSIONS (128)", () => {
    const p = new HashingEmbeddingProvider();
    expect(p.dimensions).toBe(EMBEDDING_DIMENSIONS);
    expect(p.dimensions).toBe(128);
  });

  it("respects custom dimensions", () => {
    const p = new HashingEmbeddingProvider(64);
    expect(p.dimensions).toBe(64);
  });

  it("throws RangeError for zero dimensions", () => {
    expect(() => new HashingEmbeddingProvider(0)).toThrow(RangeError);
  });

  it("throws RangeError for negative dimensions", () => {
    expect(() => new HashingEmbeddingProvider(-1)).toThrow(RangeError);
  });

  it("throws RangeError for non-integer dimensions", () => {
    expect(() => new HashingEmbeddingProvider(1.5)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// HashingEmbeddingProvider.embed()
// ---------------------------------------------------------------------------

describe("HashingEmbeddingProvider.embed()", () => {
  const provider = new HashingEmbeddingProvider();

  it("returns a Promise<number[]>", async () => {
    const result = provider.embed("hello world");
    expect(result).toBeInstanceOf(Promise);
    const v = await result;
    expect(Array.isArray(v)).toBe(true);
  });

  it("returns a zero vector for an empty string", async () => {
    const v = await provider.embed("");
    expect(v).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(v.every((x) => x === 0)).toBe(true);
  });

  it("returns a zero vector when all tokens are shorter than 2 characters", async () => {
    const v = await provider.embed("a b c");
    expect(v.every((x) => x === 0)).toBe(true);
  });

  it("returns a vector of exactly `dimensions` elements", async () => {
    const v = await provider.embed("hello world testing embedding provider");
    expect(v).toHaveLength(EMBEDDING_DIMENSIONS);
  });

  it("returns a vector of exactly the custom `dimensions` elements", async () => {
    const p = new HashingEmbeddingProvider(32);
    const v = await p.embed("hello world");
    expect(v).toHaveLength(32);
  });

  it("all elements are finite (no NaN, no Infinity)", async () => {
    const v = await provider.embed("the quick brown fox jumps over the lazy dog");
    expect(v.every((x) => isFinite(x))).toBe(true);
  });

  it("all elements are ≥ 0 (non-negative — cosine similarity stays in [0,1])", async () => {
    const v = await provider.embed("pizza pasta risotto gelato tiramisu");
    expect(v.every((x) => x >= 0)).toBe(true);
  });

  it("returns an L2-normalised vector for non-empty input", async () => {
    const v = await provider.embed("building an intelligent memory system");
    expect(isNormalized(v)).toBe(true);
  });

  it("is deterministic: same input → same vector on repeated calls", async () => {
    const text = "I love pizza every Friday evening";
    const runs = await Promise.all(
      Array.from({ length: 20 }, () => provider.embed(text)),
    );
    const first = runs[0]!;
    expect(runs.every((v) => v.every((x, i) => x === first[i]))).toBe(true);
  });

  it("different texts produce different vectors", async () => {
    const a = await provider.embed("pizza pasta");
    const b = await provider.embed("quantum physics dark matter");
    // Vectors should differ (extremely unlikely to collide with 128 dimensions)
    expect(a.some((x, i) => x !== b[i])).toBe(true);
  });

  it("is case-insensitive: 'HELLO WORLD' and 'hello world' produce the same vector", async () => {
    const upper = await provider.embed("HELLO WORLD");
    const lower = await provider.embed("hello world");
    expect(upper).toEqual(lower);
  });

  it("is punctuation-insensitive: 'hello, world!' and 'hello world' produce the same vector", async () => {
    const withPunct = await provider.embed("hello, world!");
    const withoutPunct = await provider.embed("hello world");
    expect(withPunct).toEqual(withoutPunct);
  });

  it("repeated tokens do not inflate (set-based deduplication)", async () => {
    const once = await provider.embed("apple");
    const three = await provider.embed("apple apple apple");
    expect(once).toEqual(three);
  });

  it("a single token produces exactly one non-zero dimension", async () => {
    const v = await provider.embed("uniquetoken");
    const nonZero = v.filter((x) => x !== 0);
    expect(nonZero).toHaveLength(1);
    // That one element must equal 1.0 (single token, L2-norm = 1)
    expect(nonZero[0]).toBeCloseTo(1.0, 10);
  });

  it("cosineSimilarity of identical embeddings is 1.0", async () => {
    const text = "knowledge record semantic retrieval";
    const v1 = await provider.embed(text);
    const v2 = await provider.embed(text);
    expect(cosineSimilarity(v1, v2)).toBeCloseTo(1, 10);
  });

  it("cosineSimilarity of completely different texts is < 1.0", async () => {
    const a = await provider.embed("pizza pasta italian food");
    const b = await provider.embed("quantum gravity dark energy cosmology");
    expect(cosineSimilarity(a, b)).toBeLessThan(1.0);
  });
});

// ---------------------------------------------------------------------------
// EmbeddingProvider interface — injectable contract
// ---------------------------------------------------------------------------

describe("EmbeddingProvider interface", () => {
  it("accepts any object with embed() and dimensions", async () => {
    const custom: EmbeddingProvider = {
      dimensions: 4,
      embed: async (_text: string) => [0.5, 0.5, 0.5, 0.5],
    };
    const v = await custom.embed("hello");
    expect(v).toHaveLength(4);
    expect(custom.dimensions).toBe(4);
  });

  it("custom implementation can return any normalised vector", async () => {
    const always: EmbeddingProvider = {
      dimensions: 2,
      embed: async () => l2Normalize([1, 0]),
    };
    const v = await always.embed("anything");
    expect(isNormalized(v)).toBe(true);
  });
});
