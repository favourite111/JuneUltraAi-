# ADR-005: Contextual Memory Architecture

## 1. Title
Contextual Memory Architecture for JUNE_ULTRA_AI (Phase 3B — Memory Integration)

## 2. Status
Proposed — Amended (rev 2)

> **Rev 2 amendments** (incorporated from architecture review):
> - §6.4 — `importance` field added to `UserFact`; confidence decay model formalised.
> - §8.1 — Optimistic concurrency (`expectedRevision`, `expectedEtag`) added to `WriteOptions`; new `WriteResult` type.
> - §9.1 — Context window ceiling is now model-driven via `ModelContextProfile`.
> - §9.5 — `ContextBudget` derives allocations from `ModelContextProfile`; `deriveContextBudget()` helper introduced.
> - §11.1 — `version` field added to `MemoryContext` for safe schema migration.
> - §13.6 — Event sourcing for facts deferred to ADR-006 (previously suggestion 4).

---

## 3. Context
Phase 3A established a stable, deterministic agent runtime with an immutable `ExecutionContext`, a structured `Event Bus`, a deterministic `Capability Router`, and a bounded `Reflection Engine`. Phase 3B Milestone 4 extended that foundation with hybrid intelligence — circuit-breaker-protected LLM fallback routing with validated decisions and metrics.

Throughout both phases the runtime has treated memory as a read-only snapshot: facts and conversation history are loaded by the caller (currently `routes/chat.ts`) and frozen into `ExecutionContext` before the pipeline begins. This works for short-horizon chat but has three structural gaps:

1. **No write-back.** Facts extracted during a request are saved by the route handler, outside the runtime. The runtime has no authoritative place to record tool outputs, LLM decisions, or newly discovered user attributes.
2. **No tier separation.** Everything the runtime knows lives in a flat `memory.facts` array and a flat `history` list. There is no distinction between request-scoped working memory, session state, long-lived user profile data, or tool-execution artifacts.
3. **No storage abstraction.** The existing `lib/db.ts` client is a hard PostgreSQL reference. Any alternative backend (Redis, SQLite, in-memory for tests) requires changing callers — violating the project's dependency-injection principle.

This ADR proposes the `MemoryManager` interface, a five-tier memory model, a provider-based storage abstraction, context-budgeting rules, a privacy and retention policy, and explicit integration points with the existing runtime, without breaking any existing interfaces or tests.

---

## 4. Decision

We will introduce a **Contextual Memory Architecture** composed of:

1. A `MemoryManager` interface that orchestrates five memory tiers.
2. A `StorageProvider` interface that abstracts the physical backend, with optimistic concurrency support.
3. A `ContextBudget` model that deterministically constrains what is injected into `ExecutionContext`, derived from the configured LLM's context profile.
4. A privacy and retention policy enforced at the `StorageProvider` boundary, including a confidence decay model.
5. Explicit, non-circular integration points with `ExecutionContext`, `Runtime`, `PromptManager`, `Reflection`, and the `Event Bus`.

No existing runtime file, interface, or test is modified by this ADR. All new types and classes are additive.

---

## 5. MemoryManager Interface

### 5.1 Responsibilities

The `MemoryManager` is the single coordination point for all memory operations within a request lifecycle. It is responsible for:

- **Loading** — hydrating memory tiers from storage before the pipeline begins.
- **Injecting** — producing a `MemoryContext` object that is attached to `ExecutionContext` at request time.
- **Recording** — persisting updates (new facts, tool outputs, LLM decisions, session state deltas) after the pipeline completes.
- **Evicting** — enforcing retention, decay, and budget limits at write time, never at read time.
- **Isolating** — guaranteeing that all reads and writes are scoped to the `(tenantId, botId, userId)` triple.

The `MemoryManager` must **not**:

- Execute tools.
- Call the LLM directly.
- Modify `ExecutionContext` after it is frozen.
- Block the pipeline when a storage backend is unavailable; it degrades gracefully by returning empty tiers.

### 5.2 Public Interface

```typescript
/**
 * Phase 3B — Contextual Memory Architecture.
 *
 * All operations are scoped to a (tenantId, botId, userId) triple.
 * The MemoryManager never holds mutable state itself — it delegates
 * reads and writes to an injected StorageProvider.
 */
export interface MemoryManager {
  /**
   * Loads all applicable memory tiers and returns a budget-constrained
   * snapshot ready to be attached to ExecutionContext.
   *
   * Must complete before the pipeline begins. On storage failure, returns
   * an empty MemoryContext and emits a "memory.load_failed" event.
   */
  load(scope: MemoryScope, budget: ContextBudget): Promise<MemoryContext>;

  /**
   * Persists memory updates produced during the request lifecycle.
   * Called after reflection completes, before the response is sent.
   *
   * Writes are best-effort: a failure must not prevent the response
   * from reaching the user. Failures are logged and metered.
   */
  record(scope: MemoryScope, updates: MemoryUpdates): Promise<void>;

  /**
   * Removes all memory for a given user across all tiers.
   * Used to honour "forget me" requests.
   */
  forget(scope: MemoryScope): Promise<void>;

  /**
   * Returns the current storage health status for monitoring.
   */
  health(): Promise<MemoryHealthStatus>;
}

export interface MemoryScope {
  readonly tenantId: string;   // Isolates deployment-level tenants
  readonly botId: string;      // Isolates individual bot registrations
  readonly userId: string;     // Isolates individual users
  readonly sessionId?: string; // Optional session boundary
  readonly requestId: string;  // Unique per-request, used for write attribution
}

export interface MemoryUpdates {
  readonly session?: Partial<SessionMemory>;
  readonly userFacts?: UserFact[];
  readonly toolOutputs?: ToolExecutionRecord[];
  readonly conversationTurn?: ConversationTurn;
}

export interface MemoryHealthStatus {
  readonly status: "ok" | "degraded" | "unavailable";
  readonly tiers: Record<MemoryTierId, "ok" | "degraded" | "unavailable">;
  readonly latencyMs?: number;
}

export type MemoryTierId =
  | "request"
  | "session"
  | "conversation"
  | "user_profile"
  | "tool_execution";
```

