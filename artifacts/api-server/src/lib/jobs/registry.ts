import type { JobHandler } from "./types.js";
import { reminderHandler } from "./handlers/reminder.js";

/**
 * Every supported job type. To add a new one (scheduled broadcast,
 * recurring notification, scheduled webhook call, periodic cleanup,
 * ...): create a handler module and register it here. The scheduler
 * itself never needs to change.
 */
const registry = new Map<string, JobHandler>([[reminderHandler.type, reminderHandler]]);

export function getJobHandler(type: string): JobHandler | undefined {
  return registry.get(type);
}

export type { JobHandler, JobContext, JobExecutionResult } from "./types.js";
