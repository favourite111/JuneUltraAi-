import { describe, expect, it, vi } from "vitest";
import { AgentEventBus } from "../event-bus.js";
import {
  createDeterministicAgentRuntime,
  type AgentRuntimeRequest,
} from "../runtime.js";
import { ToolRegistry, type RoutedTool } from "../registry.js";
import { MetricsCollector } from "../resilience.js";
import type {
  AgentEvent,
  ExecutionContext,
  Tool,
  ToolError,
  ToolResult,
} from "../types.js";

const EVENT_TYPES: AgentEvent["type"][] = [
  "router.started",
  "router.completed",
  "planner.started",
  "planner.completed",
  "tool.selected",
  "tool.started",
  "tool.completed",
  "tool.failed",
  "reflection.started",
  "reflection.completed",
  "reflection.failed",
];

const successResult: ToolResult = {
  type: "text",
  reply: "deterministic success",
  data: { output: "done" },
};

function request(prompt = "run test capability"): AgentRuntimeRequest {
  return {
    prompt,
    botId: "bot-1",
    userId: "user-1",
    groupId: "group-1",
    conversationKey: "bot-1:user-1:group-1",
    conversationState: { state: "test" },
    history: [],
    memory: { facts: [] },
    logger: {},
    metrics: new MetricsCollector(),
  } as any;
}

function routed(tool: Tool, args: Record<string, unknown> = { value: "input" }): RoutedTool {
  return {
    tool,
    args,
    confidence: { score: 1, reasoning: ["test router selected capability"] },
  };
}

function createFixture(router: (prompt: string) => RoutedTool | null) {
  const eventBus = new AgentEventBus();
  const events: AgentEvent[] = [];
  for (const eventType of EVENT_TYPES) {
    eventBus.on(eventType, (event) => events.push(event));
  }

  const ids = ["request-1", "plan-1", "step-1"];
  const runtime = createDeterministicAgentRuntime({
    clock: { now: () => 1_700_000_000_000 },
    idGenerator: {
      next: () => {
        const id = ids.shift();
        if (!id) throw new Error("Unexpected deterministic ID request");
        return id;
      },
    },
    eventBus,
    router,
  });

  return { runtime, events };
}

function eventTypes(events: AgentEvent[]): string[] {
  return events.map((event) => event.type);
}

