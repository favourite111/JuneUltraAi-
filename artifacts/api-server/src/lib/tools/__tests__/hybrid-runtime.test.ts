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

    const eventBus = new AgentEventBus();
    const events: AgentEvent[] = [];
    eventBus.on("llm.request", (e) => events.push(e));
    eventBus.on("llm.response", (e) => events.push(e));
    eventBus.on("llm.decision", (e) => events.push(e));

    const modelProvider = new MockModelProvider([{ text: "llm-response" }]);
    const promptManager = new MockPromptManager([{
      type: "tool_selection",
      toolName: "test-tool",
      toolArgs: { arg1: "val1" },
      reasoning: "LLM selected test-tool",
      confidence: 0.9,
    }]);

    const runtime = createDeterministicAgentRuntime({
      clock: { now: () => 1_700_000_000_000 },
      idGenerator: { next: () => "req-1" },
      eventBus,
      router: () => null, // Deterministic router always fails
      modelProvider,
      promptManager,
    });

    const response = await runtime.execute(request("ambiguous prompt"));

    expect(response.status).toBe("completed");
    expect((response as CompletedRuntimeResponse).tool.name).toBe("test-tool");
    expect(events.some(e => e.type === "llm.request")).toBe(true);
    expect(events.some(e => e.type === "llm.response")).toBe(true);
    expect(events.some(e => e.type === "llm.decision")).toBe(true);
  });

  it("fails when LLM decision has low confidence", async () => {
    const eventBus = new AgentEventBus();
    const modelProvider = new MockModelProvider([{ text: "low-confidence-response" }]);
    const promptManager = new MockPromptManager([{
      type: "tool_selection",
      toolName: "test-tool",
      reasoning: "I'm not sure",
      confidence: 0.3, // Below threshold
    }]);

    const runtime = createDeterministicAgentRuntime({
      clock: { now: () => 1_700_000_000_000 },
      idGenerator: { next: () => "req-2" },
      eventBus,
      router: () => null,
      modelProvider,
      promptManager,
    });

    const response = await runtime.execute(request("very ambiguous prompt"));

    expect(response.status).toBe("no_capability");
  });

  it("handles LLM clarification requests", async () => {
    const eventBus = new AgentEventBus();
    const modelProvider = new MockModelProvider([{ text: "clarification-response" }]);
    const promptManager = new MockPromptManager([{
      type: "clarification",
      reasoning: "Need more info",
      clarificationQuestion: "What do you mean?",
    }]);

    const runtime = createDeterministicAgentRuntime({
      clock: { now: () => 1_700_000_000_000 },
      idGenerator: { next: () => "req-3" },
      eventBus,
      router: () => null,
      modelProvider,
      promptManager,
    });

    const response = await runtime.execute(request("incomplete prompt"));

    expect(response.status).toBe("failed");
    expect((response as FailedRuntimeResponse).error.code).toBe("CLARIFICATION_NEEDED");
    expect((response as FailedRuntimeResponse).error.message).toBe("What do you mean?");
  });
});
