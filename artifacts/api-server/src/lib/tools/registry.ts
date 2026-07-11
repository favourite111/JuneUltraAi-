import type { Tool } from "./types.js";
import { urlShortenerTool } from "./url-shortener.js";
import { qrCodeTool } from "./qrcode.js";
import { screenshotTool } from "./screenshot.js";
import { textToPdfTool } from "./text-to-pdf.js";
import { reminderTool } from "./reminder.js";
import { listRemindersTool } from "./list-reminders.js";
import { deleteReminderTool } from "./delete-reminder.js";
import { screenshotPromptTool } from "./screenshot-prompt.js";
import { capabilitiesTool } from "./capabilities.js";

/**
 * Every supported tool, in match priority order (checked top to bottom,
 * first match wins — deterministic, not AI-based). Only one tool runs
 * per message; if a message could plausibly match more than one tool,
 * put the more specific/less ambiguous one first.
 *
 * Ordering rationale:
 * - Functional tools come first so actual requests (e.g. "remind me at 6pm",
 *   "screenshot of google.com") are always caught before the capabilities
 *   meta-handler sees them.
 * - `capabilitiesTool` is last: it catches "what can you do?" style questions
 *   only after every real tool has had a chance to claim the message.
 * - url_shortener and screenshot both require a link, but their trigger
 *   phrases don't overlap so they never compete for the same message.
 * - If a future tool's phrases could overlap with an existing one, order by
 *   most-specific / most-likely intent first, and leave a comment explaining
 *   the tie-break.
 *
 * To add a new tool: create a file in this directory exporting a `Tool`,
 * then add it here. The chat route never needs to change.
 */
const registry: Tool[] = [
  urlShortenerTool,
  qrCodeTool,
  screenshotTool,
  screenshotPromptTool, // fallback: screenshot intent but no URL → asks for one
  textToPdfTool,
  reminderTool,
  listRemindersTool,
  deleteReminderTool,
  capabilitiesTool, // always last — catches capability queries after real tools
];

export interface RoutedTool {
  tool: Tool;
  args: unknown;
}

/**
 * Deterministically checks the message against every registered tool
 * and returns the first match, or null if no tool applies (the caller
 * should fall back to the normal AI conversation in that case).
 */
export function routeTool(text: string): RoutedTool | null {
  for (const tool of registry) {
    const args = tool.match(text);
    if (args !== null) {
      return { tool, args };
    }
  }
  return null;
}

export type { Tool, ToolContext, ToolResult, ToolResponseType } from "./types.js";
