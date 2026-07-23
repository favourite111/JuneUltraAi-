import type { ReasoningResult } from "./reasoner-types.js";

// ---------------------------------------------------------------------------
// M18 — Immutable result builder
// Mirrors the deepFreeze + structuredClone pattern from planning-result.ts.
// ---------------------------------------------------------------------------

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value;
  const objectValue = value as object;
  if (seen.has(objectValue)) return value;
  seen.add(objectValue);
  for (const key of Reflect.ownKeys(objectValue)) {
    const descriptor = Object.getOwnPropertyDescriptor(objectValue, key);
    if (descriptor && "value" in descriptor) {
      deepFreeze(descriptor.value, seen);
    }
  }
  return Object.freeze(value);
}

/**
 * Produces a deep-frozen, structuredClone'd snapshot of the reasoning result.
 * Downstream code can hold references without risk of mutation.
 */
export function makeReasoningResult(result: ReasoningResult): ReasoningResult {
  const snapshot: ReasoningResult = {
    ...result,
    inferences:     Object.freeze([...result.inferences]),
    contradictions: Object.freeze([...result.contradictions]),
    optimizations:  Object.freeze([...result.optimizations]),
  };
  return deepFreeze(structuredClone(snapshot));
}
