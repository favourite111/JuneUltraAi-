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
import type { EventBus } from "../tools/types.js";
import {
  type TokenEstimator,
  CharacterTokenEstimator,
} from "./token-estimator.js";
import {
  type ConversationSummarizer,
  ExtractiveConversationSummarizer,
} from "./conversation-summarizer.js";

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
  private readonly estimator: TokenEstimator;
  private readonly summarizer: ConversationSummarizer;

  constructor(
    private readonly provider: StorageProvider,
    private readonly eventBus?: EventBus,
    estimator?: TokenEstimator,
    summarizer?: ConversationSummarizer,
  ) {
    this.estimator = estimator ?? new CharacterTokenEstimator();
    this.summarizer = summarizer ?? new ExtractiveConversationSummarizer();
  }

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

    // Emit load started if bus is present. Note: context is null here as it's not yet created.
    this.eventBus?.emit({
      type: "memory.load_started",
      context: null as any,
      payload: { scope, timestamp: loadedAt },
    });

    try {
      // Thread the optional query hint into list calls that benefit from
      // relevance ranking (conversation and user_profile tiers).
      // When queryHint is absent, similarityQuery is undefined and providers
      // fall back to their default insertion-order behaviour (ADR-005 §13.1).
      const queryHint = scope.queryHint;

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
              similarityQuery: queryHint,
            })
            .catch(() => [] as ConversationTurn[]),

          this.provider
            .list<UserFact>(makeUserProfileKey(scope), {
              limit: DEFAULT_USER_FACT_LIMIT,
              order: "asc",
              similarityQuery: queryHint,
            })
            .catch(() => [] as UserFact[]),

          this.provider
            .list<ToolExecutionRecord>(makeToolExecutionKey(scope), {
              limit: 1,
              order: "desc",
              // Tool execution records are not query-ranked — always most recent.
            })
            .catch(() => [] as ToolExecutionRecord[]),
        ]);

      // Conversation: provider returned desc; reverse to chronological order.
      const rawConversation: ConversationTurn[] = [...(conversationDesc ?? [])].reverse();

      // Apply conversation budget: trim oldest turns until estimate fits the
      // tier allocation, then prepend a synthetic summary turn for the dropped
      // turns.  ADR-005 §9.3 rule 1: the most recent turn is always kept.
      // ADR-005 §9.4: evicted turns are replaced with a deterministic
      // extractive summary; no LLM call.
      const conversation = this.applyConversationBudget(
        rawConversation,
        budget.tierAllocations.conversation,
        scope,
      );

      // User facts: exclude decayed; sort by importance × confidence descending.
      const userFacts: UserFact[] = (userFactValues ?? [])
        .filter((f) => !f.decayed)
        .sort((a, b) => b.importance * b.confidence - a.importance * a.confidence);

      // Tool summary: extract from the most recent record, if any.
      const toolSummary: string | null =
        toolRecords && toolRecords.length > 0
          ? buildToolSummary(toolRecords[0]!)
          : null;

      // Budget accounting — delegated to the injected TokenEstimator.
      const budgetUsed =
        this.estimator.estimate(session) +
        this.estimator.estimate(conversation) +
        this.estimator.estimate(userFacts) +
        this.estimator.estimate(toolSummary);
      const budgetRemaining = Math.max(
        0,
        budget.modelProfile.usableContextTokens - budgetUsed,
      );

      const context: MemoryContext = {
        version: MEMORY_CONTEXT_VERSION,
        session: session ?? null,
        conversation,
        userFacts,
        toolSummary,
        budgetUsed,
        budgetRemaining,
        loadedAt,
      };

      this.eventBus?.emit({
        type: "memory.load_completed",
        context: null as any,
        payload: {
          version: context.version,
          budgetUsed: context.budgetUsed,
          tiersSummary: {
            session: session ? 1 : 0,
            conversation: conversation.length,
            user_profile: userFacts.length,
            tool_execution: toolRecords?.length ?? 0,
            request: 0,
          },
          timestamp: Date.now(),
        },
      });

      return context;
    } catch (err) {
      this.eventBus?.emit({
        type: "memory.load_failed",
        context: null as any,
        payload: { error: err instanceof Error ? err.message : String(err), timestamp: Date.now() },
      });
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
    this.eventBus?.emit({
      type: "memory.record_started",
      context: null as any,
      payload: { scope, timestamp: Date.now() },
    });

    const writes: Promise<unknown>[] = [];
    const tiersWritten: MemoryTierId[] = [];

    // -- Session (single value, replace) ------------------------------------
    if (updates.session !== undefined) {
      writes.push(
        this.provider
          .write(makeSessionKey(scope), updates.session)
          .then(() => { tiersWritten.push("session"); })
          .catch((err) => {
            this.eventBus?.emit({
              type: "memory.record_failed",
              context: null as any,
              payload: { error: `session: ${err.message}`, timestamp: Date.now() },
            });
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

    this.eventBus?.emit({
      type: "memory.record_completed",
      context: null as any,
      payload: { tiersWritten, timestamp: Date.now() },
    });
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

  // -------------------------------------------------------------------------
  // applyConversationBudget() — private
  // -------------------------------------------------------------------------

  /**
   * Enforces the conversation tier token allocation (ADR-005 §9.3 and §9.4).
   *
   * Algorithm:
   *   1. If the full conversation fits within the tier allocation, return it
   *      unchanged.
   *   2. Otherwise, remove turns from the oldest end (index 0) one by one
   *      until the remaining slice fits.  The most recent turn is always kept
   *      (ADR-005 §9.3 rule 1).
   *   3. If any turns were removed, call the injected ConversationSummarizer
   *      to produce a deterministic extractive summary of the dropped turns,
   *      then prepend a synthetic ConversationTurn carrying that summary so
   *      the LLM retains semantic context for the evicted history.
   *
   * The synthetic summary turn is ephemeral — it exists only in the returned
   * MemoryContext snapshot and is never written to storage.
   *
   * @param turns       Chronologically ordered conversation turns.
   * @param tokenBudget Max tokens available for the conversation tier.
   * @param scope       The current request scope (used for synthetic turn IDs).
   * @returns           The (possibly truncated + summary-prefixed) conversation.
   */
  private applyConversationBudget(
    turns: ConversationTurn[],
    tokenBudget: number,
    scope: MemoryScope,
  ): ConversationTurn[] {
    // Fast path: fits within budget — no truncation needed.
    if (this.estimator.estimate(turns) <= tokenBudget) {
      return turns;
    }

    // Trim from the oldest end until the slice fits.
    // We always keep at least the last turn (ADR-005 §9.3 rule 1).
    let remaining = [...turns];
    const evicted: ConversationTurn[] = [];

    while (
      remaining.length > 1 &&
      this.estimator.estimate(remaining) > tokenBudget
    ) {
      evicted.push(remaining.shift()!);
    }

    if (evicted.length === 0) {
      // Nothing could be evicted (single-turn edge case) — return as-is.
      return remaining;
    }

    // Build a synthetic summary turn from the evicted slice.
    // turnId is deterministic: derived from the first evicted turn's timestamp.
    const summaryContent = this.summarizer.summarize(evicted);
    const syntheticTurn: ConversationTurn = {
      turnId:    `summary-${evicted[0]!.timestamp}`,
      requestId: scope.requestId,
      role:      "assistant",
      content:   summaryContent,
      timestamp: evicted[0]!.timestamp,
    };

    // Emit truncation event for observability (ADR-005 events table).
    this.eventBus?.emit({
      type: "memory.budget_truncated",
      context: null as any,
      payload: {
        removedTiers: ["conversation"] as any,
        tokensSaved: this.estimator.estimate(evicted),
        timestamp: Date.now(),
      },
    });

    return [syntheticTurn, ...remaining];
  }
}
