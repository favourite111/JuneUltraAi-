/**
 * Phase 3B — Contextual Memory Architecture (ADR-005)
 *
 * All memory interfaces are defined here and are self-contained — this file
 * does not import from lib/tools/types.ts to avoid circular dependencies.
 * lib/tools/types.ts imports from this file (one-way dependency).
 *
 * Nothing in this file touches a database driver, the agent runtime, or any
 * route handler. It is contracts only.
 */

// ---------------------------------------------------------------------------
// Tier identity
// ---------------------------------------------------------------------------

/**
 * Stable identifier for each memory tier.
 * Used as a discriminant in StorageKey, event payloads, and budget maps.
 */
export type MemoryTierId =
  | "request"
  | "session"
  | "conversation"
  | "user_profile"
  | "tool_execution";

// ---------------------------------------------------------------------------
// Scope & identity
// ---------------------------------------------------------------------------

/**
 * Fully-qualified identity triple that scopes every memory read and write.
 * The StorageProvider must reject any operation that omits tenantId, botId,
 * or userId.
 */
export interface MemoryScope {
  /** Isolates deployment-level tenants. */
  readonly tenantId: string;
  /** Isolates individual bot registrations within a tenant. */
  readonly botId: string;
  /** Isolates individual users within a bot. */
  readonly userId: string;
  /** Optional session boundary — used by the session tier. */
  readonly sessionId?: string;
  /** Unique per-request; used for write attribution in ToolExecutionRecord. */
  readonly requestId: string;
  /**
   * Optional hint from the current user message, threaded into
   * ListOptions.similarityQuery for relevance-ranked retrieval (ADR-005 §13.1).
   * When absent, retrieval falls back to insertion-order (existing behaviour).
   * Additive extension — Milestone 3.
   */
  readonly queryHint?: string;
}

// ---------------------------------------------------------------------------
// Tier data shapes
// ---------------------------------------------------------------------------

/**
 * Ephemeral working state for the current pipeline invocation.
 * Never persisted. Destroyed when execute() returns.
 * Cross-cutting fields (routing decision, LLM decision) are typed as
 * Record<string, unknown> to keep this file free of tool-layer imports.
 */
export interface RequestMemory {
  readonly routingDecision?: Record<string, unknown>;
  readonly llmDecision?: Record<string, unknown>;
  readonly toolArgs?: Record<string, unknown>;
  readonly reflectionNotes: string[];
  readonly timings: Record<string, number>;
  readonly warnings: string[];
}

/**
 * Short-lived state spanning multiple requests within a single interaction
 * window (e.g. a WhatsApp conversation within one day).
 * Default TTL: 4 hours from last activity.
 */
export interface SessionMemory {
  readonly sessionId: string;
  readonly lastActivityAt: number;
  readonly userMood: string;
  readonly conversationStage: string;
  readonly personalityTemp: string;
  readonly questionChainDepth: number;
  readonly activeTopics: string[];
  readonly recentBotPhrases: string[];
  readonly greetingDone: boolean;
}

/**
 * One turn of conversation history (user or assistant message).
 * Append-only; oldest turns are evicted via sliding window.
 */
export interface ConversationTurn {
  readonly turnId: string;
  readonly requestId: string;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly timestamp: number;
  readonly toolUsed?: string;
  /** Estimated token count for budget tracking. */
  readonly tokenCount?: number;
}

/**
 * A long-lived objective fact about the user.
 *
 * confidence — certainty that the fact is currently true (0.0–1.0).
 * importance — relevance weight used for eviction ordering (0.0–1.0).
 *              Does not decay; assigned at write time based on fact category.
 *
 * Eviction order when budget is exhausted:
 *   drop ascending (importance × decayedConfidence) — lowest score first.
 *
 * Facts with decayed: true are excluded from MemoryContext injection but
 * retained in storage to seed future event-sourcing (ADR-006).
 */
export interface UserFact {
  readonly factId: string;
  /** Stable key, e.g. "name", "language", "city". */
  readonly key: string;
  readonly value: string;
  /** 0.0–1.0 — certainty that this fact is currently true. Decays over time. */
  readonly confidence: number;
  /**
   * 0.0–1.0 — relevance weight used for eviction ordering.
   * Does not decay. Assigned at write time from ImportanceDefaults.
   */
  readonly importance: number;
  readonly source: "explicit" | "inferred" | "tool";
  readonly createdAt: number;
  readonly confirmedAt: number;
  readonly expiresAt?: number;
  /** Governs injection, logging, and decay rules. */
  readonly sensitive: boolean;
  /**
   * Set true by the background sweep when decayedConfidence < minimumConfidence.
   * Decayed facts are excluded from MemoryContext injection until re-confirmed.
   */
  readonly decayed?: boolean;
}

