import type { JobHandler } from "../types.js";

interface ReminderPayload {
  message: string;
  userId: string;
  groupId?: string;
  [key: string]: unknown;
}

/**
 * The first (and simplest) job type: a reminder is just "deliver this
 * message once, at this time" — all the actual work (retry, backoff,
 * webhook signing) lives in the generic scheduler, not here.
 */
export const reminderHandler: JobHandler<ReminderPayload> = {
  type: "reminder",
  description: "Delivers a one-off reminder message to the bot's webhook at the scheduled time.",
  async execute(payload) {
    return {
      webhookPayload: {
        message: payload.message,
        userId: payload.userId,
        groupId: payload.groupId,
      },
    };
  },
};
