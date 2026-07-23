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

/**
 * Produces a deep-frozen, structuredClone'd snapshot of an ExecutionResult.
 *
 * Bridge fields (bridgeTool, bridgeToolResult, bridgeToolError) are excluded from
 * structuredClone because Tool objects contain function properties (match, execute)
 * that cannot be cloned. They are re-attached after cloning and frozen in place.
 */
export function makeExecutionResult(result: ExecutionResult): ExecutionResult {
  const { bridgeTool, bridgeToolResult, bridgeToolError, ...cloneable } = result;

  const snapshot = {
    ...cloneable,
    outputs:     Object.freeze([...result.outputs]),
    toolResults: Object.freeze([...result.toolResults]),
    errors:      Object.freeze([...result.errors]),
  };

  const cloned = structuredClone(snapshot);

  // Re-attach bridge fields that were stripped before cloning.
  const full: ExecutionResult = {
    ...cloned,
    ...(bridgeTool       !== undefined && { bridgeTool }),
    ...(bridgeToolResult !== undefined && { bridgeToolResult }),
    ...(bridgeToolError  !== undefined && { bridgeToolError }),
  };

  return deepFreeze(full);
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
