import type { Tool, ToolResult } from "./types.js";
import { containsAnyPhrase, extractUrl, imageResult } from "./utils.js";

interface ScreenshotArgs {
  url: string;
}

// Requires a phrase from this list AND a URL (or bare domain) in the message,
// so "screenshot" alone (no target) falls through to AI instead of erroring.
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
  "screenshoot",   // common typo
] as const;

/**
 * Accepts full URLs (https://...) first; falls back to bare domain patterns
 * like "google.com" and auto-prefixes with https://. Keeps false-positives
 * low by requiring at least one recognisable TLD.
 */
const BARE_DOMAIN_RE =
  /\b(?:[a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?\.)+(?:com|org|net|io|co|app|dev|ai|me|tv|info|xyz|tech|gov|edu|uk|us|ca|ng|gh|za)\b/i;

function extractTarget(text: string): string | null {
  const full = extractUrl(text);
  if (full) return full;
  const bare = text.match(BARE_DOMAIN_RE);
  return bare ? `https://${bare[0]}` : null;
}

function match(text: string): ScreenshotArgs | null {
  if (!containsAnyPhrase(text, TRIGGER_PHRASES)) return null;

  const url = extractTarget(text);
  if (!url) return null;

  return { url };
}

interface ScreenshotJsonResponse {
  url?: string;
  result?: string;
  data?: { url?: string };
}

async function execute(args: ScreenshotArgs): Promise<ToolResult> {
  const apiUrl = `https://eliteprotech-apis.zone.id/ssweb?url=${encodeURIComponent(args.url)}`;

  const res = await fetch(apiUrl);
  if (!res.ok) {
    throw new Error(`Screenshot API returned status ${res.status}`);
  }

  const contentType = res.headers.get("content-type") ?? "";

  // The upstream API's exact response shape is undocumented -- handle
  // both "returns a hosted URL as JSON" and "returns raw image bytes"
  // so this tool degrades gracefully either way.
  if (contentType.includes("application/json")) {
    const json = (await res.json()) as ScreenshotJsonResponse;
    const screenshotUrl = json.url ?? json.result ?? json.data?.url;

    if (!screenshotUrl) {
      throw new Error("Screenshot API returned an unexpected JSON shape");
    }

    return imageResult(`Here's a screenshot of ${args.url} 📸`, {
      targetUrl: args.url,
      url: screenshotUrl,
    });
  }

  const arrayBuffer = await res.arrayBuffer();
  return imageResult(`Here's a screenshot of ${args.url} 📸`, {
    targetUrl: args.url,
    buffer: Buffer.from(arrayBuffer).toString("base64"),
    mimeType: contentType || "image/png",
  });
}

export const screenshotTool: Tool<ScreenshotArgs> = {
  name: "website_screenshot",
  description: "Captures a screenshot of a website",
  match,
  execute,
};