describe("Deterministic Agent Runtime Pipeline - Phase 3A Milestone 6", () => {
  it("executes the successful request-to-response flow end to end", async () => {
    const execute = vi.fn(async (_args: unknown, context: ExecutionContext) => {
      expect(context.user.id).toBe("user-1");
      expect(context.requestId).toBe("request-1");
      return successResult;
    });
    const tool: Tool = {
      name: "success-tool",
      description: "Returns a deterministic result.",
      match: () => null,
      execute,
    };
    const { runtime, events } = createFixture(() => routed(tool));

    const response = await runtime.execute(request());

    expect(response.status).toBe("completed");
    if (response.status !== "completed") throw new Error("Expected completed response");
    expect(response.tool.name).toBe("success-tool");
    expect(response.result).toEqual(successResult);
    expect(response.plan.steps).toEqual([
      {
        stepId: "step-1",
        capabilityId: "success-tool",
        inputs: { value: "input" },
        expectedOutputs: {},
      },
    ]);
    expect(Object.isFrozen(response.context)).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(eventTypes(events)).toEqual([
      "router.started",
      "router.completed",
      "planner.started",
      "planner.completed",
      "tool.selected",
      "tool.started",
      "tool.completed",
      "reflection.started",
      "reflection.completed",
    ]);
  });

  it("retries a retryable tool failure and returns the succeeding result", async () => {
    const retryableError: ToolError = {
      code: "TRANSIENT",
      message: "Temporary dependency outage",
      isRetryable: true,
    };
    let attempts = 0;
    const tool: Tool = {
      name: "retry-tool",
      description: "Fails once, then succeeds.",
      match: () => null,
      execute: async () => {
        attempts += 1;
        if (attempts === 1) throw retryableError;
        return successResult;
      },
    };
    const { runtime, events } = createFixture(() => routed(tool));

    const response = await runtime.execute(request());

    expect(response.status).toBe("completed");
    expect(attempts).toBe(2);
    expect(eventTypes(events)).toEqual([
      "router.started",
      "router.completed",
      "planner.started",
      "planner.completed",
      "tool.selected",
      "tool.started",
      "tool.failed",
      "reflection.started",
      "reflection.completed",
      "tool.started",
      "tool.completed",
      "reflection.started",
      "reflection.completed",
    ]);
    const retryDecision = events.find(
      (event) => event.type === "reflection.completed" && event.payload.decision.type === "retry",
    );
    expect(retryDecision).toBeDefined();
  });

  it("returns a deterministic failed response for a non-retryable tool failure", async () => {
    const nonRetryableError: ToolError = {
      code: "INVALID_INPUT",
      message: "The supplied input is invalid.",
      isRetryable: false,
    };
    const execute = vi.fn(async () => {
      throw nonRetryableError;
    });
    const tool: Tool = {
      name: "failing-tool",
      description: "Always fails.",
      match: () => null,
      execute,
    };
    const { runtime, events } = createFixture(() => routed(tool));

    const response = await runtime.execute(request());

    expect(response.status).toBe("failed");
    if (response.status !== "failed") throw new Error("Expected failed response");
    expect(response.error).toEqual(nonRetryableError);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(eventTypes(events)).toEqual([
      "router.started",
      "router.completed",
      "planner.started",
      "planner.completed",
      "tool.selected",
      "tool.started",
      "tool.failed",
      "reflection.started",
      "reflection.failed",
      "reflection.completed",
    ]);
  });

  it("returns a no-capability response without selecting or executing a tool", async () => {
    const { runtime, events } = createFixture(() => null);

    const response = await runtime.execute(request("not a tool request"));

    expect(response.status).toBe("no_capability");
    expect(response.plan.steps).toEqual([]);
    expect(eventTypes(events)).toEqual([
      "router.started",
      "router.completed",
    ]);
  });

  it("honors an M17 no-tool planning decision without invoking the router", async () => {
    const router = vi.fn(() => {
      throw new Error("router must not run for a no-tool plan");
    });
    const eventBus = new AgentEventBus();
    const runtime = createDeterministicAgentRuntime({
      clock: { now: () => 1_700_000_000_000 },
      idGenerator: { next: () => "planned-request" },
      eventBus,
      router,
    });

    const response = await runtime.execute({
      ...request("Explain anatomy"),
      planningDecision: { needsTool: false },
    });

    expect(response.status).toBe("no_capability");
    expect(router).not.toHaveBeenCalled();
  });

  it("does not invoke an LLM when clarification has already been decided", async () => {
    const modelProvider = {
      generate: vi.fn(async () => ({ text: "must not run" })),
      getMetadata: () => ({ name: "test", models: [] }),
    };
    const promptManager = {
      renderPrompt: vi.fn(() => "must not render"),
      parseResponse: vi.fn(() => ({
        type: "no_action" as const,
        reasoning: "must not parse",
      })),
    };
    const runtime = createDeterministicAgentRuntime({
      clock: { now: () => 1_700_000_000_000 },
      idGenerator: { next: () => "clarification-request" },
      router: vi.fn(() => {
        throw new Error("router must not run");
      }),
      modelProvider,
      promptManager,
      hybridConfig: { enabled: true },
    });

    const response = await runtime.execute({
      ...request("Book me a flight"),
      planningDecision: { needsTool: false },
    });

    expect(response.status).toBe("no_capability");
    expect(modelProvider.generate).not.toHaveBeenCalled();
    expect(promptManager.renderPrompt).not.toHaveBeenCalled();
  });

  it("executes the planner-selected tool instead of a conflicting router result", async () => {
    const routerTool: Tool = {
      name: "router-tool",
      description: "Should not win.",
      match: () => null,
      execute: vi.fn(async () => successResult),
    };
    const plannedTool: Tool = {
      name: "planned-tool",
      description: "Planner authority test tool.",
      match: () => null,
      execute: vi.fn(async () => successResult),
    };
    const runtime = createDeterministicAgentRuntime({
      clock: { now: () => 1_700_000_000_000 },
      idGenerator: {
        next: (() => {
          const ids = ["planned-request", "planned-plan", "planned-step"];
          return () => ids.shift()!;
        })(),
      },
      router: () => routed(routerTool),
    });
    ToolRegistry.register(plannedTool);

    const response = await runtime.execute({
      ...request("Search latest Node.js"),
      planningDecision: {
        needsTool: true,
        toolName: "planned-tool",
        toolArgs: { query: "Node.js" },
      },
    });

    expect(response.status).toBe("completed");
    expect(plannedTool.execute).toHaveBeenCalledOnce();
    expect(routerTool.execute).not.toHaveBeenCalled();
  });

  it("does not fall through to router or LLM when a planned tool is unavailable", async () => {
    const router = vi.fn(() => {
      throw new Error("router bypassed planner authority");
    });
    const modelProvider = {
      generate: vi.fn(async () => ({ text: "must not run" })),
      getMetadata: () => ({ name: "test", models: [] }),
    };
    const promptManager = {
      renderPrompt: vi.fn(() => "must not render"),
      parseResponse: vi.fn(() => ({
        type: "no_action" as const,
        reasoning: "must not parse",
      })),
    };
    const runtime = createDeterministicAgentRuntime({
      clock: { now: () => 1_700_000_000_000 },
      idGenerator: { next: () => "missing-tool-request" },
      router,
      modelProvider,
      promptManager,
      hybridConfig: { enabled: true },
    });

    const response = await runtime.execute({
      ...request("Search latest Node.js"),
      planningDecision: { needsTool: true, toolName: "missing-web-search" },
    });

    expect(response.status).toBe("no_capability");
    expect(router).not.toHaveBeenCalled();
    expect(modelProvider.generate).not.toHaveBeenCalled();
  });

  it("replays identical request inputs and dependency streams with the same lifecycle transcript", async () => {
    const buildRun = () => {
      const tool: Tool = {
        name: "replay-tool",
        description: "Returns a replayable result.",
        match: () => null,
        execute: async () => successResult,
      };
      return createFixture(() => routed(tool));
    };

    const first = buildRun();
    const second = buildRun();
    const firstResponse = await first.runtime.execute(request());
    const secondResponse = await second.runtime.execute(request());

    expect({
      status: firstResponse.status,
      requestId: firstResponse.context.requestId,
      correlationId: firstResponse.context.correlationId,
      plan: firstResponse.plan,
      result: firstResponse.status === "completed" ? firstResponse.result : undefined,
    }).toEqual({
      status: secondResponse.status,
      requestId: secondResponse.context.requestId,
      correlationId: secondResponse.context.correlationId,
      plan: secondResponse.plan,
      result: secondResponse.status === "completed" ? secondResponse.result : undefined,
    });
    expect(first.events.map((event) => ({
      type: event.type,
      requestId: event.context.requestId,
      correlationId: event.context.correlationId,
      payload: event.payload,
    }))).toEqual(second.events.map((event) => ({
      type: event.type,
      requestId: event.context.requestId,
      correlationId: event.context.correlationId,
      payload: event.payload,
    })));
  });
});
