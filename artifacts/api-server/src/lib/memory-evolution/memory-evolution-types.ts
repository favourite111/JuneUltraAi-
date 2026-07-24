/**
 * M24 — Memory Evolution types.
 *
 * Memory Evolution is the pipeline stage that turns Reflection insights into
 * durable long-term knowledge. It sits entirely outside the request-response
 * path and is invoked fire-and-forget from the Execution Observer.
 *
 * Hard boundaries — Memory Evolution MUST NOT:
 *   ✗ execute tools
 *   ✗ call the LLM
 *   ✗ influence tool selection, routing, or execution path
 *   ✗ make planning decisions (memory informs, Planner decides)
 *   ✗ propagate errors to the caller (all failures swallowed internally)
 *
 * Memory Evolution MUST:
 *   ✓ accept a completed ReflectionResult (post-reflection only)
 *   ✓ route candidates through ConfidenceFilter → Extractor → KnowledgeReader → Policy → Store
 *   ✓ keep MemoryPolicy pure (receives existing memory as parameter, never queries storage)
 *   ✓ return a MemoryEvolutionResult regardless of internal outcome
 *   ✓ never write to ToolLearningStore (learning stats belong exclusively to M21)
 */

import type { KnowledgeCategory, KnowledgeRecord, MemoryScope } from "../memory/types.js";
import type { ReflectionResult } from "../reflection/reflection-types.js";

// ---------------------------------------------------------------------------
// Candidate
// ---------------------------------------------------------------------------

/**
 * A proposed mutation to long-term knowledge, produced by MemoryCandidateExtractor.
 * Immutable value type — never modified after creation.
 */
export interface MemoryCandidate {
  /** Unique ID for this candidate (becomes the KnowledgeRecord's recordId on write). */
  readonly candidateId: string;
  /** Stable namespaced key — convention: "tool.<name>.<pattern>". */
  readonly key: string;
  /** Human-readable summary of the knowledge being proposed. */
  readonly value: string;
  readonly category: KnowledgeCategory;
  /** 0.0–1.0 — certainty that this candidate is accurate. */
  readonly confidence: number;
  /** 0.0–1.0 — retrieval priority weight. */
  readonly importance: number;
  readonly source: "reflection";
  /** executionId of the ReflectionResult that produced this candidate. */
  readonly sourceExecutionId: string;
  /** Tool name associated with this candidate. */
  readonly sourceTool: string;
  readonly tags: readonly string[];
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/**
 * What the MemoryPolicy decided to do with a candidate.
 *
 *   ignore   — discard; no write
 *   merge    — write if no existing, or reinforce existing
 *   update   — overwrite existing with higher-confidence value
 *   replace  — replace low-confidence existing record
 *   promote  — immediately persist as authoritative (high-importance)
 *   decay    — reduce existing record's confidence (contradictory evidence)
 */
export type PolicyAction = "ignore" | "merge" | "update" | "replace" | "promote" | "decay";

/** Immutable decision for one MemoryCandidate. */
export interface PolicyDecision {
  readonly candidateId: string;
  readonly action: PolicyAction;
  /** Human-readable explanation — aids debugging and future tests. */
  readonly rationale: string;
}

// ---------------------------------------------------------------------------
// Evolution result
// ---------------------------------------------------------------------------

/** Immutable summary of one Memory Evolution pass. */
export interface MemoryEvolutionResult {
  /** Unique ID for this evolution run. */
  readonly engineId: string;
  /** executionId from the originating ReflectionResult. */
  readonly executionId: string;
  /**
   * 0 means the ReflectionResult was filtered out before candidate extraction.
   */
  readonly candidatesExtracted: number;
  /** One decision per extracted candidate. Empty when filtered early. */
  readonly decisions: readonly PolicyDecision[];
  /** Number of KnowledgeRecords actually written (upserted + decayed). */
  readonly written: number;
  /** Number of candidates skipped (ignored by policy or lost to merge version guard). */
  readonly skipped: number;
  readonly evolvedAt: number;
}

// ---------------------------------------------------------------------------
// Layer interface
// ---------------------------------------------------------------------------

/** Input envelope passed by the Observer to the MemoryEvolutionEngine. */
export interface MemoryEvolutionInput {
  /**
   * Full user scope — includes userId, which is required to read/write
   * per-user knowledge records via KnowledgeManager.
   */
  readonly scope: MemoryScope;
  /** Tool name from the originating execution (not present on ReflectionResult). */
  readonly toolName: string;
  readonly reflectionResult: ReflectionResult;
}

/**
 * M24 — MemoryEvolutionLayer public interface.
 *
 * CALL-SITE RULES (same isolation contract as M22/M23):
 *   1. Call ONLY after reflection has completed.
 *   2. Always call as `void memoryEvolution.evolve(...)` — never await.
 *   3. Never use the return value to gate execution or modify the response.
 */
export interface MemoryEvolutionLayer {
  evolve(input: MemoryEvolutionInput): Promise<MemoryEvolutionResult>;
}

// ---------------------------------------------------------------------------
// Structural store interfaces (avoid importing concrete classes)
// ---------------------------------------------------------------------------

/**
 * The subset of KnowledgeManager that KnowledgeReader needs.
 * Structural — keeps the reader decoupled from KnowledgeManager internals.
 */
export interface KnowledgeReaderStore {
  load(
    scope: MemoryScope,
    options?: {
      readonly categories?: readonly KnowledgeCategory[];
      readonly minConfidence?: number;
      readonly limit?: number;
    },
  ): Promise<readonly KnowledgeRecord[]>;
}

/**
 * The subset of KnowledgeManager that MemoryEvolutionEngine needs for writes.
 * Structural — decouples the engine from KnowledgeManager internals.
 */
export interface MemoryCandidateStore {
  merge(
    scope: MemoryScope,
    records: readonly KnowledgeRecord[],
  ): Promise<{ upserted: number; skipped: number }>;
  upsert(scope: MemoryScope, record: KnowledgeRecord): Promise<void>;
}

// ---------------------------------------------------------------------------
// MemoryReader types (pre-planning advisory read)
// ---------------------------------------------------------------------------

/**
 * The subset of KnowledgeManager that MemoryReader needs.
 * Structural — keeps the reader decoupled from KnowledgeManager internals.
 */
export interface MemoryReaderStore {
  loadRelevant(
    scope: MemoryScope,
    query: string | undefined,
    options?: {
      readonly limit?: number;
      readonly minConfidence?: number;
      readonly similarityThreshold?: number;
    },
  ): Promise<readonly KnowledgeRecord[]>;
}

/**
 * Advisory read result supplied to the Planner before intent detection.
 * The Planner may use records to inform decisions but MUST NOT delegate
 * any decision to them — memory provides context, Planner decides.
 */
export interface MemoryReaderResult {
  /** Relevant KnowledgeRecords for this query, ranked by semantic + deterministic score. */
  readonly records: readonly KnowledgeRecord[];
  /** The query string used for retrieval. */
  readonly query: string;
  readonly loadedAt: number;
}

/** M24 — MemoryReader public interface (pre-planning advisory). */
export interface MemoryReader {
  read(scope: MemoryScope, query: string): Promise<MemoryReaderResult>;
}
