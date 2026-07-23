/**
 * Phase 3C — Memory Pruning & Storage Hygiene (ADR-005, Milestone 5)
 *
 * A deterministic background maintenance service that prevents unbounded
 * storage growth across the session, conversation, and tool_execution tiers.
 *
 * Scope of this service:
 *   SESSION        — deletes the record when now − lastActivityAt > sessionTtlMs
 *   CONVERSATION   — prunes turns older than maxConversationAgeMs and/or beyond
 *                    maxConversationTurns (oldest turns first, most recent kept)
 *   TOOL_EXECUTION — retains only the most recent maxToolExecutionRecords entries
 *   USER_PROFILE   — intentionally excluded; managed by ConfidenceDecayService
 *                    (facts are auditable and must never be physically deleted)
 *
 * Design rules:
 *   - MUST NOT run on the request path.  Wire to a scheduled background job or
 *     an admin-triggered maintenance endpoint.
 *   - The injectable nowMs clock makes every sweep deterministic and fully testable.
 *   - List-trimming follows delete → sequential-reappend to stay within the
 *     StorageProvider interface contract.  Concurrent appends are unsafe because
 *     InMemoryStorageProvider's append() is not atomic; PostgresStorageProvider
 *     similarly lacks a transactional bulk-replace primitive.
 *   - Pruning is best-effort per tier: a failure in one tier does not block the
 *     others; the caller receives a PruneResult summarising what succeeded.
 *   - No new AgentEvent types are emitted (none are defined in the ADR for pruning).
 *
 * Nothing in this file touches routes, the agent runtime, or PromptManager.
 */

import {
  type ConversationTurn,
  type MemoryScope,
  type SessionMemory,
  type StorageKey,
  type StorageProvider,
  type ToolExecutionRecord,
} from "./types.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Controls thresholds for each pruning tier.
 * All fields are optional — pass a partial config and the rest will use defaults.
 */
export interface StoragePrunerConfig {
  /**
   * Session idle TTL in milliseconds.
   * Sessions whose lastActivityAt is older than this are deleted.
   * Default: 4 hours (matching the documented SessionMemory TTL).
   */
  readonly sessionTtlMs: number;

  /**
   * Maximum number of conversation turns to retain per user/session scope.
   * Excess turns (oldest first) are pruned.
   * Default: 100.
   */
  readonly maxConversationTurns: number;

  /**
   * Maximum age of a conversation turn in milliseconds.
   * Turns older than this are eligible for pruning even if count < maxConversationTurns.
   * At least 1 turn is always preserved (safety guard).
   * Default: 30 days.
   */
  readonly maxConversationAgeMs: number;

  /**
   * Maximum number of tool execution records to retain per user scope.
   * Excess records (oldest first) are pruned.
   * Default: 50.
   */
  readonly maxToolExecutionRecords: number;
}

/** Sensible production defaults. Override any field at construction time. */
export const DEFAULT_PRUNER_CONFIG: StoragePrunerConfig = {
  sessionTtlMs:            4 * 60 * 60 * 1_000,       // 4 hours
  maxConversationTurns:    100,
  maxConversationAgeMs:    30 * 24 * 60 * 60 * 1_000,  // 30 days
  maxToolExecutionRecords: 50,
};

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/**
 * Summary of one runPrune() execution.
 * All counts refer to items removed from storage in this sweep.
 */
export interface PruneResult {
  /** 1 if the session record was deleted, 0 if it was kept or absent. */
  readonly sessionsRemoved: number;
  /** Number of conversation turns removed from storage. */
  readonly conversationTurnsPruned: number;
  /** Number of tool execution records removed from storage. */
  readonly toolRecordsPruned: number;
  /** The nowMs value used for this sweep (injectable clock). */
  readonly timestamp: number;
}

// ---------------------------------------------------------------------------
// StorageKey construction helpers (private to this module)
// ---------------------------------------------------------------------------

function makeSessionKey(scope: MemoryScope): StorageKey {
  return {
    tier: "session",
    tenantId: scope.tenantId,
    botId: scope.botId,
    userId: scope.userId,
    qualifier: scope.sessionId,
  };
}

function makeConversationKey(scope: MemoryScope): StorageKey {
  return {
    tier: "conversation",
    tenantId: scope.tenantId,
    botId: scope.botId,
    userId: scope.userId,
  };
}

