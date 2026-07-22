import { describe, expect, it, vi } from "vitest";
import { createExecutionContext } from "../context.js";
import { AgentEventBus } from "../event-bus.js";
import type { AgentEvent, ExecutionContext } from "../types.js";

function createContext(requestId = "request-1", timestamp = 1_725_000_000_000): ExecutionContext {
  return createExecutionContext(
    {
      botId: "bot-123",
      userId: "user-456",
      conversationKey: "conv-789",
      conversationState: { phase: "active" },
      history: [],
      logger: {},
      metrics: { record: () => {}, getSnapshot: () => ({}) },
    },
    {
      idGenerator: { next: () => requestId },
      clock: { now: () => timestamp },
    },
  );
}

function toolStarted(context: ExecutionContext, timestamp = 1_725_000_000_001): AgentEvent {
  return {
    type: "tool.started",
    context,
    payload: { toolId: "test-tool", timestamp },
  };
}

describe("AgentEventBus - Milestone 2", () => {
  it("emits an immutable lifecycle event through the declared on API", () => {
    const eventBus = new AgentEventBus();
    const context = createContext();
    const listener = vi.fn();
    const event = toolStarted(context);

    eventBus.on("tool.started", listener);
    eventBus.emit(event);

    expect(listener).toHaveBeenCalledTimes(1);
    const received = listener.mock.calls[0]![0] as AgentEvent;
    expect(received).toEqual(event);
    expect(Object.isFrozen(received)).toBe(true);
    expect(Object.isFrozen(received.payload)).toBe(true);
    expect(() => {
      (received.payload as { toolId: string }).toolId = "mutated";
    }).toThrow();
  });

  it("retains subscribe and unsubscribe aliases for backward compatibility", () => {
    const eventBus = new AgentEventBus();
    const context = createContext();
    const listener = vi.fn();

    eventBus.subscribe("tool.started", listener);
    eventBus.unsubscribe("tool.started", listener);
    eventBus.emit(toolStarted(context));

    expect(listener).not.toHaveBeenCalled();
  });

  it("honors once listeners and registration ordering deterministically", () => {
    const eventBus = new AgentEventBus();
    const context = createContext();
    const order: string[] = [];
    const once = vi.fn(() => order.push("once"));

    eventBus.on("tool.started", () => order.push("first"));
    eventBus.once("tool.started", once);
    eventBus.on("tool.started", () => order.push("last"));

    eventBus.emit(toolStarted(context, 1));
    eventBus.emit(toolStarted(context, 2));

    expect(order).toEqual(["first", "once", "last", "first", "last"]);
    expect(once).toHaveBeenCalledTimes(1);
  });
});
