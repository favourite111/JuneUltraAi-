import type { Tool, ToolResult } from "./types.js";
import { containsAnyPhrase, textResult } from "./utils.js";
import { getManifestTools } from "./registry.js";

/**
 * Capabilities tool — answers "what can you do?" and similar questions
 * with the real list of registered tools. Intercepts before the AI so the
 * bot never invents a false "I can't..." denial for a feature it actually has.
 *
 * Placed AFTER all functional tools in the registry so actual tool requests
 * (e.g. "remind me at 6pm") are caught by the right tool first.
 */

const TRIGGER_PHRASES = [
  // Generic capability questions
  "what can you do",
  "what tools do you have",
  "what are your tools",
  "your capabilities",
  "what are your capabilities",
  "what are your features",
  "what features do you have",
  "list your tools",
  "show your tools",
  "show me what you can do",
  "what do you support",
  "do you have tools",
  "do you have any tools",
  // Feature-specific capability questions
  "can you screenshot",
  "can you take screenshots",
  "can you take a screenshot",
  "can you capture screenshots",
  "can you create pdf",
  "can you make pdf",
  "can you make a pdf",
  "can you create a pdf",
  "can you convert to pdf",
  "can you shorten url",
  "can you shorten links",
  "can you shorten a link",
  "can you shorten a url",
  "can you generate qr",
  "can you make qr",
  "can you make a qr",
  "can you generate a qr",
] as const;

function match(text: string): Record<string, never> | null {
  return containsAnyPhrase(text, TRIGGER_PHRASES) ? {} : null;
}

async function execute(): Promise<ToolResult> {
  const manifestTools = getManifestTools();
  
  let reply = "Here's what I can do 😎\n\n";
  
  // Dynamically list tools that have manifests (Phase 2)
  for (const tool of manifestTools) {
    const m = tool.manifest!;
    reply += `*${m.name}* — ${m.description}\n`;
    if (m.examples.length > 0) {
      reply += `  → "${m.examples[0]}"\n`;
    }
    reply += "\n";
  }

  // Fallback for legacy tools not yet refactored
  reply += "🔗 *URL Shortener* — shorten long links\n";
  reply += "  → \"shorten https://yourlink.com\"\n\n";
  reply += "📸 *Website Screenshot* — capture any webpage\n";
  reply += "  → \"screenshot of https://example.com\"\n\n";
  reply += "📄 *Text to PDF* — convert text into a PDF file\n";
  reply += "  → \"convert to pdf: your text here\"\n\n";

  reply += "Just send the right phrase and I'll handle the rest 💪";

  return textResult(reply, {});
}

export const capabilitiesTool: Tool<Record<string, never>> = {
  name: "capabilities",
  description: "Lists all available tools and how to use them",
  match,
  execute,
};
