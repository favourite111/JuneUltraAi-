/**
 * M14-C: Memory Sanity Check
 *
 * Filters out impossible claims, jokes, and handles conflicts with existing memory.
 */

import { type ScoredFact } from "./confidence-scorer.js";
import { type UserFact } from "./types.js";
import { isSensitive } from "./sensitive-data-filter.js";

/**
 * Impossible or highly suspicious values for specific keys.
 */
const IMPOSSIBLE_VALUES: Record<string, RegExp[]> = {
  name: [
    /\bpresident of mars\b/i,
    /\bking of the world\b/i,
    /\bgod\b/i,
    /\balien\b/i,
  ],
  location: [
    /\bmars\b/i,
    /\bjupiter\b/i,
    /\bthe moon\b/i,
    /\bnarnia\b/i,
    /\bhogwarts\b/i,
  ],
};

/**
 * Performs a sanity check on a scored fact.
 *
 * @param fact The scored fact to check.
 * @param existingFacts Current known facts for the user.
 * @returns true if the fact is sane and should be stored, false otherwise.
 */
export function isSaneFact(fact: ScoredFact, existingFacts: Record<string, string> | readonly UserFact[]): boolean {
  const existingMap = Array.isArray(existingFacts)
    ? Object.fromEntries(existingFacts.map(f => [f.key, f.value]))
    : existingFacts;

  // 1. Check for sensitive data (Milestone 15)
  if (isSensitive(fact.key, fact.value, fact.rawSource)) {
    return false;
  }

  // 2. Check for impossible values
  const impossiblePatterns = IMPOSSIBLE_VALUES[fact.key];
  if (impossiblePatterns && impossiblePatterns.some(p => p.test(fact.value))) {
    return false;
  }

  // 2. Check for extreme confidence drops
  // If a fact has very low confidence after scoring, it's likely a joke or ambiguous
  if (fact.confidence < 0.4) {
    return false;
  }

  // 3. Conflict resolution
  const existingValue = existingMap[fact.key];
  if (existingValue) {
    // If the value is identical, it's a confirmation (sane)
    if (existingValue.toLowerCase() === fact.value.toLowerCase()) {
      return true;
    }

    // If it's a different name/identity basics, we might want to be more careful.
    // For now, we allow updates if confidence is high, but we could add a "verification"
    // state here in the future.
    if (fact.key === "name" && fact.confidence < 0.9) {
      return false; // Don't change name unless very confident
    }
  }

  return true;
}