/**
 * Default importance scores per fact category.
 * Deployment-level configuration — not a runtime constant.
 */
export const DEFAULT_IMPORTANCE_SCORES: Record<string, number> = {
  name:                1.00,
  language:            0.95,
  city:                0.80,
  country:             0.80,
  occupation:          0.70,
  relationship_status: 0.60,
  "interests.*":       0.30,
  "preferences.*":     0.15,
};

/**
 * Tamper-evident audit record of one tool invocation.
 * Written by MemoryManager.record() after reflection completes.
 */
export interface ToolExecutionRecord {
  readonly executionId: string;
  readonly requestId: string;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly args: Record<string, unknown>;
  /** Omitted for sensitive tools (see ToolStorageRules). */
  readonly result?: Record<string, unknown>;
  readonly error?: string;
  readonly reflectionDecision: string;
  readonly durationMs: number;
  readonly timestamp: number;
}

// ---------------------------------------------------------------------------
// MemoryContext — the frozen snapshot injected into ExecutionContext
// ---------------------------------------------------------------------------

/**
 * Budget-constrained snapshot of all memory tiers, frozen into ExecutionContext
 * before the pipeline begins. Read-only inside execute().
 *
 * version — incremented on every structural change so callers can detect and
 *            discard stale snapshots during replay.
 */
export interface MemoryContext {
  /**
   * Schema version — increment this constant whenever the MemoryContext
   * structure changes in a way that requires migration.
   */
  readonly version: number;
  readonly session: SessionMemory | null;
  readonly conversation: readonly ConversationTurn[];
  /** Active (non-decayed) user facts, sorted by importance × confidence desc. */
  readonly userFacts: readonly UserFact[];
  /** Short extractive summary of the most recent tool invocation, or null. */
  readonly toolSummary: string | null;
  /** Tokens consumed by this context snapshot. */
  readonly budgetUsed: number;
  /** Tokens remaining for the prompt template and LLM reply. */
  readonly budgetRemaining: number;
  /** Wall-clock timestamp when MemoryManager.load() was called. */
  readonly loadedAt: number;
}

/** Increment on every structural change to MemoryContext. */
export const MEMORY_CONTEXT_VERSION = 1;

// ---------------------------------------------------------------------------
// Updates — what the route handler passes to MemoryManager.record()
// ---------------------------------------------------------------------------

/**
 * Aggregated memory mutations produced during a single request lifecycle.
 * Assembled by the route handler from pipeline outputs and passed to
 * MemoryManager.record() after the response is prepared.
 */
export interface MemoryUpdates {
  readonly session?: Partial<SessionMemory>;
  readonly userFacts?: UserFact[];
  readonly toolOutputs?: ToolExecutionRecord[];
  readonly conversationTurn?: ConversationTurn;
}

// ---------------------------------------------------------------------------
// MemoryManager health
// ---------------------------------------------------------------------------

export interface MemoryHealthStatus {
  readonly status: "ok" | "degraded" | "unavailable";
  readonly tiers: Record<MemoryTierId, "ok" | "degraded" | "unavailable">;
  readonly latencyMs?: number;
}

// ---------------------------------------------------------------------------
// MemoryManager interface
// ---------------------------------------------------------------------------

/**
 * Phase 3B — primary coordination point for all memory operations.
 *
 * Responsibilities:
 *   load()   — hydrate tiers from storage, apply budget, return frozen snapshot
 *   record() — persist pipeline outputs after execute() returns
 *   forget() — erase all tiers for a user (GDPR / "forget me")
 *   health() — return storage backend status for monitoring
 *
 * Must NOT:
 *   - Execute tools
 *   - Call the LLM
 *   - Modify ExecutionContext after it is frozen
 *   - Block the pipeline on storage failure (degrade gracefully)
 */
export interface MemoryManager {
  /**
   * Loads all applicable memory tiers and returns a budget-constrained,
   * versioned snapshot ready to be attached to ExecutionContextInput.
   *
   * Called by the route handler BEFORE createExecutionContext().
   * On storage failure returns an empty MemoryContext and emits
   * "memory.load_failed" on the EventBus.
   */
  load(scope: MemoryScope, budget: ContextBudget): Promise<MemoryContext>;

