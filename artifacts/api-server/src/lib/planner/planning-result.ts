import type { PlanningResult } from "./planner-types.js";

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

export function makePlanningResult(
  result: Omit<PlanningResult, "plan"> & { plan?: readonly PlanningResult["plan"][number][] },
): PlanningResult {
  const snapshot: PlanningResult = {
    ...result,
    plan: Object.freeze([...(result.plan ?? [])]),
  };
  return deepFreeze(structuredClone(snapshot));
}