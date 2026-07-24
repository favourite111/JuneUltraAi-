/**
 * M24 — MemoryEvolutionEngine.
 *
 * Orchestrates the full Memory Evolution pipeline:
 *
 *   ConfidenceFilter  → early exit for weak signals
 *         ↓
 *   CandidateExtractor → pure: ReflectionResult → MemoryCandidate[]
 *         ↓
 *   KnowledgeReader   → I/O: load existing records for candidate keys
 *         ↓
 *   MemoryPolicy      → pure: decide action per (candidate, existingMemory)
 *         ↓
 *   KnowledgeManager  → I/O: write approved records
 *
 * ISOLATION CONTRACT (matches M22/M23):
 *   evolve() NEVER throws. Every error is caught, logged, and swallowed.
 *   Callers invoke it as `void memoryEvolution.evolve(...)` — non-blocking.
 *   A crashed evolve() call must leave the user response completely unaffected.
 *
 * VERSIONING:
 *   When updating or replacing an existing record, the engine increments the
 *   existing record's version so KnowledgeManager.merge() accepts the write
 *   (incoming.version must exceed stored.version).
 *
 * DECAY:
 *   Decayed records are written via store.upsert() rather than merge() to
 *   bypass the version guard. The existing record's confidence is multiplied
 *   by DECAY_FACTOR and its version is incremented.
 */

