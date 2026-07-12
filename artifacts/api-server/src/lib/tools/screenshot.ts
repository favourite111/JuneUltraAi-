import type { Tool, ToolResult } from "./types.js";
import { containsAnyPhrase, extractUrl, imageResult } from "./utils.js";

interface ScreenshotArgs {
  url: string;
}

// Requires BOTH a phrase from this list AND a URL/domain in the message.
// Loose aliases like "snap a screenshot" or "web screenshot" are removed —
// the double gate (phrase + URL) is the real safety net, but keeping the
// phrase list tight avoids matching "I took a screenshot" or similar.
const TRIGGER_PHRASES = [
  "screenshot of",
  "screenshot",
  "take a screenshot",
  "take screenshot",
  "capture screenshot",
  "grab screenshot",
  "screenshoot",   // common typo
] as const;

/**
 * Accepts full URLs (https://...) first; falls back to bare domain patterns
 * like "google.com" and auto-prefixes with https://. Requires a recognisable
 * TLD to keep false-positives low.
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
