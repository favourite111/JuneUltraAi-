/**
 * M14-B: Confidence Scorer
 *
 * Assigns a confidence score to extracted facts based on context and extraction quality.
 */

import { type ExtractedFact } from "./knowledge-extractor.js";

export interface ScoredFact extends ExtractedFact {
  confidence: number;
}

/**
 * Heuristics for confidence modifiers.
 */
const CONFIDENCE_MODIFIERS = {
  DIRECT_STATEMENT: 0.95,
  INFERRED_STATEMENT: 0.70,
  HAS_EMOJI_POLLUTION: -0.30,
  HAS_HEDGING: -0.20,
};

/**
 * Hedging words that indicate uncertainty.
 */
const HEDGING_WORDS = [
  "think", "maybe", "probably", "possibly", "guess", "perhaps", "might"
];

/**
 * Emojis that might indicate non-serious statements.
 */
const POLLUTION_EMOJIS = ["😂", "🤣", "🤡", "🤥", "😜", "🤪", "👻"];

/**
 * Scores an extracted fact based on its raw source and context.
 *
 * @param fact The extracted fact.
 * @returns The fact with an assigned confidence score.
 */
export function scoreFact(fact: ExtractedFact): ScoredFact {
  let score = CONFIDENCE_MODIFIERS.DIRECT_STATEMENT;
  const lowerSource = fact.rawSource.toLowerCase();

  // 1. Check for hedging (uncertainty)
  if (HEDGING_WORDS.some(word => lowerSource.includes(word))) {
    score += CONFIDENCE_MODIFIERS.HAS_HEDGING;
  }

  // 2. Check for emoji pollution (non-seriousness)
  if (POLLUTION_EMOJIS.some(emoji => fact.rawSource.includes(emoji))) {
    score += CONFIDENCE_MODIFIERS.HAS_EMOJI_POLLUTION;
  }

  // 3. Length-based adjustment (very short sources might be ambiguous)
  if (fact.rawSource.length < 10) {
    score -= 0.1;
  }

  // Clamp score between 0.1 and 1.0
  score = Math.max(0.1, Math.min(1.0, score));

  return {
    ...fact,
    confidence: score,
  };
}
