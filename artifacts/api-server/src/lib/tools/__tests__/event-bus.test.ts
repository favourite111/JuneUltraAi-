import { describe, it, expect, vi } from "vitest";
import { AgentEventBus } from "../event-bus.js";
import { createExecutionContext } from "../context.js";
import type { AnyAgentEvent, ExecutionContext } from "../types.js";

const createMockDependencies = () => {
  const clockNow = vi.fn(() => 1_725_000_000_000);
  const idGeneratorNext = vi.fn(() => "mock-event-id");
  return {
    clock: { now: clockNow },
    idGenerator: { next: idGeneratorNext },
    clockNow,
    idGeneratorNext,
  };
};

// Creates an ExecutionContext using provided requestId/timestamp without consuming the mock's call count
const createMockExecutionContext = (_deps: ReturnType<typeof createMockDependencies>, requestId: string, timestamp: number): ExecutionContext => {
  return createExecutionContext(
    {
      botId: "bot-123",
      userId: "user-456",
      conversationKey: "conv-789",
      conversationState: { phase: "active" },
      history: [],
      logger: { child: vi.fn() },
      metrics: { increment: vi.fn() },
    },
    {
      idGenerator: { next: () => requestId },
      clock: { now: () => timestamp },
    } as any,
  );
};

describe("AgentEventBus - Milestone 2", () => {
  it("should emit events with injected IDs and timestamps, and ensure immutability", () => {
    const deps = createMockDependencies();
    const eventBus = new AgentEventBus();
    // Consume the mock once for context requestId, once for event eventId
    const requestId = deps.idGeneratorNext();
    const timestamp = deps.clockNow();
    const eventId = deps.idGeneratorNext();
    const context = createMockExecutionContext(deps, requestId, timestamp);
    const listener = vi.fn();

    eventBus.subscribe("test.event", listener);

    const eventPayload = { data: "some data" };
    const emittedEvent: AnyAgentEvent = {
      type: "test.event",
      context,
      payload: {
        eventId: eventId,
        requestId: context.requestId,
        correlationId: context.correlationId,
        timestamp: timestamp,
        eventType: "test.event",
        ...eventPayload,
      },
    };

    eventBus.emit(emittedEvent);

    expect(listener).toHaveBeenCalledTimes(1);
    const receivedEvent = listener.mock.calls[0][0];

    expect(receivedEvent.type).toBe("test.event");
    expect(receivedEvent.context.requestId).toBe(context.requestId);
    expect(receivedEvent.payload.eventId).toBe("mock-event-id");
    expect(receivedEvent.payload.requestId).toBe(context.requestId);
    expect(receivedEvent.payload.correlationId).toBe(context.correlationId);
    expect(receivedEvent.payload.timestamp).toBe(1_725_000_000_000);
    expect(receivedEvent.payload.eventType).toBe("test.event");
    expect(receivedEvent.payload.data).toBe("some data");

    // Ensure immutability
    expect(Object.isFrozen(receivedEvent)).toBe(true);
    expect(Object.isFrozen(receivedEvent.payload)).toBe(true);
    expect(() => {
      (receivedEvent.payload as any).data = "mutated";
    }).toThrow();
    expect(() => {
      (receivedEvent as any).type = "mutated";
    }).toThrow();

    // idGeneratorNext called twice: once for requestId, once for eventId
    expect(deps.idGeneratorNext).toHaveBeenCalledTimes(2);
    // clockNow called once: for timestamp
    expect(deps.clockNow).toHaveBeenCalledTimes(1);
  });

  it("should handle multiple subscribers for the same event type", () => {
    const deps = createMockDependencies();
    const eventBus = new AgentEventBus();
    const requestId = deps.idGeneratorNext();
    const timestamp = deps.clockNow();
    const eventId = deps.idGeneratorNext();
    const context = createMockExecutionContext(deps, requestId, timestamp);
    const listener1 = vi.fn();
    const listener2 = vi.fn();

    eventBus.subscribe("multi.event", listener1);
    eventBus.subscribe("multi.event", listener2);

    const emittedEvent: AnyAgentEvent = {
      type: "multi.event",
      context,
      payload: {
        eventId: eventId,
        requestId: context.requestId,
        correlationId: context.correlationId,
        timestamp: timestamp,
        eventType: "multi.event",
      },
    };

    eventBus.emit(emittedEvent);

    expect(listener1).toHaveBeenCalledTimes(1);
    expect(listener2).toHaveBeenCalledTimes(1);
    expect(listener1.mock.calls[0][0]).toEqual(listener2.mock.calls[0][0]);

    expect(deps.idGeneratorNext).toHaveBeenCalledTimes(2);
    expect(deps.clockNow).toHaveBeenCalledTimes(1);
  });

  it("should not notify unsubscribed listeners", () => {
    const deps = createMockDependencies();
    const eventBus = new AgentEventBus();
    const requestId = deps.idGeneratorNext();
    const timestamp = deps.clockNow();
    const eventId = deps.idGeneratorNext();
    const context = createMockExecutionContext(deps, requestId, timestamp);
    const listener1 = vi.fn();
    const listener2 = vi.fn();

    eventBus.subscribe("unsub.event", listener1);
    eventBus.subscribe("unsub.event", listener2);
    eventBus.unsubscribe("unsub.event", listener1);

    const emittedEvent: AnyAgentEvent = {
      type: "unsub.event",
      context,
      payload: {
        eventId: eventId,
        requestId: context.requestId,
        correlationId: context.correlationId,
        timestamp: timestamp,
        eventType: "unsub.event",
      },
    };

    eventBus.emit(emittedEvent);

    expect(listener1).not.toHaveBeenCalled();
    expect(listener2).toHaveBeenCalledTimes(1);

    expect(deps.idGeneratorNext).toHaveBeenCalledTimes(2);
    expect(deps.clockNow).toHaveBeenCalledTimes(1);
  });

  it("should only notify once() listeners a single time", () => {
    const deps = createMockDependencies();
    const eventBus = new AgentEventBus();
    const requestId1 = deps.idGeneratorNext();
    const timestamp1 = deps.clockNow();
    const eventId1 = deps.idGeneratorNext();
    const context = createMockExecutionContext(deps, requestId1, timestamp1);
    const listener = vi.fn();

    eventBus.once("once.event", listener);

    const emittedEvent1: AnyAgentEvent = {
      type: "once.event",
      context,
      payload: {
        eventId: eventId1,
        requestId: context.requestId,
        correlationId: context.correlationId,
        timestamp: timestamp1,
        eventType: "once.event",
      },
    };
    eventBus.emit(emittedEvent1);

    const requestId2 = deps.idGeneratorNext();
    const timestamp2 = deps.clockNow();
    const eventId2 = deps.idGeneratorNext();
    const emittedEvent2: AnyAgentEvent = {
      type: "once.event",
      context,
      payload: {
        eventId: eventId2,
        requestId: context.requestId,
        correlationId: context.correlationId,
        timestamp: timestamp2,
        eventType: "once.event",
      },
    };
    eventBus.emit(emittedEvent2);

    expect(listener).toHaveBeenCalledTimes(1);

    // idGeneratorNext called 4 times: requestId1, eventId1, requestId2, eventId2
    expect(deps.idGeneratorNext).toHaveBeenCalledTimes(4);
    // clockNow called 2 times: timestamp1, timestamp2
    expect(deps.clockNow).toHaveBeenCalledTimes(2);
  });

  it("should maintain deterministic event ordering", () => {
    const deps = createMockDependencies();
    const eventBus = new AgentEventBus();
    const requestId = deps.idGeneratorNext();
    const timestamp = deps.clockNow();
    const eventId = deps.idGeneratorNext();
    const context = createMockExecutionContext(deps, requestId, timestamp);
    const callOrder: string[] = [];

    eventBus.subscribe("order.event", () => callOrder.push("listener1"));
    eventBus.subscribe("order.event", () => callOrder.push("listener2"));
    eventBus.subscribe("order.event", () => callOrder.push("listener3"));

    const emittedEvent: AnyAgentEvent = {
      type: "order.event",
      context,
      payload: {
        eventId: eventId,
        requestId: context.requestId,
        correlationId: context.correlationId,
        timestamp: timestamp,
        eventType: "order.event",
      },
    };

    eventBus.emit(emittedEvent);

    expect(callOrder).toEqual(["listener1", "listener2", "listener3"]);

    expect(deps.idGeneratorNext).toHaveBeenCalledTimes(2);
    expect(deps.clockNow).toHaveBeenCalledTimes(1);
  });

  it("should allow deterministic replay by using injected dependencies", () => {
    const eventBus = new AgentEventBus();
    const listener = vi.fn();
    eventBus.subscribe("replay.event", listener);

    // First run with specific dependencies
    const clockNow1 = vi.fn(() => 1_000);
    const idGeneratorNext1 = vi.fn(() => "id-1");
    const deps1 = {
      clock: { now: clockNow1 },
      idGenerator: { next: idGeneratorNext1 },
      clockNow: clockNow1,
      idGeneratorNext: idGeneratorNext1,
    };
    const requestId1 = deps1.idGeneratorNext();
    const timestamp1 = deps1.clockNow();
    const eventId1 = deps1.idGeneratorNext();
    const context1 = createMockExecutionContext(deps1, requestId1, timestamp1);
    const event1: AnyAgentEvent = {
      type: "replay.event",
      context: context1,
      payload: {
        eventId: eventId1,
        requestId: context1.requestId,
        correlationId: context1.correlationId,
        timestamp: timestamp1,
        eventType: "replay.event",
        value: 1,
      },
    };
    eventBus.emit(event1);

    // Second run with identical dependencies should produce identical events
    const clockNow2 = vi.fn(() => 1_000);
    const idGeneratorNext2 = vi.fn(() => "id-1");
    const deps2 = {
      clock: { now: clockNow2 },
      idGenerator: { next: idGeneratorNext2 },
      clockNow: clockNow2,
      idGeneratorNext: idGeneratorNext2,
    };
    const requestId2 = deps2.idGeneratorNext();
    const timestamp2 = deps2.clockNow();
    const eventId2 = deps2.idGeneratorNext();
    const context2 = createMockExecutionContext(deps2, requestId2, timestamp2);
    const event2: AnyAgentEvent = {
      type: "replay.event",
      context: context2,
      payload: {
        eventId: eventId2,
        requestId: context2.requestId,
        correlationId: context2.correlationId,
        timestamp: timestamp2,
        eventType: "replay.event",
        value: 1,
      },
    };
    eventBus.emit(event2);

    expect(listener).toHaveBeenCalledTimes(2);
    // Compare relevant properties individually for deeply frozen objects
    const event1Received = listener.mock.calls[0][0];
    const event2Received = listener.mock.calls[1][0];

    expect(event1Received.type).toEqual(event2Received.type);
    expect(event1Received.context.requestId).toEqual(event2Received.context.requestId);
    expect(event1Received.context.correlationId).toEqual(event2Received.context.correlationId);
    expect(event1Received.payload.eventId).toEqual(event2Received.payload.eventId);
    expect(event1Received.payload.requestId).toEqual(event2Received.payload.requestId);
    expect(event1Received.payload.correlationId).toEqual(event2Received.payload.correlationId);
    expect(event1Received.payload.timestamp).toEqual(event2Received.payload.timestamp);
    expect(event1Received.payload.eventType).toEqual(event2Received.payload.eventType);
    expect(event1Received.payload.value).toEqual(event2Received.payload.value);

    expect(event1Received.payload.eventId).toBe("id-1");
    expect(event1Received.payload.timestamp).toBe(1_000);

    // idGeneratorNext called twice: once for requestId, once for eventId
    expect(deps1.idGeneratorNext).toHaveBeenCalledTimes(2);
    expect(deps1.clockNow).toHaveBeenCalledTimes(1);
    expect(deps2.idGeneratorNext).toHaveBeenCalledTimes(2);
    expect(deps2.clockNow).toHaveBeenCalledTimes(1);
  });
});
