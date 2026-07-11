import type { Tool, ToolResult } from "./types.js";
import { containsAnyPhrase, extractUrl, fetchOrThrow, textResult } from "./utils.js";

interface UrlShortenerArgs {
  url: string;
}

// Every alias a user might reasonably use to ask for this tool. Matching
// requires BOTH a phrase from this list AND an actual URL in the message
// (see `match` below) — that combination is what keeps normal
// conversation ("can you shorten your answer?") from false-triggering.
const TRIGGER_PHRASES = [
  "shorten",
  "shrink",
  "trim this link",
  "trim that link",
  "trim url",
  "trim the url",
  "trim the link",
  "make this link shorter",
  "make that link shorter",
  "make it shorter",
  "make this url shorter",
  "compress this link",
  "compress url",
  "compress the link",
  "tinyurl",
  "short url",
  "short link",
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
