import type { Tool, ToolResult } from "./types.js";
import { containsAnyPhrase, textResult } from "./utils.js";

/**
 * Screenshot intent WITHOUT a URL — fires when the user asks about
 * screenshotting a website but hasn't provided a link yet. Registered
 * directly after `screenshotTool` in the registry, so `screenshotTool`
 * always wins when a URL is present; this only fires as the fallback.
 *
 * Returns a prompt asking for the URL instead of letting the AI
 * incorrectly deny the capability.
 */

// Must exactly match the trigger phrases in screenshot.ts so this tool
// is checked only for messages that would have triggered screenshotTool
// if a URL had been present.
const TRIGGER_PHRASES = [
  "screenshot",
  "screen shot",
  "take a screenshot",
  "take screenshot",
  "capture a screenshot",
  "capture screenshot",
  "grab a screenshot",
  "grab screenshot",
  "screenshot of",
  "snap a screenshot",
  "site screenshot",
  "webpage screenshot",
  "web screenshot",
  "screenshoot",
  // Capability-style questions that name the feature but give no URL
  "can you capture",
  "can you screenshot",
  "can you take a screenshot",
  "can you take screenshots",
  "can you grab a screenshot",
  "can you snap a screenshot",
] as const;

function match(text: string): Record<string, never> | null {
  return containsAnyPhrase(text, TRIGGER_PHRASES) ? {} : null;
}

async function execute(): Promise<ToolResult> {
  return textResult(
    "Yes 😎 Send me the website URL and I'll capture it 📸\nExample: screenshot of https://google.com",
    {},
  );
}

export const screenshotPromptTool: Tool<Record<string, never>> = {
  name: "screenshot_prompt",
  description: "Asks for a URL when the user requests a screenshot but didn't provide one",
  match,
  execute,
};
