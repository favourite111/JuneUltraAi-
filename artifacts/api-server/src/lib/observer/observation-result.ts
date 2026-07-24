import type { ObservationResult } from "./observer-types.js";

// ---------------------------------------------------------------------------
// M22 — Immutable ObservationResult builder
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
 * Produces a deep-frozen, structuredClone'd ObservationResult.
 * Every result returned from ExecutionObserver.observe() passes through here.
 * No consumer may mutate the returned object.
 */
export function makeObservationResult(result: ObservationResult): ObservationResult {
  return deepFreeze(structuredClone(result));
}

// ---------------------------------------------------------------------------
// Convenience constructors
// ---------------------------------------------------------------------------

/**
 * Builds a "not recorded" result — used when observe() detects invalid input
 * or catches an internal error. storedAt defaults to Date.now() at call time.
 */
export function failedObservationResult(
  input: { durationMs?: number; confidenceAtSelection: number },
  storedAt = Date.now(),
): ObservationResult {
  return makeObservationResult({
    recorded:             false,
    durationMs:           input.durationMs !== undefined ? Math.max(0, input.durationMs) : 0,
    confidenceAtSelection: Math.min(1, Math.max(0, input.confidenceAtSelection)),
    storedAt,
  });
}

/**
 * Builds a successful result.
 */
export function successObservationResult(
  input: { durationMs: number; confidenceAtSelection: number },
  storedAt = Date.now(),
): ObservationResult {
  return makeObservationResult({
    recorded:             true,
    durationMs:           Math.max(0, input.durationMs),
    confidenceAtSelection: Math.min(1, Math.max(0, input.confidenceAtSelection)),
    storedAt,
  });
}
