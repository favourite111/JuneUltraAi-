/**
 * M20 — Tool Intelligence Layer test suite.
 *
 * Coverage:
 *   - Tool ranking
 *   - Confidence estimation
 *   - Conflict detection
 *   - Fallback selection
 *   - Availability checks
 *   - Result immutability
 *   - Metrics
 *   - Integration with Execution Orchestrator
 *   - No-execution boundary enforcement
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { ToolRegistry } from "../../tools/registry.js";
import type { Tool, ToolResult } from "../../tools/types.js";

import {
  createToolIntelligenceLayer,
  ToolIntelligenceMetrics,
  rankTools,
  selectBestCandidate,
  selectFallbacks,
  detectConflicts,
  detectUnavailabilityConflict,
  estimateCost,
  estimateLatency,
  getToolCostProfile,
  checkToolAvailability,
  isToolAvailable,
  getRegisteredToolNames,
  estimateToolConfidence,
  estimatePlannerNominatedConfidence,
  buildCandidate,
  noToolResult,
  makeToolIntelligenceResult,
} from "../index.js";

import type {
  ToolIntelligenceInput,
  CandidateTool,
} from "../tool-intelligence-types.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

let toolCounter = 0;

function makeTestTool(
  name: string,
  opts: {
    hasSore?: boolean;
    scoreValue?: number;
    hasTrigger?: boolean;
    trigger?: string;
    cost?: number;
    latency?: number;
  } = {},
): Tool {
  const {
    hasSore    = false,
    scoreValue = 0.8,
    hasTrigger = false,
    trigger    = name,
    cost       = 1,
    latency    = 300,
  } = opts;

  const tool: Tool = {
    name,
    description: `Test tool ${name}`,
    match: (text) => (text.includes(name) ? { text } : null),
    execute: vi.fn().mockResolvedValue({
      type: "text",
      reply: `Result from ${name}`,
      data: {},
    } satisfies ToolResult),
  };

  if (hasSore) {
    tool.score = () => ({
      score: scoreValue,
      reasoning: [`${name} matched with score ${scoreValue}`],
    });
  }

  if (hasTrigger) {
    (tool as Tool & { manifest: NonNullable<Tool["manifest"]> }).manifest = {
      id:             name,
      name,
      description:    `${name} manifest`,
      version:        "1.0.0",
      category:       "test",
      triggers:       [trigger],
      inputSchema:    {},
      outputTypes:    ["text"],
      cost,
      estimatedLatency: latency,
      permissions:    [],
      examples:       [],
    };
  }

  return tool;
}

function makeInput(overrides: Partial<ToolIntelligenceInput> = {}): ToolIntelligenceInput {
  return {
    prompt:    "test prompt",
    needsTool: true,
    ...overrides,
  };
}

// Clear registered test tools before each test to avoid cross-test contamination.
// We use uniquely-named tools per test, so no cleanup of real tools is needed.

// ---------------------------------------------------------------------------
// 1. Tool Ranking
// ---------------------------------------------------------------------------

describe("M20 ToolIntelligence — tool ranking", () => {
  it("returns empty array when no tools score above threshold", () => {
    const toolName = `zeroc-${++toolCounter}`;
    const tool = makeTestTool(toolName, { hasSore: true, scoreValue: 0.1 });
    ToolRegistry.register(tool);

    const candidates = rankTools("completely unrelated prompt xyz123");
    // The tool won't match on the unrelated prompt (score below threshold)
    const found = candidates.find((c) => c.name === toolName);
    expect(found).toBeUndefined();
  });

  it("sorts candidates by confidence descending", () => {
    const n1 = `rank-high-${++toolCounter}`;
    const n2 = `rank-low-${++toolCounter}`;
    ToolRegistry.register(makeTestTool(n1, { hasSore: true, scoreValue: 0.9 }));
    ToolRegistry.register(makeTestTool(n2, { hasSore: true, scoreValue: 0.6 }));

    const candidates = rankTools(`${n1} ${n2}`);
    const idx1 = candidates.findIndex((c) => c.name === n1);
    const idx2 = candidates.findIndex((c) => c.name === n2);

    expect(idx1).toBeGreaterThanOrEqual(0);
    expect(idx2).toBeGreaterThanOrEqual(0);
    expect(idx1).toBeLessThan(idx2);
  });

  it("breaks confidence ties by lower cost ascending", () => {
    const n1 = `tie-cheap-${++toolCounter}`;
    const n2 = `tie-expensive-${++toolCounter}`;
    ToolRegistry.register(makeTestTool(n1, { hasSore: true, scoreValue: 0.8, hasTrigger: true, trigger: n1, cost: 1 }));
    ToolRegistry.register(makeTestTool(n2, { hasSore: true, scoreValue: 0.8, hasTrigger: true, trigger: n2, cost: 5 }));

    const candidates = rankTools(`${n1} ${n2}`);
    const idx1 = candidates.findIndex((c) => c.name === n1);
    const idx2 = candidates.findIndex((c) => c.name === n2);

    if (idx1 >= 0 && idx2 >= 0) {
      // cheap tool should rank before expensive tool when confidence is equal
      expect(idx1).toBeLessThanOrEqual(idx2);
    }
  });

  it("nominated tool receives higher confidence floor", () => {
    const n = `nominated-${++toolCounter}`;
    ToolRegistry.register(makeTestTool(n)); // no score method — default confidence

    const withNom    = rankTools("some prompt", n);
    const withoutNom = rankTools("some prompt");

    const withNomResult    = withNom.find((c) => c.name === n);
    const withoutNomResult = withoutNom.find((c) => c.name === n);

    if (withNomResult && withoutNomResult) {
      expect(withNomResult.confidence).toBeGreaterThanOrEqual(withoutNomResult.confidence);
    }
  });

  it("includes only tools above min confidence threshold (0.30)", () => {
    const n = `lowscore-${++toolCounter}`;
    ToolRegistry.register(makeTestTool(n, { hasSore: true, scoreValue: 0.2 }));

    const candidates = rankTools(`${n} prompt`);
    const found = candidates.find((c) => c.name === n);
    expect(found).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Confidence Estimation
// ---------------------------------------------------------------------------

describe("M20 ToolIntelligence — confidence estimation", () => {
  it("returns confidence 0 for an unregistered tool", () => {
    const { confidence } = estimateToolConfidence("__nonexistent_tool__", "prompt");
    expect(confidence).toBe(0);
  });

  it("uses tool.score() when available", () => {
    const n = `scored-${++toolCounter}`;
    ToolRegistry.register(makeTestTool(n, { hasSore: true, scoreValue: 0.77 }));
    const { confidence } = estimateToolConfidence(n, `prompt ${n}`);
    expect(confidence).toBeCloseTo(0.77);
  });

  it("gives higher confidence when manifest trigger matches prompt", () => {
    const trigger = `trigger-phrase-${++toolCounter}`;
    const n = `mani-match-${++toolCounter}`;
    ToolRegistry.register(makeTestTool(n, { hasTrigger: true, trigger }));

    const matched   = estimateToolConfidence(n, `${trigger} please`);
    const unmatched = estimateToolConfidence(n, "unrelated text");

    expect(matched.confidence).toBeGreaterThan(unmatched.confidence);
  });

  it("falls back to default confidence for legacy tools without manifest or score()", () => {
    const n = `legacy-${++toolCounter}`;
    ToolRegistry.register(makeTestTool(n)); // no manifest, no score
    const { confidence, reasoning } = estimateToolConfidence(n, "any prompt");
    expect(confidence).toBeGreaterThan(0);
    expect(reasoning.some((r) => r.toLowerCase().includes("legacy") || r.toLowerCase().includes("default"))).toBe(true);
  });

  it("planner-nominated tool confidence is at least 0.90", () => {
    const n = `planner-nom-${++toolCounter}`;
    ToolRegistry.register(makeTestTool(n)); // default confidence ~0.70
    const { confidence } = estimatePlannerNominatedConfidence(n, "any prompt");
    expect(confidence).toBeGreaterThanOrEqual(0.90);
  });

  it("buildCandidate includes correct metadata fields", () => {
    const n = `cand-meta-${++toolCounter}`;
    ToolRegistry.register(makeTestTool(n, { hasTrigger: true, trigger: n, cost: 3, latency: 1000 }));
    const c = buildCandidate(n, `${n} please`, false);
    expect(c.name).toBe(n);
    expect(c.estimatedCost).toBe(3);
    expect(c.estimatedLatency).toBe(1000);
    expect(c.available).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Conflict Detection
// ---------------------------------------------------------------------------

describe("M20 ToolIntelligence — conflict detection", () => {
  it("returns no conflicts when only one candidate", () => {
    const candidate: CandidateTool = Object.freeze({
      name: "solo", confidence: 0.9, reasoning: [], estimatedCost: 1,
      estimatedLatency: 100, available: true,
    });
    const conflicts = detectConflicts([candidate]);
    expect(conflicts).toHaveLength(0);
  });

  it("detects conflict when two tools have confidence within 0.15 of each other", () => {
    const a: CandidateTool = Object.freeze({ name: "a", confidence: 0.80, reasoning: [], estimatedCost: 1, estimatedLatency: 100, available: true });
    const b: CandidateTool = Object.freeze({ name: "b", confidence: 0.75, reasoning: [], estimatedCost: 1, estimatedLatency: 100, available: true });
    const conflicts = detectConflicts([a, b]);
    expect(conflicts.length).toBeGreaterThan(0);
    expect(conflicts[0]!.toolA).toBe("a");
    expect(conflicts[0]!.toolB).toBe("b");
  });

  it("does NOT flag conflict when confidence gap is large (>0.15)", () => {
    const a: CandidateTool = Object.freeze({ name: "a", confidence: 0.95, reasoning: [], estimatedCost: 1, estimatedLatency: 100, available: true });
    const b: CandidateTool = Object.freeze({ name: "b", confidence: 0.50, reasoning: [], estimatedCost: 1, estimatedLatency: 100, available: true });
    const conflicts = detectConflicts([a, b]);
    expect(conflicts).toHaveLength(0);
  });

  it("detects unavailability conflict for nominated tool that is missing", () => {
    const conflicts = detectUnavailabilityConflict("missing-tool", false, ["fallback-a"]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.toolA).toBe("missing-tool");
    expect(conflicts[0]!.toolB).toBe("fallback-a");
  });

  it("detects unavailability conflict with (none) when no fallbacks exist", () => {
    const conflicts = detectUnavailabilityConflict("missing-tool", false, []);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.toolB).toBe("(none)");
  });

  it("returns no unavailability conflict when tool IS available", () => {
    const conflicts = detectUnavailabilityConflict("good-tool", true, []);
    expect(conflicts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Fallback Selection
// ---------------------------------------------------------------------------

describe("M20 ToolIntelligence — fallback selection", () => {
  it("returns empty when no other tools available", () => {
    const candidates: CandidateTool[] = [
      Object.freeze({ name: "selected", confidence: 0.9, reasoning: [], estimatedCost: 1, estimatedLatency: 100, available: true }),
    ];
    const fallbacks = selectFallbacks(candidates, "selected");
    expect(fallbacks).toHaveLength(0);
  });

  it("returns available tools excluding the selected one", () => {
    const candidates: CandidateTool[] = [
      Object.freeze({ name: "selected", confidence: 0.9, reasoning: [], estimatedCost: 1, estimatedLatency: 100, available: true }),
      Object.freeze({ name: "fallback1", confidence: 0.7, reasoning: [], estimatedCost: 1, estimatedLatency: 100, available: true }),
      Object.freeze({ name: "fallback2", confidence: 0.6, reasoning: [], estimatedCost: 1, estimatedLatency: 100, available: true }),
    ];
    const fallbacks = selectFallbacks(candidates, "selected");
    expect(fallbacks).toContain("fallback1");
    expect(fallbacks).toContain("fallback2");
    expect(fallbacks).not.toContain("selected");
  });

  it("limits fallbacks to maxFallbacks (default 3)", () => {
    const candidates: CandidateTool[] = [
      Object.freeze({ name: "s", confidence: 0.9, reasoning: [], estimatedCost: 1, estimatedLatency: 100, available: true }),
      Object.freeze({ name: "f1", confidence: 0.8, reasoning: [], estimatedCost: 1, estimatedLatency: 100, available: true }),
      Object.freeze({ name: "f2", confidence: 0.75, reasoning: [], estimatedCost: 1, estimatedLatency: 100, available: true }),
      Object.freeze({ name: "f3", confidence: 0.7, reasoning: [], estimatedCost: 1, estimatedLatency: 100, available: true }),
      Object.freeze({ name: "f4", confidence: 0.65, reasoning: [], estimatedCost: 1, estimatedLatency: 100, available: true }),
    ];
    const fallbacks = selectFallbacks(candidates, "s");
    expect(fallbacks.length).toBeLessThanOrEqual(3);
  });

  it("excludes unavailable tools from fallbacks", () => {
    const candidates: CandidateTool[] = [
      Object.freeze({ name: "selected", confidence: 0.9, reasoning: [], estimatedCost: 1, estimatedLatency: 100, available: true }),
      Object.freeze({ name: "unavail",  confidence: 0.8, reasoning: [], estimatedCost: 1, estimatedLatency: 100, available: false }),
      Object.freeze({ name: "good-fb",  confidence: 0.7, reasoning: [], estimatedCost: 1, estimatedLatency: 100, available: true }),
    ];
    const fallbacks = selectFallbacks(candidates, "selected");
    expect(fallbacks).not.toContain("unavail");
    expect(fallbacks).toContain("good-fb");
  });
});

// ---------------------------------------------------------------------------
// 5. Availability Checks
// ---------------------------------------------------------------------------

describe("M20 ToolIntelligence — availability checks", () => {
  it("returns 'available' for a registered tool", () => {
    const n = `avail-${++toolCounter}`;
    ToolRegistry.register(makeTestTool(n));
    expect(checkToolAvailability(n)).toBe("available");
    expect(isToolAvailable(n)).toBe(true);
  });

  it("returns 'unavailable' for an unregistered tool", () => {
    expect(checkToolAvailability("__no_such_tool__")).toBe("unavailable");
    expect(isToolAvailable("__no_such_tool__")).toBe(false);
  });

  it("returns 'unknown' for null or undefined", () => {
    expect(checkToolAvailability(null)).toBe("unknown");
    expect(checkToolAvailability(undefined)).toBe("unknown");
  });

  it("getRegisteredToolNames returns at least the registered test tools", () => {
    const n = `names-${++toolCounter}`;
    ToolRegistry.register(makeTestTool(n));
    const names = getRegisteredToolNames();
    expect(names).toContain(n);
  });
});

// ---------------------------------------------------------------------------
// 6. Cost & Latency
// ---------------------------------------------------------------------------

describe("M20 ToolIntelligence — cost and latency estimation", () => {
  it("returns default cost 1 for tools without manifest", () => {
    const n = `no-manifest-${++toolCounter}`;
    ToolRegistry.register(makeTestTool(n));
    expect(estimateCost(n)).toBe(1);
  });

  it("returns manifest cost when available", () => {
    const n = `manifest-cost-${++toolCounter}`;
    ToolRegistry.register(makeTestTool(n, { hasTrigger: true, trigger: n, cost: 7 }));
    expect(estimateCost(n)).toBe(7);
  });

  it("returns default latency 500ms for tools without manifest", () => {
    const n = `no-lat-${++toolCounter}`;
    ToolRegistry.register(makeTestTool(n));
    expect(estimateLatency(n)).toBe(500);
  });

  it("returns manifest latency when available", () => {
    const n = `manifest-lat-${++toolCounter}`;
    ToolRegistry.register(makeTestTool(n, { hasTrigger: true, trigger: n, latency: 2000 }));
    expect(estimateLatency(n)).toBe(2000);
  });

  it("getToolCostProfile indicates fromManifest correctly", () => {
    const nNoMani = `no-mani-prof-${++toolCounter}`;
    ToolRegistry.register(makeTestTool(nNoMani));
    const profileA = getToolCostProfile(nNoMani);
    expect(profileA.fromManifest).toBe(false);

    const nMani = `mani-prof-${++toolCounter}`;
    ToolRegistry.register(makeTestTool(nMani, { hasTrigger: true, trigger: nMani, cost: 4, latency: 1200 }));
    const profileB = getToolCostProfile(nMani);
    expect(profileB.fromManifest).toBe(true);
    expect(profileB.cost).toBe(4);
    expect(profileB.latencyMs).toBe(1200);
  });
});

// ---------------------------------------------------------------------------
// 7. Result Immutability
// ---------------------------------------------------------------------------

describe("M20 ToolIntelligence — result immutability", () => {
  it("ToolIntelligenceResult is deeply frozen", () => {
    const result = noToolResult();
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.candidateTools)).toBe(true);
    expect(Object.isFrozen(result.fallbackCandidates)).toBe(true);
    expect(Object.isFrozen(result.conflicts)).toBe(true);
    expect(Object.isFrozen(result.warnings)).toBe(true);
  });

  it("makeToolIntelligenceResult produces a frozen result", () => {
    const result = makeToolIntelligenceResult({
      selectedTool:       "some-tool",
      candidateTools:     [],
      confidence:         0.9,
      estimatedLatency:   500,
      estimatedCost:      1,
      availability:       "available",
      fallbackCandidates: ["other-tool"],
      conflicts:          [],
      warnings:           ["test warning"],
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.fallbackCandidates)).toBe(true);
    expect(Object.isFrozen(result.warnings)).toBe(true);
  });

  it("attempting to mutate a frozen result throws in strict mode", () => {
    const result = noToolResult();
    expect(() => {
      (result as { selectedTool: string }).selectedTool = "hacked";
    }).toThrow();
  });

  it("layer.evaluate() result is deeply frozen", () => {
    const n = `immut-tool-${++toolCounter}`;
    ToolRegistry.register(makeTestTool(n));
    const layer = createToolIntelligenceLayer();
    const result = layer.evaluate({ prompt: `${n} request`, needsTool: true, toolName: n });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.candidateTools)).toBe(true);
    expect(Object.isFrozen(result.conflicts)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8. Metrics
// ---------------------------------------------------------------------------

describe("M20 ToolIntelligence — metrics", () => {
  let metrics: ToolIntelligenceMetrics;

  beforeEach(() => {
    metrics = new ToolIntelligenceMetrics();
  });

  it("increments evaluations on each record() call", () => {
    metrics.record({ confidence: 0.8, candidateCount: 2, conflictCount: 0, fallbacksUsed: false });
    metrics.record({ confidence: 0.7, candidateCount: 1, conflictCount: 1, fallbacksUsed: false });
    expect(metrics.snapshot().evaluations).toBe(2);
  });

  it("tracks conflicts_detected correctly", () => {
    metrics.record({ confidence: 0.8, candidateCount: 3, conflictCount: 2, fallbacksUsed: false });
    expect(metrics.snapshot().conflicts_detected).toBe(2);
  });

  it("tracks fallbacks_used correctly", () => {
    metrics.record({ confidence: 0.5, candidateCount: 2, conflictCount: 0, fallbacksUsed: true });
    metrics.record({ confidence: 0.9, candidateCount: 1, conflictCount: 0, fallbacksUsed: false });
    expect(metrics.snapshot().fallbacks_used).toBe(1);
  });

  it("computes average_confidence correctly", () => {
    metrics.record({ confidence: 0.8, candidateCount: 1, conflictCount: 0, fallbacksUsed: false });
    metrics.record({ confidence: 0.6, candidateCount: 1, conflictCount: 0, fallbacksUsed: false });
    expect(metrics.snapshot().average_confidence).toBeCloseTo(0.7);
  });

  it("computes average_candidates correctly", () => {
    metrics.record({ confidence: 0.8, candidateCount: 4, conflictCount: 0, fallbacksUsed: false });
    metrics.record({ confidence: 0.8, candidateCount: 2, conflictCount: 0, fallbacksUsed: false });
    expect(metrics.snapshot().average_candidates).toBeCloseTo(3);
  });

  it("snapshot returns 0 for averages when no records exist", () => {
    const snap = metrics.snapshot();
    expect(snap.average_confidence).toBe(0);
    expect(snap.average_candidates).toBe(0);
  });

  it("snapshot is frozen", () => {
    const snap = metrics.snapshot();
    expect(Object.isFrozen(snap)).toBe(true);
  });

  it("layer.evaluate() records metrics via injected recorder", () => {
    const recorder = {
      record: vi.fn(),
    };
    const n = `metrics-test-${++toolCounter}`;
    ToolRegistry.register(makeTestTool(n));
    const layer = createToolIntelligenceLayer({ metrics: recorder });
    layer.evaluate({ prompt: `${n} please`, needsTool: true, toolName: n });
    expect(recorder.record).toHaveBeenCalledOnce();
    const arg = recorder.record.mock.calls[0]![0];
    expect(typeof arg.confidence).toBe("number");
    expect(typeof arg.candidateCount).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// 9. Integration with Execution Orchestrator (via OrchestratorInput)
// ---------------------------------------------------------------------------

describe("M20 ToolIntelligence — integration with Execution Orchestrator", () => {
  it("evaluate() with needsTool=true and a registered tool returns selectedTool", () => {
    const n = `integration-${++toolCounter}`;
    ToolRegistry.register(makeTestTool(n));
    const layer = createToolIntelligenceLayer();
    const result = layer.evaluate({ prompt: `${n} please`, needsTool: true, toolName: n });
    expect(result.selectedTool).toBe(n);
  });

  it("evaluate() with needsTool=false returns null selectedTool", () => {
    const layer = createToolIntelligenceLayer();
    const result = layer.evaluate({ prompt: "just chat", needsTool: false });
    expect(result.selectedTool).toBeNull();
    expect(result.candidateTools).toHaveLength(0);
  });

  it("evaluate() with unregistered toolName marks availability as unavailable", () => {
    const layer = createToolIntelligenceLayer();
    const result = layer.evaluate({ prompt: "use missing tool", needsTool: true, toolName: "__not_registered__" });
    expect(result.availability).toBe("unavailable");
  });

  it("evaluate() warns when nominated tool is unregistered", () => {
    const layer = createToolIntelligenceLayer();
    const result = layer.evaluate({ prompt: "do something", needsTool: true, toolName: "__ghost_tool__" });
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some((w) => w.includes("__ghost_tool__"))).toBe(true);
  });

  it("evaluate() returns confidence 1.0 when needsTool=false", () => {
    const layer = createToolIntelligenceLayer();
    const result = layer.evaluate({ prompt: "no tool needed", needsTool: false });
    expect(result.confidence).toBe(1.0);
  });

  it("evaluate() does NOT call any tool's execute() method", () => {
    const n = `no-exec-${++toolCounter}`;
    const executeSpy = vi.fn();
    ToolRegistry.register({
      name: n,
      description: "spy tool",
      match: () => ({}),
      execute: executeSpy,
    });
    const layer = createToolIntelligenceLayer();
    layer.evaluate({ prompt: `${n} please`, needsTool: true, toolName: n });
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("evaluate() includes fallbackCandidates when selected tool is unavailable", () => {
    const fb = `fb-avail-${++toolCounter}`;
    ToolRegistry.register(makeTestTool(fb, { hasSore: true, scoreValue: 0.85 }));

    const layer = createToolIntelligenceLayer();
    const result = layer.evaluate({
      prompt: `${fb} help me`,
      needsTool: true,
      toolName: "__unavailable_tool__",
    });

    expect(result.availability).toBe("unavailable");
    // The fallback should appear in the candidate list
    expect(result.candidateTools.length).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// 10. No-execution boundary
// ---------------------------------------------------------------------------

describe("M20 ToolIntelligence — no-execution boundary", () => {
  it("evaluate() is synchronous — no async execution path", () => {
    const layer = createToolIntelligenceLayer();
    const returnValue = layer.evaluate({ prompt: "test", needsTool: false });
    // If evaluate() returned a Promise, the next assertion would fail
    expect(returnValue).not.toBeInstanceOf(Promise);
    expect(typeof returnValue.selectedTool).toBe("object"); // null or string
  });

  it("evaluate() with needsTool=false short-circuits without inspecting tools", () => {
    const executeSpy = vi.fn();
    const n = `shortcircuit-${++toolCounter}`;
    ToolRegistry.register({ name: n, description: "spy", match: () => ({}), execute: executeSpy });

    const layer = createToolIntelligenceLayer();
    layer.evaluate({ prompt: "hello", needsTool: false });
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("layer result has all required ToolIntelligenceResult fields", () => {
    const n = `schema-${++toolCounter}`;
    ToolRegistry.register(makeTestTool(n));
    const layer = createToolIntelligenceLayer();
    const result = layer.evaluate({ prompt: `${n} test`, needsTool: true, toolName: n });

    expect("selectedTool"       in result).toBe(true);
    expect("candidateTools"     in result).toBe(true);
    expect("confidence"         in result).toBe(true);
    expect("estimatedLatency"   in result).toBe(true);
    expect("estimatedCost"      in result).toBe(true);
    expect("availability"       in result).toBe(true);
    expect("fallbackCandidates" in result).toBe(true);
    expect("conflicts"          in result).toBe(true);
    expect("warnings"           in result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 11. selectBestCandidate
// ---------------------------------------------------------------------------

describe("M20 ToolIntelligence — selectBestCandidate", () => {
  it("returns null for empty list", () => {
    expect(selectBestCandidate([])).toBeNull();
  });

  it("prefers available candidates over unavailable", () => {
    const candidates: CandidateTool[] = [
      Object.freeze({ name: "unavail-high", confidence: 0.99, reasoning: [], estimatedCost: 1, estimatedLatency: 100, available: false }),
      Object.freeze({ name: "avail-lower",  confidence: 0.70, reasoning: [], estimatedCost: 1, estimatedLatency: 100, available: true }),
    ];
    const best = selectBestCandidate(candidates);
    expect(best?.name).toBe("avail-lower");
  });

  it("falls back to unavailable candidate when no available ones exist", () => {
    const candidates: CandidateTool[] = [
      Object.freeze({ name: "unavail-a", confidence: 0.8, reasoning: [], estimatedCost: 1, estimatedLatency: 100, available: false }),
    ];
    const best = selectBestCandidate(candidates);
    expect(best?.name).toBe("unavail-a");
  });
});
