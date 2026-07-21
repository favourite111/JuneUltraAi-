import { v4 as uuidv4 } from 'uuid';
import type { ExecutionContext } from "./types.js";

/**
 * Factory to create a new immutable ExecutionContext.
 * This is the stable contract that every Phase 3A runtime component depends on.
 */
export function createExecutionContext(params: {
  botId: string;
  userId: string;
  groupId?: string;
  conversationKey: string;
  conversationState: any;
  facts: any[];
  history: any[];
  logger: any;
  metrics: any;
  abortSignal?: AbortSignal;
  plannerState?: Record<string, unknown>;
}): ExecutionContext {
  const {
    botId,
    userId,
    groupId,
    conversationKey,
    conversationState,
    facts,
    history,
    logger,
    metrics,
    abortSignal = new AbortController().signal,
    plannerState,
  } = params;

  // Use Object.freeze to ensure immutability at runtime
  return Object.freeze({
    metadata: Object.freeze({
      requestId: uuidv4(),
      timestamp: Date.now(),
    }),
    user: Object.freeze({
      id: userId,
      botId: botId,
    }),
    group: groupId ? Object.freeze({ id: groupId }) : undefined,
    conversation: Object.freeze({
      key: conversationKey,
      state: Object.freeze(conversationState),
    }),
    memory: Object.freeze({
      facts: Object.freeze([...facts]),
      history: Object.freeze([...history]),
    }),
    plannerState: plannerState ? Object.freeze({ ...plannerState }) : undefined,
    abortSignal,
    logger,
    metrics,
  });
}
