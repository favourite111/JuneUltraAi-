/**
 * M21 — Tool Learning Layer public API.
 *
 * Import from this barrel; do NOT import from sub-modules directly.
 */

// Types
export type {
  ToolLearningScope,
  CompletedToolExecution,
  ToolLearningStats,
  ToolLearningReader,
} from "./tool-learning-types.js";
export {
  TOOL_LEARNING_TIER,
  TOOL_LEARNING_USER_SENTINEL,
  TOOL_LEARNING_QUALIFIER_PREFIX,
  MIN_LEARNING_EXECUTIONS,
} from "./tool-learning-types.js";

// Store
export { ToolLearningStore, mergeStats } from "./tool-learning-store.js";
export type { ToolLearningStoreOptions } from "./tool-learning-store.js";

// Metrics
export {
  ToolLearningMetrics,
  toolLearningMetrics,
} from "./tool-learning-metrics.js";
export type {
  ToolLearningMetricsRecorder,
  ToolLearningMetricsSnapshot,
} from "./tool-learning-metrics.js";
