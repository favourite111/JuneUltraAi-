import * as chrono from "chrono-node";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { containsAnyPhrase, textResult } from "./utils.js";
import { createJob } from "../job-store.js";

interface ReminderArgs {
  message: string;
  dueAt: Date;
}

const TRIGGER_PHRASES = [
  "remind me",
  "remind us",
  "set a reminder",
  "set reminder",
  "create a reminder",
] as const;

function match(text: string): ReminderArgs | null {
  if (!containsAnyPhrase(text, TRIGGER_PHRASES)) return null;

  const now = new Date();
  const results = chrono.parse(text, now, { forwardDate: true });
  if (results.length === 0) return null;

  const parsed = results[0]!;
  const dueAt = parsed.start.date();
  if (dueAt.getTime() <= now.getTime()) return null; // must schedule for the future

  // Strip the trigger phrase and the matched date/time text -- whatever's
  // left is the actual reminder message.
  let message = text;
  for (const phrase of TRIGGER_PHRASES) {
    message = message.replace(new RegExp(`\\b${phrase}\\b`, "i"), " ");
  }
  message = message.replace(parsed.text, " ");
  message = message
    .replace(/\b(to|that|about|me|please)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[:\-,.\s]+|[:\-,.\s]+$/g, "");

  if (!message) return null;

  return { message, dueAt };
}

async function execute(args: ReminderArgs, ctx: ToolContext): Promise<ToolResult> {
  const job = await createJob(
    ctx.botId,
    "reminder",
    { message: args.message, userId: ctx.userId, groupId: ctx.groupId },
    args.dueAt,
  );

  const when = args.dueAt.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

  return textResult(`Got it 👍 I'll remind you: "${args.message}" on ${when}`, {
    jobId: job.id,
    message: args.message,
    dueAt: args.dueAt.toISOString(),
  });
}

export const reminderTool: Tool<ReminderArgs> = {
  name: "reminder",
  description: "Schedules a one-off reminder, delivered later via the bot's webhook",
  match,
  execute,
};