  /**
   * Persists memory updates produced during the request lifecycle.
   * Called by the route handler AFTER the response is prepared.
   *
   * Writes are best-effort — a failure must not prevent the response from
   * reaching the user. Failures are logged and emitted as "memory.record_failed".
   */
  record(scope: MemoryScope, updates: MemoryUpdates): Promise<void>;

  /**
   * Erases all memory for a given user across every tier.
   * Used to honour "forget me" / GDPR deletion requests.
   * Throws MemoryError on failure — the caller (admin route) must surface it.
   */
  forget(scope: MemoryScope): Promise<void>;

  /**
   * Returns the current health status of each storage backend.
   */
  health(): Promise<MemoryHealthStatus>;
}

// ---------------------------------------------------------------------------
// StorageProvider — backend abstraction
// ---------------------------------------------------------------------------

/**
 * Fully-qualified key that addresses one entry in one tier for one user.
 * The StorageProvider must reject any key missing tenantId, botId, or userId.
 */
export interface StorageKey {
  readonly tier: MemoryTierId;
  readonly tenantId: string;
  readonly botId: string;
  readonly userId: string;
  /** Additional discriminant, e.g. sessionId or conversationKey. */
  readonly qualifier?: string;
}

/**
 * Scope prefix used by delete() to erase all keys for one user.
 * All three fields are required.
 */
export interface ScopePrefix {
  readonly tenantId: string;
  readonly botId: string;
  readonly userId: string;
}

export interface ListOptions {
  readonly limit: number;
  readonly order: "asc" | "desc";
  /** Timestamp upper bound (exclusive). */
  readonly before?: number;
  /** Timestamp lower bound (exclusive). */
  readonly after?: number;
  /**
   * Reserved — future VectorStorageProvider extension (ADR-005 §13.1).
   * Setting this field on a non-vector backend is a no-op.
   */
  readonly similarityQuery?: string;
  readonly similarityThreshold?: number;
}

export interface WriteOptions {
  /** Optional time-to-live in milliseconds. */
  readonly ttlMs?: number;
  /** Reject the write if the key already exists. */
  readonly ifNotExists?: boolean;
  /**
   * Optimistic concurrency guard (integer revision).
   * Write is rejected with WriteConflictError when the stored revision
   * differs from this value. Obtain the revision from the last WriteResult
   * or read response. Only one of expectedRevision / expectedEtag per call.
   */
  readonly expectedRevision?: number;
  /**
   * Content-hash-based concurrency guard.
   * Alternative to expectedRevision for backends (e.g. Redis) that prefer
   * opaque etags over integer revisions.
   */
  readonly expectedEtag?: string;
}

/**
 * Returned by every mutating StorageProvider method.
 * Store revision and etag when a subsequent conditional write is planned.
 */
export interface WriteResult {
  /** Monotonically increasing revision counter after a successful write. */
  readonly revision: number;
  /** Opaque content hash for etag-based concurrency control. */
  readonly etag: string;
  /** Wall-clock timestamp of the write, set by the storage backend. */
  readonly updatedAt: number;
}

/**
 * Thrown by StorageProvider when an optimistic concurrency check fails.
 * MemoryManager catches this, retries once with a fresh read, then logs
 * and skips on a second conflict (ADR-005 §5.4).
 */
export class WriteConflictError extends Error {
  constructor(
    readonly key: StorageKey,
    readonly expectedRevision: number | undefined,
    readonly actualRevision: number,
  ) {
    super(
      `Write conflict on ${key.tier}:${key.tenantId}:${key.botId}:${key.userId}` +
      ` — expected revision ${expectedRevision ?? "(etag)"}, found ${actualRevision}`,
    );
    this.name = "WriteConflictError";
  }
}

/**
 * Thrown by MemoryManager.forget() on storage failure.
 * The caller (admin route) is responsible for surfacing this to the operator.
 */
export class MemoryError extends Error {
  constructor(
    readonly operation: "forget" | "load" | "record",
    readonly scope: Pick<MemoryScope, "tenantId" | "botId" | "userId">,
    readonly cause: unknown,
  ) {
    super(`MemoryManager.${operation} failed for ${scope.tenantId}:${scope.botId}:${scope.userId}`);
    this.name = "MemoryError";
  }
}

