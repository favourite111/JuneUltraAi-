/**
 * M15-A: Session Analyzer
 *
 * Deterministic, pattern-based inference of temporary session states.
 * This component focuses on mood, conversation stage, current task,
 * and temporary tone adjustments.
 *
 * Designed to be fast, offline, and free of LLM costs.
 */

import { type SessionMemory } from "./types.js";

export interface SessionInference {
  userMood?: string;
  conversationStage?: string;
  currentTask?: string;
  activeTopics?: string[];
  temporaryToneAdjustment?: string;
}

/**
 * Patterns for inferring user mood.
 */
const MOOD_PATTERNS: Array<{ mood: string; patterns: RegExp[] }> = [
  { mood: "stressed", patterns: [/\b(?:stressed|overwhelmed|anxious|worried|exhausted|tired)\b/i, /😭|😩|😫/] },
  { mood: "happy", patterns: [/\b(?:happy|excited|great|awesome|good|wonderful)\b/i, /😊|😀|🎉/] },
  { mood: "confused", patterns: [/\b(?:confused|don't understand|what|how|help)\b/i, /🤔|❓/] },
  { mood: "frustrated", patterns: [/\b(?:frustrated|annoyed|angry|hate|stupid|dumb)\b/i, /😤|😠|😡/] },
];

/**
 * Patterns for inferring conversation stage.
 */
const STAGE_PATTERNS: Array<{ stage: string; patterns: RegExp[] }> = [
  { stage: "greeting", patterns: [/\b(?:hi|hello|hey|good morning|good afternoon|good evening)\b/i] },
  { stage: "learning", patterns: [/\b(?:learn|study|explain|understand|how does|what is)\b/i] },
  { stage: "debugging", patterns: [/\b(?:debug|fix|error|bug|not working|broken)\b/i] },
  { stage: "problem_solving", patterns: [/\b(?:solve|help me with|how do i|need a solution)\b/i] },
  { stage: "closing", patterns: [/\b(?:bye|goodbye|thanks|thank you|done|finished)\b/i] },
];

/**
 * Patterns for inferring current task.
 */
const TASK_PATTERNS: Array<{ task: string; patterns: RegExp[] }> = [
  { task: "Preparing anatomy exam", patterns: [/\banatomy\b.*\bexam\b/i, /\bstudy\b.*\banatomy\b/i] },
  { task: "Debugging bot", patterns: [/\bdebug\b.*\bbot\b/i, /\bfix\b.*\bbot\b/i, /\bbot\b.*\bfix\b/i, /\bbot\b.*\berror\b/i] },
  { task: "Writing documentation", patterns: [/\bwrite\b.*\bdocs\b/i, /\bwriting\b.*\bdocumentation\b/i] },
];

/**
 * Analyzes a message and history to infer session state.
 *
 * @param message Current user message.
 * @param history Recent conversation history (optional).
 * @returns Inferred session attributes.
 */
export function analyzeSession(message: string, _history: readonly unknown[] = []): SessionInference {
  const inference: SessionInference = {};

  // 1. Infer Mood
  for (const { mood, patterns } of MOOD_PATTERNS) {
    if (patterns.some(p => p.test(message))) {
      inference.userMood = mood;
      break;
    }
  }

  // 2. Infer Stage
  for (const { stage, patterns } of STAGE_PATTERNS) {
    if (patterns.some(p => p.test(message))) {
      inference.conversationStage = stage;
      break;
    }
  }

  // 3. Infer Task
  for (const { task, patterns } of TASK_PATTERNS) {
    if (patterns.some(p => p.test(message))) {
      inference.currentTask = task;
      break;
    }
  }

  // 4. Infer Active Topics (simple keyword extraction for now)
  const words = message.toLowerCase().split(/\W+/);
  const potentialTopics = words.filter(w => w.length > 4 && !["about", "there", "their", "would", "could"].includes(w));
  if (potentialTopics.length > 0) {
    inference.activeTopics = potentialTopics.slice(0, 3);
  }

  // 5. Temporary Tone Adjustment
  if (inference.userMood === "stressed" || inference.userMood === "frustrated") {
    inference.temporaryToneAdjustment = "more empathetic";
  } else if (inference.conversationStage === "debugging" || inference.conversationStage === "problem_solving") {
    inference.temporaryToneAdjustment = "more direct and technical";
  }

  return inference;
}
