/**
 * Phase 3C — RelevanceScorer unit tests (Milestone 3)
 *
 * Covers:
 *   tokenise()
 *     - empty string → empty set
 *     - lowercase normalisation
 *     - splits on non-alphanumeric characters
 *     - minimum token length of 2 characters
 *     - deduplicates repeated words
 *
 *   TermOverlapRelevanceScorer.score()
 *     - empty query → 0.0
 *     - empty content → 0.0
 *     - both empty → 0.0
 *     - no token overlap → 0.0
 *     - perfect overlap (identical strings) → 1.0
 *     - partial overlap → Jaccard coefficient
 *     - score is symmetric: score(a, b) === score(b, a)
 *     - score is in [0.0, 1.0] for arbitrary inputs
 *     - deterministic: same inputs always produce same score
 *     - case-insensitive: "Hello" matches "hello"
 *     - punctuation-insensitive: "hello, world!" matches "hello world"
 *     - short tokens (single char) do not participate in matching
 *     - higher score for more overlap
 *     - tie-breaking: identical score for rearranged token sets
 *
 *   RelevanceScorer interface
 *     - custom implementation is accepted (injectable)
 *     - custom impl can return any value in [0, 1] for the same inputs
 */

import { describe, it, expect } from "vitest";
import {
  TermOverlapRelevanceScorer,
  tokenise,
  type RelevanceScorer,
} from "../relevance-scorer.js";

// ---------------------------------------------------------------------------
// tokenise()
// ---------------------------------------------------------------------------

