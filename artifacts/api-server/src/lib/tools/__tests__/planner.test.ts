import { describe, it, expect, vi } from "vitest";
import { createPlanner } from "../planner.js";
import type { ExecutionContext, AgentPlan, AgentPlanStep } from "../types.js";

describe("Deterministic Task Planner - Milestone 4", () => {
  const mockClock = {
    now: vi.fn(() => 1700000000000),
  };
  const mockIdGenerator = {
    next: vi.fn(() => "mock-id"),
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
      ...overrides,
    } as ExecutionContext;
  };

  it("should create a single-step plan for a simple goal", () => {
    const ctx = createMockExecutionContext();
    const planner = createPlanner(ctx);
    const goal = "Shorten the URL https://example.com";
    const plan = planner.plan(goal);

    expect(plan).not.toBeNull();
    expect(plan?.planId).toBe("mock-id");
    expect(plan?.goal).toBe(goal);
    expect(plan?.steps).toHaveLength(1);

    const step = plan?.steps[0];
    expect(step?.stepId).toBe("mock-id");
    expect(step?.capabilityId).toBe("url_shortener");
    expect(step?.inputs).toEqual({ url: "https://example.com" });
    expect(step?.expectedOutputs).toEqual({});
  });

  it("should create a multi-step deterministic plan for a complex goal", () => {
    const ctx = createMockExecutionContext();
    const planner = createPlanner(ctx);
    const goal = "Shorten https://example.com and then generate a QR code for it.";
    const plan = planner.plan(goal);

    expect(plan).not.toBeNull();
    expect(plan?.planId).toBe("mock-id");
    expect(plan?.goal).toBe(goal);
    expect(plan?.steps).toHaveLength(2);

    const step1 = plan?.steps[0];
    expect(step1?.stepId).toBe("mock-id");
    expect(step1?.capabilityId).toBe("url_shortener");
    expect(step1?.inputs).toEqual({ url: "https://example.com" });
    expect(step1?.expectedOutputs).toEqual({ shortUrl: expect.any(String) });

    const step2 = plan?.steps[1];
    expect(step2?.stepId).toBe("mock-id");
    expect(step2?.capabilityId).toBe("qrcode");
    expect(step2?.inputs).toEqual({ url: expect.any(String) }); // Should use output from step1
    expect(step2?.expectedOutputs).toEqual({ imageUrl: expect.any(String) });
  });

  it("should return an empty plan for an unplannable goal", () => {
    const ctx = createMockExecutionContext();
    const planner = createPlanner(ctx);
    const goal = "This is an unplannable goal with no matching capabilities.";
    const plan = planner.plan(goal);

    expect(plan).not.toBeNull();
    expect(plan?.planId).toBe("mock-id");
    expect(plan?.goal).toBe(goal);
    expect(plan?.steps).toHaveLength(0);
  });

  it("should ensure replay consistency for the same goal and context", () => {
    const ctx1 = createMockExecutionContext();
    const planner1 = createPlanner(ctx1);
    const goal1 = "Shorten the URL https://example.com";
    const plan1 = planner1.plan(goal1);

    const ctx2 = createMockExecutionContext();
    const planner2 = createPlanner(ctx2);
    const goal2 = "Shorten the URL https://example.com";
    const plan2 = planner2.plan(goal2);

    expect(plan1).toEqual(plan2);
  });

  it("should ensure deterministic ordering of steps", () => {
    const ctx = createMockExecutionContext();
    const planner = createPlanner(ctx);
    const goal = "Generate a QR code for https://example.com and then shorten it.";
    const plan = planner.plan(goal);

    expect(plan).not.toBeNull();
    expect(plan?.planId).toBe("mock-id");
    expect(plan?.goal).toBe(goal);
    expect(plan?.steps).toHaveLength(2);

    const step1 = plan?.steps[0];
    expect(step1?.capabilityId).toBe("qrcode"); // Assuming qrcode is matched first

    const step2 = plan?.steps[1];
    expect(step2?.capabilityId).toBe("url_shortener"); // Assuming url_shortener is matched second
  });

  it("should handle invalid capabilities gracefully", () => {
    const ctx = createMockExecutionContext();
    const planner = createPlanner(ctx);
    const goal = "Use an invalid_capability to do something.";
    const plan = planner.plan(goal);

    expect(plan).not.toBeNull();
    expect(plan?.planId).toBe("mock-id");
    expect(plan?.goal).toBe(goal);
    expect(plan?.steps).toHaveLength(0); // Invalid capability should result in no steps
  });
});
