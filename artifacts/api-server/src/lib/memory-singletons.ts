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
// Storage pruner (M15 — background hygiene)
// ---------------------------------------------------------------------------

/**
 * StoragePruner — background hygiene for session, conversation, and
 * tool-execution tiers.  Milestone 15: Scheduler activated.
 */
export const storagePruner = new StoragePruner(storageProvider, {
  sessionTtlMs: 24 * 60 * 60 * 1000, // 24 hour sliding TTL (Milestone 15)
});

/**
 * Milestone 15: Background Scheduler (M15-F1)
 * Runs every 4 hours to clean up expired sessions and prune conversation history.
 * Only one instance exists as it is part of the singleton module initialization.
 */
export function startPrunerScheduler(): void {
  const FOUR_HOURS = 4 * 60 * 60 * 1000;
  
  const runPrune = async () => {
    const now = Date.now();
    try {
      // M15-F1: Log pruner start
      console.log(`[MemoryPruner] Started at ${new Date(now).toISOString()}`);
      
      memoryEventBus.emit({
        type: "memory.maintenance_started",
        context: { requestId: "system-maintenance" } as any,
        payload: { timestamp: now },
      });

      // M15-F4: Perform global sweep
      const result = await storagePruner.runPruneAll(now);

      // M15-F1: Log pruner completion with stats
      console.log(`[MemoryPruner] Completed: ${result.scopeCount} scopes scanned, ` +
                  `${result.sessionsRemoved} sessions removed, ` +
                  `${result.conversationTurnsPruned} turns pruned, ` +
                  `${result.toolRecordsPruned} tool records pruned. ` +
                  `Duration: ${result.durationMs}ms`);

      memoryEventBus.emit({
        type: "memory.maintenance_completed",
        context: { requestId: "system-maintenance" } as any,
        payload: { ...result },
      });
    } catch (error) {
      // M15-F1: Log failures
      console.error(`[MemoryPruner] Failed:`, error);
      
      memoryEventBus.emit({
        type: "memory.maintenance_failed",
        context: { requestId: "system-maintenance" } as any,
        payload: { error: error instanceof Error ? error.message : String(error), timestamp: now },
      });
    }
  };

  // Run once on boot, then every 4 hours
  void runPrune();
  setInterval(runPrune, FOUR_HOURS);
}
