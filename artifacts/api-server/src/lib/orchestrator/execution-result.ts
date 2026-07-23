import type { ExecutionResult } from "./orchestrator-types.js";

// ---------------------------------------------------------------------------
// M19 — Immutable ExecutionResult builder
// Mirrors the deepFreeze + structuredClone pattern from planning-result.ts.
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

/** Produces a deep-frozen, structuredClone'd snapshot of an ExecutionResult. */
export function makeExecutionResult(result: ExecutionResult): ExecutionResult {
  const snapshot: ExecutionResult = {
    ...result,
    outputs:     Object.freeze([...result.outputs]),
    toolResults: Object.freeze([...result.toolResults]),
    errors:      Object.freeze([...result.errors]),
  };
  return deepFreeze(structuredClone(snapshot));
}

// ---------------------------------------------------------------------------
// Convenience constructors
// ---------------------------------------------------------------------------

export function noCapabilityResult(startMs: number, endMs: number): ExecutionResult {
  return makeExecutionResult({
    success:        true,
    handledBy:      "no_capability",
    outputs:        [{ step: 1, executor: "no_capability", success: true, durationMs: 0 }],
    toolResults:    [],
    executionTimeMs: endMs - startMs,
    errors:         [],
  });
}
