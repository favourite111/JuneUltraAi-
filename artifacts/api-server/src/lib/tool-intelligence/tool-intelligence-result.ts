/**
 * M20 — Tool Intelligence Layer result builder.
 *
 * Mirrors the deepFreeze + structuredClone pattern from planning-result.ts
 * and execution-result.ts for consistency across the pipeline.
 */

import type { ToolIntelligenceResult } from "./tool-intelligence-types.js";

// ---------------------------------------------------------------------------
// Deep freeze utility (same pattern as planning-result.ts / execution-result.ts)
// ---------------------------------------------------------------------------

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value;
  const obj = value as object;
  if (seen.has(obj)) return value;
  seen.add(obj);
  for (const key of Reflect.ownKeys(obj)) {
    const d = Object.getOwnPropertyDescriptor(obj, key);
    if (d && "value" in d) deepFreeze(d.value, seen);
  }
  return Object.freeze(value);
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Produces a deep-frozen, structuredClone'd snapshot of a ToolIntelligenceResult.
 * All array fields are frozen before cloning so structuredClone preserves them.
 */
export function makeToolIntelligenceResult(
  result: ToolIntelligenceResult,
): ToolIntelligenceResult {
  const snapshot: ToolIntelligenceResult = {
    ...result,
    candidateTools:     Object.freeze([...result.candidateTools]),
    fallbackCandidates: Object.freeze([...result.fallbackCandidates]),
    conflicts:          Object.freeze([...result.conflicts]),
    warnings:           Object.freeze([...result.warnings]),
  };
  return deepFreeze(structuredClone(snapshot));
}

// ---------------------------------------------------------------------------
// Convenience constructors
// ---------------------------------------------------------------------------

/**
 * Returns a deep-frozen "no tool needed" result.
 * Used when needsTool=false — skips all analysis.
 */
export function noToolResult(): ToolIntelligenceResult {
  return makeToolIntelligenceResult({
    selectedTool:       null,
    candidateTools:     [],
    confidence:         1.0,
    estimatedLatency:   0,
    estimatedCost:      0,
    availability:       "unknown",
    fallbackCandidates: [],
    conflicts:          [],
    warnings:           [],
  });
}

/**
 * Returns a deep-frozen "unavailable tool" error result.
 * Used when the nominated tool is missing from the registry and no fallback exists.
 */
export function unavailableToolResult(toolName: string): ToolIntelligenceResult {
  return makeToolIntelligenceResult({
    selectedTool:       toolName,
    candidateTools:     [],
    confidence:         0,
    estimatedLatency:   0,
    estimatedCost:      0,
    availability:       "unavailable",
    fallbackCandidates: [],
    conflicts:          [],
    warnings:           [`Tool "${toolName}" is not registered in ToolRegistry.`],
  });
}
