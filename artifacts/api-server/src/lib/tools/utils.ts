/**
 * Shared helpers for tool modules — intent matching, HTTP calls, and
 * result formatting. Keeping these here means each tool file stays
 * focused on its own trigger phrases and business logic instead of
 * re-implementing URL extraction or fetch error handling.
 */
import type { ToolResult } from "./types.js";

const URL_PATTERN = /https?:\/\/\S+/i;

function normalize(text: string): string {
  return text.toLowerCase().trim();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True if any of the given phrases appears in `text` as a whole
 * word/phrase (word-boundary anchored on both ends), so e.g. the phrase
 * "shorten" matches "please shorten this" but not "shortened" or
 * "endorsement". Multi-word phrases like "make this shorter" are
 * matched literally (in order, allowing the surrounding boundaries).
 */
export function containsAnyPhrase(text: string, phrases: readonly string[]): boolean {
  const normalized = normalize(text);
  return phrases.some((phrase) => {
    const pattern = new RegExp(`\\b${escapeRegExp(normalize(phrase))}\\b`, "i");
    return pattern.test(normalized);
  });
}

/** Extracts the first http(s) URL found in `text`, or null if there isn't one. */
export function extractUrl(text: string): string | null {
  const match = text.match(URL_PATTERN);
  return match ? match[0] : null;
}

/** Fetches `url` and throws a descriptive error if the response isn't OK. */
export async function fetchOrThrow(url: string, label: string): Promise<Response> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${label} returned status ${res.status}`);
  }
  return res;
}

export function textResult(reply: string, data: Record<string, unknown> = {}): ToolResult {
  return { type: "text", reply, data };
}

export function imageResult(reply: string, data: Record<string, unknown>): ToolResult {
  return { type: "image", reply, data };
}
