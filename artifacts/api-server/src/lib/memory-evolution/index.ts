/**
 * M24 — Memory Evolution public API.
 *
 * External consumers should import from this barrel file only.
 * Internal cross-module imports within memory-evolution/ are allowed to use
 * direct file paths to avoid re-exporting implementation details.
 */

// Types
export type {
  MemoryCandidate,
  MemoryCandidateStore,
  MemoryEvolutionInput,
  MemoryEvolutionLayer,
  MemoryEvolutionResult,
  MemoryReader,
  MemoryReaderResult,
  MemoryReaderStore,
  KnowledgeReaderStore,
  PolicyAction,
  PolicyDecision,
} from "./memory-evolution-types.js";

// Confidence filter
export { CONFIDENCE_THRESHOLD, computeSignalStrength, passesConfidenceFilter } from "./confidence-filter.js";

// Candidate extractor
export { extractCandidates } from "./memory-candidate-extractor.js";

// Knowledge reader
export { createKnowledgeReader } from "./knowledge-reader.js";
export type { KnowledgeReader } from "./knowledge-reader.js";

// Memory policy
export { createMemoryPolicy, memoryPolicy } from "./memory-policy.js";
export type { MemoryPolicy } from "./memory-policy.js";

// Evolution engine
export { createMemoryEvolutionEngine } from "./memory-evolution-engine.js";

// Memory reader (pre-planning)
export { createMemoryReader } from "./memory-reader.js";

// Metrics
export {
  MemoryEvolutionMetrics,
  memoryEvolutionMetrics,
} from "./memory-evolution-metrics.js";
export type {
  MemoryEvolutionMetricsRecorder,
  MemoryEvolutionMetricsSnapshot,
} from "./memory-evolution-metrics.js";
