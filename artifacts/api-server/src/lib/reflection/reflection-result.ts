import type { ReflectionResult } from "./reflection-types.js";

// ---------------------------------------------------------------------------
// M23 — Immutable ReflectionResult builder
// Mirrors the deepFreeze + structuredClone pattern from M19 execution-result.ts.
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
 * Produces a deep-frozen, structuredClone'd ReflectionResult.
 * Every result returned from ReflectionLayer.reflect() passes through here.
 * No consumer may mutate the returned object.
 */
export function makeReflectionResult(result: ReflectionResult): ReflectionResult {
  return deepFreeze(structuredClone(result));
}

// ---------------------------------------------------------------------------
// Convenience constructors
// ---------------------------------------------------------------------------

/**
 * Builds a "not analyzed" result — used when reflect() detects invalid input
 * or catches an internal error. reflectedAt defaults to Date.now() at call time.
 */
export function failedReflectionResult(
  input: {
    reflectionId: string;
    executionId: string;
  },
  reflectedAt = Date.now(),
): ReflectionResult {
  return makeReflectionResult({
    reflectionId: input.reflectionId,
    executionId: input.executionId,
    analyzed: false,
    quality: "neutral",
    confidenceAlignment: "neutral",
    latency: "acceptable",
    recommendation: "Reflection failed internally or was skipped.",
    issues: ["internal_reflection_failure"],
    reflectedAt,
  });
}

/**
 * Builds a successful result.
 */
export function successReflectionResult(
  input: Omit<ReflectionResult, "analyzed" | "reflectedAt">,
  reflectedAt = Date.now(),
): ReflectionResult {
  return makeReflectionResult({
    ...input,
    analyzed: true,
    reflectedAt,
  });
}
