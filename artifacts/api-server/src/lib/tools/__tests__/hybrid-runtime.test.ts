import { describe, expect, it, vi } from "vitest";
import { AgentEventBus } from "../event-bus.js";
import { createDeterministicAgentRuntime } from "../runtime.js";
import { MockModelProvider } from "../mock-model-provider.js";
import { MockPromptManager } from "../mock-prompt-manager.js";
import { ToolRegistry } from "../registry.js";
import type {
  AgentEvent,
  AgentRuntimeRequest,
  Tool,
  ToolResult,
} from "../types.js";
import type {
  AgentRuntimeResponse,
  CompletedRuntimeResponse,
  FailedRuntimeResponse,
} from "../runtime.js";
import { RoutedTool } from "../registry.js";

const successResult: ToolResult = {
  type: "text",
  reply: "deterministic success",
  data: { output: "done" },
};

function createFixture(router: (prompt: string) => RoutedTool | null, idPrefix = "") {
  const eventBus = new AgentEventBus();
  const events: AgentEvent[] = [];
  // For hybrid tests, we only care about LLM events
  eventBus.on("llm.request", (e) => events.push(e));
  eventBus.on("llm.response", (e) => events.push(e));
  eventBus.on("llm.decision", (e) => events.push(e));

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
        if (ids.length > 0) {
          return ids.shift()!;
        }
        return `${idPrefix}-dynamic-id-${idCounter++}`;
      },
    },
    eventBus,
    router,
  });

  return { runtime, events, eventBus };
}

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
    metrics: {},
  };
}