### 5.3 Dependency Boundaries

```
Route Handler
  └─ creates MemoryScope
  └─ calls MemoryManager.load()
       └─ reads from StorageProvider (injected)
  └─ attaches MemoryContext to ExecutionContextInput
       └─ Runtime freezes it into ExecutionContext
  └─ after pipeline completes: calls MemoryManager.record()
       └─ writes to StorageProvider
```

The `MemoryManager` depends on:
- `StorageProvider` (injected — never a concrete database client)
- `EventBus` (injected — to emit memory lifecycle events)

The `MemoryManager` must **not** depend on:
- `createDeterministicAgentRuntime`
- Any tool implementation
- Any route handler
- Any LLM provider

### 5.4 Error Handling

| Failure Scenario | Behaviour |
| :--- | :--- |
| Storage unavailable at load time | Return empty `MemoryContext`; emit `memory.load_failed` event; log with severity `warn` |
| Storage unavailable at write time | Log with severity `error`; emit `memory.record_failed` event; do **not** throw — response is already prepared |
| Partial tier failure at load time | Load available tiers; mark failed tiers as empty; emit `memory.tier_degraded` event |
| Budget overflow | Truncate according to §9 (Context Budgeting) rules; emit `memory.budget_truncated` event |
| Optimistic concurrency conflict | Emit `memory.write_conflict` event; retry once with a fresh read; on second conflict, log and skip the write |
| `forget()` failure | Throw `MemoryError`; caller (admin route) must surface this to the operator |

---

## 6. Memory Tiers

### Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        MemoryContext                            │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐   │
│  │   Request    │  │   Session    │  │   Conversation     │   │
│  │  (in-memory) │  │  (Redis /    │  │  (PostgreSQL)      │   │
│  │  ephemeral   │  │  in-memory)  │  │  last N turns      │   │
│  └──────────────┘  └──────────────┘  └────────────────────┘   │
│  ┌──────────────┐  ┌──────────────┐                           │
│  │ User Profile │  │   Tool       │                           │
│  │ (PostgreSQL) │  │  Execution   │                           │
│  │  long-lived  │  │ (PostgreSQL) │                           │
│  └──────────────┘  └──────────────┘                           │
└─────────────────────────────────────────────────────────────────┘
```

---

### 6.1 Request Memory

| Property | Value |
| :--- | :--- |
| **Purpose** | Ephemeral working state for the current pipeline invocation. Carries intermediate values (extracted args, routing decisions, reflection notes) that need to flow between pipeline stages without round-tripping to storage. |
| **Lifetime** | Single request. Destroyed when `execute()` returns. |
| **Storage backend** | In-process heap only. Never persisted. |
| **Read policy** | Populated by the runtime as the pipeline advances. Components read via `ExecutionContext`. |
| **Write policy** | Each pipeline stage may append to its own namespace. No cross-stage writes. |
| **Eviction policy** | Automatic — garbage collected when the request object is released. |

```typescript
export interface RequestMemory {
  readonly routingDecision?: RoutingDecision;
  readonly llmDecision?: LLMDecision;
  readonly toolArgs?: Record<string, unknown>;
  readonly reflectionNotes: string[];
  readonly timings: Record<string, number>;
  readonly warnings: string[];
}
```

---

### 6.2 Session Memory

| Property | Value |
| :--- | :--- |
| **Purpose** | Short-lived state that spans multiple requests within a recognisable interaction window (e.g. a continuous WhatsApp conversation within a single day). Carries mood, active topics, question-chain depth, and personality temperature so they do not have to be re-derived on every request. |
| **Lifetime** | Configurable TTL, default 4 hours from last activity. |
| **Storage backend** | Redis (preferred) or in-process `Map` (fallback / test). Must implement `StorageProvider`. |
| **Read policy** | Loaded once at the start of `MemoryManager.load()`. Treated as a mutable overlay on top of the frozen `ExecutionContext` snapshot — the snapshot itself is never mutated. |
| **Write policy** | Written by `MemoryManager.record()` after reflection completes. Merges delta fields; does not overwrite the entire record. |
| **Eviction policy** | TTL-based. Evicted automatically by the storage backend. No explicit sweep required. |

```typescript
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
```

---

### 6.3 Conversation Memory

| Property | Value |
| :--- | :--- |
| **Purpose** | The ordered message history shared with the LLM for context and anti-repetition. Mirrors the existing `conversation-store.ts` data but accessed through the `StorageProvider` abstraction. |
| **Lifetime** | Persistent, subject to the configurable `maxTurns` retention window (default 50 message pairs). |
| **Storage backend** | PostgreSQL via `StorageProvider`. Maps to the existing `conversations` table. |
| **Read policy** | Load the most recent `N` turns (budget-limited — see §9). Oldest turns are excluded before injection. |
| **Write policy** | Append-only per turn. Each `ConversationTurn` is written after the response is generated. |
| **Eviction policy** | Sliding window — on each write, delete turns older than `maxTurns`. Optionally summarise evicted turns into a single `summary` entry before deletion (see §9.4). |

```typescript
export interface ConversationTurn {
  readonly turnId: string;
  readonly requestId: string;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly timestamp: number;
  readonly toolUsed?: string;
  readonly tokenCount?: number;
}
```

---

### 6.4 User Profile Memory

| Property | Value |
| :--- | :--- |
| **Purpose** | Long-lived objective facts about the user: name, language preference, location, known interests, stated goals, and any attributes explicitly extracted by the memory system. These survive conversation resets and session expiry. |
| **Lifetime** | Persistent until `forget()` is called or the retention period (`defaultRetentionDays`, default 365) expires. |
| **Storage backend** | PostgreSQL via `StorageProvider`. Maps to the existing `user_facts` table. |
| **Read policy** | Loaded in full (budget-limited — see §9). Newer facts override older facts with the same key. Facts flagged `decayed: true` are excluded from injection. |
| **Write policy** | Upsert per fact key. New facts are added; existing facts are updated with a `confirmedAt` timestamp. Facts must pass a confidence threshold (`>= 0.7`) before being written. |
| **Eviction policy** | TTL-based on `retentionDays` per fact, plus explicit `forget()` for full erasure. Low-confidence stale facts (not confirmed in 90 days) are downgraded but not deleted, to avoid false erasure. When budget is exhausted, facts are dropped in ascending order of `importance × decayedConfidence` — lowest combined score first. |

```typescript
export interface UserFact {
  readonly factId: string;
  readonly key: string;           // e.g. "name", "language", "city"
  readonly value: string;
  readonly confidence: number;    // 0.0–1.0 — certainty that this fact is currently true
  readonly importance: number;    // 0.0–1.0 — relevance weight used for eviction ordering
  readonly source: "explicit" | "inferred" | "tool";
  readonly createdAt: number;
  readonly confirmedAt: number;
  readonly expiresAt?: number;
  readonly sensitive: boolean;    // Governs injection and logging rules
  readonly decayed?: boolean;     // Set true by sweep when decayedConfidence < minimumConfidence
}
```

#### Importance Guidance

`importance` is assigned at write time based on the fact's category. It is independent of `confidence` and does not decay. Example defaults:

| Fact key | Default importance |
| :--- | :--- |
| `name` | 1.0 |
| `language` | 0.95 |
| `city` / `country` | 0.8 |
| `occupation` | 0.7 |
| `relationship_status` | 0.6 |
| `interests.*` | 0.3 |
| `preferences.*` (e.g. shirt colour) | 0.15 |

These defaults are a configurable deployment-level map, not runtime constants.

#### Confidence Decay

Facts should not retain their original confidence indefinitely — the world changes and users' circumstances evolve. Confidence decays exponentially between confirmations, making the memory system self-correcting without requiring explicit user correction.

```typescript
export interface ConfidenceDecayConfig {
  /** Days for confidence to halve if not re-confirmed (default 180). */
  readonly halfLifeDays: number;
  /** Confidence floor; facts below this are flagged decayed: true (default 0.2). */
  readonly minimumConfidence: number;
  /** How often the background sweep applies decay (default 7 days). */
  readonly decayCheckIntervalDays: number;
}

export const DEFAULT_CONFIDENCE_DECAY: ConfidenceDecayConfig = {
  halfLifeDays: 180,
  minimumConfidence: 0.2,
  decayCheckIntervalDays: 7,
};
```

The decay formula applied by the background sweep:

```
decayedConfidence = storedConfidence × (0.5 ^ (daysSinceConfirmed / halfLifeDays))
```

Facts whose `decayedConfidence` falls below `minimumConfidence` are flagged `decayed: true` in storage. They remain in the database (to avoid false erasure and to support future event-sourcing — see §13.6) but are excluded from `MemoryContext` injection until re-confirmed. The sweep runs on the background retention job and must **never** execute on the request path.

---

### 6.5 Tool Execution Memory

| Property | Value |
| :--- | :--- |
| **Purpose** | A tamper-evident audit trail of every tool invocation: which tool ran, with what arguments, what it returned, and whether reflection accepted or rejected the result. Supports debugging, replay, and future semantic search over past tool outputs. |
| **Lifetime** | Persistent, subject to `toolExecutionRetentionDays` (default 30). |
| **Storage backend** | PostgreSQL via `StorageProvider`. New table `tool_executions` (defined in implementation phase). |
| **Read policy** | Not injected into `ExecutionContext` by default (too large). Available via explicit query for debugging routes and future RAG. Session Memory may carry a short summary of the most recent tool invocation. |
| **Write policy** | Written by `MemoryManager.record()`. One record per tool invocation. Tool output is stored only when `storageRules.storeOutput === true` for that tool category (see §10.6). |
| **Eviction policy** | TTL-based on `toolExecutionRetentionDays`. Sensitive tool outputs (see §10.6) are zeroed before the TTL expires if the user invokes `forget()`. |

```typescript
export interface ToolExecutionRecord {
  readonly executionId: string;
  readonly requestId: string;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly args: Record<string, unknown>;
  readonly result?: Record<string, unknown>;  // Omitted for sensitive tools
  readonly error?: string;
  readonly reflectionDecision: string;
  readonly durationMs: number;
  readonly timestamp: number;
}
```

---

### 6.6 Future: Long-Term Knowledge Memory (Reserved)

This tier is **not implemented in Phase 3B**. Extension points are reserved in §13. Its inclusion here is to ensure the current interface boundaries do not preclude it.

| Property | Value |
| :--- | :--- |
| **Purpose** | Semantic, vector-indexed memory of past conversations for RAG-style retrieval. Enables JUNE to surface relevant past context even from conversations outside the sliding window. |
| **Lifetime** | Indefinite, subject to user-level retention policy. |
| **Storage backend** | Vector database (e.g. pgvector, Pinecone) — injected via `StorageProvider` extension. |
| **Status** | Reserved. Interface placeholder only. No implementation until ADR-006. |

---

## 7. Runtime Lifecycle

The diagram below shows the complete request lifecycle with `MemoryManager` participation annotated.

```
Incoming Request (botId, userId, prompt)
  │
  ▼
