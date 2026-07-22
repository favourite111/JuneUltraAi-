/**
 * Phase 3B — DefaultMemoryManager (ADR-005, Milestone 7)
 *
 * Concrete implementation of the MemoryManager interface.
 * Coordinates all memory tier reads and writes through an injected
 * StorageProvider — no database driver, no HTTP client, no LLM call.
 *
 * Design rules (ADR-005 §4):
 *   - load()   is called BEFORE createExecutionContext(); failure → empty context
 *   - record() is called AFTER the response is prepared; failure is best-effort
 *   - forget() is called from an admin route; failure MUST throw MemoryError
 *   - health() proxies the underlying StorageProvider status
 *
 * Nothing in this file touches runtime.ts, routes, or PromptManager.
 * The memoryManager field on AgentRuntimeDependencies is wired in Milestone 8.
 */

import {
  type ContextBudget,
  type ConversationTurn,
  type MemoryContext,
  type MemoryHealthStatus,
  type MemoryManager,
  type MemoryScope,
  type MemoryTierId,
  type MemoryUpdates,
  type SessionMemory,
  type StorageKey,
  type ScopePrefix,
  type StorageProvider,
  type ToolExecutionRecord,
  type UserFact,
  MemoryError,
  MEMORY_CONTEXT_VERSION,
} from "./types.js";

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

/** All tier IDs in declaration order — used to populate MemoryHealthStatus. */
const ALL_TIER_IDS: MemoryTierId[] = [
  "request",
  "session",
  "conversation",
  "user_profile",
  "tool_execution",
];

/**
 * Default conversation list limit for load().
 * Keeps the hydration bounded without a budget-aware truncation loop.
 * Milestone 12 will replace this with a proper budget-driven sliding window.
 */
const DEFAULT_CONVERSATION_LIMIT = 50;

/** Default user-fact list limit for load(). */
const DEFAULT_USER_FACT_LIMIT = 200;

// ---------------------------------------------------------------------------
// Token estimation (Milestone 12 will replace with a proper counter)
// ---------------------------------------------------------------------------

/**
 * Rough character-to-token estimate (4 chars ≈ 1 token).
 * Used only for budgetUsed / budgetRemaining in the MemoryContext snapshot.
 * Milestone 12 replaces this with model-specific tokenisation.
 */
