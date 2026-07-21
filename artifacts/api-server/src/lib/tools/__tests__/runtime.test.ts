import { describe, it, expect, vi } from "vitest";
import { createExecutionContext } from "../context.js";
import { AgentEventBus } from "../event-bus.js";
import { routeTool } from "../registry.js";

const runtimeDependencies = {
  clock: { now: () => 1_725_000_000_000 },
  idGenerator: { next: () => "runtime-test-request-id" },
};

describe("Agent Runtime - Phase 3A", () => {
  describe("Milestone 1: Execution Context", () => {
    it("should create an immutable execution context", () => {
      const context = createExecutionContext({
        botId: "bot-123",
        userId: "user-456",
        conversationKey: "conv-789",
        conversationState: { mood: "happy" },
        facts: ["fact 1"],
        history: [{ role: "user", content: "hello" }],
        logger: {},
        metrics: {},
      }, runtimeDependencies);

      expect(context.user.id).toBe("user-456");
      expect(context.metadata.requestId).toBeDefined();
      expect(Object.isFrozen(context)).toBe(true);
      expect(Object.isFrozen(context.metadata)).toBe(true);
      expect(Object.isFrozen(context.user)).toBe(true);
    });
  });

  describe("Milestone 2: Event Bus", () => {
    it("should emit and receive events with context", () => {
      const eventBus = new AgentEventBus();
      const context = createExecutionContext({
        botId: "bot-123",
        userId: "user-456",
        conversationKey: "conv-789",
        conversationState: {},
        facts: [],
        history: [],
        logger: {},
        metrics: {},
      }, runtimeDependencies);

      const listener = vi.fn();
      eventBus.on("tool.started", listener);

      eventBus.emit({
        type: "tool.started",
        context,
        payload: { toolId: "qrcode", timestamp: Date.now() },
      });

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0].context.metadata.requestId).toBe(context.metadata.requestId);
    });
  });

  describe("Milestone 3: Capability Router", () => {
    it("should return a confidence score for matched tools", () => {
      const result = routeTool("generate a qr code for https://example.com");
      
      expect(result).not.toBeNull();
      expect(result?.tool.name).toBe("qrcode");
      expect(result?.confidence.score).toBe(0.98);
      expect(result?.confidence.reasoning).toBe("Calculated via tool.score()");
    });

    it("should fallback to legacy confidence for tools without score()", () => {
      const result = routeTool("shorten https://google.com");
      
      expect(result).not.toBeNull();
      expect(result?.tool.name).toBe("url_shortener");
      expect(result?.confidence.score).toBe(0.95);
      expect(result?.confidence.reasoning).toBe("Deterministic regex match (legacy fallback)");
    });
  });
});
