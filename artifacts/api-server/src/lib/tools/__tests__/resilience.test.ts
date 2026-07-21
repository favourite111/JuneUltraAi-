import { describe, expect, it, vi } from "vitest";
import { AgentEventBus } from "../event-bus.js";
import { createDeterministicAgentRuntime } from "../runtime.js";
import { MockModelProvider } from "../mock-model-provider.js";
import { MockPromptManager } from "../mock-prompt-manager.js";
import { ToolRegistry } from "../registry.js";
import { MetricsCollector } from "../resilience.js";
import type { AgentRuntimeRequest, Tool, ToolResult } from "../types.js";

const successResult: ToolResult = {
  type: "text",
  reply: "success",
  data: { output: "done" },
};

function createRequest(prompt: string, clock?: any): AgentRuntimeRequest {
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
    clock,
  } as any;
}

describe("Hybrid Runtime Resilience - Phase 3B Milestone 4", () => {
  it("validates LLM response and falls back on invalid JSON/schema", async () => {
    const eventBus = new AgentEventBus();
    const modelProvider = new MockModelProvider([{ text: "invalid-json" }]);
    const promptManager = new MockPromptManager([{
      type: "tool_selection",
      // Missing toolName
      reasoning: "invalid",
      confidence: 0.9,
    } as any]);

    const runtime = createDeterministicAgentRuntime({
      clock: { now: () => 1000 },
      idGenerator: { next: () => "req-1" },
      eventBus,
      router: () => null,
      modelProvider,
      promptManager,
      hybridConfig: { enabled: true },
    });

    const req = createRequest("test prompt");
    const response = await runtime.execute(req);

    expect(response.status).toBe("no_capability");
    expect(req.metrics.getSnapshot().llm_validation_failures).toBe(1);
    expect(req.metrics.getSnapshot().fallback_count).toBe(1);
  });

  it("normalizes provider errors and retries on timeout", async () => {
    const eventBus = new AgentEventBus();
    const modelProvider = new MockModelProvider([]);
    let calls = 0;
    modelProvider.generate = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error("timeout error");
      return { text: "success" };
    });

    const promptManager = new MockPromptManager([{
      type: "tool_selection",
      toolName: "test-tool",
      reasoning: "retry success",
      confidence: 0.9,
    }]);

    const testTool: Tool = {
      name: "test-tool",
      description: "test",
      match: () => ({}),
      execute: async () => successResult,
    };
    ToolRegistry.register(testTool);

    const runtime = createDeterministicAgentRuntime({
      clock: { now: () => 1000 },
      idGenerator: { next: () => "req-2" },
      eventBus,
      router: () => null,
      modelProvider,
      promptManager,
      hybridConfig: { enabled: true, retryAttempts: 1 },
    });

    const req = createRequest("test prompt");
    await runtime.execute(req);

    expect(modelProvider.generate).toHaveBeenCalledTimes(2);
    expect(req.metrics.getSnapshot().llm_timeout).toBe(1);
    expect(req.metrics.getSnapshot().llm_retries).toBe(1);
    expect(req.metrics.getSnapshot().llm_success).toBe(1);
  });

  it("triggers circuit breaker after repeated failures", async () => {
    const eventBus = new AgentEventBus();
    const modelProvider = new MockModelProvider([]);
    modelProvider.generate = vi.fn(async () => {
      throw new Error("persistent failure");
    });

    const runtime = createDeterministicAgentRuntime({
      clock: { now: () => 1000 },
      idGenerator: { next: () => "req-3" },
      eventBus,
      router: () => null,
      modelProvider,
      promptManager: new MockPromptManager([]),
      hybridConfig: { 
        enabled: true, 
        retryAttempts: 0,
        circuitBreaker: { failureThreshold: 2, cooldownPeriodMs: 1000 }
      },
    });

    // First failure
    const req1 = createRequest("p1");
    await runtime.execute(req1);
    expect(req1.metrics.getSnapshot().circuit_breaker_opens).toBe(0);

    // Second failure - should open breaker
    const req2 = createRequest("p2");
    await runtime.execute(req2);
    expect(req2.metrics.getSnapshot().circuit_breaker_opens).toBe(1);

    // Third request - should skip LLM
    const req3 = createRequest("p3");
    const resp3 = await runtime.execute(req3);
    expect(resp3.status).toBe("no_capability");
    expect(req3.metrics.getSnapshot().circuit_breaker_skips).toBe(1);
    expect(modelProvider.generate).toHaveBeenCalledTimes(2);
  });

  it("recovers from open circuit after cooldown", async () => {
    let now = 1000;
    const clock = { now: () => now };
    const eventBus = new AgentEventBus();
    const modelProvider = new MockModelProvider([]);
    modelProvider.generate = vi.fn(async () => {
      // Success only after recovery
      return { text: "recovered" };
    });

    const promptManager = new MockPromptManager([{
      type: "tool_selection",
      toolName: "test-tool",
      reasoning: "recovered",
      confidence: 0.9,
    }]);

    const runtime = createDeterministicAgentRuntime({
      clock,
      idGenerator: { next: () => "req-4" },
      eventBus,
      router: () => null,
      modelProvider,
      promptManager,
      hybridConfig: { 
        enabled: true, 
        retryAttempts: 0,
        circuitBreaker: { failureThreshold: 1, cooldownPeriodMs: 1000 }
      },
    });

    // 1. Force a failure to open the breaker (t=1000)
    modelProvider.generate = vi.fn().mockRejectedValueOnce(new Error("fail"));
    await runtime.execute(createRequest("p1", clock));
    
    // 2. Verify it's open (t=1000, cooldown=1000)
    const resp2 = await runtime.execute(createRequest("p2", clock));
    expect(resp2.status).toBe("no_capability");

    // 3. Advance time past cooldown (t=2500)
    now = 2500;
    
    // 4. Should attempt and succeed
    modelProvider.generate = vi.fn().mockResolvedValue({ text: "recovered" });
    const req3 = createRequest("p3", clock);
    const resp3 = await runtime.execute(req3);
    
    expect(resp3.status).toBe("completed");
    expect(req3.metrics.getSnapshot().llm_success).toBe(1);
  });
});
