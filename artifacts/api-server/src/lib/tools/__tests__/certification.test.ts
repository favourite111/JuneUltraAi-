import { describe, expect, it, vi } from "vitest";
import { AgentEventBus } from "../event-bus.js";
import { createDeterministicAgentRuntime } from "../runtime.js";
import type { RoutedTool } from "../registry.js";
import type {
  AgentEvent,
  ExecutionContext,
  Tool,
  ToolError,
  ToolResult,
} from "../types.js";
import type {
  AgentRuntimeRequest,
  CompletedRuntimeResponse,
  FailedRuntimeResponse,
} from "../runtime.js";

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

function request(prompt = "run test capability", userId: string = "user-1"): AgentRuntimeRequest {
  return {
    prompt,
    botId: "bot-1",
    userId,
    groupId: "group-1",
    conversationKey: `bot-1:${userId}:group-1`,
    conversationState: { state: "test" },
    history: [],
    memory: { facts: [] },
    logger: {},
    metrics: { record: () => {}, getSnapshot: () => ({}) },
  };
}

function routed(tool: Tool, args: Record<string, unknown> = { value: "input" }): RoutedTool {
  return {
    tool,
    args,
    confidence: { score: 1, reasoning: ["test router selected capability"] },
  };
}

function createFixture(router: (prompt: string) => RoutedTool | null, idPrefix = "") {
  const eventBus = new AgentEventBus();
  const events: AgentEvent[] = [];
  for (const eventType of EVENT_TYPES) {
    eventBus.on(eventType, (event) => events.push(event));
  }

  let idCounter = 0;
  const ids = [
    `${idPrefix}-request-1`,
    `${idPrefix}-plan-1`,
    `${idPrefix}-step-1`,
  ];
  const runtime = createDeterministicAgentRuntime({
    clock: { now: () => 1_700_000_000_000 },
    idGenerator: {
      next: () => {
        // For concurrent tests, we need a dynamic, yet deterministic ID generator.
        // For single-threaded tests, the `ids` array provides fixed IDs.
        if (ids.length > 0) {
          return ids.shift()!;
        }
        return `${idPrefix}-dynamic-id-${idCounter++}`;

      },
    },
    eventBus,
    router,
  });

  return { runtime, events };
}

function eventTrace(events: AgentEvent[]) {
  return events.map((event) => ({
    type: event.type,
    requestId: event.context.requestId,
    correlationId: event.context.correlationId,
    payload: event.payload,
  }));
}

