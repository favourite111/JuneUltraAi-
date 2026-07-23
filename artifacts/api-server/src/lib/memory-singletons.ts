/**
 * Phase 3C — M13: Memory Subsystem Singletons
 *
 * Constructs and exports the long-lived memory subsystem instances so they can
 * be shared between route handlers without circular dependencies.
 *
 * Ownership:
 *   chat.ts   → imports memoryManager for request handling
 *   stats.ts  → imports metricsCollector for the GET /api/stats "memory" key
 *
 * The persistent memoryEventBus is the key wiring: DefaultMemoryManager emits
 * lifecycle events onto it, and MemoryMetricsCollector subscribes to the same
 * bus, so every load/record/decay event across ALL requests flows to the
 * collector without any per-request setup.
 */

import { AgentEventBus } from "./tools/event-bus.js";
import {
  DefaultMemoryManager,
  HashingEmbeddingProvider,
  KnowledgeManager,
  MemoryMetricsCollector,
  PostgresStorageProvider,
  StoragePruner,
  VectorStorageProvider,
} from "./memory/index.js";

// ---------------------------------------------------------------------------
// Event bus — persistent, shared across all requests
// ---------------------------------------------------------------------------

/** Module-level event bus for the memory subsystem (survives individual requests). */
export const memoryEventBus = new AgentEventBus();

// ---------------------------------------------------------------------------
// Storage backends
// ---------------------------------------------------------------------------

/** Production storage provider backed by Neon PostgreSQL. */
export const storageProvider = new PostgresStorageProvider();

/**
 * In-memory vector index for semantic knowledge retrieval.
 * Vectors are rebuilt from storage on restart (see KnowledgeManager.reconcile).
 */
export const vectorStorageProvider = new VectorStorageProvider();

// ---------------------------------------------------------------------------
// Knowledge manager
// ---------------------------------------------------------------------------

/**
 * KnowledgeManager owns long-term knowledge CRUD + hybrid retrieval.
 * Deterministic branch (exact key > phrase > token overlap) leads;
 * semantic branch (cosine via HashingEmbeddingProvider) appends.
 */
export const knowledgeManager = new KnowledgeManager(storageProvider, {
  embeddingProvider: new HashingEmbeddingProvider(),
  vectorStorageProvider,
});

// ---------------------------------------------------------------------------
// Memory manager — the composition root for all tier access
// ---------------------------------------------------------------------------

/**
 * DefaultMemoryManager — receives the persistent event bus so every lifecycle
 * event (load_started, load_completed, record_completed, budget_truncated …)
 * flows to metricsCollector without any per-request wiring.
 */
export const memoryManager = new DefaultMemoryManager(
  storageProvider,
  memoryEventBus,   // ← persistent bus (not per-request AgentEventBus)
  undefined,        // TokenEstimator — defaults to CharacterTokenEstimator
  undefined,        // ConversationSummarizer — defaults to ExtractiveConversationSummarizer
  knowledgeManager,
);

// ---------------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------------

/**
 * Memory metrics collector — subscribes to memoryEventBus on construction
 * and accumulates load/record/decay/forget stats across all requests.
 *
 * Exposed via GET /api/stats as the "memory" key.
 * Call metricsCollector.snapshot() for an immutable point-in-time view.
 * Call metricsCollector.reset()    to clear counters (e.g. between test runs).
 */
export const metricsCollector = new MemoryMetricsCollector(memoryEventBus);

// ---------------------------------------------------------------------------
// Storage pruner (M15 — session tier DB schema required before scheduling)
// ---------------------------------------------------------------------------

/**
 * StoragePruner — background hygiene for session, conversation, and
 * tool-execution tiers.  Instance is ready; scheduler wiring is deferred to
 * M15 when the session tier has a real DB schema.
 */
export const storagePruner = new StoragePruner(storageProvider);