/**
 * Provider-agnostic storage abstraction for all memory tiers.
 *
 * Implementations are swappable without changing runtime logic:
 *   PostgresStorageProvider — production
 *   InMemoryStorageProvider — unit tests, zero infrastructure
 *   RedisStorageProvider    — session tier, high-throughput (future)
 *   SqliteStorageProvider   — local dev without Postgres (future)
 *
 * All implementations live in lib/memory/providers/ and are never imported
 * directly by the runtime or route handlers.
 */
export interface StorageProvider {
  /**
   * Reads the current value for a scoped key.
   * Returns null if the key does not exist or has expired.
   */
  read<T>(key: StorageKey): Promise<T | null>;

  /**
   * Reads a paginated, time-ordered list for a scoped key.
   * Used for conversation history and tool execution records.
   */
  list<T>(key: StorageKey, options: ListOptions): Promise<T[]>;

  /**
   * Writes or replaces the value for a scoped key.
   * If WriteOptions.expectedRevision is set, rejects with WriteConflictError
   * when the stored revision differs.
   */
  write<T>(key: StorageKey, value: T, options?: WriteOptions): Promise<WriteResult>;

  /**
   * Appends a new entry to a time-ordered list for a scoped key.
   */
  append<T>(key: StorageKey, value: T, options?: WriteOptions): Promise<WriteResult>;

  /**
   * Upserts a keyed entry within a map for a scoped key.
   * Used for user facts (upsert by fact key).
   * If WriteOptions.expectedRevision is set, rejects with WriteConflictError
   * when the stored revision differs.
   */
  upsert<T>(
    key: StorageKey,
    entryKey: string,
    value: T,
    options?: WriteOptions,
  ): Promise<WriteResult>;

  /**
   * Deletes all entries for a scoped key, or all keys matching a scope prefix.
   * Used by MemoryManager.forget().
   */
  delete(key: StorageKey | ScopePrefix): Promise<void>;

  /**
   * Returns the health status of this storage backend.
   */
  health(): Promise<"ok" | "degraded" | "unavailable">;
}

// ---------------------------------------------------------------------------
// Context Budgeting
// ---------------------------------------------------------------------------

/**
 * LLM-specific context window profile.
 * Drives the total token ceiling for MemoryContext budget allocation.
 * Resolved at composition time — never read inside the runtime pipeline.
 */
export interface ModelContextProfile {
  /** Stable ID matching the provider's model identifier. */
  readonly modelId: string;
  /** Total context window reported by the provider (tokens). */
  readonly maxContextTokens: number;
  /** Tokens reserved for the model's own reply. */
  readonly reservedOutputTokens: number;
  /** Derived: maxContextTokens − reservedOutputTokens. */
  readonly usableContextTokens: number;
}

/**
 * Registry of known LLM context profiles.
 * Add entries here when wiring a new provider; do not change runtime logic.
 */
export const KNOWN_CONTEXT_PROFILES: Record<string, ModelContextProfile> = {
  "shizo/default": {
    modelId: "shizo/default",
    maxContextTokens: 4_096,
    reservedOutputTokens: 512,
    usableContextTokens: 3_584,
  },
  "openai/gpt-4o": {
    modelId: "openai/gpt-4o",
    maxContextTokens: 128_000,
    reservedOutputTokens: 4_096,
    usableContextTokens: 123_904,
  },
  "openai/gpt-4o-mini": {
    modelId: "openai/gpt-4o-mini",
    maxContextTokens: 16_000,
    reservedOutputTokens: 4_096,
    usableContextTokens: 11_904,
  },
  "anthropic/claude-3-haiku": {
    modelId: "anthropic/claude-3-haiku",
    maxContextTokens: 200_000,
    reservedOutputTokens: 4_096,
    usableContextTokens: 195_904,
  },
};

/**
 * Fallback profile used when the configured model is not in KNOWN_CONTEXT_PROFILES.
 * Sized conservatively to the Shizo backend's declared limit.
 */
export const DEFAULT_CONTEXT_PROFILE: ModelContextProfile =
  KNOWN_CONTEXT_PROFILES["shizo/default"]!;

/**
 * Immutable budget applied by MemoryManager.load().
 * All parameters are resolved before the pipeline begins and must not change
 * during execute() — this preserves deterministic replay (ADR-005 §12).
 */
