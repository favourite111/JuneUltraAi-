import { describe, it, expect, beforeEach, vi } from "vitest";
import { createReflectionLayer } from "./reflection.js";
import { ReflectionMetrics } from "./reflection-metrics.js";
import type { ExecutionReflectionInput, ReflectionResult } from "./reflection-types.js";

describe("M23 — ReflectionLayer", () => {
  let mockMetrics: ReflectionMetrics;
  let reflectionLayer: ReturnType<typeof createReflectionLayer>;

  beforeEach(() => {
    mockMetrics = new ReflectionMetrics();
    reflectionLayer = createReflectionLayer({ metrics: mockMetrics });
    vi.spyOn(console, "warn").mockImplementation(() => {}); // Suppress console.warn in tests
  });

  it("should produce a good quality reflection for a successful, low-latency, high-confidence execution", async () => {
    const input: Omit<ExecutionReflectionInput, "reflectionId" | "executionId"> = {
      scope: { tenantId: "test", botId: "test" },
      toolName: "weather_tool",
      success: true,
      durationMs: 100,
      confidenceAtSelection: 0.9,
      executedAt: Date.now(),
    };

    const result = await reflectionLayer.reflect(input);

    expect(result.analyzed).toBe(true);
    expect(result.quality).toBe("good");
    expect(result.confidenceAlignment).toBe("high");
    expect(result.latency).toBe("acceptable");
    expect(result.recommendation).toContain("Continue using weather_tool tool.");
    expect(result.issues).toEqual([]);
    expect(result.reflectionId).toBeTypeOf("string");
    expect(result.executionId).toBeTypeOf("string");

    const metricsSnapshot = mockMetrics.snapshot();
    expect(metricsSnapshot.reflection_calls).toBe(1);
    expect(metricsSnapshot.reflections_analyzed).toBe(1);
    expect(metricsSnapshot.reflections_failed).toBe(0);
    expect(metricsSnapshot.average_quality_score).toBe(1);
    expect(metricsSnapshot.average_confidence_alignment).toBe(1);
  });

  it("should produce a poor quality reflection for a failed, high-confidence execution (over-confident failure)", async () => {
    const input: Omit<ExecutionReflectionInput, "reflectionId" | "executionId"> = {
      scope: { tenantId: "test", botId: "test" },
      toolName: "payment_tool",
      success: false,
      durationMs: 50,
      confidenceAtSelection: 0.8,
      executedAt: Date.now(),
    };

    const result = await reflectionLayer.reflect(input);

    expect(result.analyzed).toBe(true);
    expect(result.quality).toBe("poor");
    expect(result.confidenceAlignment).toBe("low");
    expect(result.latency).toBe("acceptable");
    expect(result.recommendation).toContain("Review payment_tool due to: execution_failure, over_confident_failure.");
    expect(result.issues).toContain("execution_failure");
    expect(result.issues).toContain("over_confident_failure");

    const metricsSnapshot = mockMetrics.snapshot();
    expect(metricsSnapshot.reflection_calls).toBe(1);
    expect(metricsSnapshot.reflections_analyzed).toBe(1);
    expect(metricsSnapshot.reflections_failed).toBe(0);
    expect(metricsSnapshot.average_quality_score).toBe(-1);
    expect(metricsSnapshot.average_confidence_alignment).toBe(-1);
  });

  it("should produce a poor quality reflection for a successful, low-confidence execution (under-confident success)", async () => {
    const input: Omit<ExecutionReflectionInput, "reflectionId" | "executionId"> = {
      scope: { tenantId: "test", botId: "test" },
      toolName: "search_tool",
      success: true,
      durationMs: 150,
      confidenceAtSelection: 0.3,
      executedAt: Date.now(),
    };

    const result = await reflectionLayer.reflect(input);

    expect(result.analyzed).toBe(true);
    expect(result.quality).toBe("poor");
    expect(result.confidenceAlignment).toBe("low");
    expect(result.latency).toBe("acceptable");
    expect(result.recommendation).toContain("Review search_tool due to: under_confident_success.");
    expect(result.issues).toContain("under_confident_success");

    const metricsSnapshot = mockMetrics.snapshot();
    expect(metricsSnapshot.reflection_calls).toBe(1);
    expect(metricsSnapshot.reflections_analyzed).toBe(1);
    expect(metricsSnapshot.reflections_failed).toBe(0);
    expect(metricsSnapshot.average_quality_score).toBe(-1);
    expect(metricsSnapshot.average_confidence_alignment).toBe(-1);
  });

  it("should produce a poor quality reflection for a high-latency execution", async () => {
    const input: Omit<ExecutionReflectionInput, "reflectionId" | "executionId"> = {
      scope: { tenantId: "test", botId: "test" },
      toolName: "data_fetch_tool",
      success: true,
      durationMs: 1200,
      confidenceAtSelection: 0.7,
      executedAt: Date.now(),
    };

    const result = await reflectionLayer.reflect(input);

    expect(result.analyzed).toBe(true);
    expect(result.quality).toBe("poor");
    expect(result.confidenceAlignment).toBe("neutral"); // High confidence, success, but high latency makes it neutral
    expect(result.latency).toBe("high");
    expect(result.recommendation).toContain("Review data_fetch_tool due to: high_latency.");
    expect(result.issues).toContain("high_latency");

    const metricsSnapshot = mockMetrics.snapshot();
    expect(metricsSnapshot.reflection_calls).toBe(1);
    expect(metricsSnapshot.reflections_analyzed).toBe(1);
    expect(metricsSnapshot.reflections_failed).toBe(0);
    expect(metricsSnapshot.average_quality_score).toBe(-1);
    expect(metricsSnapshot.average_confidence_alignment).toBe(0);
  });

  it("should handle internal errors gracefully and return a failed result", async () => {
    // Temporarily break the analyzeExecution function to simulate an internal error
    vi.spyOn(await import("./reflection-rules.js"), "analyzeExecution").mockImplementationOnce(() => {
      throw new Error("Simulated analysis error");
    });

    const input: Omit<ExecutionReflectionInput, "reflectionId" | "executionId"> = {
      scope: { tenantId: "test", botId: "test" },
      toolName: "any_tool",
      success: true,
      durationMs: 100,
      confidenceAtSelection: 0.8,
      executedAt: Date.now(),
    };

    const result = await reflectionLayer.reflect(input);

    expect(result.analyzed).toBe(false);
    expect(result.quality).toBe("neutral");
    expect(result.confidenceAlignment).toBe("neutral");
    expect(result.latency).toBe("acceptable");
    expect(result.recommendation).toContain("Reflection failed internally");
    expect(result.issues).toContain("internal_reflection_failure");

    const metricsSnapshot = mockMetrics.snapshot();
    expect(metricsSnapshot.reflection_calls).toBe(1);
    expect(metricsSnapshot.reflections_analyzed).toBe(0);
    expect(metricsSnapshot.reflections_failed).toBe(1);
    expect(metricsSnapshot.average_quality_score).toBe(0);
    expect(metricsSnapshot.average_confidence_alignment).toBe(0);
  });

  it("should ensure ReflectionResult is deep-frozen", async () => {
    const input: Omit<ExecutionReflectionInput, "reflectionId" | "executionId"> = {
      scope: { tenantId: "test", botId: "test" },
      toolName: "test_tool",
      success: true,
      durationMs: 100,
      confidenceAtSelection: 0.9,
      executedAt: Date.now(),
    };

    const result = await reflectionLayer.reflect(input);

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.issues)).toBe(true);
    // Attempting to modify should throw an error in strict mode
    const attemptModification = () => {
      // @ts-expect-error - testing immutability
      result.quality = "poor";
    };
    expect(attemptModification).toThrow(TypeError);
  });

  it("should correctly map quality and confidenceAlignment to numeric scores for metrics", async () => {
    const inputs: Array<Omit<ExecutionReflectionInput, "reflectionId" | "executionId"> & { expectedQualityScore: number; expectedConfidenceAlignmentScore: number }> = [
      { scope: { tenantId: "t1", botId: "b1" }, toolName: "tool1", success: true, durationMs: 100, confidenceAtSelection: 0.9, executedAt: Date.now(), expectedQualityScore: 1, expectedConfidenceAlignmentScore: 1 }, // good, high
      { scope: { tenantId: "t2", botId: "b2" }, toolName: "tool2", success: false, durationMs: 50, confidenceAtSelection: 0.8, executedAt: Date.now(), expectedQualityScore: -1, expectedConfidenceAlignmentScore: -1 }, // poor, low
      { scope: { tenantId: "t3", botId: "b3" }, toolName: "tool3", success: true, durationMs: 1200, confidenceAtSelection: 0.7, executedAt: Date.now(), expectedQualityScore: -1, expectedConfidenceAlignmentScore: 0 }, // poor, neutral
      { scope: { tenantId: "t4", botId: "b4" }, toolName: "tool4", success: true, durationMs: 150, confidenceAtSelection: 0.3, executedAt: Date.now(), expectedQualityScore: -1, expectedConfidenceAlignmentScore: -1 }, // poor, low
      { scope: { tenantId: "t5", botId: "b5" }, toolName: "tool5", success: false, durationMs: 50, confidenceAtSelection: 0.05, executedAt: Date.now(), expectedQualityScore: -1, expectedConfidenceAlignmentScore: 1 }, // poor, high (expected failure)
    ];

    for (const input of inputs) {
      await reflectionLayer.reflect(input);
    }

    const metricsSnapshot = mockMetrics.snapshot();
    expect(metricsSnapshot.reflection_calls).toBe(inputs.length);
    expect(metricsSnapshot.reflections_analyzed).toBe(inputs.length);
    expect(metricsSnapshot.reflections_failed).toBe(0);

    const totalExpectedQualityScore = inputs.reduce((sum, i) => sum + i.expectedQualityScore, 0);
    const totalExpectedConfidenceAlignmentScore = inputs.reduce((sum, i) => sum + i.expectedConfidenceAlignmentScore, 0);

    expect(metricsSnapshot.average_quality_score).toBeCloseTo(totalExpectedQualityScore / inputs.length);
    expect(metricsSnapshot.average_confidence_alignment).toBeCloseTo(totalExpectedConfidenceAlignmentScore / inputs.length);
  });
});