import { randomUUID } from "node:crypto";
import type { KnowledgeRecord, MemoryScope } from "../memory/types.js";
import { passesConfidenceFilter } from "./confidence-filter.js";
import { extractCandidates } from "./memory-candidate-extractor.js";
import type { KnowledgeReader } from "./knowledge-reader.js";
import type { MemoryPolicy } from "./memory-policy.js";
import type {
  MemoryCandidate,
  MemoryCandidateStore,
  MemoryEvolutionInput,
  MemoryEvolutionLayer,
  MemoryEvolutionResult,
  PolicyDecision,
} from "./memory-evolution-types.js";
import {
  memoryEvolutionMetrics,
  type MemoryEvolutionMetricsRecorder,
} from "./memory-evolution-metrics.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Multiplier applied to an existing record's confidence during a decay pass. */
const DECAY_FACTOR = 0.70;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface MemoryEvolutionEngineConfig {
  readonly policy: MemoryPolicy;
  readonly reader: KnowledgeReader;
  readonly store: MemoryCandidateStore;
  /** Injectable metrics recorder — defaults to the module singleton. */
  readonly metrics?: MemoryEvolutionMetricsRecorder;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createMemoryEvolutionEngine(
  config: MemoryEvolutionEngineConfig,
): MemoryEvolutionLayer {
  const { policy, reader, store } = config;
  const metrics = config.metrics ?? memoryEvolutionMetrics;

  return {
    async evolve(input: MemoryEvolutionInput): Promise<MemoryEvolutionResult> {
      const engineId = randomUUID();
      const { scope, toolName, reflectionResult } = input;

      // ------------------------------------------------------------------
      // ISOLATION: the entire evolve() body is wrapped in a try/catch.
      // Nothing inside this function may propagate an error to the caller.
      // ------------------------------------------------------------------
      try {
        // ---- 1. Confidence filter ----------------------------------------
        if (!passesConfidenceFilter(reflectionResult)) {
          metrics.record({ filtered: true });
          return filteredResult(engineId, reflectionResult.executionId);
        }

        // ---- 2. Extract candidates (pure — no I/O) -----------------------
        const candidates = extractCandidates(
          reflectionResult,
          toolName,
          reflectionResult.executionId,
        );

        if (candidates.length === 0) {
          metrics.record({ succeeded: true, candidatesExtracted: 0, written: 0, skipped: 0 });
          return emptyResult(engineId, reflectionResult.executionId);
        }

        // ---- 3. Load existing records (I/O) -----------------------------
        const existingRecords = await reader.read(scope, candidates.map((c) => c.key));

        // ---- 4. Apply policy (pure — no I/O) ----------------------------
        const decisions: PolicyDecision[] = candidates.map((candidate) =>
          policy.decide(candidate, existingRecords),
        );

        // ---- 5. Execute decisions ----------------------------------------
        const nowMs = Date.now();
        const toMerge: KnowledgeRecord[] = [];
        let written = 0;
        let skipped = 0;

        for (let i = 0; i < candidates.length; i++) {
          const candidate = candidates[i]!;
          const decision = decisions[i]!;

          if (decision.action === "ignore") {
            skipped++;
            continue;
          }

          if (decision.action === "decay") {
            const existing = existingRecords.find((r) => r.key === candidate.key);
            if (existing) {
              await store.upsert(scope, decayRecord(existing, nowMs));
              written++;
            } else {
              skipped++;
            }
            continue;
          }

          // promote | merge | update | replace — write via merge()
          const existing = existingRecords.find((r) => r.key === candidate.key);
          toMerge.push(candidateToRecord(candidate, nowMs, existing));
        }

        if (toMerge.length > 0) {
          const mergeResult = await store.merge(scope, toMerge);
          written += mergeResult.upserted;
          skipped += mergeResult.skipped;
        }

        // ---- 6. Record metrics -------------------------------------------
        metrics.record({
          succeeded: true,
          candidatesExtracted: candidates.length,
          written,
          skipped,
        });

        return Object.freeze({
          engineId,
          executionId: reflectionResult.executionId,
          candidatesExtracted: candidates.length,
          decisions: Object.freeze(decisions),
          written,
          skipped,
          evolvedAt: nowMs,
        });

      } catch (err: unknown) {
        // ------------------------------------------------------------------
        // ISOLATION CONTRACT:
        //   Catch everything. Log without re-throwing. Return failed result.
        //   The user response is never affected by what happens here.
        // ------------------------------------------------------------------
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[MemoryEvolution] Evolution failed (non-fatal): ${message}`);
        metrics.record({ failed: true });
        return failedResult(engineId, reflectionResult.executionId);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Record builders
// ---------------------------------------------------------------------------

/**
 * Converts a MemoryCandidate to a KnowledgeRecord ready for storage.
 *
 * Version is derived from the existing record (if any) so that
 * KnowledgeManager.merge()'s version guard always accepts the write:
 *   - New record      → version: 1
 *   - Update/replace  → existing.version + 1
 */
function candidateToRecord(
  candidate: MemoryCandidate,
  nowMs: number,
  existing?: KnowledgeRecord,
): KnowledgeRecord {
  return Object.freeze({
    recordId: candidate.candidateId,
    key: candidate.key,
    value: candidate.value,
    category: candidate.category,
    confidence: candidate.confidence,
    importance: candidate.importance,
    source: "inferred" as const,
    tags: Object.freeze([...candidate.tags, "m24-evolution"]),
    createdAt: existing?.createdAt ?? nowMs,
    updatedAt: nowMs,
    version: existing !== undefined ? existing.version + 1 : 1,
  });
}

/**
 * Creates a decayed version of an existing record.
 * The version is incremented so store.upsert() overwrites the stored record.
 */
function decayRecord(existing: KnowledgeRecord, nowMs: number): KnowledgeRecord {
  return Object.freeze({
    ...existing,
    confidence: Math.max(0, existing.confidence * DECAY_FACTOR),
    updatedAt: nowMs,
    version: existing.version + 1,
    tags: Object.freeze([...existing.tags, "m24-decayed"]),
  });
}

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

function filteredResult(engineId: string, executionId: string): MemoryEvolutionResult {
  return Object.freeze({
    engineId,
    executionId,
    candidatesExtracted: 0,
    decisions: Object.freeze([]),
    written: 0,
    skipped: 0,
    evolvedAt: Date.now(),
  });
}

function emptyResult(engineId: string, executionId: string): MemoryEvolutionResult {
  return filteredResult(engineId, executionId);
}

function failedResult(engineId: string, executionId: string): MemoryEvolutionResult {
  return Object.freeze({
    engineId,
    executionId,
    candidatesExtracted: 0,
    decisions: Object.freeze([]),
    written: 0,
    skipped: 0,
    evolvedAt: Date.now(),
  });
}
