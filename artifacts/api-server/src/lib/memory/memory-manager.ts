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
  type KnowledgeRecord,
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
import type { KnowledgeManager } from "./knowledge-manager.js";

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
  "long_term_knowledge",
];

/**
 * Per-turn lower-bound token estimate used to derive the storage fetch limit.
 * Conservative (real turns average far more) so the fetch always over-provides
 * enough raw material for applyConversationBudget() to fill the allocation.
 */
const MINIMUM_TURN_TOKEN_ESTIMATE = 10;

/**
 * Hard ceiling on conversation turns fetched per load() call regardless of
 * budget allocation. Prevents unbounded storage reads for large-context models.
 */
const MAX_CONVERSATION_FETCH_LIMIT = 200;

/** Default user-fact list limit for load(). */
const DEFAULT_USER_FACT_LIMIT = 200;

/** Default long-term knowledge list limit for load(). */
const DEFAULT_KNOWLEDGE_LIMIT = 200;

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
    qualifier: scope.groupId,
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

function makeLongTermKnowledgeKey(scope: MemoryScope): StorageKey {
  return {
    tier: "long_term_knowledge",
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
    knowledgeRecords: [],
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
    private readonly knowledgeManager?: KnowledgeManager,
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
   * The conversation fetch limit is derived from the budget allocation so the
   * storage query adapts to the configured model's context window (Milestone 12).
   */
  async load(scope: MemoryScope, budget: ContextBudget): Promise<MemoryContext> {
    const loadedAt = Date.now();

    // Emit load started. context carries requestId so MemoryMetricsCollector
    // can correlate load_started → load_completed latency across requests.
    this.eventBus?.emit({
      type: "memory.load_started",
      context: { requestId: scope.requestId } as any,
      payload: { scope, timestamp: loadedAt },
    });

    try {
      const queryHint = scope.queryHint;

      // Budget-derived conversation fetch limit (Milestone 12 — A).
      // Over-fetches slightly (conservative per-turn estimate) so
      // applyConversationBudget() always has enough raw turns to fill the
      // allocation. Capped at MAX_CONVERSATION_FETCH_LIMIT to prevent
      // unbounded storage reads for large-context models.
      const conversationFetchLimit = Math.min(
        Math.ceil(budget.tierAllocations.conversation / MINIMUM_TURN_TOKEN_ESTIMATE),
        MAX_CONVERSATION_FETCH_LIMIT,
      );

      // Fetch all tiers concurrently; individual failures default to null / [].
      const [rawSession, conversationDesc, userFactValues, toolRecords, rawKnowledge] =
        await Promise.all([
          this.provider
            .read<SessionMemory>(makeSessionKey(scope))
            .catch(() => null),

          this.provider
            .list<ConversationTurn>(makeConversationKey(scope), {
              limit: conversationFetchLimit,
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

          this.knowledgeManager
            ? this.knowledgeManager
                .loadRelevant(scope, queryHint, { limit: DEFAULT_KNOWLEDGE_LIMIT })
                .catch(() => [] as KnowledgeRecord[])
            : this.provider
                .list<KnowledgeRecord>(makeLongTermKnowledgeKey(scope), {
                  limit: DEFAULT_KNOWLEDGE_LIMIT,
                  order: "asc",
                })
                .catch(() => [] as KnowledgeRecord[]),
        ]);

      // Conversation: when no query hint, provider returned desc; reverse to chronological order.
      // When query hint is set, provider returns relevance-ranked items — do NOT reverse or
      // the ranking is destroyed (ADR-005 §13.1, Milestone 3).
      const rawConversation: ConversationTurn[] = queryHint
        ? (conversationDesc ?? [])
        : [...(conversationDesc ?? [])].reverse();

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

      // KnowledgeManager owns knowledge retrieval ordering. MemoryManager only
      // assembles the already-ordered records into the context snapshot.
      const knowledgeNowMs = Date.now();
      const knowledgeRecords: KnowledgeRecord[] = (rawKnowledge ?? [])
        .filter(
          (r) =>
            r.expiresAt === undefined ||
            r.expiresAt === null ||
            r.expiresAt > knowledgeNowMs,
        )

      // Tool summary: extract from the most recent record, if any.
      const toolSummary: string | null =
        toolRecords && toolRecords.length > 0
          ? buildToolSummary(toolRecords[0]!)
          : null;

      // Milestone 15 — Session Expiration (24h sliding TTL)
      const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
      const session = rawSession && (loadedAt - rawSession.lastActivityAt < SESSION_TTL_MS)
        ? rawSession
        : null;

      // Budget accounting — delegated to the injected TokenEstimator.
      const budgetUsed =
        this.estimator.estimate(session) +
        this.estimator.estimate(conversation) +
        this.estimator.estimate(userFacts) +
        this.estimator.estimate(knowledgeRecords) +
        this.estimator.estimate(toolSummary);
      const budgetRemaining = Math.max(
        0,
        budget.modelProfile.usableContextTokens - budgetUsed,
      );

      const context: MemoryContext = {
        version: MEMORY_CONTEXT_VERSION,
        session,
        conversation,
        userFacts,
        knowledgeRecords,
        toolSummary,
        budgetUsed,
        budgetRemaining,
        loadedAt,
      };

      this.eventBus?.emit({
        type: "memory.load_completed",
        context: { requestId: scope.requestId } as any,
        payload: {
          version: context.version,
          budgetUsed: context.budgetUsed,
          tiersSummary: {
            session: session ? 1 : 0,
            conversation: conversation.length,
            user_profile: userFacts.length,
            tool_execution: toolRecords?.length ?? 0,
            request: 0,
            long_term_knowledge: knowledgeRecords.length,
          },
          timestamp: Date.now(),
        },
      });

      return context;
    } catch (err) {
      this.eventBus?.emit({
        type: "memory.load_failed",
        context: { requestId: scope.requestId } as any,
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
      context: { requestId: scope.requestId } as any,
      payload: { scope, timestamp: Date.now() },
    });

    const writes: Promise<unknown>[] = [];
    const tiersWritten: MemoryTierId[] = [];

    // -- Session (single value, replace) ------------------------------------
    // Retry once on any write failure. On a second failure emit
    // memory.write_conflict (Milestone 12 — C) then give up; the response
    // is already prepared so we must not throw.
    if (updates.session !== undefined) {
      writes.push(
        (async () => {
          const sessionKey = makeSessionKey(scope);
          // Milestone 15 — 24h Sliding TTL: Always update lastActivityAt on record
          const sessionUpdate = {
            ...updates.session,
            lastActivityAt: Date.now(),
          };
          try {
            await this.provider.write(sessionKey, sessionUpdate);
            tiersWritten.push("session");
          } catch {
            // First failure — retry once silently.
            try {
              await this.provider.write(sessionKey, sessionUpdate);
              tiersWritten.push("session");
            } catch (secondErr) {
              // Second failure — observable event + record_failed; do not throw.
              this.eventBus?.emit({
                type: "memory.write_conflict",
                context: { requestId: scope.requestId } as any,
                payload: { tier: "session", retrying: false, timestamp: Date.now() },
              });
              this.eventBus?.emit({
                type: "memory.record_failed",
                context: { requestId: scope.requestId } as any,
                payload: {
                  error: `session (write conflict): ${secondErr instanceof Error ? secondErr.message : String(secondErr)}`,
                  timestamp: Date.now(),
                },
              });
            }
          }
        })()
      );
    }

    // -- Conversation turns (append to ordered list) ------------------------
    const conversationTurns = updates.conversationTurns ??
      (updates.conversationTurn ? [updates.conversationTurn] : []);
    for (const turn of conversationTurns) {
      writes.push(
        this.provider.append(makeConversationKey(scope), turn).catch(() => {
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

    // -- Long-term knowledge (upsert into map keyed by record.key) ----------
    if (updates.knowledgeRecords && updates.knowledgeRecords.length > 0) {
      for (const record of updates.knowledgeRecords) {
        writes.push((this.knowledgeManager
          ? this.knowledgeManager.upsert(scope, record)
          : this.provider.upsert(makeLongTermKnowledgeKey(scope), record.key, record)
        ).catch(() => {
          // best-effort
        }));
      }
      tiersWritten.push("long_term_knowledge");
    }

    // Fire all writes concurrently; individual catch handlers above absorb failures.
    await Promise.all(writes);

    this.eventBus?.emit({
      type: "memory.record_completed",
      context: { requestId: scope.requestId } as any,
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
      await this.knowledgeManager?.removeAll(scope);
      await this.provider.delete(makeScopePrefix(scope));
    } catch (cause) {
      throw new MemoryError("forget", scope, cause);
    }
  }

  async clearConversation(scope: MemoryScope): Promise<void> {
    try {
      await this.provider.delete(makeConversationKey(scope));
    } catch (cause) {
      throw new MemoryError("forget", scope, cause);
    }
  }

  async forgetBot(scope: Pick<MemoryScope, "tenantId" | "botId">): Promise<void> {
    try {
      await this.provider.delete({
        tenantId: scope.tenantId,
        botId: scope.botId,
      });
    } catch (cause) {
      throw new MemoryError("forget", {
        tenantId: scope.tenantId,
        botId: scope.botId,
        userId: "(all)",
      }, cause);
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
