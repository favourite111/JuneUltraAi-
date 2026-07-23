/**
 * M20 — Tool Intelligence Layer public API.
 *
 * Import from this barrel; do NOT import from sub-modules directly.
 */

// Main layer
export {
  createToolIntelligenceLayer,
  toolIntelligenceLayer,
} from "./tool-intelligence.js";
export type {
  ToolIntelligenceConfig,
  ToolIntelligenceLayer,
} from "./tool-intelligence.js";

// Types
export type {
  CandidateTool,
  ToolAvailabilityStatus,
  ToolConflict,
  ToolIntelligenceInput,
  ToolIntelligenceResult,
} from "./tool-intelligence-types.js";

// Result builders
export {
  makeToolIntelligenceResult,
  noToolResult,
  unavailableToolResult,
} from "./tool-intelligence-result.js";

// Metrics
export {
  toolIntelligenceMetrics,
  ToolIntelligenceMetrics,
} from "./tool-intelligence-metrics.js";
export type {
  ToolIntelligenceMetricsRecorder,
  ToolIntelligenceMetricsSnapshot,
} from "./tool-intelligence-metrics.js";

// Sub-module exports (for testing and advanced consumers)
export { checkToolAvailability, isToolAvailable, getRegisteredToolNames } from "./tool-availability.js";
export { rankTools, selectBestCandidate, selectFallbacks } from "./tool-ranking.js";
export { detectConflicts, detectUnavailabilityConflict } from "./tool-conflicts.js";
export { estimateCost, estimateLatency, getToolCostProfile } from "./tool-cost.js";
export {
  estimateToolConfidence,
  estimatePlannerNominatedConfidence,
  buildCandidate,
} from "./tool-confidence.js";