Route Handler
  │   creates MemoryScope
  │   calls MemoryManager.load(scope, budget)
  │     ├─ StorageProvider.read(session)      → SessionMemory
  │     ├─ StorageProvider.read(conversation) → ConversationTurn[]
  │     ├─ StorageProvider.read(user_profile) → UserFact[] (decayed facts excluded)
  │     └─ builds MemoryContext (budget-constrained, versioned)
  │   attaches MemoryContext to ExecutionContextInput
  │
  ▼
createExecutionContext()
  │   freezes ExecutionContextInput into immutable ExecutionContext
  │   MemoryContext (including version) is frozen alongside all other input fields
  │   ← MemoryManager does NOT participate below this line until step 10 →
  │
  ▼
Planner
  │   reads context.memory (frozen snapshot)
  │   no memory writes
  │
  ▼
Capability Router
  │   reads context.memory.userFacts for hint extraction (read-only)
  │   no memory writes
  │
  ▼
LLM Decision Engine (optional — hybrid path)
  │   PromptManager reads context.memoryContext to build prompt (read-only)
  │   LLMDecision stored in RequestMemory (in-process only)
  │   no StorageProvider writes
  │
  ▼
Tool Executor
  │   tool reads context.memoryContext if needed (read-only)
  │   ToolExecutionRecord created in-process (not yet persisted)
  │   no StorageProvider writes
  │
  ▼
Reflection Engine
  │   reads context.memoryContext.toolSummary for validation hints (read-only)
  │   appends to RequestMemory.reflectionNotes (in-process only)
  │   no StorageProvider writes
  │
  ▼  ← MemoryManager re-enters here →
Route Handler (post-pipeline)
  │   calls MemoryManager.record(scope, updates)
  │     ├─ StorageProvider.write(session delta)    [with optimistic concurrency check]
  │     ├─ StorageProvider.append(conversationTurn)
  │     ├─ StorageProvider.upsert(userFacts)       — if confidence >= 0.7
  │     └─ StorageProvider.append(toolExecutionRecord)
  │
  ▼
Response sent to user
```

### Critical Invariants

- `MemoryManager.load()` completes **before** `createExecutionContext()` is called. The frozen context is a deterministic snapshot of what storage contained at load time.
- `MemoryManager.record()` is called **after** the response is prepared, never inside the pipeline. This ensures a storage write failure cannot alter the response.
- No pipeline component (Planner, Router, Executor, Reflection) calls `MemoryManager` directly. All memory access inside the pipeline is through the frozen `ExecutionContext`.

---

## 8. Storage Abstraction

### 8.1 StorageProvider Interface

The runtime must never import a database driver directly. All persistence is delegated to an injected `StorageProvider`.

```typescript
/**
 * Provider-agnostic storage abstraction for all memory tiers.
 *
 * Implementations must be swappable without changing runtime logic.
 * Supported backends: PostgreSQL, Redis, SQLite, in-memory (tests).
 * Future: vector databases (see §13).
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
   * If WriteOptions.expectedRevision is supplied, the write is rejected
   * with a WriteConflictError when the stored revision differs.
   */
  write<T>(key: StorageKey, value: T, options?: WriteOptions): Promise<WriteResult>;

  /**
   * Appends a new entry to a list for a scoped key.
   */
  append<T>(key: StorageKey, value: T, options?: WriteOptions): Promise<WriteResult>;

  /**
   * Upserts a keyed value within a map for a scoped key.
   * Used for user facts (upsert by fact key).
   * If WriteOptions.expectedRevision is supplied, the upsert is rejected
   * with a WriteConflictError when the stored revision differs.
   */
  upsert<T>(key: StorageKey, entryKey: string, value: T, options?: WriteOptions): Promise<WriteResult>;

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

export interface StorageKey {
  readonly tier: MemoryTierId;
  readonly tenantId: string;
  readonly botId: string;
  readonly userId: string;
  readonly qualifier?: string;   // e.g. sessionId, conversationKey
}

export interface ScopePrefix {
  readonly tenantId: string;
  readonly botId: string;
  readonly userId: string;
}