function makeToolExecutionKey(scope: MemoryScope): StorageKey {
  return {
    tier: "tool_execution",
    tenantId: scope.tenantId,
    botId: scope.botId,
    userId: scope.userId,
  };
}

// ---------------------------------------------------------------------------
// StoragePruner
// ---------------------------------------------------------------------------

/**
 * Background maintenance service for storage hygiene.
 *
 * Usage:
 *   const pruner = new StoragePruner(provider, { maxConversationTurns: 200 });
 *   const result = await pruner.runPrune(scope, Date.now());
 *
 * Wire to a scheduled job — never call from a request handler.
 */
export class StoragePruner {
  private readonly config: StoragePrunerConfig;

  constructor(
    private readonly provider: StorageProvider,
    config?: Partial<StoragePrunerConfig>,
  ) {
    this.config = { ...DEFAULT_PRUNER_CONFIG, ...config };
  }

  // -------------------------------------------------------------------------
  // Session pruning
  // -------------------------------------------------------------------------

  /**
   * Deletes the session record if it has been idle longer than sessionTtlMs.
   *
   * @param scope  Must include sessionId to address the correct session record.
   *               Scopes without sessionId are silently skipped (returns false).
   * @param nowMs  Injectable clock. Defaults to Date.now().
   * @returns      true if the session was deleted, false if kept or absent.
   */
  async pruneSession(scope: MemoryScope, nowMs: number = Date.now()): Promise<boolean> {
    if (!scope.sessionId) return false;

    const key = makeSessionKey(scope);
    let session: SessionMemory | null;
    try {
      session = await this.provider.read<SessionMemory>(key);
    } catch {
      return false;
    }

    if (!session) return false;

    const idleMs = nowMs - session.lastActivityAt;
    if (idleMs <= this.config.sessionTtlMs) return false;

    try {
      await this.provider.delete(key);
      return true;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Conversation pruning
  // -------------------------------------------------------------------------

  /**
   * Prunes conversation turns that are either too old or exceed the retention limit.
   *
   * Retention policy (applied in this order):
   *   1. Always keep the most recent maxConversationTurns turns.
   *   2. Of the remaining turns, discard any older than maxConversationAgeMs.
   *   3. Safety guard: at least 1 turn is always kept regardless of age.
   *
   * These are the turns that have already been evicted from context by
   * applyConversationBudget() during load() — pruning them from storage
   * prevents unbounded growth without losing any information the LLM
   * would still receive.
   *
   * @returns Number of turns removed.
   */
  async pruneConversation(scope: MemoryScope, nowMs: number = Date.now()): Promise<number> {
    const key = makeConversationKey(scope);

    let turns: ConversationTurn[];
    try {
      turns = await this.provider.list<ConversationTurn>(key, {
        limit: 50_000,
        order: "asc", // oldest first — matches natural append order
      });
    } catch {
      return 0;
    }

    if (turns.length === 0) return 0;

    // Step 1 — Count rule (unconditional): always prune the oldest excess turns.
    //   Retain only the most recent maxConversationTurns items.
    //   These are the turns that would survive the sliding-window in load()
    //   and have already been represented by a synthetic summary for the rest.
    const recentStart = Math.max(0, turns.length - this.config.maxConversationTurns);
    const afterCountPrune = turns.slice(recentStart);

    // Step 2 — Age rule: from the count-survivors, additionally prune any turn
    //   older than maxConversationAgeMs.  This catches cases where count is within
    //   limit but individual turns are stale and no longer worth retaining.
    const cutoffTimestamp = nowMs - this.config.maxConversationAgeMs;
    const afterAgePrune = afterCountPrune.filter(
      (t) => t.timestamp > cutoffTimestamp,
    );

    // Step 3 — Safety guard: always keep at least 1 turn (the most recent).
    const kept = afterAgePrune.length > 0 ? afterAgePrune : [turns[turns.length - 1]!];

    const pruned = turns.length - kept.length;
    if (pruned === 0) return 0;

    // Delete the entire list and sequentially re-append survivors.
    // Sequential (not concurrent) because InMemoryStorageProvider's append() reads
    // the current list — concurrent appends race and overwrite each other.
    try {
      await this.provider.delete(key);
      for (const turn of kept) {
        await this.provider.append(key, turn);
      }
    } catch {
      // Best-effort: partial failure means some turns may be lost; acceptable for
      // a background maintenance pass. Next sweep will be a no-op on survivors.
      return 0;
    }

    return pruned;
  }

  // -------------------------------------------------------------------------
  // Tool execution compaction
  // -------------------------------------------------------------------------

  /**
   * Retains only the most recent maxToolExecutionRecords tool execution records,
   * deleting older entries.
   *
   * Tool records serve as an audit trail and reflection input. Keeping the most
   * recent N is sufficient for both purposes — older records are of limited value
   * once they have been summarised into toolSummary during load().
   *
   * @returns Number of records removed.
   */
  async pruneToolExecutions(scope: MemoryScope): Promise<number> {
    const key = makeToolExecutionKey(scope);

    let records: ToolExecutionRecord[];
    try {
      records = await this.provider.list<ToolExecutionRecord>(key, {
        limit: 50_000,
        order: "asc", // oldest first
      });
    } catch {
      return 0;
    }

    if (records.length <= this.config.maxToolExecutionRecords) return 0;

    // Keep only the most recent maxToolExecutionRecords.
    const kept   = records.slice(records.length - this.config.maxToolExecutionRecords);
    const pruned = records.length - kept.length;

    try {
      await this.provider.delete(key);
      for (const record of kept) {
        await this.provider.append(key, record);
      }
    } catch {
      return 0;
    }

    return pruned;
  }

  // -------------------------------------------------------------------------
  // Full sweep
  // -------------------------------------------------------------------------

  /**
   * Runs all pruning operations for the given scope and returns a summary.
   *
   * Each tier is attempted independently — a failure in one does not prevent
   * the others from running.
   *
   * @param scope  The tenant/bot/user/session scope to prune.
   * @param nowMs  Injectable clock. Defaults to Date.now().
   */
  async runPrune(scope: MemoryScope, nowMs: number = Date.now()): Promise<PruneResult> {
    const [sessionRemoved, conversationTurnsPruned, toolRecordsPruned] = await Promise.all([
      this.pruneSession(scope, nowMs).then(removed => (removed ? 1 : 0)),
      this.pruneConversation(scope, nowMs),
      this.pruneToolExecutions(scope),
    ]);

    return {
      sessionsRemoved: sessionRemoved,
      conversationTurnsPruned,
      toolRecordsPruned,
      timestamp: nowMs,
    };
  }

  /**
   * M15-F4: Global background sweep.
   * Discovers all active scopes and runs runPrune on each.
   */
  async runPruneAll(nowMs: number = Date.now()): Promise<PruneResult & { scopeCount: number; durationMs: number }> {
    const start = Date.now();
    const scopes = await this.provider.listActiveScopes();
    let totalSession = 0;
    let totalConversation = 0;
    let totalTool = 0;

    for (const scopeInfo of scopes) {
      // Reconstruct MemoryScope (requestId is not needed for background pruning)
      const baseScope: MemoryScope = {
        ...scopeInfo,
        requestId: "system-prune-" + nowMs,
      };

      // M15-F4: Session discovery — for each scope, find all sessions and prune them
      const sessionKey: StorageKey = { tier: "session", ...scopeInfo };
      let sessions: SessionMemory[] = [];
      try {
        sessions = await this.provider.list<SessionMemory>(sessionKey, { limit: 100, order: "asc" });
      } catch {
        // Silently skip if listing fails
      }

      for (const session of sessions) {
        const removed = await this.pruneSession({ ...baseScope, sessionId: session.sessionId }, nowMs);
        if (removed) totalSession++;
      }
      
      const result = await this.runPrune(baseScope, nowMs);
      // Note: runPrune already handles pruneSession if baseScope.sessionId is present.
      // Since baseScope.sessionId is undefined here, runPrune will skip session pruning.
      totalConversation += result.conversationTurnsPruned;
      totalTool += result.toolRecordsPruned;
    }

    return {
      scopeCount: scopes.length,
      sessionsRemoved: totalSession,
      conversationTurnsPruned: totalConversation,
      toolRecordsPruned: totalTool,
      timestamp: nowMs,
      durationMs: Date.now() - start,
    };
  }
}
