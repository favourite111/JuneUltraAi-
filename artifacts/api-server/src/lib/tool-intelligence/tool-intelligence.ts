/**
 * M20 — Tool Intelligence Layer.
 *
 * Pipeline position:
 *   Planner (M17) → Reasoner (M18) → ToolIntelligence (M20) → Execution Orchestrator (M19) → Executors
 *
 * Responsibilities:
 *   ✓ Choose best tool
 *   ✓ Estimate confidence
 *   ✓ Detect tool conflicts
 *   ✓ Estimate execution cost
 *   ✓ Estimate latency
 *   ✓ Rank candidate tools
 *   ✓ Detect unavailable tools
 *   ✓ Recommend fallback tools
 *
 * Hard boundary — this layer MUST NOT:
 *   ✗ Call tools
 *   ✗ Call LLM
 *   ✗ Modify memory
 *   ✗ Modify planner
 *   ✗ Modify reasoner
 */

import { ToolRegistry } from "../tools/registry.js";
import { checkToolAvailability, isToolAvailable } from "./tool-availability.js";
import { rankTools, selectBestCandidate, selectFallbacks } from "./tool-ranking.js";
import { estimateCost, estimateLatency, } from "./tool-cost.js";
import { detectConflicts, detectUnavailabilityConflict } from "./tool-conflicts.js";
import {
  makeToolIntelligenceResult,
  noToolResult,
} from "./tool-intelligence-result.js";
import {
  toolIntelligenceMetrics,
  type ToolIntelligenceMetricsRecorder,
} from "./tool-intelligence-metrics.js";
import { applyLearningAdjustment } from "./tool-confidence.js";
import type {
  ToolIntelligenceInput,
  ToolIntelligenceResult,
} from "./tool-intelligence-types.js";
import type { ToolLearningReader } from "../tool-learning/tool-learning-types.js";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface ToolIntelligenceConfig {
  /** Injectable metrics recorder — defaults to the singleton. */
  readonly metrics?: ToolIntelligenceMetricsRecorder;
  /**
   * M21 Tool Learning reader. When provided together with a learningScope in
   * ToolIntelligenceInput, historical success/failure stats from prior
   * executions are used to apply a bounded (±0.10) confidence adjustment to
   * the selected tool. Callers that do not supply this field continue to work
   * unchanged — additive, non-breaking.
   */
  readonly learningReader?: ToolLearningReader;
}

export interface ToolIntelligenceLayer {
  /**
   * Evaluate the input and return an immutable ToolIntelligenceResult.
   * Pure reasoning only — no I/O, no execution.
   */
  evaluate(input: ToolIntelligenceInput): ToolIntelligenceResult;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createToolIntelligenceLayer(
  config: ToolIntelligenceConfig = {},
): ToolIntelligenceLayer {
  const metrics = config.metrics ?? toolIntelligenceMetrics;

  return {
    evaluate(input: ToolIntelligenceInput): ToolIntelligenceResult {
      // ---- Short-circuit: planner says no tool is needed --------------------
      if (!input.needsTool) {
        metrics.record({
          confidence:     1.0,
          candidateCount: 0,
          conflictCount:  0,
          fallbacksUsed:  false,
        });
        return noToolResult();
      }

      const warnings: string[] = [];

      // ---- 1. Rank all registered tools against the prompt -----------------
      const candidates = rankTools(input.prompt, input.toolName);

      // ---- 2. Resolve selected tool name and cost profile ------------------
      let selectedToolName: string | null = null;
      let confidence         = 0;
      let estimatedCost      = 1;
      let estimatedLatency   = 500;

      if (input.toolName) {
        // Planner explicitly nominated a tool — respect its authority.
        selectedToolName = input.toolName;

        const nominated = candidates.find((c) => c.name === input.toolName);
        if (nominated) {
          confidence       = nominated.confidence;
          estimatedCost    = nominated.estimatedCost;
          estimatedLatency = nominated.estimatedLatency;
        } else {
          // Tool below confidence threshold or missing from registry.
          const available  = isToolAvailable(input.toolName);
          confidence       = available ? 0.90 : 0;
          estimatedCost    = estimateCost(input.toolName);
          estimatedLatency = estimateLatency(input.toolName);
        }

        if (!isToolAvailable(input.toolName)) {
          warnings.push(
            `Nominated tool "${input.toolName}" is not registered in ToolRegistry.`,
          );
        }
      } else {
        // No explicit nomination — pick the best available candidate.
        const best = selectBestCandidate(candidates);
        if (best) {
          selectedToolName = best.name;
          confidence       = best.confidence;
          estimatedCost    = best.estimatedCost;
          estimatedLatency = best.estimatedLatency;

          if (!best.available) {
            warnings.push(
              `Best-ranked tool "${best.name}" is not registered in ToolRegistry.`,
            );
          }
        } else {
          warnings.push("No suitable tool identified for the given prompt.");
        }
      }

      // Warn when manifest is missing (cost/latency are defaults only).
      if (selectedToolName) {
        const selectedTool = ToolRegistry.getTool(selectedToolName);
        if (selectedTool && !selectedTool.manifest) {
          warnings.push(
            `Tool "${selectedToolName}" has no manifest — cost and latency estimates are defaults.`,
          );
        }
      }

      // ---- M21 learning adjustment (bounded; satisfies N+1 determinism) ----
      // Reads from ToolLearningReader cache (sync) — reflects only executions
      // that completed before this request. The current execution's outcome is
      // not yet recorded, so there is no feedback loop.
      if (selectedToolName && config.learningReader && input.learningScope) {
        const lStats = config.learningReader.getStats(input.learningScope, selectedToolName);
        if (lStats) {
          const isNominated = !!input.toolName && input.toolName === selectedToolName;
          confidence = applyLearningAdjustment(confidence, lStats, isNominated);
        }
      }

      // ---- 3. Availability status ------------------------------------------
      const availability = checkToolAvailability(selectedToolName);

      // ---- 4. Fallbacks: available tools that are not the selected one ------
      const fallbackCandidates = selectFallbacks(candidates, selectedToolName);
      const fallbacksUsed =
        availability === "unavailable" && fallbackCandidates.length > 0;

      if (fallbacksUsed) {
        warnings.push(
          `Tool "${selectedToolName}" is unavailable. ` +
          `Fallback(s) available: ${fallbackCandidates.join(", ")}.`,
        );
      }

      // ---- 5. Conflict detection -------------------------------------------
      const conflicts = [
        ...detectConflicts(candidates),
        ...(selectedToolName
          ? detectUnavailabilityConflict(
              selectedToolName,
              availability === "available",
              fallbackCandidates,
            )
          : []),
      ];

      // ---- 6. Record metrics ------------------------------------------------
      metrics.record({
        confidence,
        candidateCount: candidates.length,
        conflictCount:  conflicts.length,
        fallbacksUsed,
      });

      // ---- 7. Return deep-frozen result ------------------------------------
      return makeToolIntelligenceResult({
        selectedTool:       selectedToolName,
        candidateTools:     candidates,
        confidence,
        estimatedLatency,
        estimatedCost,
        availability,
        fallbackCandidates,
        conflicts,
        warnings,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Default singleton — used by chat.ts / orchestrator integration
// ---------------------------------------------------------------------------

export const toolIntelligenceLayer = createToolIntelligenceLayer();
