/**
 * M21 — Tool Learning Layer types.
 *
 * All type contracts for the Tool Learning Layer. No imports from
 * lib/tools/, lib/orchestrator/, or lib/tool-intelligence/. The only
 * external dependency is StorageProvider from lib/memory/types.ts
 * (one-way: tool-learning → memory, never the reverse).
 *
 * The Tool Learning Layer MUST NOT:
 *   ✗ execute tools
 *   ✗ call the LLM
 *   ✗ influence the execution currently in progress
 *   ✗ introduce new database clients or direct SQL access
 *   ✗ use filesystem, JSON file, or any storage path outside StorageProvider
 *
 * It MUST:
 *   ✓ only consume completed execution results (post-execution)
 *   ✓ persist entirely via the existing StorageProvider abstraction
 *   ✓ make statistics visible to M20 from execution N+1 onward only
 */

// ---------------------------------------------------------------------------
// StorageProvider constants (no runtime import needed — strings only)
// ---------------------------------------------------------------------------

/**
 * The existing MemoryTier used by Tool Learning.
 * Tool Learning reuses "tool_execution" — no new tier, no schema changes.
 */
export const TOOL_LEARNING_TIER = "tool_execution" as const;

/**
 * Sentinel userId for bot-level (cross-user) tool learning stats.
 * Tool performance is a property of the bot, not individual users.
 * This sentinel isolates learning entries from user-scoped tool execution records.
 */
export const TOOL_LEARNING_USER_SENTINEL = "__tool_learning__" as const;

/** Qualifier prefix for per-tool stat records within the tool_execution tier. */
export const TOOL_LEARNING_QUALIFIER_PREFIX = "stats:" as const;

/** Minimum completed executions before learning-based confidence adjustment applies. */
export const MIN_LEARNING_EXECUTIONS = 3;

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/**
 * (tenantId, botId) pair that scopes tool learning statistics.
 *
 * Tool performance is a property of the bot deployment, not individual users.
 * Every user of a bot contributes to the same aggregate stats pool.
 */
export interface ToolLearningScope {
  readonly tenantId: string;
  readonly botId: string;
}

// ---------------------------------------------------------------------------
// Completed execution input
// ---------------------------------------------------------------------------

/**
 * One observed tool execution outcome.
 * Derived from ExecutionResult after M19 completes and passed to
 * ToolLearningStore.record().
 *
 * DETERMINISM CONTRACT:
 *   record() MUST only be called AFTER the execution has fully completed.
 *   The statistics persisted here become visible from execution N+1 onward.
 *   Calling record() during an in-progress execution violates M21's contract.
 */
export interface CompletedToolExecution {
  /** Tool name as registered in ToolRegistry. */
  readonly toolName: string;
  /** Whether the tool execution succeeded. */
  readonly success: boolean;
  /**
   * Actual wall-clock execution duration in milliseconds.
   * Measured by the caller from request start to execution result.
   */
  readonly durationMs: number;
  /**
   * Confidence score assigned by M20 ToolIntelligenceLayer before execution.
   * Allows M21 to detect systematic over- or under-confidence in M20's estimates.
   * Pass 0 when M20 was not consulted (legacy routing path).
   */
  readonly confidenceAtSelection: number;
  /** Epoch milliseconds when the execution completed. */
  readonly executedAt: number;
}

// ---------------------------------------------------------------------------
// Persisted aggregate statistics
// ---------------------------------------------------------------------------

/**
 * Aggregate performance statistics for one (tenantId, botId, toolName) triple.
 *
 * Persisted via StorageProvider.write() using:
 *   tier:      "tool_execution"
 *   userId:    "__tool_learning__"  (sentinel — never a real user ID)
 *   qualifier: "stats:{toolName}"
 *
 * Updated incrementally after each CompletedToolExecution using
 * Welford-style online averaging so no historical records need to be
 * re-read on every update.
 */
export interface ToolLearningStats {
  readonly toolName: string;
  /** Total completed executions (success + failure). */
  readonly totalExecutions: number;
  readonly successCount: number;
  readonly failureCount: number;
  /**
   * Derived: successCount / totalExecutions.
   * 0 when totalExecutions === 0 (no division by zero).
   */
  readonly successRate: number;
  /** Rolling average of durationMs across all observed executions. */
  readonly avgDurationMs: number;
  /**
   * Rolling average of confidenceAtSelection across all observed executions.
   * Tracks how well M20's pre-execution confidence correlates with actual outcomes.
   */
  readonly avgConfidenceAtSelection: number;
  /** Epoch ms of the most recently recorded execution. */
  readonly lastExecutedAt: number;
  /** Whether the most recently recorded execution succeeded. */
  readonly lastSuccess: boolean;
  /** Wall-clock timestamp of the last stats update (epoch ms). */
  readonly updatedAt: number;
  /**
   * Monotonically-increasing version counter for this stat record.
   * Starts at 1 after the first record(); 0 means never persisted.
   * Used for storage write tracking (not for StorageProvider concurrency).
   */
  readonly version: number;
}

// ---------------------------------------------------------------------------
// Reader interface (consumed by M20 Tool Intelligence Layer)
// ---------------------------------------------------------------------------

/**
 * Synchronous read-only interface for the tool learning statistics cache.
 *
 * Consumed by M20 ToolIntelligenceLayer during evaluate() to adjust confidence
 * scores based on historical execution outcomes.
 *
 * SYNCHRONOUS CONTRACT:
 *   All implementations MUST be synchronous so M20.evaluate() remains sync.
 *   The implementation reads from an in-memory cache — no I/O on the read path.
 *
 * DETERMINISM GUARANTEE:
 *   Values returned here reflect only executions completed before the current
 *   request. The current execution's outcome is never reflected here during
 *   the M20 evaluate() call that precedes it.
 */
export interface ToolLearningReader {
  /**
   * Returns the latest cached stats for a (scope, toolName) triple, or null
   * when no executions have been recorded for this tool in this scope.
   *
   * Callers should treat null and { totalExecutions: 0 } identically —
   * no learning adjustment should be applied when there is no history.
   */
  getStats(scope: ToolLearningScope, toolName: string): ToolLearningStats | null;
}