describe("Hybrid Agent Runtime - Phase 3B Milestone 1", () => {
  it("consults LLM when deterministic router has low confidence", async () => {
    const testTool: Tool = {
      name: "test-tool",
      description: "A test tool.",
      match: () => null,
      execute: async () => successResult,
    };
    ToolRegistry.register(testTool);

    const { runtime: baseRuntime, events, eventBus } = createFixture(() => null, "req-1");

    const modelProvider = new MockModelProvider([{ text: "llm-response" }]);
    const promptManager = new MockPromptManager([{
      type: "tool_selection",
      toolName: "test-tool",
      toolArgs: { arg1: "val1" },
      reasoning: "LLM selected test-tool",
      confidence: 0.9,
    }]);

    const runtimeWithLLM = createDeterministicAgentRuntime({
      clock: { now: () => 1_700_000_000_000 },
      idGenerator: { next: () => "req-1" },
      eventBus,
      router: () => null, // Deterministic router always fails
      modelProvider,
      promptManager,
      hybridConfig: { enabled: true },
    });

    const response = await runtimeWithLLM.execute(request("ambiguous prompt"));

    expect(response.status).toBe("completed");
    expect((response as CompletedRuntimeResponse).tool.name).toBe("test-tool");
    expect(events.some(e => e.type === "llm.request")).toBe(true);
    expect(events.some(e => e.type === "llm.response")).toBe(true);
    expect(events.some(e => e.type === "llm.decision")).toBe(true);
  });

  it("fails when LLM decision has low confidence", async () => {
    const { runtime: baseRuntime, events, eventBus } = createFixture(() => null, "req-2");

    const modelProvider = new MockModelProvider([{ text: "low-confidence-response" }]);
    const promptManager = new MockPromptManager([{
      type: "tool_selection",
      toolName: "test-tool",
      reasoning: "I\"m not sure",
      confidence: 0.3, // Below threshold
    }]);

    const runtimeWithLLM = createDeterministicAgentRuntime({
      clock: { now: () => 1_700_000_000_000 },
      idGenerator: { next: () => "req-2" },
      eventBus,
      router: () => null,
      modelProvider,
      promptManager,
      hybridConfig: { enabled: true },
    });

    const response = await runtimeWithLLM.execute(request("very ambiguous prompt"));

    expect(response.status).toBe("no_capability");
  });

  it("falls back to no_capability when hybrid intelligence is disabled", async () => {
    const { runtime: baseRuntime, events, eventBus } = createFixture(() => null, "req-4");

    const modelProvider = new MockModelProvider([{ text: "llm-response" }]);
    const promptManager = new MockPromptManager([{
      type: "tool_selection",
      toolName: "test-tool",
      reasoning: "LLM selected test-tool",
      confidence: 0.9,
    }]);

    const runtimeWithLLM = createDeterministicAgentRuntime({
      clock: { now: () => 1_700_000_000_000 },
      idGenerator: { next: () => "req-4" },
      eventBus,
      router: () => null, // Deterministic router always fails
      modelProvider,
      promptManager,
      hybridConfig: { enabled: false }, // Hybrid intelligence disabled
    });

    const response = await runtimeWithLLM.execute(request("disabled hybrid prompt"));

    expect(response.status).toBe("no_capability");
    expect(events.some(e => e.type === "llm.request")).toBe(false);
    expect(events.some(e => e.type === "llm.response")).toBe(false);
    expect(events.some(e => e.type === "llm.decision")).toBe(false);
  });

  it("handles LLM no_action decision", async () => {
    const { runtime: baseRuntime, events, eventBus } = createFixture(() => null, "req-5");

    const modelProvider = new MockModelProvider([{ text: "no-action-response" }]);
    const promptManager = new MockPromptManager([{
      type: "no_action",
      reasoning: "No suitable tool found",
    }]);

    const runtimeWithLLM = createDeterministicAgentRuntime({
      clock: { now: () => 1_700_000_000_000 },
      idGenerator: { next: () => "req-5" },
      eventBus,
      router: () => null,
      modelProvider,
      promptManager,
      hybridConfig: { enabled: true },
    });

    const response = await runtimeWithLLM.execute(request("unsupported prompt"));

    expect(response.status).toBe("no_capability");
    expect(events.some(e => e.type === "llm.request")).toBe(true);
    expect(events.some(e => e.type === "llm.response")).toBe(true);
    expect(events.some(e => e.type === "llm.decision")).toBe(true);
  });

  it("falls back to no_capability when LLM times out and retries fail", async () => {
    vi.useFakeTimers();
    const { runtime: baseRuntime, events, eventBus } = createFixture(() => null, "req-6");

    // Mock a model provider that always times out
    const modelProvider = new MockModelProvider([]);
    modelProvider.generate = vi.fn(async () => {
      const error = new Error("AbortError");
      error.name = "AbortError";
      throw error;
    });

    const promptManager = new MockPromptManager([{
      type: "tool_selection",
      toolName: "test-tool",
      reasoning: "LLM selected test-tool",
      confidence: 0.9,
    }]);

    const runtimeWithLLM = createDeterministicAgentRuntime({
      clock: { now: () => 1_700_000_000_000 },
      idGenerator: { next: () => "req-6" },
      eventBus,
      router: () => null,
      modelProvider,
      promptManager,
      hybridConfig: { enabled: true, timeout: 1000, retryAttempts: 0 }, // 1s timeout, 0 retries
    });

    const executePromise = runtimeWithLLM.execute(request("timeout prompt"));

    // Advance timers to trigger the timeout
    await vi.advanceTimersByTimeAsync(1000); // Advance by timeout duration

    const response = await executePromise;

    expect(response.status).toBe("no_capability");
    expect(modelProvider.generate).toHaveBeenCalledTimes(1); // Initial attempt only
    expect(events.some(e => e.type === "llm.request")).toBe(true);
    expect(events.some(e => e.type === "llm.response")).toBe(false); // No successful response
    expect(events.some(e => e.type === "llm.decision")).toBe(false); // No successful decision
  });

  it("succeeds on retry after initial LLM timeout", async () => {
    vi.useFakeTimers();
    const { runtime: baseRuntime, events, eventBus } = createFixture(() => null, "req-7");

    // Mock a model provider that times out once, then succeeds
    const modelProvider = new MockModelProvider([{ text: "llm-response-retry" }]);
    let callCount = 0;
    modelProvider.generate = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        const error = new Error("AbortError");
        error.name = "AbortError";
        throw error;
      } else {
        return { text: "llm-response-retry" };
      }
    });

    const promptManager = new MockPromptManager([{
      type: "tool_selection",
      toolName: "test-tool",
      reasoning: "LLM selected test-tool on retry",
      confidence: 0.9,
    }]);

    const runtimeWithLLM = createDeterministicAgentRuntime({
      clock: { now: () => 1_700_000_000_000 },
      idGenerator: { next: () => "req-7" },
      eventBus,
      router: () => null,
      modelProvider,
      promptManager,
      hybridConfig: { enabled: true, timeout: 1000, retryAttempts: 1 }, // 1s timeout, 1 retry
    });

    const executePromise = runtimeWithLLM.execute(request("retry prompt"));

    // Advance timers to trigger the first timeout
    await vi.advanceTimersByTimeAsync(1000); // Advance by timeout duration

    // Advance timers to trigger the second (successful) call
    await vi.advanceTimersByTimeAsync(1000); // Advance by timeout duration

    const response = await executePromise;

    expect(response.status).toBe("completed");
    expect((response as CompletedRuntimeResponse).tool.name).toBe("test-tool");
    expect(modelProvider.generate).toHaveBeenCalledTimes(2); // Initial attempt + 1 retry
    expect(events.some(e => e.type === "llm.request")).toBe(true);
    expect(events.some(e => e.type === "llm.response")).toBe(true);
    expect(events.some(e => e.type === "llm.decision")).toBe(true);
  });

  it("handles LLM clarification requests", async () => {
    const { runtime: baseRuntime, events, eventBus } = createFixture(() => null, "req-3");

    const modelProvider = new MockModelProvider([{ text: "clarification-response" }]);
    const promptManager = new MockPromptManager([{
      type: "clarification",
      reasoning: "Need more info",
      clarificationQuestion: "What do you mean?",
    }]);

    const runtimeWithLLM = createDeterministicAgentRuntime({
      clock: { now: () => 1_700_000_000_000 },
      idGenerator: { next: () => "req-3" },
      eventBus,
      router: () => null,
      modelProvider,
      promptManager,
      hybridConfig: { enabled: true },
    });

    const response = await runtimeWithLLM.execute(request("incomplete prompt"));

    expect(response.status).toBe("failed");
    expect((response as FailedRuntimeResponse).error.code).toBe("CLARIFICATION_NEEDED");
    expect((response as FailedRuntimeResponse).error.message).toBe("What do you mean?");
  });
});
