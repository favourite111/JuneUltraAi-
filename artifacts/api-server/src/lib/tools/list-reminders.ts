import type { Tool, ToolContext, ToolResult } from "./types.js";
import { containsAnyPhrase, textResult } from "./utils.js";
import { listJobsForBot } from "../job-store.js";

const TRIGGER_PHRASES = [
  "list my reminders",
  "show my reminders",
  "my reminders",
  "what reminders",
  "list reminders",
] as const;

interface ReminderPayload {
  message: string;
  userId: string;
  groupId?: string;
  [key: string]: unknown;
}

function match(text: string): Record<string, never> | null {
  return containsAnyPhrase(text, TRIGGER_PHRASES) ? {} : null;
}

async function execute(_args: Record<string, never>, ctx: ToolContext): Promise<ToolResult> {
  const jobs = await listJobsForBot(ctx.botId, "reminder", "pending");
  const mine = jobs.filter((j) => (j.payload as ReminderPayload).userId === ctx.userId);

  if (mine.length === 0) {
    return textResult("You don't have any reminders scheduled 📭", { reminders: [] });
  }

  const lines = mine.map((j, i) => {
    const payload = j.payload as ReminderPayload;
    const when = j.dueAt.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
    return `${i + 1}. "${payload.message}" — ${when}`;
  });

  return textResult(`Here's what you've got scheduled 📋\n${lines.join("\n")}`, {
    reminders: mine.map((j) => ({
      jobId: j.id,
      message: (j.payload as ReminderPayload).message,
      dueAt: j.dueAt.toISOString(),
    })),
  });
}

export const listRemindersTool: Tool<Record<string, never>> = {
  name: "list_reminders",
  description: "Lists the caller's pending reminders",
  match,
  execute,
};
