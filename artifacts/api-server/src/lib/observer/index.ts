/**
 * M22 — Execution Observer Layer public API.
 *
 * Import from this barrel; do NOT import from sub-modules directly.
 *
 * Usage (call site in chat.ts — after M22-B wiring):
 *
 *   import { executionObserver } from "../lib/observer/index.js";
 *
 *   // Non-blocking — always void, never await on the request path
 *   void executionObserver.observe({
 *     scope:                 { tenantId, botId },
 *     toolName:              tool.name,
 *     success:               true,
 *     durationMs:            runtimeResponse.context.executionTimeMs ?? 0,
 *     confidenceAtSelection: toolIntelResult.confidence,
 *     executedAt:            Date.now(),
 *   });
 */

// Main layer
export { createExecutionObserver, executionObserver } from "./execution-observer.js";
export type { ExecutionObserver, ExecutionObserverConfig } from "./execution-observer.js";

// Types
export type {
  ObservationInput,
  ObservationResult,
  ObservationScope,
  ObservationStore,
} from "./observer-types.js";

// Metrics
export { observerMetrics, ObserverMetrics } from "./observer-metrics.js";
export type {
  ObserverMetricsRecorder,
  ObserverMetricsSnapshot,
} from "./observer-metrics.js";

// Result builders (for testing and advanced consumers)
export {
  makeObservationResult,
  failedObservationResult,
  successObservationResult,
} from "./observation-result.js";
