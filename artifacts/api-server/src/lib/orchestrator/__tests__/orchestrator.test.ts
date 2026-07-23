import { describe, expect, it, vi, beforeEach } from "vitest";
import { createExecutionOrchestrator } from "../execution-orchestrator.js";
import type { OrchestratorExecutors } from "../execution-orchestrator.js";
import { OrchestratorMetrics } from "../orchestrator-metrics.js";
import type {
  OrchestratorInput,
  OrchestratorPlannerInput,
  ToolExecutionOutput,
  MemoryExecutionOutput,
} from "../orchestrator-types.js";
import type { ExecutionContext, EventBus, Tool, ToolResult } from "../../tools/types.js";
import type { ReasoningResult } from "../../reasoner/reasoner-types.js";
import { ToolRegistry } from "../../tools/registry.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTool(name: string): Tool {
  return {
    name,
    description: `Mock ${name} tool`,
    match: () => null,
    execute: vi.fn().mockResolvedValue({
      type: "text",
      reply: `Result from ${name}`,
      data: {},
    } satisfies ToolResult),
  };
}

function makeContext(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  let counter = 0;
  return {
    requestId:    "req-1",
    correlationId: "cor-1",
    userId:       "user-1",
    metadata:     { requestId: "req-1", correlationId: "cor-1", timestamp: 1000 },
    user:         { id: "user-1", botId: "bot-1" },
    conversation: { key: "bot-1::user-1", state: {} },
    history:      [],
    memory:       { facts: [], history: [] },
    abortSignal:  new AbortController().signal,
    logger:       { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    metrics:      { record: vi.fn(), getSnapshot: () => ({}) },
    clock:        { now: () => 1_000 + counter++ },
    idGenerator:  { next: () => `id-${counter++}` },
    eventBus:     undefined,
    ...overrides,
  } as unknown as ExecutionContext;
}

function makeEventBus(): EventBus {
  return { emit: vi.fn(), on: vi.fn(), once: vi.fn(), off: vi.fn() };
}

function basePlanner(overrides: Partial<OrchestratorPlannerInput> = {}): OrchestratorPlannerInput {
  return {
    needsTool:   false,
    toolName:    undefined,
    toolArgs:    {},
    intent:      "general_answer",
    needsMemory: false,
    plan:        [{ step: 1, action: "answer", description: "Direct answer" }],
    ...overrides,
  };
}

function makeInput(
  plannerOverrides: Partial<OrchestratorPlannerInput> = {},
  reasoningOverrides?: Partial<ReasoningResult>,
): OrchestratorInput {
  return {
    prompt:    "test prompt",
    planner:   basePlanner(plannerOverrides),
    reasoning: reasoningOverrides as ReasoningResult | undefined,
    context:   makeContext(),
    eventBus:  makeEventBus(),
  };
}

/** Mock ToolExecutor — succeeds by default, injectable with custom impl. */
function mockToolExecutor(result?: Partial<ToolExecutionOutput>) {
  return {
    execute: vi.fn().mockResolvedValue({
      step:      1,
      executor:  "tool" as const,
      success:   true,
      durationMs: 5,
      toolName:  "weather",
      result:    { type: "text" as const, reply: "Sunny", data: {} },
      ...result,
    } satisfies ToolExecutionOutput),
  };
}

function mockMemoryExecutor(success = true) {
  return {
    execute: vi.fn().mockResolvedValue({
      step:      1,
      executor:  "memory" as const,
      success,
      durationMs: 0,
    } satisfies MemoryExecutionOutput),
  };
}

function mockLLMExecutor(selectedTool: Tool | null = null) {
  return {
    execute: vi.fn().mockResolvedValue({
      step:         1,
      executor:     "llm_selection" as const,
      success:      selectedTool !== null,
      durationMs:   5,
      selectedTool,
    }),
  };
}

const baseConfig = {
  confidenceThresholds: { routerMinConfidence: 0.6, llmMinConfidence: 0.7 } as typeof import("../../tools/types.js").DEFAULT_CONFIDENCE_THRESHOLDS,
  clock: { now: () => Date.now() },
};

// Register the mock "weather" tool so ToolRegistry.getTool("weather") succeeds.
// The orchestrator looks up the tool by name before calling the injected executor.
beforeEach(() => {
  ToolRegistry.register(makeTool("weather"));
});

// ---------------------------------------------------------------------------
// M19-G Test 1 — Single tool execution
// ---------------------------------------------------------------------------

describe("M19 ExecutionOrchestrator — single tool execution", () => {
  it("calls ToolExecutor once and returns success when needsTool=true", async () => {
    const toolExec = mockToolExecutor();
    const orch = createExecutionOrchestrator(baseConfig, { tool: toolExec });

    const result = await orch.execute(makeInput({
      needsTool: true,
      toolName:  "weather",
      toolArgs:  { location: "London" },
      plan:      [{ step: 1, action: "search", description: "Get weather" }],
    }));

    expect(toolExec.execute).toHaveBeenCalledOnce();
    expect(result.success).toBe(true);
    expect(result.handledBy).toBe("tool");
    expect(result.toolResults).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
  });

  it("sets bridgeToolResult on success", async () => {
    const orch = createExecutionOrchestrator(baseConfig, { tool: mockToolExecutor() });

    const result = await orch.execute(makeInput({
      needsTool: true, toolName: "weather",
      plan: [{ step: 1, action: "search", description: "Get weather" }],
    }));

    expect(result.bridgeToolResult).toBeDefined();
    expect(result.bridgeToolResult?.reply).toBe("Sunny");
    expect(result.bridgeTool).toBeDefined();
  });

  it("calls ToolExecutor with the correct step number", async () => {
    const toolExec = mockToolExecutor();
    const orch = createExecutionOrchestrator(baseConfig, { tool: toolExec });

    await orch.execute(makeInput({
      needsTool: true,
      toolName:  "weather",
      plan:      [{ step: 42, action: "search", description: "Get weather" }],
    }));

    const callArg = toolExec.execute.mock.calls[0]![0];
    expect(callArg.step).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// M19-G Test 2 — Multi-step sequential execution
// ---------------------------------------------------------------------------

describe("M19 ExecutionOrchestrator — multi-step sequential ordering", () => {
  it("processes steps in plan order without concurrency", async () => {
    const callOrder: number[] = [];
    const toolExec = {
      execute: vi.fn().mockImplementation(async (input: { step: number }) => {
        callOrder.push(input.step);
        return {
          step: input.step, executor: "tool" as const, success: true,
          durationMs: 1, toolName: "weather",
          result: { type: "text" as const, reply: "ok", data: {} },
        };
      }),
    };

    const orch = createExecutionOrchestrator(baseConfig, { tool: toolExec });

    await orch.execute(makeInput({
      needsTool: true,
      toolName:  "weather",
      plan: [
        { step: 1, action: "step-one", description: "First" },
        { step: 2, action: "step-two", description: "Second" },
        { step: 3, action: "step-three", description: "Third" },
      ],
    }));

    expect(callOrder).toEqual([1, 2, 3]);
    expect(toolExec.execute).toHaveBeenCalledTimes(3);
  });

  it("outputs array reflects steps in plan order", async () => {
    const toolExec = {
      execute: vi.fn().mockImplementation(async (input: { step: number }) => ({
        step: input.step, executor: "tool" as const, success: true,
        durationMs: 1, toolName: "weather",
        result: { type: "text" as const, reply: "ok", data: {} },
      })),
    };

    const orch = createExecutionOrchestrator(baseConfig, { tool: toolExec });

    const result = await orch.execute(makeInput({
      needsTool: true,
      toolName: "weather",
      plan: [
        { step: 1, action: "first",  description: "First step" },
        { step: 2, action: "second", description: "Second step" },
      ],
    }));

    expect(result.outputs.map((o) => o.step)).toEqual([1, 2]);
  });
});

// ---------------------------------------------------------------------------
// M19-G Test 3 — Failure handling
// ---------------------------------------------------------------------------

describe("M19 ExecutionOrchestrator — failure handling", () => {
  it("returns success=false when the tool executor fails, without throwing", async () => {
    const failingToolExec = {
      execute: vi.fn().mockResolvedValue({
        step: 1, executor: "tool" as const, success: false, durationMs: 5,
        toolName: "weather",
        error: { code: "TOOL_FAILED", message: "Network timeout", isRetryable: false },
      } satisfies ToolExecutionOutput),
    };

    const orch = createExecutionOrchestrator(baseConfig, { tool: failingToolExec });

    const result = await orch.execute(makeInput({
      needsTool: true, toolName: "weather",
      plan: [{ step: 1, action: "search", description: "Get weather" }],
    }));

    expect(result.success).toBe(false);
    expect(result.handledBy).toBe("tool");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.code).toBe("TOOL_FAILED");
    expect(result.bridgeToolError).toBeDefined();
  });

  it("stops sequential queue after the first failing step", async () => {
    const toolExec = {
      execute: vi.fn()
        .mockResolvedValueOnce({
          step: 1, executor: "tool" as const, success: false, durationMs: 1,
          toolName: "weather",
          error: { code: "FAIL", message: "Step 1 failed", isRetryable: false },
        })
        .mockResolvedValueOnce({
          step: 2, executor: "tool" as const, success: true, durationMs: 1,
          toolName: "weather", result: { type: "text" as const, reply: "ok", data: {} },
        }),
    };

    const orch = createExecutionOrchestrator(baseConfig, { tool: toolExec });

    const result = await orch.execute(makeInput({
      needsTool: true, toolName: "weather",
      plan: [
        { step: 1, action: "first",  description: "First" },
        { step: 2, action: "second", description: "Second" },
      ],
    }));

    // Step 2 must NOT have been called
    expect(toolExec.execute).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.outputs).toHaveLength(1);
  });

  it("returns no_capability result when tool is not registered", async () => {
    const orch = createExecutionOrchestrator(baseConfig, {
      tool: mockToolExecutor(), // not called — tool lookup fails first
    });

    // Use a tool name that doesn't exist in the registry
    const result = await orch.execute(makeInput({
      needsTool: true,
      toolName:  "__nonexistent_tool_xyz__",
      plan:      [{ step: 1, action: "search", description: "Search" }],
    }));

    expect(result.success).toBe(false);
    expect(result.errors[0]!.code).toBe("TOOL_NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// M19-G Test 4 — Planner authority
// ---------------------------------------------------------------------------

describe("M19 ExecutionOrchestrator — planner authority", () => {
  it("never calls ToolExecutor when planner says needsTool=false", async () => {
    const toolExec = mockToolExecutor();
    const orch = createExecutionOrchestrator(baseConfig, { tool: toolExec });

    await orch.execute(makeInput({ needsTool: false }));

    expect(toolExec.execute).not.toHaveBeenCalled();
  });

  it("returns no_capability when needsTool=false and needsMemory=false", async () => {
    const orch = createExecutionOrchestrator(baseConfig, { tool: mockToolExecutor() });

    const result = await orch.execute(makeInput({ needsTool: false, needsMemory: false }));

    expect(result.handledBy).toBe("no_capability");
  });

  it("calls MemoryExecutor (not ToolExecutor) when needsTool=false and needsMemory=true", async () => {
    const toolExec = mockToolExecutor();
    const memExec  = mockMemoryExecutor();
    const orch = createExecutionOrchestrator(baseConfig, { tool: toolExec, memory: memExec });

    await orch.execute(makeInput({ needsTool: false, needsMemory: true }));

    expect(toolExec.execute).not.toHaveBeenCalled();
    expect(memExec.execute).toHaveBeenCalledOnce();
  });

  it("uses the toolName supplied by the planner, not any other source", async () => {
    const toolExec = mockToolExecutor();
    const orch = createExecutionOrchestrator(baseConfig, { tool: toolExec });

    await orch.execute(makeInput({
      needsTool: true, toolName: "weather",
      plan: [{ step: 1, action: "search", description: "Get weather" }],
    }));

    const callArg = toolExec.execute.mock.calls[0]![0];
    expect(callArg.tool.name).toBe("weather");
  });
});

// ---------------------------------------------------------------------------
// M19-G Test 5 — Reasoner isolation
// ---------------------------------------------------------------------------

describe("M19 ExecutionOrchestrator — reasoner isolation", () => {
  it("does not change execution path based on reasoning.preferredDepth", async () => {
    const toolExec = mockToolExecutor();
    const orch = createExecutionOrchestrator(baseConfig, { tool: toolExec });

    const withBrief  = makeInput(
      { needsTool: true, toolName: "weather", plan: [{ step: 1, action: "search", description: "Get weather" }] },
      { preferredDepth: "brief" } as Partial<ReasoningResult>,
    );
    const withDetailed = makeInput(
      { needsTool: true, toolName: "weather", plan: [{ step: 1, action: "search", description: "Get weather" }] },
      { preferredDepth: "detailed" } as Partial<ReasoningResult>,
    );

    const r1 = await orch.execute(withBrief);
    const r2 = await orch.execute(withDetailed);

    // Execution path must be identical regardless of preferredDepth
    expect(r1.handledBy).toBe(r2.handledBy);
    expect(r1.success).toBe(r2.success);
    expect(toolExec.execute).toHaveBeenCalledTimes(2);
  });

  it("does not change execution path based on reasoning.expertiseLevel", async () => {
    const toolExec = mockToolExecutor();
    const orch = createExecutionOrchestrator(baseConfig, { tool: toolExec });

    for (const level of ["beginner", "intermediate", "expert"] as const) {
      const result = await orch.execute(makeInput(
        { needsTool: true, toolName: "weather", plan: [{ step: 1, action: "search", description: "Get weather" }] },
        { expertiseLevel: level } as Partial<ReasoningResult>,
      ));
      expect(result.handledBy).toBe("tool");
    }
  });

  it("returns identical tool outputs regardless of reasoning content", async () => {
    const orch = createExecutionOrchestrator(baseConfig, { tool: mockToolExecutor() });

    const withReasoning = makeInput(
      { needsTool: true, toolName: "weather", plan: [{ step: 1, action: "search", description: "Get weather" }] },
      { required: true, summary: "Reasoning: user prefers brief." } as Partial<ReasoningResult>,
    );
    const withoutReasoning = makeInput(
      { needsTool: true, toolName: "weather", plan: [{ step: 1, action: "search", description: "Get weather" }] },
    );

    const r1 = await orch.execute(withReasoning);
    const r2 = await orch.execute(withoutReasoning);

    expect(r1.handledBy).toBe(r2.handledBy);
    expect(r1.success).toBe(r2.success);
    expect(r1.toolResults.length).toBe(r2.toolResults.length);
  });
});

// ---------------------------------------------------------------------------
// M19 — Immutability
// ---------------------------------------------------------------------------

describe("M19 ExecutionOrchestrator — immutability", () => {
  it("returns a frozen ExecutionResult", async () => {
    const orch = createExecutionOrchestrator(baseConfig, { tool: mockToolExecutor() });

    const result = await orch.execute(makeInput({
      needsTool: true, toolName: "weather",
      plan: [{ step: 1, action: "search", description: "Get weather" }],
    }));

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.outputs)).toBe(true);
    expect(Object.isFrozen(result.toolResults)).toBe(true);
    expect(Object.isFrozen(result.errors)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// M19 — Metrics
// ---------------------------------------------------------------------------

describe("M19 ExecutionOrchestrator — metrics", () => {
  let metrics: OrchestratorMetrics;

  beforeEach(() => { metrics = new OrchestratorMetrics(); });

  it("increments execution_runs once per execute() call", async () => {
    const orch = createExecutionOrchestrator({ ...baseConfig, metrics }, { tool: mockToolExecutor() });

    await orch.execute(makeInput({ needsTool: true, toolName: "weather", plan: [{ step: 1, action: "search", description: "Get weather" }] }));
    await orch.execute(makeInput({ needsTool: false }));

    expect(metrics.snapshot().execution_runs).toBe(2);
  });

  it("tracks successful_runs and failed_runs separately", async () => {
    const orch = createExecutionOrchestrator({ ...baseConfig, metrics }, {
      tool: {
        execute: vi.fn()
          .mockResolvedValueOnce({ step: 1, executor: "tool" as const, success: true, durationMs: 1, toolName: "weather", result: { type: "text" as const, reply: "ok", data: {} } })
          .mockResolvedValueOnce({ step: 1, executor: "tool" as const, success: false, durationMs: 1, toolName: "weather", error: { code: "ERR", message: "fail", isRetryable: false } }),
      },
    });

    await orch.execute(makeInput({ needsTool: true, toolName: "weather", plan: [{ step: 1, action: "search", description: "Get weather" }] }));
    await orch.execute(makeInput({ needsTool: true, toolName: "weather", plan: [{ step: 1, action: "search", description: "Get weather" }] }));

    const snap = metrics.snapshot();
    expect(snap.successful_runs).toBe(1);
    expect(snap.failed_runs).toBe(1);
  });

  it("records metrics exactly once per execute() call", async () => {
    const record = vi.fn();
    const orch = createExecutionOrchestrator({ ...baseConfig, metrics: { record } }, { tool: mockToolExecutor() });

    await orch.execute(makeInput({ needsTool: false }));

    expect(record).toHaveBeenCalledOnce();
  });
});
