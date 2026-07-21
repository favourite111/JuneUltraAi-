import type {
  ExecutionContext,
  ExecutionContextDependencies,
  ExecutionContextInput,
} from "./types.js";

const DEFAULT_ABORT_SIGNAL = new AbortController().signal;

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") {
    return value;
  }

  const objectValue = value as object;
  if (seen.has(objectValue)) {
    return value;
  }

  seen.add(objectValue);

  for (const key of Reflect.ownKeys(objectValue)) {
    const descriptor = Object.getOwnPropertyDescriptor(objectValue, key);
    if (descriptor && "value" in descriptor) {
      deepFreeze(descriptor.value, seen);
    }
  }

  return Object.freeze(objectValue) as T;
}

function immutableSnapshot<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

/**
 * Creates the immutable request snapshot shared by the Phase 3A runtime.
 * Time and identity are supplied by the caller so a recorded dependency set
 * reproduces the same context during replay.
 */
export function createExecutionContext(
  input: ExecutionContextInput,
  dependencies: ExecutionContextDependencies,
): ExecutionContext {
  const requestId = dependencies.idGenerator.next();
  const timestamp = dependencies.clock.now();
  const correlationId = input.correlationId ?? requestId;
  const history = immutableSnapshot(input.history);
  const facts = immutableSnapshot(input.memory?.facts ?? input.facts ?? []);
  const conversationState = immutableSnapshot(input.conversationState);
  const plannerState = input.plannerState
    ? immutableSnapshot(input.plannerState)
    : undefined;

  const context: ExecutionContext = {
    requestId,
    correlationId,
    userId: input.userId,
    groupId: input.groupId,
    metadata: Object.freeze({ requestId, correlationId, timestamp }),
    user: Object.freeze({ id: input.userId, botId: input.botId }),
    group: input.groupId ? Object.freeze({ id: input.groupId }) : undefined,
    conversation: Object.freeze({
      key: input.conversationKey,
      state: conversationState,
    }),
    history,
    memory: Object.freeze({ facts, history }),
    plannerState,
    abortSignal: input.abortSignal ?? DEFAULT_ABORT_SIGNAL,
    logger: input.logger,
    metrics: input.metrics,
    clock: dependencies.clock,
    idGenerator: dependencies.idGenerator,
    eventBus: input.eventBus,
  };

  return Object.freeze(context);
}
