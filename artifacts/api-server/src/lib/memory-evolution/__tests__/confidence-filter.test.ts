import { describe, it, expect } from "vitest";
import {
  CONFIDENCE_THRESHOLD,
  computeSignalStrength,
  passesConfidenceFilter,
} from "../confidence-filter.js";
import type { ReflectionResult } from "../../reflection/reflection-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(overrides: Partial<ReflectionResult> = {}): ReflectionResult {
  return Object.freeze({
    reflectionId: "r1",
    executionId: "e1",
    analyzed: true,
    quality: "neutral",
    confidenceAlignment: "neutral",
    latency: "acceptable",
    recommendation: "",
    issues: [],
    reflectedAt: Date.now(),
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// computeSignalStrength
// ---------------------------------------------------------------------------

describe("computeSignalStrength", () => {
  it("returns 0 when analyzed is false (regardless of other fields)", () => {
    const result = makeResult({
      analyzed: false,
      quality: "poor",
      confidenceAlignment: "low",
      latency: "high",
      issues: ["execution_failure"],
    });
    expect(computeSignalStrength(result)).toBe(0);
  });

  it("returns 0 for neutral/neutral/acceptable with no issues", () => {
    expect(computeSignalStrength(makeResult())).toBe(0);
  });

  it("adds 0.30 for good quality", () => {
    expect(computeSignalStrength(makeResult({ quality: "good" }))).toBeCloseTo(0.30);
  });

  it("adds 0.40 for poor quality", () => {
    expect(computeSignalStrength(makeResult({ quality: "poor" }))).toBeCloseTo(0.40);
  });

  it("adds 0.30 for high confidence alignment", () => {
    expect(computeSignalStrength(makeResult({ confidenceAlignment: "high" }))).toBeCloseTo(0.30);
  });

  it("adds 0.40 for low confidence alignment", () => {
    expect(computeSignalStrength(makeResult({ confidenceAlignment: "low" }))).toBeCloseTo(0.40);
  });

  it("adds 0.10 for high latency", () => {
    expect(computeSignalStrength(makeResult({ latency: "high" }))).toBeCloseTo(0.10);
  });

  it("adds 0.05 per issue, capped at 0.15 for 3+ issues", () => {
    expect(computeSignalStrength(makeResult({ issues: ["a"] }))).toBeCloseTo(0.05);
    expect(computeSignalStrength(makeResult({ issues: ["a", "b"] }))).toBeCloseTo(0.10);
    expect(computeSignalStrength(makeResult({ issues: ["a", "b", "c"] }))).toBeCloseTo(0.15);
    // 4 issues still caps at 0.15
    expect(computeSignalStrength(makeResult({ issues: ["a", "b", "c", "d"] }))).toBeCloseTo(0.15);
  });

  it("combines all factors correctly for good + high alignment", () => {
    const score = computeSignalStrength(makeResult({ quality: "good", confidenceAlignment: "high" }));
    expect(score).toBeCloseTo(0.60); // 0.30 + 0.30
  });

  it("combines all factors for poor + low alignment (overconfident failure)", () => {
    const score = computeSignalStrength(makeResult({
      quality: "poor",
      confidenceAlignment: "low",
      issues: ["execution_failure", "over_confident_failure"],
    }));
    expect(score).toBeCloseTo(0.90); // 0.40 + 0.40 + 0.10 = 0.90
  });

  it("caps total score at 1.0", () => {
    const score = computeSignalStrength(makeResult({
      quality: "poor",
      confidenceAlignment: "low",
      latency: "high",
      issues: ["a", "b", "c", "d"],
    }));
    expect(score).toBeLessThanOrEqual(1.0);
    expect(score).toBeCloseTo(1.0); // 0.40 + 0.40 + 0.10 + 0.15 = 1.05 → capped
  });
});

// ---------------------------------------------------------------------------
// passesConfidenceFilter
// ---------------------------------------------------------------------------

describe("passesConfidenceFilter", () => {
  it("filters out unanalyzed results", () => {
    expect(passesConfidenceFilter(makeResult({ analyzed: false }))).toBe(false);
  });

  it("filters out neutral/neutral/acceptable with no issues (score = 0)", () => {
    expect(passesConfidenceFilter(makeResult())).toBe(false);
  });

  it(`filters out good/neutral/acceptable (score 0.30 < threshold ${CONFIDENCE_THRESHOLD})`, () => {
    expect(passesConfidenceFilter(makeResult({ quality: "good" }))).toBe(false);
  });

  it("passes poor/neutral/acceptable (score 0.40 ≥ threshold)", () => {
    expect(passesConfidenceFilter(makeResult({ quality: "poor" }))).toBe(true);
  });

  it("passes good/high/acceptable (score 0.60 ≥ threshold)", () => {
    expect(passesConfidenceFilter(makeResult({ quality: "good", confidenceAlignment: "high" }))).toBe(true);
  });

  it("passes good/low/acceptable (under-confident success, score 0.70)", () => {
    expect(passesConfidenceFilter(makeResult({
      quality: "good",
      confidenceAlignment: "low",
      issues: ["under_confident_success"],
    }))).toBe(true);
  });

  it("passes poor/low/acceptable (overconfident failure, score ≥ 0.80)", () => {
    expect(passesConfidenceFilter(makeResult({
      quality: "poor",
      confidenceAlignment: "low",
      issues: ["execution_failure", "over_confident_failure"],
    }))).toBe(true);
  });

  it("filters neutral/neutral/high-latency alone (score 0.10 < threshold)", () => {
    expect(passesConfidenceFilter(makeResult({ latency: "high" }))).toBe(false);
  });

  it("passes good/neutral/high-latency (score 0.40 ≥ threshold)", () => {
    expect(passesConfidenceFilter(makeResult({ quality: "good", latency: "high" }))).toBe(true);
  });
});