export interface ContextBudget {
  /**
   * The model profile that determines the usable token ceiling.
   * Resolved at composition time from KNOWN_CONTEXT_PROFILES.
   */
  readonly modelProfile: ModelContextProfile;
  readonly tierAllocations: {
    /** Tokens reserved for injected user facts. */
    readonly userFacts: number;
    /** Tokens reserved for session memory fields. */
    readonly session: number;
    /** Tokens reserved for conversation history. */
    readonly conversation: number;
    /** Tokens reserved for the recent tool execution summary. */
    readonly toolSummary: number;
    /** Tokens reserved for the prompt template and system instructions. */
    readonly systemReserved: number;
  };
  /**
   * Order in which tiers are truncated when budget is exhausted.
   * Lowest-priority tier first (dropped first).
   */
  readonly truncationOrder: MemoryTierId[];
}

/**
 * Derives proportional tier allocations from a ModelContextProfile.
 *
 * Fixed ratios of usableContextTokens:
 *   conversation    50%
 *   systemReserved  28%
 *   userFacts       12%
 *   toolSummary      6%
 *   session          remainder (≈ 3–4%)
 *
 * Rounding is absorbed into the session allocation.
 */
export function deriveContextBudget(profile: ModelContextProfile): ContextBudget {
  const u = profile.usableContextTokens;
  const conversation    = Math.round(u * 0.50);
  const systemReserved  = Math.round(u * 0.28);
  const userFacts       = Math.round(u * 0.12);
  const toolSummary     = Math.round(u * 0.06);
  const session         = u - conversation - systemReserved - userFacts - toolSummary;
  return {
    modelProfile: profile,
    tierAllocations: { userFacts, session, conversation, toolSummary, systemReserved },
    truncationOrder: ["tool_execution", "conversation", "user_profile", "session", "request"],
  };
}

/** Production default budget — sized for the Shizo/default backend. */
export const DEFAULT_CONTEXT_BUDGET: ContextBudget = deriveContextBudget(DEFAULT_CONTEXT_PROFILE);

// ---------------------------------------------------------------------------
// Privacy & Retention
// ---------------------------------------------------------------------------

/**
 * Per-tool rules governing whether output is persisted and which args are
 * redacted before storage. Evaluated by MemoryManager.record() at write time.
 */
export interface ToolStorageRules {
  /** Whether to persist the tool result in ToolExecutionRecord. */
  readonly storeOutput: boolean;
  /** Arg keys whose values are redacted (replaced with "[REDACTED]") before storage. */
  readonly sensitiveArgs: string[];
  /** When true, the entire result is omitted from ToolExecutionRecord. */
  readonly sensitiveOutput: boolean;
}

/** Default storage rules for existing tools. Extend when registering new tools. */
export const DEFAULT_TOOL_STORAGE_RULES: Record<string, ToolStorageRules> = {
  url_shortener:     { storeOutput: true,  sensitiveArgs: [],       sensitiveOutput: false },
  qrcode:            { storeOutput: false, sensitiveArgs: [],       sensitiveOutput: false },
  screenshot:        { storeOutput: false, sensitiveArgs: [],       sensitiveOutput: false },
  screenshot_prompt: { storeOutput: false, sensitiveArgs: [],       sensitiveOutput: false },
  text_to_pdf:       { storeOutput: false, sensitiveArgs: ["text"], sensitiveOutput: true  },
  capabilities:      { storeOutput: false, sensitiveArgs: [],       sensitiveOutput: false },
};

/**
 * Governs how quickly UserFact confidence decays between confirmations.
 * Applied by the background sweep — never on the request path.
 *
 * Formula:  decayedConfidence = storedConfidence × (0.5 ^ (daysSinceConfirmed / halfLifeDays))
 *
 * Facts whose decayedConfidence < minimumConfidence are flagged decayed: true
 * and excluded from MemoryContext injection until re-confirmed.
 */
export interface ConfidenceDecayConfig {
  /** Days for confidence to halve if not re-confirmed. Default 180. */
  readonly halfLifeDays: number;
  /** Confidence floor; facts below this threshold are flagged decayed. Default 0.2. */
  readonly minimumConfidence: number;
  /** How often the background sweep applies the decay formula. Default 7 days. */
  readonly decayCheckIntervalDays: number;
}

export const DEFAULT_CONFIDENCE_DECAY: ConfidenceDecayConfig = {
  halfLifeDays: 180,
  minimumConfidence: 0.2,
  decayCheckIntervalDays: 7,
};
