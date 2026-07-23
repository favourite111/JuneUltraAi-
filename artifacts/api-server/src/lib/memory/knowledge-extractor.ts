/**
 * M14-A: Knowledge Extractor
 *
 * Deterministic, pattern-based extraction of long-term facts from user messages.
 * This is the high-performance "Tier 1" of the Knowledge Synthesis Pipeline.
 *
 * Designed to be fast, offline, and free of LLM costs.
 */

export interface ExtractedFact {
  key: string;
  value: string;
  rawSource: string;
}

/**
 * Patterns for extracting various types of long-term knowledge.
 * Each pattern maps to a specific fact key.
 */
const EXTRACTION_PATTERNS: Array<{
  key: string;
  patterns: RegExp[];
}> = [
  {
    key: "name",
    patterns: [
      /\bmy name is ([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)\b/i,
      /\bcall me ([A-Z][a-z]+)\b/i,
      /\bi go by ([A-Z][a-z]+)\b/i,
    ],
  },
  {
    key: "occupation",
    patterns: [
      /\bi (?:work|am working) as a ([^.!?\n,]{3,30})\b/i,
      /\bi(?:'m| am) a ([^.!?\n,]{3,30})\b/i,
      /\bmy job is ([^.!?\n,]{3,30})\b/i,
    ],
  },
  {
    key: "education",
    patterns: [
      /\bi(?:'m| am) studying ([^.!?\n,]{3,30}?)(?:\s+at\s+.*)?\b/i,
      /\bi(?:'m| am) a ([^.!?\n,]{3,30}) student\b/i,
      /\bmy major is ([^.!?\n,]{3,30})\b/i,
    ],
  },
  {
    key: "location",
    patterns: [
      /\bi(?:'m| am) from ([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)\b/i,
      /\bi live in ([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)\b/i,
      /\bi(?:'m| am) (?:based|living) in ([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)\b/i,
    ],
  },
  {
    key: "relationship",
    patterns: [
      /\bmy (wife|husband|boyfriend|girlfriend|partner)(?:'s name)? is ([A-Z][a-z]+)\b/i,
      /\bi have a (brother|sister|son|daughter) named ([A-Z][a-z]+)\b/i,
    ],
  },
  {
    key: "goal",
    patterns: [
      /\bi(?:'m| am) trying to ([^.!?\n]{5,50})\b/i,
      /\bi want to learn ([^.!?\n]{3,30})\b/i,
      /\bmy goal is to ([^.!?\n]{5,50})\b/i,
    ],
  },
];

/**
 * Extracts facts from a raw message string using deterministic patterns.
 *
 * @param message The raw user message.
 * @returns An array of extracted facts.
 */
export function extractKnowledge(message: string): ExtractedFact[] {
  const extracted: ExtractedFact[] = [];
  const seenKeys = new Set<string>();

  for (const entry of EXTRACTION_PATTERNS) {
    if (seenKeys.has(entry.key)) continue;

    for (const pattern of entry.patterns) {
      const match = message.match(pattern);
      if (match) {
        // For relationships, we might have two capture groups
        const value = match.length > 2 
          ? `${match[1]}: ${match[2]}` 
          : match[1]?.trim();

        if (value && value.length >= 2) {
          extracted.push({
            key: entry.key,
            value: value,
            rawSource: message,
          });
          seenKeys.add(entry.key);
          break; // move to next key
        }
      }
    }
  }

  return extracted;
}
