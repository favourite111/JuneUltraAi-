import type { ExecutionReflectionInput, ReflectionResult } from "./reflection-types.js";

/**
 * M23 — Reflection Rules.
 *
 * This module contains the core logic for analyzing execution observations
 * and deriving structured insights for the Reflection Layer.
 */

interface ReflectionAnalysis {
  quality: ReflectionResult["quality"];
  confidenceAlignment: ReflectionResult["confidenceAlignment"];
  latency: ReflectionResult["latency"];
  recommendation: string;
  issues: string[];
}

export function analyzeExecution(input: ExecutionReflectionInput): ReflectionAnalysis {
  const issues: string[] = [];
  let quality: ReflectionResult["quality"] = "neutral";
  let confidenceAlignment: ReflectionResult["confidenceAlignment"] = "neutral";
  let latency: ReflectionResult["latency"] = "acceptable";
  let recommendation = "";

  // Latency Analysis
  // Assuming a threshold for high latency, e.g., 500ms for a typical tool execution
  const HIGH_LATENCY_THRESHOLD = 500;
  if (input.durationMs > HIGH_LATENCY_THRESHOLD) {
    latency = "high";
    issues.push("high_latency");
  }

  // Confidence Alignment Analysis
  if (input.success) {
    if (input.confidenceAtSelection < 0.5) {
      confidenceAlignment = "low"; // Predicted low, succeeded: under-confident
      issues.push("under_confident_success");
    } else if (input.confidenceAtSelection >= 0.9) {
      confidenceAlignment = "high"; // Predicted high, succeeded: well-aligned
    } else {
      confidenceAlignment = "neutral";
    }
  } else { // Execution failed
    if (input.confidenceAtSelection > 0.5) {
      confidenceAlignment = "low"; // Predicted high, failed: over-confident
      issues.push("over_confident_failure");
    } else if (input.confidenceAtSelection < 0.1) {
      confidenceAlignment = "high"; // Predicted low, failed: well-aligned (expected failure)
    } else {
      confidenceAlignment = "neutral";
    }
  }

  // Quality Assessment
  if (input.success && latency === "acceptable" && confidenceAlignment !== "low") {
    quality = "good";
    recommendation = `Continue using ${input.toolName} tool.`;
  } else if (!input.success || latency === "high" || confidenceAlignment === "low") {
    quality = "poor";
    if (!input.success) {
      recommendation = `Review ${input.toolName} tool for failures.`;
      issues.push("execution_failure");
    }
    if (latency === "high") {
      recommendation = `Investigate latency for ${input.toolName} tool.`;
    }
    if (confidenceAlignment === "low") {
      recommendation = `Adjust confidence prediction for ${input.toolName} tool.`;
    }
    if (issues.length > 0) {
      recommendation = `Review ${input.toolName} due to: ${issues.sort().join(", ")}.`;
    }
  } else {
    quality = "neutral";
    recommendation = `Monitor ${input.toolName} tool.`;
  }

  return {
    quality,
    confidenceAlignment,
    latency,
    recommendation,
    issues,
  };
}
