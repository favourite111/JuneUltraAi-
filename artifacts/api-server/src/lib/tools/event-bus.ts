import { EventEmitter } from "events";
import type { EventBus, AgentEvent } from "./types.js";
import { deepFreeze } from "./utils.js";

/**
 * Implementation of the Phase 3A Event Bus.
 * Uses Node.js EventEmitter for lightweight, synchronous event handling.
 * Every event carries the ExecutionContext for observability.
 */
export class AgentEventBus implements EventBus {
  private emitter: EventEmitter;

  constructor() {
    this.emitter = new EventEmitter();
  }

  /**
   * Emits an agent event.
   * In Phase 3A, every event must include the ExecutionContext.
   */
  emit(event: AgentEvent): void {
    // Deep freeze the event to ensure immutability
    const frozenEvent = deepFreeze(event);
    this.emitter.emit(frozenEvent.type, frozenEvent);
  }

  /**
   * Subscribes to an agent event.
   */
  subscribe(eventType: AgentEvent["type"], listener: (event: AgentEvent) => void): void {
    this.emitter.on(eventType, listener);
  }

  /**
   * Subscribes to an agent event once.
   */
  once(eventType: AgentEvent["type"], listener: (event: AgentEvent) => void): void {
    this.emitter.once(eventType, listener);
  }

  /**
   * Unsubscribes from an agent event.
   */
  unsubscribe(eventType: AgentEvent["type"], listener: (event: AgentEvent) => void): void {
    this.emitter.off(eventType, listener);
  }
}

/**
 * Singleton instance of the Event Bus for the runtime.
 * While dependency injection is preferred, a singleton provides a stable
 * entry point for the global runtime metrics and logging.
 */
export const globalEventBus = new AgentEventBus();
