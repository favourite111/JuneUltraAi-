import { EventEmitter } from "events";
import type { AgentEvent, EventBus } from "./types.js";
import { deepFreeze } from "./utils.js";

/**
 * Implementation of the Phase 3A Event Bus.
 *
 * Dispatch is synchronous and listener order is the registration order supplied
 * by Node's EventEmitter. The bus freezes the event envelope and payload, but
 * deliberately does not recursively freeze the ExecutionContext because it
 * contains injected services such as the bus itself, clocks, and loggers.
 */
export class AgentEventBus implements EventBus {
  private readonly emitter = new EventEmitter();

  /**
   * Emits an immutable lifecycle event synchronously.
   */
  emit(event: AgentEvent): void {
    const frozenEvent = Object.freeze({
      ...event,
      payload: deepFreeze(event.payload),
    }) as AgentEvent;

    this.emitter.emit(frozenEvent.type, frozenEvent);
  }

  /**
   * Registers a lifecycle listener.
   */
  on(eventType: AgentEvent["type"], listener: (event: AgentEvent) => void): void {
    this.emitter.on(eventType, listener);
  }

  /**
   * Registers a listener that is removed after its first invocation.
   */
  once(eventType: AgentEvent["type"], listener: (event: AgentEvent) => void): void {
    this.emitter.once(eventType, listener);
  }

  /**
   * Removes a lifecycle listener.
   */
  off(eventType: AgentEvent["type"], listener: (event: AgentEvent) => void): void {
    this.emitter.off(eventType, listener);
  }

  /**
   * Backward-compatible alias retained for the Milestone 2 API.
   */
  subscribe(eventType: AgentEvent["type"], listener: (event: AgentEvent) => void): void {
    this.on(eventType, listener);
  }

  /**
   * Backward-compatible alias retained for the Milestone 2 API.
   */
  unsubscribe(eventType: AgentEvent["type"], listener: (event: AgentEvent) => void): void {
    this.off(eventType, listener);
  }
}

/**
 * Singleton instance retained for legacy callers. New runtime instances should
 * inject an event bus so recordings and tests remain isolated and replayable.
 */
export const globalEventBus = new AgentEventBus();
