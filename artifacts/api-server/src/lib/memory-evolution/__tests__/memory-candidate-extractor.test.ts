import { describe, it, expect } from "vitest";
import { extractCandidates } from "../memory-candidate-extractor.js";
import type { ReflectionResult } from "../../reflection/reflection-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(overrides: Partial<ReflectionResult> = {}): ReflectionResult {
  return Object.freeze({
    reflectionId: "r1",
    executionId: "exec-1",
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
// extractCandidates
// ---------------------------------------------------------------------------

describe("extractCandidates", () => {
  const TOOL = "qrcode";
  const EXEC = "exec-1";

  it("returns [] when analyzed is false", () => {
    const result = makeResult({ analyzed: false, quality: "poor", confidenceAlignment: "low" });
    expect(extractCandidates(result, TOOL, EXEC)).toHaveLength(0);
  });

  it("returns [] for neutral/neutral/acceptable with no issues", () => {
    expect(extractCandidates(makeResult(), TOOL, EXEC)).toHaveLength(0);
  });

  // --- reliable ------------------------------------------------------------

  it("emits 'reliable' candidate for good quality + high confidence alignment", () => {
    const candidates = extractCandidates(
      makeResult({ quality: "good", confidenceAlignment: "high" }),
      TOOL,
      EXEC,
    );
    const reliable = candidates.find((c) => c.key === `tool.${TOOL}.reliable`);
    expect(reliable).toBeDefined();
    expect(reliable!.category).toBe("fact");
    expect(reliable!.confidence).toBeGreaterThan(0.7);
    expect(reliable!.source).toBe("reflection");
    expect(reliable!.sourceTool).toBe(TOOL);
    expect(reliable!.sourceExecutionId).toBe(EXEC);
  });

  it("does NOT emit 'reliable' for good quality + neutral alignment", () => {
    const candidates = extractCandidates(
      makeResult({ quality: "good", confidenceAlignment: "neutral" }),
      TOOL,
      EXEC,
    );
    expect(candidates.find((c) => c.key.includes("reliable"))).toBeUndefined();
  });

  // --- failure_pattern -----------------------------------------------------

  it("emits 'failure_pattern' when issues includes execution_failure", () => {
    const candidates = extractCandidates(
      makeResult({ quality: "poor", issues: ["execution_failure"] }),
      TOOL,
      EXEC,
    );
    const fp = candidates.find((c) => c.key === `tool.${TOOL}.failure_pattern`);
    expect(fp).toBeDefined();
    expect(fp!.importance).toBeGreaterThanOrEqual(0.75);
  });

  // --- overconfidence_risk -------------------------------------------------

  it("emits 'overconfidence_risk' when issues includes over_confident_failure", () => {
    const candidates = extractCandidates(
      makeResult({
        quality: "poor",
        confidenceAlignment: "low",
        issues: ["execution_failure", "over_confident_failure"],
      }),
      TOOL,
      EXEC,
    );
    expect(candidates.find((c) => c.key === `tool.${TOOL}.overconfidence_risk`)).toBeDefined();
  });

  // --- underconfidence_pattern ---------------------------------------------

  it("emits 'underconfidence_pattern' when issues includes under_confident_success", () => {
    const candidates = extractCandidates(
      makeResult({ quality: "poor", issues: ["under_confident_success"] }),
      TOOL,
      EXEC,
    );
    expect(candidates.find((c) => c.key === `tool.${TOOL}.underconfidence_pattern`)).toBeDefined();
  });

  // --- latency_concern -----------------------------------------------------

  it("emits 'latency_concern' when latency is high", () => {
    const candidates = extractCandidates(
      makeResult({ quality: "poor", latency: "high", issues: ["high_latency"] }),
      TOOL,
      EXEC,
    );
    const lc = candidates.find((c) => c.key === `tool.${TOOL}.latency_concern`);
    expect(lc).toBeDefined();
    expect(lc!.category).toBe("context");
  });

  // --- multiple candidates -------------------------------------------------

  it("emits multiple candidates from a single high-signal ReflectionResult", () => {
    const candidates = extractCandidates(
      makeResult({
        quality: "poor",
        confidenceAlignment: "low",
        latency: "high",
        issues: ["execution_failure", "over_confident_failure", "high_latency"],
      }),
      TOOL,
      EXEC,
    );
    // failure_pattern + overconfidence_risk + latency_concern = 3
    expect(candidates.length).toBeGreaterThanOrEqual(3);
    const keys = candidates.map((c) => c.key);
    expect(keys).toContain(`tool.${TOOL}.failure_pattern`);
    expect(keys).toContain(`tool.${TOOL}.overconfidence_risk`);
    expect(keys).toContain(`tool.${TOOL}.latency_concern`);
  });

  // --- candidate shape -----------------------------------------------------

  it("produces deep-frozen candidates with unique IDs", () => {
    const candidates = extractCandidates(
      makeResult({ quality: "good", confidenceAlignment: "high" }),
      TOOL,
      EXEC,
    );
    expect(candidates.length).toBeGreaterThan(0);
    const c = candidates[0]!;
    expect(Object.isFrozen(c)).toBe(true);
    expect(c.candidateId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("uses the supplied toolName in the key and tags", () => {
    const candidates = extractCandidates(
      makeResult({ quality: "good", confidenceAlignment: "high" }),
      "url_shortener",
      EXEC,
    );
    expect(candidates[0]!.key).toContain("url_shortener");
    expect(candidates[0]!.tags).toContain("url_shortener");
  });
});
