/**
 * Phase 3B — Contextual Memory Architecture (ADR-005)
 *
 * Public surface of the memory subsystem.
 * Import from here, not from individual files inside lib/memory/.
 */
export { DefaultMemoryManager } from "./memory-manager.js";
export { PostgresStorageProvider } from "./providers/postgres-storage-provider.js";
export { InMemoryStorageProvider } from "./providers/in-memory-storage-provider.js";

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