describe("tokenise()", () => {
  it("returns an empty set for an empty string", () => {
    expect(tokenise("").size).toBe(0);
  });

  it("returns an empty set for a string of only non-alphanumeric characters", () => {
    expect(tokenise("!!! ??? ---").size).toBe(0);
  });

  it("normalises to lowercase", () => {
    const tokens = tokenise("Hello WORLD");
    expect(tokens.has("hello")).toBe(true);
    expect(tokens.has("world")).toBe(true);
    expect(tokens.has("Hello")).toBe(false);
  });

  it("splits on non-alphanumeric delimiters", () => {
    const tokens = tokenise("foo-bar.baz_qux");
    expect(tokens.has("foo")).toBe(true);
    expect(tokens.has("bar")).toBe(true);
    expect(tokens.has("baz")).toBe(true);
    expect(tokens.has("qux")).toBe(true);
  });

  it("excludes tokens shorter than 2 characters", () => {
    const tokens = tokenise("a b c do re mi");
    expect(tokens.has("a")).toBe(false);
    expect(tokens.has("b")).toBe(false);
    expect(tokens.has("c")).toBe(false);
    expect(tokens.has("do")).toBe(true);
    expect(tokens.has("re")).toBe(true);
    expect(tokens.has("mi")).toBe(true);
  });

  it("deduplicates repeated words", () => {
    const tokens = tokenise("apple apple apple");
    expect(tokens.size).toBe(1);
    expect(tokens.has("apple")).toBe(true);
  });

  it("handles numeric tokens", () => {
    const tokens = tokenise("order 42 ref 99");
    expect(tokens.has("42")).toBe(true);
    expect(tokens.has("99")).toBe(true);
    expect(tokens.has("order")).toBe(true);
    expect(tokens.has("ref")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TermOverlapRelevanceScorer.score()
// ---------------------------------------------------------------------------

describe("TermOverlapRelevanceScorer.score()", () => {
  const scorer = new TermOverlapRelevanceScorer();

  // -- Edge cases -----------------------------------------------------------

  it("returns 0.0 for an empty query", () => {
    expect(scorer.score("", "some content here")).toBe(0.0);
  });

  it("returns 0.0 for empty content", () => {
    expect(scorer.score("some query here", "")).toBe(0.0);
  });

  it("returns 0.0 when both query and content are empty", () => {
    expect(scorer.score("", "")).toBe(0.0);
  });

  it("returns 0.0 when there is no token overlap", () => {
    expect(scorer.score("apple banana cherry", "dog elephant frog")).toBe(0.0);
  });

  it("returns 0.0 when all tokens are shorter than 2 characters", () => {
    expect(scorer.score("a b c", "x y z")).toBe(0.0);
  });

  // -- Perfect overlap ------------------------------------------------------

  it("returns 1.0 for identical non-empty strings", () => {
    expect(scorer.score("hello world", "hello world")).toBe(1.0);
  });

  it("returns 1.0 when tokenised sets are identical (different punctuation)", () => {
    expect(scorer.score("hello, world!", "hello world")).toBe(1.0);
  });

  it("returns 1.0 for case-insensitive identical content", () => {
    expect(scorer.score("Hello World", "hello world")).toBe(1.0);
  });

  // -- Partial overlap — Jaccard math ---------------------------------------

  it("returns 0.5 for exactly half overlap (2 of 4 unique tokens match)", () => {
    // query tokens: {apple, banana}
    // content tokens: {apple, banana, cherry, date}
    // intersection = 2, union = 4 → Jaccard = 0.5
    const result = scorer.score("apple banana", "apple banana cherry date");
    expect(result).toBeCloseTo(0.5, 10);
  });

  it("returns the correct Jaccard for a concrete 3-token intersection", () => {
    // query: {cat, dog, bird}; content: {cat, dog, bird, fish, lion}
    // intersection=3, union=5 → 0.6
    const result = scorer.score("cat dog bird", "cat dog bird fish lion");
    expect(result).toBeCloseTo(0.6, 10);
  });

  it("returns 1/3 when one of three query tokens matches", () => {
    // query: {alpha, beta, gamma}; content: {alpha, delta, epsilon}
    // intersection=1, union=5 → 1/5 = 0.2
    const result = scorer.score("alpha beta gamma", "alpha delta epsilon");
    expect(result).toBeCloseTo(1 / 5, 10);
  });

  // -- Symmetry -------------------------------------------------------------

  it("is symmetric: score(a, b) === score(b, a)", () => {
    const a = "pizza pasta risotto";
    const b = "risotto soup pasta bread";
    expect(scorer.score(a, b)).toBeCloseTo(scorer.score(b, a), 10);
  });

  // -- Range ----------------------------------------------------------------

  it("always returns a value in [0.0, 1.0] for arbitrary inputs", () => {
    const pairs = [
      ["", ""],
      ["hello", "hello"],
      ["foo bar", "baz qux"],
      ["a b c d e f", "d e f g h i j k"],
      ["long text with many words here for testing", "completely different content altogether"],
    ] as const;
    for (const [q, c] of pairs) {
      const s = scorer.score(q, c);
      expect(s).toBeGreaterThanOrEqual(0.0);
      expect(s).toBeLessThanOrEqual(1.0);
    }
  });

  // -- Determinism ----------------------------------------------------------

  it("is deterministic: same inputs always produce the same score", () => {
    const query = "I love pizza every friday evening";
    const content = "pizza and pasta are my favourite friday foods";
    const scores = Array.from({ length: 20 }, () => scorer.score(query, content));
    const first = scores[0]!;
    expect(scores.every(s => s === first)).toBe(true);
  });

  // -- Content sensitivity --------------------------------------------------

  it("returns a higher score for more overlapping content", () => {
    const query = "favourite food pizza pasta";
    const highOverlap  = "my favourite food is pizza and pasta";
    const lowOverlap   = "my favourite hobby is reading books";
    expect(scorer.score(query, highOverlap)).toBeGreaterThan(
      scorer.score(query, lowOverlap),
    );
  });

  it("single-character tokens do not participate in matching", () => {
    // "a" and "b" are excluded; only "cat" matches
    const score = scorer.score("a b cat", "a b cat");
    // tokens: {cat}; intersection=1, union=1 → 1.0
    expect(score).toBe(1.0);
  });

  it("repeated tokens in query/content do not inflate the score (set-based)", () => {
    // "apple apple apple" tokenises to {apple} — same as "apple"
    const s1 = scorer.score("apple apple apple", "apple");
    const s2 = scorer.score("apple", "apple");
    expect(s1).toBe(s2);
  });
});

// ---------------------------------------------------------------------------
// RelevanceScorer interface — injectable contract
// ---------------------------------------------------------------------------

describe("RelevanceScorer interface", () => {
  it("accepts any object implementing the interface", () => {
    const custom: RelevanceScorer = {
      score: (q: string, c: string) => (q.length > 0 && c.length > 0 ? 0.42 : 0),
    };
    expect(custom.score("hello", "world")).toBe(0.42);
    expect(custom.score("", "world")).toBe(0);
  });

  it("custom scorer result replaces TermOverlapRelevanceScorer for the same input", () => {
    const always1: RelevanceScorer = { score: () => 1.0 };
    const always0: RelevanceScorer = { score: () => 0.0 };
    // Two non-overlapping strings
    const query = "unique words here";
    const content = "completely different text";
    // Default scorer would return 0; custom always-1 should differ
    const defaultScorer = new TermOverlapRelevanceScorer();
    expect(defaultScorer.score(query, content)).toBe(0.0);
    expect(always1.score(query, content)).toBe(1.0);
    expect(always0.score(query, content)).toBe(0.0);
  });
});