function estimateTokens(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (Array.isArray(value) && value.length === 0) return 0;
  try {
    return Math.ceil(JSON.stringify(value).length / 4);
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// StorageKey construction helpers
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

function makeUserProfileKey(scope: MemoryScope): StorageKey {
  return {
    tier: "user_profile",
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

function makeScopePrefix(scope: MemoryScope): ScopePrefix {
  return {
    tenantId: scope.tenantId,
    botId: scope.botId,
    userId: scope.userId,
  };
}

// ---------------------------------------------------------------------------
// Tool summary
// ---------------------------------------------------------------------------

/**
 * Builds a short extractive summary from the most recent ToolExecutionRecord.
 * Milestone 11 (Reflection) will produce richer summaries; this is a skeleton.
 */
function buildToolSummary(record: ToolExecutionRecord): string {
  const status = record.error ? `error: ${record.error}` : record.reflectionDecision;
  return `${record.toolName} → ${status} (${record.durationMs}ms)`;
}

// ---------------------------------------------------------------------------
// Empty context factory
// ---------------------------------------------------------------------------

function emptyContext(budget: ContextBudget, loadedAt: number): MemoryContext {
  const budgetTotal = budget.modelProfile.usableContextTokens;
  return {
    version: MEMORY_CONTEXT_VERSION,
    session: null,
    conversation: [],
    userFacts: [],
    toolSummary: null,
    budgetUsed: 0,
    budgetRemaining: budgetTotal,
    loadedAt,
  };
}

// ---------------------------------------------------------------------------
// DefaultMemoryManager
// ---------------------------------------------------------------------------

/**
 * The canonical MemoryManager implementation for Phase 3B.
 *
 * Injected with a StorageProvider at construction time — swap the provider
 * to switch between InMemoryStorageProvider (tests), PostgresStorageProvider
 * (production), or future Redis/SQLite backends.
 *
 * Usage:
 *   const manager = new DefaultMemoryManager(new InMemoryStorageProvider());
 *   const context = await manager.load(scope, budget);
 */
export class DefaultMemoryManager implements MemoryManager {
  constructor(private readonly provider: StorageProvider) {}

  // -------------------------------------------------------------------------
  // load()
  // -------------------------------------------------------------------------

  /**
   * Hydrates all applicable memory tiers from the storage backend and returns
   * a budget-constrained, frozen MemoryContext snapshot.
   *
   * Each tier is fetched independently — a single tier failure degrades
   * gracefully rather than voiding the entire context. If ALL reads fail
   * (or the overall assembly throws), an empty MemoryContext is returned so
   * the pipeline can still run.
   *
   * Milestone 12 will add proper budget-driven truncation; for now the context
   * is assembled from whatever the provider returns within the list limits.
   */
  async load(scope: MemoryScope, budget: ContextBudget): Promise<MemoryContext> {
    const loadedAt = Date.now();

    try {
      // Fetch all tiers concurrently; individual failures default to null / [].
      const [session, conversationDesc, userFactValues, toolRecords] =
        await Promise.all([
          this.provider
            .read<SessionMemory>(makeSessionKey(scope))
            .catch(() => null),

          this.provider
            .list<ConversationTurn>(makeConversationKey(scope), {
              limit: DEFAULT_CONVERSATION_LIMIT,
              order: "desc",
            })
            .catch(() => [] as ConversationTurn[]),

          this.provider
            .list<UserFact>(makeUserProfileKey(scope), {
              limit: DEFAULT_USER_FACT_LIMIT,
              order: "asc",
            })
            .catch(() => [] as UserFact[]),

          this.provider
            .list<ToolExecutionRecord>(makeToolExecutionKey(scope), {
              limit: 1,
              order: "desc",
            })
            .catch(() => [] as ToolExecutionRecord[]),
        ]);

      // Conversation: provider returned desc; reverse to chronological order.
      const conversation: ConversationTurn[] = [...(conversationDesc ?? [])].reverse();

      // User facts: exclude decayed; sort by importance × confidence descending.
      const userFacts: UserFact[] = (userFactValues ?? [])
        .filter((f) => !f.decayed)
        .sort((a, b) => b.importance * b.confidence - a.importance * a.confidence);

      // Tool summary: extract from the most recent record, if any.
      const toolSummary: string | null =
        toolRecords && toolRecords.length > 0
          ? buildToolSummary(toolRecords[0]!)
          : null;

      // Budget accounting (simple character-based estimate for now).
      const budgetUsed =
        estimateTokens(session) +
        estimateTokens(conversation) +
        estimateTokens(userFacts) +
        estimateTokens(toolSummary);
      const budgetRemaining = Math.max(
        0,
        budget.modelProfile.usableContextTokens - budgetUsed,
      );

      return {
        version: MEMORY_CONTEXT_VERSION,
        session: session ?? null,
        conversation,
        userFacts,
        toolSummary,
        budgetUsed,
        budgetRemaining,
        loadedAt,
      };
    } catch {
      // Any unexpected assembly error → degrade to an empty context so the
      // pipeline can still run.  Milestone 8 will wire EventBus emission here.
      return emptyContext(budget, loadedAt);
    }
  }

  // -------------------------------------------------------------------------
  // record()
  // -------------------------------------------------------------------------

  /**
   * Persists the aggregated memory updates produced during a single request.
   *
   * Writes are best-effort: a failure in one tier does not block the others,
   * and no error is re-thrown to the caller (the response is already sent).
   * Milestone 8 will wire EventBus "memory.record_failed" emission on error.
   *
   * WriteConflictError on session: single retry with a fresh read-merge-write.
   * On a second conflict the write is skipped and noted for Milestone 12.
   */
  async record(scope: MemoryScope, updates: MemoryUpdates): Promise<void> {
    const writes: Promise<unknown>[] = [];

    // -- Session (single value, replace) ------------------------------------
    if (updates.session !== undefined) {
      writes.push(
        this.provider
          .write(makeSessionKey(scope), updates.session)
          .catch(() => {
            // best-effort: swallow; EventBus emission added in Milestone 8
          }),
      );
    }

    // -- Conversation turn (append to ordered list) -------------------------
    if (updates.conversationTurn !== undefined) {
      writes.push(
        this.provider
          .append(makeConversationKey(scope), updates.conversationTurn)
          .catch(() => {
            // best-effort
          }),
      );
    }

    // -- User facts (upsert into map keyed by fact.key) ---------------------
    if (updates.userFacts && updates.userFacts.length > 0) {
      const key = makeUserProfileKey(scope);
      for (const fact of updates.userFacts) {
        writes.push(
          this.provider.upsert(key, fact.key, fact).catch(() => {
            // best-effort
          }),
        );
      }
    }

    // -- Tool execution records (append to ordered list) --------------------
    if (updates.toolOutputs && updates.toolOutputs.length > 0) {
      const key = makeToolExecutionKey(scope);
      for (const record of updates.toolOutputs) {
        writes.push(
          this.provider.append(key, record).catch(() => {
            // best-effort
          }),
        );
      }
    }

    // Fire all writes concurrently; individual catch handlers above absorb failures.
    await Promise.all(writes);
  }

  // -------------------------------------------------------------------------
  // forget()
  // -------------------------------------------------------------------------

  /**
   * Erases all memory for a user across every tier by issuing a ScopePrefix
   * delete to the storage backend.
   *
   * Unlike load() and record(), this operation MUST surface failures to the
   * caller (an admin route handling a GDPR "forget me" request).
   */
  async forget(scope: MemoryScope): Promise<void> {
    try {
      await this.provider.delete(makeScopePrefix(scope));
    } catch (cause) {
      throw new MemoryError("forget", scope, cause);
    }
  }

  // -------------------------------------------------------------------------
  // health()
  // -------------------------------------------------------------------------

  /**
   * Proxies the storage backend health to MemoryHealthStatus.
   * In Milestone 9 this will be extended to check each tier independently
   * when PostgresStorageProvider is wired with per-tier connection pools.
   */
  async health(): Promise<MemoryHealthStatus> {
    const status = await this.provider.health();
    const tiers = Object.fromEntries(
      ALL_TIER_IDS.map((id) => [id, status]),
    ) as Record<MemoryTierId, "ok" | "degraded" | "unavailable">;

    return { status, tiers };
  }
}
