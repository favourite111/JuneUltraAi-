/**
 * Phase 3B — Contextual Memory Architecture (ADR-005)
 *
 * Public surface of the memory subsystem.
 * Import from here, not from individual files inside lib/memory/.
 */
export { DefaultMemoryManager } from "./memory-manager.js";
export { ConfidenceDecayService, computeDecayedConfidence } from "./confidence-decay.js";
export type { DecaySweepResult } from "./confidence-decay.js";
export { StoragePruner, DEFAULT_PRUNER_CONFIG } from "./storage-pruner.js";
export type { StoragePrunerConfig, PruneResult } from "./storage-pruner.js";
export { MemoryMetricsCollector } from "./memory-metrics-collector.js";
export type {
  NumericStats,
  LoadMetricsSnapshot,
  RecordMetricsSnapshot,
  DecayMetricsSnapshot,
  ForgetMetricsSnapshot,
  MemoryMetricsSnapshot,
} from "./memory-metrics-collector.js";
export { KnowledgeManager } from "./knowledge-manager.js";
export type {
  KnowledgeLoadOptions,
  MergeResult,
  KnowledgeManagerOptions,
} from "./knowledge-manager.js";
export { CharacterTokenEstimator } from "./token-estimator.js";
export type { TokenEstimator } from "./token-estimator.js";
export { ExtractiveConversationSummarizer } from "./conversation-summarizer.js";
export type { ConversationSummarizer } from "./conversation-summarizer.js";
export { TermOverlapRelevanceScorer, tokenise } from "./relevance-scorer.js";
export type { RelevanceScorer } from "./relevance-scorer.js";
export {
  HashingEmbeddingProvider,
  cosineSimilarity,
  l2Norm,
  l2Normalize,
  EMBEDDING_DIMENSIONS,
} from "./embedding-provider.js";
export type { EmbeddingProvider } from "./embedding-provider.js";
export { PostgresStorageProvider } from "./providers/postgres-storage-provider.js";
export { InMemoryStorageProvider } from "./providers/in-memory-storage-provider.js";
export { VectorStorageProvider } from "./providers/vector-storage-provider.js";

export type {
  MemoryTierId,

  // Scope & identity
  MemoryScope,

  // Tier data shapes
  RequestMemory,
  SessionMemory,
  ConversationTurn,
  UserFact,
  ToolExecutionRecord,

  // Frozen context snapshot
  MemoryContext,

  // Updates (route handler → MemoryManager.record)
  MemoryUpdates,

  // Health
  MemoryHealthStatus,

  // Manager interface
  MemoryManager,

  // StorageProvider interfaces
  StorageKey,
  ScopePrefix,
  ListOptions,
  WriteOptions,
  WriteResult,
  StorageProvider,

  // Context budgeting
  ModelContextProfile,
  ContextBudget,

  // Privacy & retention
  ToolStorageRules,
  ConfidenceDecayConfig,
} from "./types.js";

export {
  // Versioning
  MEMORY_CONTEXT_VERSION,

  // Defaults & helpers
  DEFAULT_IMPORTANCE_SCORES,
  KNOWN_CONTEXT_PROFILES,
  DEFAULT_CONTEXT_PROFILE,
  deriveContextBudget,
  DEFAULT_CONTEXT_BUDGET,
  DEFAULT_TOOL_STORAGE_RULES,
  DEFAULT_CONFIDENCE_DECAY,

  // Error classes
  WriteConflictError,
  MemoryError,
} from "./types.js";