export interface ListOptions {
  readonly limit: number;
  readonly order: "asc" | "desc";
  readonly before?: number;    // Timestamp upper bound (exclusive)
  readonly after?: number;     // Timestamp lower bound (exclusive)
  // Future: vector similarity fields reserved in §13.1
}

export interface WriteOptions {
  readonly ttlMs?: number;            // Optional time-to-live in milliseconds
  readonly ifNotExists?: boolean;
  /**
   * Optimistic concurrency guard. If set, the write is rejected with
   * WriteConflictError when the stored revision does not equal this value.
   * Use the revision from the most recent WriteResult or read response.
   */
  readonly expectedRevision?: number;
  /**
   * Content-hash-based concurrency guard. Alternative to expectedRevision
   * for backends (e.g. Redis) that prefer opaque etags over integer revisions.
   * Only one of expectedRevision or expectedEtag should be set per call.
   */
  readonly expectedEtag?: string;
}

/**
 * Returned by every mutating StorageProvider method.
 * Callers should store revision and etag if they plan to issue
 * a subsequent conditional write to the same key.
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
 * and skips on a second conflict (see §5.4).
 */
export class WriteConflictError extends Error {
  constructor(
    readonly key: StorageKey,
    readonly expectedRevision: number | undefined,
    readonly actualRevision: number,
  ) {
    super(`Write conflict on key ${key.tier}:${key.userId} — expected revision ${expectedRevision}, found ${actualRevision}`);
    this.name = "WriteConflictError";
  }
}
```

### 8.2 Provided Implementations (Phase 3B)

| Implementation | Use Case |
| :--- | :--- |
| `PostgresStorageProvider` | Production (wraps existing `postgres.js` client) |
| `InMemoryStorageProvider` | Unit and integration tests; zero infrastructure required |
| `RedisStorageProvider` | Session tier in high-throughput deployments (future) |
| `SqliteStorageProvider` | Local development without a Neon/Postgres connection (future) |

Each implementation class lives in `lib/memory/providers/` and is **never imported directly by the runtime**.

---

## 9. Context Budgeting

Context budgeting ensures the memory injected into `ExecutionContext` never exceeds the LLM's context window and never degrades determinism.

### 9.1 Model Context Profiles

The context ceiling is not hardcoded — it is derived from the configured LLM provider's declared context window. This makes the budget adaptive across the current Shizo backend and any future OpenRouter-wired model.

```typescript
export interface ModelContextProfile {
  /** Stable identifier matching the provider's model ID. */
  readonly modelId: string;
  /** Total context window reported by the provider (in tokens). */
  readonly maxContextTokens: number;
  /** Tokens reserved for the model's own reply — not available for memory injection. */
  readonly reservedOutputTokens: number;
  /** Derived: maxContextTokens − reservedOutputTokens. */
  readonly usableContextTokens: number;
}

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

export const DEFAULT_CONTEXT_PROFILE = KNOWN_CONTEXT_PROFILES["shizo/default"]!;
```

Providers not listed in `KNOWN_CONTEXT_PROFILES` fall back to `DEFAULT_CONTEXT_PROFILE`. The profiles table is a deployment-level configuration; the runtime never reads it directly.

### 9.2 Priority Ordering

When the aggregate memory exceeds the usable context ceiling, tiers are truncated in reverse priority order (lowest priority first):

```
Priority 1 (highest) — User Profile Memory (facts, ordered by importance × decayedConfidence descending)
Priority 2           — Session Memory
Priority 3           — Conversation Memory (most recent turns)
Priority 4           — Conversation Memory (older turns)
Priority 5 (lowest)  — Tool Execution Summary
```

The compound eviction key `importance × decayedConfidence` ensures that low-importance facts (e.g. shirt colour preference) are dropped before high-importance facts (e.g. user's name), and that decayed facts are dropped before fresh ones of equal importance.

### 9.3 Truncation Rules

1. **Conversation history** is truncated from the oldest end. The most recent turn is always included.
2. **User facts** are sorted by `importance × decayedConfidence` descending. Lowest-scoring facts are dropped first. Facts with `decayed: true` are already excluded at load time.
3. **Session fields** are never truncated — they are structurally bounded by the `SessionMemory` interface.
4. **Tool summaries** are omitted entirely when the budget is exhausted, before any other tier is truncated.
5. Truncation operates on token-count estimates (average 4 characters per token). Exact tokenisation is **not** performed at this stage to preserve determinism.

### 9.4 Summarisation Strategy

When conversation history exceeds `maxConversationTurns`, evicted turns are replaced with a single `summary` turn before deletion. The summary is produced deterministically from the turn content without an LLM call, using extractive compression (keep topic keywords, named entities, and intent markers). LLM-based summarisation is deferred to a future ADR.

### 9.5 Context Budget

```typescript
export interface ContextBudget {
  /**
   * The model profile that determines the usable token ceiling.
   * Resolved at composition time from KNOWN_CONTEXT_PROFILES.
   */
  readonly modelProfile: ModelContextProfile;
  readonly tierAllocations: {
    readonly userFacts: number;       // tokens
    readonly session: number;         // tokens
    readonly conversation: number;    // tokens
    readonly toolSummary: number;     // tokens
    readonly systemReserved: number;  // tokens (prompt template overhead)
  };
  readonly truncationOrder: MemoryTierId[];
}

