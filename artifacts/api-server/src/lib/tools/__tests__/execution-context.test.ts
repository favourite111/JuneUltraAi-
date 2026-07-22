import { describe, expect, it, vi } from "vitest";
import { createExecutionContext } from "../context.js";

type HistoryEntry = {
  role: string;
  content: string;
  metadata: {
    source: string;
  };
};

function createInput(overrides: Record<string, unknown> = {}) {
  return {
    botId: "bot-123",
    userId: "user-456",
    groupId: "group-789",
    conversationKey: "bot-123::group-789::user-456",
    conversationState: { phase: "active" },
    memory: {
      facts: [{ key: "name", value: "Ada" }],
    },
    history: [
      {
        role: "user",
        content: "hello",
        metadata: { source: "test" },
      },
    ],
    logger: { child: vi.fn() },
    metrics: { record: vi.fn(), getSnapshot: vi.fn(() => ({})) },
    abortSignal: new AbortController().signal,
    ...overrides,
  };
}

function createDependencies() {
  return {
    clock: { now: vi.fn(() => 1_725_000_000_000) },
    idGenerator: { next: vi.fn(() => "request-fixed-001") },
  };
}

describe("ExecutionContext", () => {
  it("creates an immutable, deterministic snapshot from injected runtime dependencies", () => {
    const input = createInput({ correlationId: "correlation-fixed-001" });
    const dependencies = createDependencies();

    const context = createExecutionContext(input, dependencies);

    expect(context.requestId).toBe("request-fixed-001");
    expect(context.correlationId).toBe("correlation-fixed-001");
    expect(context.userId).toBe("user-456");
    expect(context.groupId).toBe("group-789");
    expect(context.history).toEqual(input.history);
    expect(context.memory.facts).toEqual([{ key: "name", value: "Ada" }]);
    expect(context.memory.history).toBe(context.history);
    expect(context.metadata).toEqual({
      requestId: "request-fixed-001",
      correlationId: "correlation-fixed-001",
      timestamp: 1_725_000_000_000,
    });
    expect(context.user).toEqual({ id: "user-456", botId: "bot-123" });
    expect(context.group).toEqual({ id: "group-789" });
    expect(context.clock).toBe(dependencies.clock);
    expect(context.idGenerator).toBe(dependencies.idGenerator);
    expect(dependencies.clock.now).toHaveBeenCalledOnce();
    expect(dependencies.idGenerator.next).toHaveBeenCalledOnce();

    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.metadata)).toBe(true);
    expect(Object.isFrozen(context.history)).toBe(true);
    expect(Object.isFrozen(context.memory)).toBe(true);
    expect(Object.isFrozen(context.memory.facts)).toBe(true);
    expect(Object.isFrozen(context.memory.facts[0])).toBe(true);
    expect(Object.isFrozen(context.conversation.state)).toBe(true);
    expect(Object.isFrozen(context.history[0])).toBe(true);
    expect(Object.isFrozen((context.history[0] as HistoryEntry).metadata)).toBe(true);
  });

  it("does not retain mutable references from caller-provided memory or history", () => {
    const sourceHistory: HistoryEntry[] = [
      {
        role: "user",
        content: "original",
        metadata: { source: "caller" },
      },
    ];
    const sourceFacts = [{ key: "language", value: "English" }];
    const sourceConversationState = { nested: { status: "original" } };
    const input = createInput({
      history: sourceHistory,
      memory: { facts: sourceFacts },
      conversationState: sourceConversationState,
    });

    const context = createExecutionContext(input, createDependencies());

    sourceHistory[0].content = "mutated after creation";
    sourceHistory[0].metadata.source = "mutated after creation";
    sourceFacts[0].value = "mutated after creation";
    sourceConversationState.nested.status = "mutated after creation";

    expect((context.history[0] as HistoryEntry).content).toBe("original");
    expect((context.history[0] as HistoryEntry).metadata.source).toBe("caller");
    expect((context.memory.facts[0] as { value: string }).value).toBe("English");
    expect((context.conversation.state as { nested: { status: string } }).nested.status).toBe("original");
    expect(() => (context.history as HistoryEntry[]).push(sourceHistory[0])).toThrow(TypeError);
    expect(() => {
      (context.history[0] as HistoryEntry).metadata.source = "attempted context mutation";
    }).toThrow(TypeError);
  });

  it("uses the request ID as the root correlation ID when no parent correlation ID is supplied", () => {
    const dependencies = createDependencies();

    const context = createExecutionContext(createInput(), dependencies);

    expect(context.requestId).toBe("request-fixed-001");
    expect(context.correlationId).toBe("request-fixed-001");
    expect(context.metadata.correlationId).toBe("request-fixed-001");
    expect(dependencies.idGenerator.next).toHaveBeenCalledOnce();
  });
});
