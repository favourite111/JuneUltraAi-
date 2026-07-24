/**
 * M21 — ToolLearningStore.
 *
 * Records completed tool execution outcomes and persists aggregate statistics
 * through the existing StorageProvider abstraction. No new DB clients,
 * no SQL, no filesystem access.
 *
 * Storage addressing:
 *   tier:      "tool_execution"         (existing MemoryTier — no schema changes)
 *   tenantId:  <from ToolLearningScope>
 *   botId:     <from ToolLearningScope>
 *   userId:    "__tool_learning__"       (sentinel — never a real user ID)
 *   qualifier: "stats:<toolName>"        (per-tool discriminant)
 *
 * Design:
 *   - In-memory Map cache backs synchronous getStats() reads consumed by M20.
 *   - record() updates the cache synchronously, then writes to storage async.
 *   - Storage writes are best-effort (degrade gracefully on failure, same
 *     contract as MemoryManager.record()).
 *   - loadAll() warms the cache from storage at startup so stats survive restarts.
 *
 * Determinism invariant (M21 contract):
 *   record() MUST be called only AFTER execution completes.
 *   getStats() is called BEFORE execution begins (by M20).
 *   These two operations never overlap on the same execution — there is no
 *   feedback loop that could alter an execution already in progress.
 */

import type { StorageProvider, StorageKey } from "../memory/types.js";
import {
  type CompletedToolExecution,
  type ToolLearningScope,
  type ToolLearningStats,
  type ToolLearningReader,
  TOOL_LEARNING_TIER,
  TOOL_LEARNING_USER_SENTINEL,
  TOOL_LEARNING_QUALIFIER_PREFIX,
} from "./tool-learning-types.js";
import type { ToolLearningMetricsRecorder } from "./tool-learning-metrics.js";

// ---------------------------------------------------------------------------
// Helpers — pure functions
// ---------------------------------------------------------------------------

function cacheKey(scope: ToolLearningScope, toolName: string): string {
  return `${scope.tenantId}:${scope.botId}:${toolName}`;
}

function toStorageKey(scope: ToolLearningScope, toolName: string): StorageKey {
  return {
    tier:      TOOL_LEARNING_TIER,
    tenantId:  scope.tenantId,
    botId:     scope.botId,
    userId:    TOOL_LEARNING_USER_SENTINEL,
    qualifier: `${TOOL_LEARNING_QUALIFIER_PREFIX}${toolName}`,
  };
}

function emptyStats(toolName: string, now: number): ToolLearningStats {
  return Object.freeze<ToolLearningStats>({
    toolName,
    totalExecutions:           0,
    successCount:              0,
    failureCount:              0,
    successRate:               0,
    avgDurationMs:             0,
    avgConfidenceAtSelection:  0,
    lastExecutedAt:            now,
    lastSuccess:               false,
    updatedAt:                 now,
    version:                   0,
  });
}

/**
 * Merge one completed execution into existing aggregate stats.
 * Uses incremental (Welford-style) averaging to avoid re-reading history.
 * Pure function — no side effects.
 */
export function mergeStats(
  current: ToolLearningStats,
  execution: CompletedToolExecution,
): ToolLearningStats {
  const total        = current.totalExecutions + 1;
  const successCount = current.successCount + (execution.success ? 1 : 0);
  const failureCount = current.failureCount + (execution.success ? 0 : 1);

  // Welford incremental average: avg_n = avg_{n-1} + (x_n - avg_{n-1}) / n
  const avgDurationMs =
    current.avgDurationMs +
    (execution.durationMs - current.avgDurationMs) / total;

  const avgConfidenceAtSelection =
    current.avgConfidenceAtSelection +
    (execution.confidenceAtSelection - current.avgConfidenceAtSelection) / total;

  return Object.freeze<ToolLearningStats>({
    toolName:                  current.toolName,
    totalExecutions:           total,
    successCount,
    failureCount,
    successRate:               successCount / total,
    avgDurationMs,
    avgConfidenceAtSelection,
    lastExecutedAt:            execution.executedAt,
    lastSuccess:               execution.success,
    updatedAt:                 execution.executedAt,
    version:                   current.version + 1,
  });
}

// ---------------------------------------------------------------------------
// ToolLearningStore
// ---------------------------------------------------------------------------