/**
 * Derives proportional tier allocations from a ModelContextProfile.
 * Proportions are fixed ratios of usableContextTokens:
 *   systemReserved  28%
 *   conversation    50%
 *   userFacts       12%
 *   toolSummary      6%
 *   session          3%
 *   (rounding carried into systemReserved)
 */
export function deriveContextBudget(profile: ModelContextProfile): ContextBudget {
  const u = profile.usableContextTokens;
  const conversation   = Math.round(u * 0.50);
  const systemReserved = Math.round(u * 0.28);
  const userFacts      = Math.round(u * 0.12);
  const toolSummary    = Math.round(u * 0.06);
  const session        = u - conversation - systemReserved - userFacts - toolSummary;
  return {
    modelProfile: profile,
    tierAllocations: { userFacts, session, conversation, toolSummary, systemReserved },
    truncationOrder: ["tool_execution", "conversation", "user_profile", "session", "request"],
  };
}

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = deriveContextBudget(DEFAULT_CONTEXT_PROFILE);
```

All budget parameters are resolved at `MemoryManager.load()` time and are immutable thereafter. The same `ContextBudget` input always produces the same `MemoryContext` output, preserving determinism (see §12).

---

## 10. Privacy & Retention Policy

### 10.1 Per-User Isolation

Every `StorageKey` includes `tenantId`, `botId`, and `userId`. The `StorageProvider` **must** reject any read or write that does not supply all three. No cross-user key patterns are permitted.

### 10.2 Tenant Isolation

A single `MemoryManager` instance may serve multiple bots. Bot data is partitioned by `(tenantId, botId)`. A bot may only access memory scoped to its own `botId`. The `MemoryScope` carries the authoritative values; the route handler is responsible for populating them from the verified auth context.

### 10.3 Retention Periods

| Tier | Default Retention | Configurable |
| :--- | :--- | :--- |
| Request | None (in-process only) | N/A |
| Session | 4 hours from last activity | Yes, per bot |
| Conversation | 90 days | Yes, per bot |
| User Profile (facts) | 365 days from last confirmation | Yes, per deployment |
| Tool Execution | 30 days | Yes, per bot |

### 10.4 Forgotten Memory

`MemoryManager.forget(scope)` issues a `StorageProvider.delete()` for all keys matching the scope prefix. This covers all five tiers. The operation is synchronous from the caller's perspective (awaitable). On completion, a `memory.forgotten` event is emitted on the `EventBus`.

Retention-expired records are deleted by a scheduled sweep job (one per storage backend). The sweep runs independently of the request path and must not block request processing. The same sweep applies confidence decay (§6.4) and flags facts whose `decayedConfidence` falls below `minimumConfidence`.

### 10.5 Sensitive Data Handling

Facts with `sensitive: true` (e.g. health data, financial data inferred from tool inputs) are subject to additional constraints:

- They are **not** logged in any log line (not even at DEBUG level).
- They are **not** included in `ToolExecutionRecord.args` or `ToolExecutionRecord.result`.
- They are **not** emitted on the `EventBus` in plaintext.
- Their `expiresAt` is hard-capped at 30 days regardless of the deployment's `userFactRetentionDays`.
- Their confidence decay `halfLifeDays` is hard-capped at 30 days.

Sensitive fact detection is keyword-based (configurable list) at write time. The list is a deployment-level configuration, not a runtime constant.

### 10.6 Tool Output Storage Rules

```typescript
export interface ToolStorageRules {
  readonly storeOutput: boolean;       // Whether to persist the tool result
  readonly sensitiveArgs: string[];    // Arg keys to redact before storage
  readonly sensitiveOutput: boolean;   // Whether the entire output is sensitive
}

export const DEFAULT_TOOL_STORAGE_RULES: Record<string, ToolStorageRules> = {
  url_shortener:      { storeOutput: true,  sensitiveArgs: [],       sensitiveOutput: false },
  qrcode:             { storeOutput: false, sensitiveArgs: [],       sensitiveOutput: false },
  screenshot:         { storeOutput: false, sensitiveArgs: [],       sensitiveOutput: false },
  screenshot_prompt:  { storeOutput: false, sensitiveArgs: [],       sensitiveOutput: false },
  text_to_pdf:        { storeOutput: false, sensitiveArgs: ["text"], sensitiveOutput: true  },
  capabilities:       { storeOutput: false, sensitiveArgs: [],       sensitiveOutput: false },
};
```

---

## 11. Runtime Integration Points

### 11.1 ExecutionContext

`MemoryContext` is added as a new optional field on `ExecutionContextInput`. It is populated by the route handler before calling `createExecutionContext()` and frozen alongside all other fields. The `version` field enables the implementation phase to detect and migrate stale snapshots without breaking existing callers.

```typescript
// Addition to ExecutionContextInput (non-breaking — field is optional)
export interface ExecutionContextInput {
  // ... existing fields unchanged ...
  readonly memoryContext?: MemoryContext;
}

// Addition to ExecutionContext (non-breaking — field is optional)
export interface ExecutionContext {
  // ... existing fields unchanged ...
  readonly memoryContext?: MemoryContext;
}

