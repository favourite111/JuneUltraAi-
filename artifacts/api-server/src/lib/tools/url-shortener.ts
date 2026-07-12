import type { Tool, ToolResult } from "./types.js";
import { containsAnyPhrase, extractUrl, fetchOrThrow, textResult } from "./utils.js";

interface UrlShortenerArgs {
  url: string;
}

// Matching requires BOTH a phrase from this list AND an actual URL in the
// message — that double gate keeps false positives near zero. Loose phrases
// like "make it shorter" or "trim the link" are excluded because they appear
// in ordinary conversation unrelated to URLs.
const TRIGGER_PHRASES = [
  "shorten",
  "shrink",
  "short url",
  "short link",
  "shorten url",
  "shorten link",
  "shorten this url",
  "shorten that url",
  "shorten this link",
  "shorten that link",
  "tinyurl",
] as const;

function match(text: string): UrlShortenerArgs | null {
  if (!containsAnyPhrase(text, TRIGGER_PHRASES)) return null;

  const url = extractUrl(text);
  if (!url) return null;

  return { url };
}

async function execute(args: UrlShortenerArgs): Promise<ToolResult> {
  const apiUrl = `https://tinyurl.com/api-create.php?url=${encodeURIComponent(args.url)}`;

  const res = await fetchOrThrow(apiUrl, "TinyURL API");
  const shortUrl = (await res.text()).trim();
  if (!shortUrl.startsWith("http")) {
    throw new Error(`TinyURL API returned an unexpected response: ${shortUrl}`);
  }

  return textResult(`Here's your short link 😏 ${shortUrl}`, { originalUrl: args.url, shortUrl });
}

export const urlShortenerTool: Tool<UrlShortenerArgs> = {
  name: "url_shortener",
  description: "Shortens a long URL using TinyURL",
  match,
  execute,
};