export interface ToolLearningStoreOptions {
  /** Injectable metrics recorder — defaults to a no-op when absent. */
  readonly metrics?: ToolLearningMetricsRecorder;
}

export class ToolLearningStore implements ToolLearningReader {
  /** In-memory cache: cacheKey → ToolLearningStats */
  private readonly cache = new Map<string, ToolLearningStats>();
  private readonly metrics: ToolLearningMetricsRecorder | undefined;

  constructor(
    private readonly storage: StorageProvider,
    options: ToolLearningStoreOptions = {},
  ) {
    this.metrics = options.metrics;
  }

  // ---------------------------------------------------------------------------
  // ToolLearningReader — synchronous, consumed by M20
  // ---------------------------------------------------------------------------

  /**
   * Returns cached stats for (scope, toolName), or null if no executions recorded.
   *
   * SYNCHRONOUS — reads only from the in-memory cache. No I/O.
   * Safe to call from M20.evaluate() which must remain synchronous.
   *
   * DETERMINISM: values here reflect only executions that completed before
   * this call. record() updates the cache after the execution settles.
   */
  getStats(scope: ToolLearningScope, toolName: string): ToolLearningStats | null {
    const key   = cacheKey(scope, toolName);
    const stats = this.cache.get(key) ?? null;
    if (stats !== null) {
      this.metrics?.cacheHit();
    } else {
      this.metrics?.cacheMiss();
    }
    return stats;
  }

  // ---------------------------------------------------------------------------
  // Post-execution recording
  // ---------------------------------------------------------------------------

  /**
   * Record one completed tool execution outcome.
   *
   * DETERMINISM GUARANTEE:
   *   This method MUST be called only AFTER execution has fully completed.
   *   It updates the in-memory cache synchronously, then writes to storage
   *   asynchronously (best-effort). Any future M20.evaluate() call in a
   *   subsequent request will see the updated stats via getStats().
   *
   * Storage write failures are logged and counted but do not throw —
   *   the cache remains valid regardless of storage state.
   *
   * @param scope     - Identifies the bot whose stats are updated.
   * @param execution - The completed execution outcome to merge in.
   */
  async record(
    scope: ToolLearningScope,
    execution: CompletedToolExecution,
  ): Promise<void> {
    const key     = cacheKey(scope, execution.toolName);
    const current = this.cache.get(key) ?? emptyStats(execution.toolName, execution.executedAt);
    const updated = mergeStats(current, execution);

    // Update cache synchronously — subsequent getStats() calls see this immediately.
    this.cache.set(key, updated);

    // Persist to storage (async, best-effort).
    try {
      await this.storage.write(
        toStorageKey(scope, execution.toolName),
        updated,
      );
      this.metrics?.recordStored();
    } catch (err) {
      // Degrade gracefully: cache is valid; storage will resync on next record().
      console.warn(
        `[ToolLearning] Storage write failed for "${execution.toolName}" ` +
        `in ${scope.tenantId}/${scope.botId}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
      this.metrics?.storageFailed();
    }
  }

  // ---------------------------------------------------------------------------
  // Cache warm-up
  // ---------------------------------------------------------------------------

  /**
   * Load persisted stats from storage into the in-memory cache.
   *
   * Call once per (tenantId, botId) at startup to ensure stats survive
   * process restarts. Missing entries are silently skipped — they will be
   * created on the first record() call.
   *
   * @param scope     - The bot scope to load.
   * @param toolNames - Tool names to attempt loading (typically ToolRegistry.listTools()).
   */
  async loadAll(scope: ToolLearningScope, toolNames: readonly string[]): Promise<void> {
    await Promise.all(toolNames.map((name) => this.loadOne(scope, name)));
  }

  private async loadOne(scope: ToolLearningScope, toolName: string): Promise<void> {
    try {
      const stats = await this.storage.read<ToolLearningStats>(
        toStorageKey(scope, toolName),
      );
      if (stats !== null) {
        this.cache.set(cacheKey(scope, toolName), Object.freeze(stats));
      }
    } catch {
      // Silently skip — the tool starts from zero stats on first record().
    }
  }

  /** Returns the number of (scope, toolName) entries currently in the cache. */
  get cacheSize(): number {
    return this.cache.size;
  }
}