export interface MemoryContext {
  /**
   * Schema version — incremented when the MemoryContext structure changes
   * in a way that requires migration. Callers may use this to detect and
   * discard stale snapshots during replay.
   */
  readonly version: number;
  readonly session: SessionMemory | null;
  readonly conversation: readonly ConversationTurn[];
  readonly userFacts: readonly UserFact[];
  readonly toolSummary: string | null;    // Short extractive summary of last tool run
  readonly budgetUsed: number;            // Tokens consumed by this context
  readonly budgetRemaining: number;       // Tokens available for the prompt
  readonly loadedAt: number;              // Timestamp of the load call
}

/** Current MemoryContext schema version. Increment on every structural change. */
export const MEMORY_CONTEXT_VERSION = 1;
```

Existing callers that do not supply `memoryContext` continue to work unchanged.

### 11.2 Runtime (createDeterministicAgentRuntime)

No changes to `runtime.ts` are required in Phase 3B. The `MemoryManager` participates before and after `execute()` — never inside it. `AgentRuntimeDependencies` gains an optional `memoryManager` field for future phases where the runtime itself may need to trigger memory queries (e.g. semantic search mid-pipeline).

```typescript
// Optional addition to AgentRuntimeDependencies (non-breaking)
export interface AgentRuntimeDependencies extends ExecutionContextDependencies {
  // ... existing fields unchanged ...
  readonly memoryManager?: MemoryManager; // Reserved; not used in Phase 3B
}
```

### 11.3 PromptManager

`PromptManager.renderPrompt()` already receives `ExecutionContext`. It accesses `context.memoryContext` to include user facts and conversation history in the prompt. No interface change is required.

```typescript
// Existing interface — no modification needed
interface PromptManager {
  renderPrompt(context: ExecutionContext, availableTools: Tool[]): string;
  parseResponse(llmResponse: string): LLMDecision;
}
// The ConcretePromptManager implementation reads context.memoryContext?.userFacts
// (filtering out decayed facts) and context.memoryContext?.conversation to build
// a richer, importance-weighted prompt.
```

### 11.4 Reflection

The `Reflection Engine` reads `context.memoryContext?.toolSummary` to inform its `matchesExpectedOutputs` logic — for example, if a prior tool run produced a URL, Reflection can verify the current tool output references that URL. No interface changes to `reflection.ts` are required; the `ExecutionContext` already flows through.

### 11.5 Event Bus

New memory lifecycle events are added to the `AgentEvent` union. This is a **non-breaking additive extension** — existing listeners that do not subscribe to the new event types are unaffected.

```typescript
// Additions to the AgentEvent union in types.ts
| { type: "memory.load_started";    context: ExecutionContext; payload: { scope: MemoryScope; timestamp: number; } }
| { type: "memory.load_completed";  context: ExecutionContext; payload: { version: number; budgetUsed: number; tiersSummary: Record<MemoryTierId, number>; timestamp: number; } }
| { type: "memory.load_failed";     context: ExecutionContext; payload: { error: string; timestamp: number; } }
| { type: "memory.record_started";  context: ExecutionContext; payload: { scope: MemoryScope; timestamp: number; } }
| { type: "memory.record_completed";context: ExecutionContext; payload: { tiersWritten: MemoryTierId[]; timestamp: number; } }
| { type: "memory.record_failed";   context: ExecutionContext; payload: { error: string; timestamp: number; } }
| { type: "memory.tier_degraded";   context: ExecutionContext; payload: { tier: MemoryTierId; reason: string; timestamp: number; } }
| { type: "memory.budget_truncated";context: ExecutionContext; payload: { removedTiers: MemoryTierId[]; tokensSaved: number; timestamp: number; } }
| { type: "memory.forgotten";       context: ExecutionContext; payload: { scope: MemoryScope; tiersCleared: MemoryTierId[]; timestamp: number; } }
| { type: "memory.write_conflict";  context: ExecutionContext; payload: { tier: MemoryTierId; retrying: boolean; timestamp: number; } }
| { type: "memory.fact_decayed";    context: ExecutionContext; payload: { factId: string; key: string; finalConfidence: number; timestamp: number; } }
```

---

## 12. Determinism

### 12.1 Core Guarantee

The deterministic replay guarantee established in Phase 3A (§8, ADR-003) and extended in Phase 3B (ADR-004) is preserved as follows:

> **Given the same `ExecutionContext` and the same injected dependencies, `createDeterministicAgentRuntime().execute()` produces the same `AgentRuntimeResponse` and the same event trace.**

`MemoryContext` is part of `ExecutionContext` and is frozen at context creation time. Inside `execute()`, memory is read-only. Therefore any replay test that supplies the same frozen `MemoryContext` (including its `version`) will observe the same pipeline behaviour.

### 12.2 Which Memory Operations Are Replayed

| Operation | Replayed? | Rationale |
| :--- | :--- | :--- |
| `MemoryManager.load()` | **Yes** — via snapshot | The loaded `MemoryContext` is frozen into `ExecutionContext`. Replaying with the same snapshot produces identical pipeline behaviour. |
| `context.memoryContext` reads inside the pipeline | **Yes** — automatic | Reads are against the frozen snapshot; they are deterministic by construction. |
| `MemoryManager.record()` | **No** | Write-back is a side-effect that occurs after the pipeline. Replays do not re-run write-back. |
| Optimistic concurrency resolution | **No** | Conflict detection and retry are storage-layer concerns, outside the pipeline boundary. |
| Confidence decay sweep | **No** | Background job; not on the request path. |
| Storage backend I/O | **No** | Excluded from the replay boundary by design. |

### 12.3 Replay Test Pattern

```typescript
// Record: capture the MemoryContext at load time
const memoryContext = await memoryManager.load(scope, DEFAULT_CONTEXT_BUDGET);

