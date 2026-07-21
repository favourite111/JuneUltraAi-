import { describe, it, expect, vi, beforeEach } from "vitest";
import { createReflectionEngine } from "../reflection.js";
import {
  ReflectionDecisionType,
} from "../types.js";
import type {
  ExecutionContext,
  ToolResult,
  ToolError,
  AgentPlanStep,
  ReflectionDecision,
  EventBus,
  AgentEvent,
} from "../types.js";

describe("Deterministic Reflection Engine - Milestone 5", () => {
  const mockClock = {
    now: vi.fn(() => 1700000000000),
  };
  const mockIdGenerator = {
    next: vi.fn(() => "mock-id"),
  };
  const mockEventBus: EventBus = {
    emit: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
  };

  const createMockExecutionContext = (overrides?: Partial<ExecutionContext>): ExecutionContext => {
    return {
      requestId: "test-request-id",
      correlationId: "test-correlation-id",
      userId: "test-user-id",
      metadata: {
        requestId: "test-request-id",
        correlationId: "test-correlation-id",
        timestamp: mockClock.now(),
      },
      user: {
        id: "test-user-id",
        botId: "test-bot-id",
      },
      conversation: {
        key: "test-conversation-key",
        state: {},
      },
      history: [],
      memory: {
        facts: [],
        history: [],
      },
      abortSignal: new AbortController().signal,
      logger: {},
      metrics: {},
      clock: mockClock,
      idGenerator: mockIdGenerator,
      eventBus: mockEventBus, // Inject event bus
      ...overrides,
    } as ExecutionContext;
  };

  const mockPlanStep: AgentPlanStep = {
    stepId: "step-1",
    capabilityId: "test_tool",
    inputs: { input: "value" },
    expectedOutputs: { output: "" },
  };

  const mockToolResult: ToolResult = {
    type: "text",
    reply: "Tool executed successfully",
    data: { output: "actual" },
  };

  const mockRetryableToolError: ToolError = {
    code: "TRANSIENT_ERROR",
    message: "Temporary issue",
    isRetryable: true,
  };

  const mockNonRetryableToolError: ToolError = {
    code: "INVALID_INPUT",
    message: "Bad input provided",
    isRetryable: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return COMPLETE if the tool result matches expected outputs and it's the last step", () => {
    const ctx = createMockExecutionContext();
    const reflectionEngine = createReflectionEngine(ctx);
    const decision = reflectionEngine.reflect(
      mockToolResult,
      mockPlanStep,
      0, // currentStepIndex
      1, // totalSteps
      [] // reflectionHistory
    );

    expect(decision.type).toBe(ReflectionDecisionType.COMPLETE);
    expect(decision.reasoning).toEqual([
      "Tool result matches expected outputs.",
      "This was the last step in the plan.",
    ]);
    expect(mockEventBus.emit).toHaveBeenCalledWith({
      type: "reflection.started",
      context: ctx,
      payload: {
        observation: mockToolResult,
        currentPlanStep: mockPlanStep,
        timestamp: mockClock.now(),
      },
    });
    expect(mockEventBus.emit).toHaveBeenCalledWith({
      type: "reflection.completed",
      context: ctx,
      payload: {
        decision,
        timestamp: mockClock.now(),
      },
    });
  });

  it("should return CONTINUE if the tool result matches expected outputs and there are more steps", () => {
    const ctx = createMockExecutionContext();
    const reflectionEngine = createReflectionEngine(ctx);
    const decision = reflectionEngine.reflect(
      mockToolResult,
      mockPlanStep,
      0, // currentStepIndex
      2, // totalSteps
      [] // reflectionHistory
    );

    expect(decision.type).toBe(ReflectionDecisionType.CONTINUE);
    expect(decision.reasoning).toEqual([
      "Tool result matches expected outputs.",
      "More steps remain in the plan.",
    ]);
    expect(decision.nextStepIndex).toBe(1);
  });

  it("should return RETRY for a retryable error if retry count is below limit", () => {
    const ctx = createMockExecutionContext();
    const reflectionEngine = createReflectionEngine(ctx);
    const decision = reflectionEngine.reflect(
      mockRetryableToolError,
      mockPlanStep,
      0, // currentStepIndex
      1, // totalSteps
      [] // reflectionHistory
    );

    expect(decision.type).toBe(ReflectionDecisionType.RETRY);
    expect(decision.reasoning).toEqual([
      "Encountered a retryable error.",
      "Retry count (0) is below the limit (3).",
    ]);
    expect(decision.retryCount).toBe(1);

  });

  it("should return FAIL for a retryable error if retry count is at limit", () => {
    const ctx = createMockExecutionContext();
    const reflectionEngine = createReflectionEngine(ctx);
    const decision = reflectionEngine.reflect(
      mockRetryableToolError,
      mockPlanStep,
      0, // currentStepIndex
      1, // totalSteps
      [{ decision: { type: ReflectionDecisionType.RETRY, reasoning: [], retryCount: 1 } }, { decision: { type: ReflectionDecisionType.RETRY, reasoning: [], retryCount: 2 } }, { decision: { type: ReflectionDecisionType.RETRY, reasoning: [], retryCount: 3 } }] // reflectionHistory
    );

    expect(decision.type).toBe(ReflectionDecisionType.FAIL);
    expect(decision.reasoning).toEqual([
      "Encountered a retryable error.",
      "Retry count (3) has reached the limit (3).",
    ]);
  });

  it("should return FAIL for a non-retryable error", () => {
    const ctx = createMockExecutionContext();
    const reflectionEngine = createReflectionEngine(ctx);
    const decision = reflectionEngine.reflect(
      mockNonRetryableToolError,
      mockPlanStep,
      0, // currentStepIndex
      1, // totalSteps
      [] // reflectionHistory
    );

    expect(decision.type).toBe(ReflectionDecisionType.FAIL);
    expect(decision.reasoning).toEqual([
      "Encountered a non-retryable error.",
    ]);
  });

  it("should return FAIL if tool result does not match expected outputs", () => {
    const ctx = createMockExecutionContext();
    const reflectionEngine = createReflectionEngine(ctx);
    const nonMatchingResult: ToolResult = {
      type: "text",
      reply: "Tool executed with wrong output",
      data: { output: "unexpected" },
    };
    const specificExpectedOutputs = { output: "expected_specific_value" };
    const decision = reflectionEngine.reflect(
      nonMatchingResult,
      { ...mockPlanStep, expectedOutputs: specificExpectedOutputs },
      0, // currentStepIndex
      1, // totalSteps
      [] // reflectionHistory
    );

    expect(decision.type).toBe(ReflectionDecisionType.FAIL);
    expect(decision.reasoning).toEqual([
      "Tool result does not match expected outputs.",
    ]);
    expect(mockEventBus.emit).toHaveBeenCalledWith({
      type: "reflection.failed",
      context: ctx,
      payload: {
        error: {
          code: "OUTPUT_MISMATCH",
          message: "Tool output did not match expected outputs.",
          details: { actual: nonMatchingResult.data, expected: specificExpectedOutputs },
          isRetryable: false,
        },
        timestamp: mockClock.now(),
      },
    });
  });

  it("should ensure replay consistency for the same inputs", () => {
    const ctx1 = createMockExecutionContext();
    const reflectionEngine1 = createReflectionEngine(ctx1);
    const decision1 = reflectionEngine1.reflect(
      mockToolResult,
      mockPlanStep,
      0,
      1,
      []
    );

    const ctx2 = createMockExecutionContext();
    const reflectionEngine2 = createReflectionEngine(ctx2);
    const decision2 = reflectionEngine2.reflect(
      mockToolResult,
      mockPlanStep,
      0,
      1,
      []
    );

    expect(decision1).toEqual(decision2);
  });

  it("should handle empty reflection history for retry count", () => {
    const ctx = createMockExecutionContext();
    const reflectionEngine = createReflectionEngine(ctx);
    const decision = reflectionEngine.reflect(
      mockRetryableToolError,
      mockPlanStep,
      0,
      1,
      []
    );
    expect(decision.retryCount).toBe(1);
  });

  it("should correctly increment retry count from history", () => {
    const ctx = createMockExecutionContext();
    const reflectionEngine = createReflectionEngine(ctx);
    const history = [
      { decision: { type: ReflectionDecisionType.RETRY, reasoning: [], retryCount: 1 } },
      { decision: { type: ReflectionDecisionType.RETRY, reasoning: [], retryCount: 2 } },
    ];
    const decision = reflectionEngine.reflect(
      mockRetryableToolError,
      mockPlanStep,
      0,
      1,
      history
    );
    expect(decision.retryCount).toBe(3);
  });
});
