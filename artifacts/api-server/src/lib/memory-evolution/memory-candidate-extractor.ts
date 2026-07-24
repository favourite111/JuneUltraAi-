/**
 * M24 — MemoryCandidateExtractor.
 *
 * Pure function that maps a ReflectionResult to zero or more MemoryCandidate
 * objects. Contains no I/O, no storage access, and no side effects.
 *
 * Candidate key convention:  "tool.<toolName>.<pattern>"
 *
 * Patterns generated:
 *
 *   reliable
 *     Condition:  quality === "good" AND confidenceAlignment === "high"
 *     Meaning:    Tool performed well and confidence was well-calibrated.
 *     Category:   fact   importance: 0.75   confidence: 0.80
 *
 *   failure_pattern
 *     Condition:  issues includes "execution_failure"
 *     Meaning:    Tool has failed at least once in a relevant execution.
 *     Category:   fact   importance: 0.80   confidence: 0.70
 *
 *   overconfidence_risk
 *     Condition:  issues includes "over_confident_failure"
 *     Meaning:    M20 predicted high confidence but the tool failed.
 *     Category:   fact   importance: 0.75   confidence: 0.70
 *
 *   underconfidence_pattern
 *     Condition:  issues includes "under_confident_success"
 *     Meaning:    M20 predicted low confidence but the tool succeeded.
 *     Category:   fact   importance: 0.70   confidence: 0.60
 *
 *   latency_concern
 *     Condition:  latency === "high"
 *     Meaning:    Tool execution took longer than the acceptable threshold.
 *     Category:   context   importance: 0.60   confidence: 0.65
 *
 * A single ReflectionResult may produce multiple candidates (e.g. a failed,
 * high-latency, over-confident execution produces three candidates).
 * Duplicates from the same execution are never emitted because each pattern
 * maps to a distinct key.
 */

import { randomUUID } from "node:crypto";
import type { ReflectionResult } from "../reflection/reflection-types.js";
import type { MemoryCandidate } from "./memory-evolution-types.js";

// ---------------------------------------------------------------------------
// Extractor
// ---------------------------------------------------------------------------

/**
 * Extracts zero or more MemoryCandidates from a analyzed ReflectionResult.
 *
 * @param result      - The completed ReflectionResult from M23.
 * @param toolName    - The name of the tool that was executed (not present on ReflectionResult).
 * @param executionId - The executionId shared with the ReflectionResult.
 */
export function extractCandidates(
  result: ReflectionResult,
  toolName: string,
  executionId: string,
): readonly MemoryCandidate[] {
  // Caller (ConfidenceFilter) should have already gated on result.analyzed,
  // but we guard defensively to prevent any I/O calls on unanalyzed results.
  if (!result.analyzed) return [];

  const candidates: MemoryCandidate[] = [];
  const base = { source: "reflection" as const, sourceExecutionId: executionId, sourceTool: toolName };

  // --- Pattern: reliable ---------------------------------------------------
  if (result.quality === "good" && result.confidenceAlignment === "high") {
    candidates.push(Object.freeze({
      ...base,
      candidateId: randomUUID(),
      key: `tool.${toolName}.reliable`,
      value: `Tool "${toolName}" executes reliably with well-calibrated confidence.`,
      category: "fact",
      confidence: 0.80,
      importance: 0.75,
      tags: Object.freeze(["tool-reliability", toolName]),
    }));
  }

  // --- Pattern: failure_pattern --------------------------------------------
  if (result.issues.includes("execution_failure")) {
    candidates.push(Object.freeze({
      ...base,
      candidateId: randomUUID(),
      key: `tool.${toolName}.failure_pattern`,
      value: `Tool "${toolName}" has exhibited execution failures.`,
      category: "fact",
      confidence: 0.70,
      importance: 0.80,
      tags: Object.freeze(["tool-failure", toolName]),
    }));
  }

  // --- Pattern: overconfidence_risk ----------------------------------------
  if (result.issues.includes("over_confident_failure")) {
    candidates.push(Object.freeze({
      ...base,
      candidateId: randomUUID(),
      key: `tool.${toolName}.overconfidence_risk`,
      value: `Tool "${toolName}" selection confidence is systematically over-estimated — it has failed despite high predicted confidence.`,
      category: "fact",
      confidence: 0.70,
      importance: 0.75,
      tags: Object.freeze(["tool-calibration", "overconfidence", toolName]),
    }));
  }

  // --- Pattern: underconfidence_pattern ------------------------------------
  if (result.issues.includes("under_confident_success")) {
    candidates.push(Object.freeze({
      ...base,
      candidateId: randomUUID(),
      key: `tool.${toolName}.underconfidence_pattern`,
      value: `Tool "${toolName}" selection confidence is systematically under-estimated — it has succeeded despite low predicted confidence.`,
      category: "fact",
      confidence: 0.60,
      importance: 0.70,
      tags: Object.freeze(["tool-calibration", "underconfidence", toolName]),
    }));
  }

  // --- Pattern: latency_concern --------------------------------------------
  if (result.latency === "high") {
    candidates.push(Object.freeze({
      ...base,
      candidateId: randomUUID(),
      key: `tool.${toolName}.latency_concern`,
      value: `Tool "${toolName}" has exhibited high execution latency.`,
      category: "context",
      confidence: 0.65,
      importance: 0.60,
      tags: Object.freeze(["tool-latency", toolName]),
    }));
  }

  return Object.freeze(candidates);
}