// Replay: inject the same versioned, frozen snapshot
const context = createExecutionContext({
  ...requestInput,
  memoryContext,  // ← same version + same data → identical pipeline behaviour
}, dependencies);

// The pipeline produces the same result regardless of storage state at replay time.
const result = await runtime.execute({ ...request, memoryContext });
```

### 12.4 Non-Deterministic Operations Excluded From the Pipeline

The following operations are **outside** the pipeline and therefore outside the replay boundary:

- `MemoryManager.load()` I/O (network latency, database reads)
- `MemoryManager.record()` I/O (database writes, concurrency retry)
- Background confidence decay sweep
- Background retention sweep
- `MemoryManager.forget()` calls

---

## 13. Future Extensions

The following extension points are reserved in the current interfaces. They require no changes to the `MemoryManager`, `StorageProvider`, or `ExecutionContext` interfaces as defined in this ADR.

### 13.1 Semantic Search / Embeddings

The `StorageProvider.list()` method signature includes an `options` parameter. A future `VectorStorageProvider` implementation may add a `similarityQuery` field to `ListOptions` without changing the interface contract:

```typescript
// Future extension to ListOptions — additive, non-breaking
export interface ListOptions {
  readonly limit: number;
  readonly order: "asc" | "desc";
  readonly before?: number;
  readonly after?: number;
  readonly similarityQuery?: string;       // Future: vector similarity search
  readonly similarityThreshold?: number;  // Future: minimum cosine similarity
}
```

### 13.2 RAG (Retrieval-Augmented Generation)

The reserved `Long-Term Knowledge Memory` tier (§6.6) is the natural home for RAG. When ADR-006 defines this tier, `MemoryContext` gains a `knowledgeChunks` field and `PromptManager` includes those chunks in the LLM prompt. No existing tier, interface, or pipeline stage changes.

### 13.3 Vector Memory

A `VectorStorageProvider` implements `StorageProvider` and delegates similarity queries to pgvector, Pinecone, or Weaviate. The `MemoryManager` selects the provider for the `tool_execution` and `long_term_knowledge` tiers at construction time. All other tiers continue using `PostgresStorageProvider`.

### 13.4 Multi-Agent Shared Memory

A `SharedStorageProvider` can serve multiple `MemoryManager` instances across different bot registrations by using a `tenantId`-scoped key namespace without a `botId` component. The existing `StorageKey` interface supports this via its `qualifier` field. No interface changes required.

### 13.5 Streaming Memory Updates

A future `StreamingStorageProvider` may implement `append()` as a Kafka or SSE-backed write, enabling real-time memory synchronisation across horizontally scaled instances. The `StorageProvider` interface is already async-first; streaming semantics can be hidden behind the same `append()` contract.

### 13.6 Event Sourcing for Facts (Deferred — ADR-006)

**This feature is explicitly deferred. No implementation in Phase 3B.**

Rather than storing only the latest value for a user fact, a future event-sourcing model would store the full change history:

```
favourite_food: Rice → Beans → Pizza
```

This enables JUNE to answer questions like "you used to like rice" without requiring a vector database. Facts with `decayed: true` (§6.4) are intentionally kept in storage rather than deleted, forming the beginning of this audit trail. ADR-006 will define the full event-sourcing schema, compaction strategy, and query interface. The current `UserFact` interface and `StorageProvider` contract are designed to be compatible with this extension without modification.

---

## 14. Consequences

### Positive
- **Zero breaking changes.** Every existing interface, test, and route handler continues to work without modification.
- **Clear write-back boundary.** Memory mutations are isolated to the route handler, outside the deterministic pipeline.
- **Provider independence.** The runtime never touches a database driver; switching backends is a one-file change.
- **Deterministic replay preserved.** Versioned, frozen `MemoryContext` snapshots ensure pipeline replay is unaffected by live storage state.
- **Privacy by design.** Tenant and user isolation is structural, not advisory.
- **Self-correcting memory.** Confidence decay and importance-weighted eviction make the user profile stay accurate without manual pruning.
- **Adaptive context ceiling.** Budget scales automatically with whatever LLM is configured — no hardcoded token limits in the runtime.
- **Concurrency-safe writes.** Optimistic concurrency guards prevent silent overwrites under concurrent request load.

### Negative
- **Two-phase request handling.** Every request now has a `load` phase (before pipeline) and a `record` phase (after pipeline), adding two round-trips to storage per request. Mitigated by keeping tiers small and using TTL-cached session storage.
- **Snapshot staleness.** The frozen `MemoryContext` reflects storage state at load time. If another process writes to storage mid-request, the pipeline does not see the update. This is intentional (determinism) but must be documented for operators.
- **Summarisation cost.** Extractive summarisation of evicted conversation turns adds CPU time at write. The impact is bounded by `maxConversationTurns` and is off the critical request path.
- **Decay sweep complexity.** A background job must be scheduled and monitored. If the sweep falls behind, facts may remain injected longer than their decay curve warrants. Mitigated by the `decayed` flag in storage — a manual sweep can be triggered via admin API.

---

## 15. Decision Makers
User, Mini (Advisor), and Replit Agent.

## 16. Date
July 21, 2026