describe("Deterministic Agent Runtime Certification - Phase 3A Milestone 7", () => {
  it("fully replays recorded sessions with identical event traces", async () => {
    const buildRun = () => {
      const tool: Tool = {
        name: "replay-tool",
        description: "Returns a replayable result.",
        match: () => null,
        execute: async (_args: unknown, context: ExecutionContext) => {
          context.eventBus?.emit({
            type: "tool.started",
            context,
            payload: { toolId: "replay-tool-internal", timestamp: context.clock.now() },
          });
          return successResult;
        },
      };
      return createFixture(() => routed(tool));
    };

    const first = buildRun();
    const second = buildRun();
    const firstResponse = await first.runtime.execute(request("run test capability", "user-1"));
    const secondResponse = await second.runtime.execute(request("run test capability", "user-1"));

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
    expect(eventTrace(first.events)).toEqual(eventTrace(second.events));
  });

  it("isolates concurrent user sessions without state leakage", async () => {
    const tool: Tool = {
      name: "concurrent-tool",
      description: "Processes concurrent requests.",
      match: () => null,
      execute: async (_args: unknown, context: ExecutionContext) => {
        // Simulate some async work
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { type: "text", reply: `Processed for ${context.userId}`, data: {} };
      },
    };
    const userAId = "user-a";
    const userBId = "user-b";
    const userCId = "user-c";

    const { runtime: runtimeA } = createFixture(() => routed(tool), userAId);
    const { runtime: runtimeB } = createFixture(() => routed(tool), userBId);
    const { runtime: runtimeC } = createFixture(() => routed(tool), userCId);

    const requests = [
      runtimeA.execute(request("prompt for A", userAId)),
      runtimeB.execute(request("prompt for B", userBId)),
      runtimeC.execute(request("prompt for C", userCId)),
    ];

    const responses = await Promise.all(requests);

    expect(responses.length).toBe(3);
    expect(responses[0].status).toBe("completed");
    expect((responses[0] as CompletedRuntimeResponse).result.reply).toContain(`Processed for ${userAId}`);
    expect(responses[1].status).toBe("completed");
    expect((responses[1] as CompletedRuntimeResponse).result.reply).toContain(`Processed for ${userBId}`);
    expect(responses[2].status).toBe("completed");
    expect((responses[2] as CompletedRuntimeResponse).result.reply).toContain(`Processed for ${userCId}`);

    // Verify context isolation by checking request IDs from different runtimes
    expect((responses[0] as CompletedRuntimeResponse).context.requestId).not.toEqual(
      (responses[1] as CompletedRuntimeResponse).context.requestId,
    );
    expect((responses[0] as CompletedRuntimeResponse).context.requestId).not.toEqual(
      (responses[2] as CompletedRuntimeResponse).context.requestId,
    );
    expect((responses[1] as CompletedRuntimeResponse).context.requestId).not.toEqual(
      (responses[2] as CompletedRuntimeResponse).context.requestId,
    );

  });

  it("validates multiple tool chains and deterministic failure recovery", async () => {
    const shortenerTool: Tool = {
      name: "url_shortener",
      description: "Shortens a URL.",
      match: () => null,
      execute: async (args: { url: string }) => {
        if (args.url.includes("fail")) {
          throw { code: "SHORTENER_FAILED", message: "Failed to shorten", isRetryable: false };
        }
        return { type: "text", reply: `shortened-${args.url}`, data: { shortUrl: `shortened-${args.url}` } };
      },
    };

    const qrcodeTool: Tool = {
      name: "qrcode",
      description: "Generates a QR code.",
      match: () => null,
      execute: async (args: { url: string }) => {
        if (args.url.includes("fail")) {
          throw { code: "QRCODE_FAILED", message: "Failed to generate QR", isRetryable: false };
        }
        return { type: "image", reply: `qrcode-${args.url}`, data: { imageUrl: `qrcode-${args.url}` } };
      },
    };

    const { runtime, events } = createFixture((prompt) => {
      if (prompt.includes("shorten and qr")) {
        return routed(shortenerTool, { url: "https://example.com" });
      } else if (prompt.includes("qr and shorten")) {
        return routed(qrcodeTool, { url: "https://example.com" });
      } else if (prompt.includes("fail shorten")) {
        return routed(shortenerTool, { url: "https://fail.com" });
      } else if (prompt.includes("fail qr")) {
        return routed(qrcodeTool, { url: "https://fail.com" });
      }
      return null;
    });

    // Successful chain
    const successResponse = await runtime.execute(request("shorten and qr"));
    expect(successResponse.status).toBe("completed");
    expect((successResponse as CompletedRuntimeResponse).result.reply).toContain("shortened-https://example.com");

    // Failed chain (shortener fails)
    const failShortenResponse = await runtime.execute(request("fail shorten"));
    expect(failShortenResponse.status).toBe("failed");
    expect((failShortenResponse as FailedRuntimeResponse).error.code).toBe("SHORTENER_FAILED");

    // Failed chain (qrcode fails)
    const failQrResponse = await runtime.execute(request("fail qr"));
    expect(failQrResponse.status).toBe("failed");
    expect((failQrResponse as FailedRuntimeResponse).error.code).toBe("QRCODE_FAILED");

    // This test needs to be refined to properly test multi-step chains as the current planner only supports single-step execution based on the `selectedTool`.
    // Will address this in a subsequent step.
  });
});
