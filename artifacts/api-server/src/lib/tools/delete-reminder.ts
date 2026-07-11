import type { Tool, ToolContext, ToolResult } from "./types.js";
import { containsAnyPhrase, textResult } from "./utils.js";
import { listJobsForBot, cancelJob } from "../job-store.js";

/**
 * Delete-reminder tool — lets users cancel pending reminders by saying
 * "delete it", "cancel reminder 2", "remove all reminders", etc.
 *
 * Behaviour matrix:
 *   0 reminders          → "nothing to delete" message
 *   1 reminder + vague   → cancels it automatically
 *   N reminders + vague  → lists them and asks which number
 *   "delete 2"           → cancels the 2nd in their list
 *   "delete all"         → cancels every pending reminder for this user
 */

interface ReminderPayload {
  message: string;
  userId: string;
  groupId?: string;
  [key: string]: unknown;
}

interface DeleteReminderArgs {
  mode: "vague" | "numbered" | "all";
  number: number | null; // only meaningful for mode "numbered"
}

// ── Trigger phrases ──────────────────────────────────────────────────────────

const DELETE_VERBS = ["delete", "cancel", "remove", "clear", "dismiss", "drop"] as const;
const REMINDER_NOUNS = [
  "reminder",
  "reminders",
  "my reminder",
  "my reminders",
  "that reminder",
  "the reminder",
] as const;

// Vague references — match only when paired with a reminder noun OR when
// the message is a bare "delete it" / "cancel it" (common follow-up after
// listing reminders). These are intentionally short so they don't collide
// with unrelated delete commands in other features.
const VAGUE_PHRASES = [
  "delete it",
  "cancel it",
  "remove it",
  "dismiss it",
  ...DELETE_VERBS.flatMap((v) => REMINDER_NOUNS.map((n) => `${v} ${n}`)),
  ...DELETE_VERBS.map((v) => `${v} all reminders`),
  ...DELETE_VERBS.map((v) => `${v} all my reminders`),
] as const;

function match(text: string): DeleteReminderArgs | null {
  const lower = text.toLowerCase().trim();

  // "delete all" variants
  if (
    containsAnyPhrase(text, VAGUE_PHRASES) &&
    /\ball\b/.test(lower)
  ) {
    return { mode: "all", number: null };
  }

  // "delete reminder 2" / "cancel #3" / "remove the 1st"
  const numberedMatch = lower.match(
    /\b(?:delete|cancel|remove|clear|dismiss|drop)\b.*?\b(?:reminder\s*)?[#]?(\d+)(?:st|nd|rd|th)?\b/,
  );
  if (numberedMatch) {
    const n = parseInt(numberedMatch[1]!, 10);
    if (n > 0) return { mode: "numbered", number: n };
  }

  // Vague: "delete it", "cancel my reminder", etc.
  if (containsAnyPhrase(text, VAGUE_PHRASES)) {
    return { mode: "vague", number: null };
  }

  return null;
}

// ── Execute ──────────────────────────────────────────────────────────────────

async function execute(args: DeleteReminderArgs, ctx: ToolContext): Promise<ToolResult> {
  const allJobs = await listJobsForBot(ctx.botId, "reminder", "pending");
  const mine = allJobs.filter((j) => (j.payload as ReminderPayload).userId === ctx.userId);

  if (mine.length === 0) {
    return textResult("You don't have any pending reminders to delete 📭", { deleted: [] });
  }

  // ── Delete all ─────────────────────────────────────────────────────────
  if (args.mode === "all") {
    const results = await Promise.all(mine.map((j) => cancelJob(j.id, ctx.botId)));
    const count = results.filter(Boolean).length;
    return textResult(
      count === 1
        ? `Done ✅ Deleted your 1 reminder.`
        : `Done ✅ Deleted all ${count} reminders.`,
      { deleted: mine.map((j) => j.id) },
    );
  }

  // ── Delete by number ────────────────────────────────────────────────────
  if (args.mode === "numbered" && args.number !== null) {
    const idx = args.number - 1; // user says "2", array is 0-indexed
    const job = mine[idx];
    if (!job) {
      const max = mine.length;
      return textResult(
        `I only see ${max} reminder${max === 1 ? "" : "s"} for you — pick a number between 1 and ${max} 🙂`,
        { deleted: [] },
      );
    }
    const ok = await cancelJob(job.id, ctx.botId);
    if (!ok) {
      return textResult(
        "Couldn't delete that reminder — it may have already fired or been removed 😬",
        { deleted: [] },
      );
    }
    const payload = job.payload as ReminderPayload;
    const when = job.dueAt.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
    return textResult(
      `Done ✅ Deleted reminder: "${payload.message}" (was due ${when})`,
      { deleted: [job.id] },
    );
  }

  // ── Vague ("delete it") ─────────────────────────────────────────────────
  if (mine.length === 1) {
    // Only one — delete it automatically
    const job = mine[0]!;
    const ok = await cancelJob(job.id, ctx.botId);
    if (!ok) {
      return textResult(
        "Couldn't delete that reminder — it may have already fired 😬",
        { deleted: [] },
      );
    }
    const payload = job.payload as ReminderPayload;
    const when = job.dueAt.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
    return textResult(
      `Done ✅ Deleted reminder: "${payload.message}" (was due ${when})`,
      { deleted: [job.id] },
    );
  }

  // Multiple reminders — ask which one
  const lines = mine.map((j, i) => {
    const payload = j.payload as ReminderPayload;
    const when = j.dueAt.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
    return `${i + 1}. "${payload.message}" — ${when}`;
  });

  return textResult(
    `You've got ${mine.length} reminders — which one should I delete? 🤔\n\n` +
      lines.join("\n") +
      `\n\nReply with the number, e.g. "delete reminder 1"`,
    { reminders: mine.map((j) => ({ jobId: j.id, message: (j.payload as ReminderPayload).message })) },
  );
}

export const deleteReminderTool: Tool<DeleteReminderArgs> = {
  name: "delete_reminder",
  description: "Cancels one or all of the user's pending reminders",
  match,
  execute,
};
