import type { UserFact } from "../memory/types.js";
import type {
  ExpertiseLevel,
  ExplanationDepth,
  ReasoningContradiction,
  ReasoningInput,
  ReasoningResult,
  UrgencyLevel,
} from "./reasoner-types.js";

// ---------------------------------------------------------------------------
// M18 — Deterministic reasoning rules
//
// Rules:
//   ✗ No LLM calls
//   ✗ No memory writes
//   ✗ No tool calls
//   ✓ Pure function: same input → same output, always
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return the string value of the first matching fact key (case-insensitive). */
function getFact(facts: readonly UserFact[], ...keys: string[]): string | undefined {
  for (const key of keys) {
    const f = facts.find((fact) => fact.key.toLowerCase() === key.toLowerCase());
    if (f) return f.value;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Expertise inference
// ---------------------------------------------------------------------------

const EXPERT_RE =
  /\b(doctor|physician|surgeon|engineer|developer|programmer|professor|researcher|architect|pharmacist|dentist|lawyer|attorney|scientist)\b/i;

const INTERMEDIATE_RE =
  /\b(nursing student|medical student|law student|engineering student|nursing|nurse|technician|analyst|designer|accountant|therapist|paramedic)\b/i;

function inferExpertise(facts: readonly UserFact[]): ExpertiseLevel {
  const occupation = getFact(facts, "occupation", "job", "profession", "role");
  if (!occupation) return "beginner";
  if (EXPERT_RE.test(occupation)) return "expert";
  if (INTERMEDIATE_RE.test(occupation)) return "intermediate";
  if (/student/i.test(occupation)) return "intermediate";
  return "beginner";
}

// ---------------------------------------------------------------------------
// Explanation depth inference
// ---------------------------------------------------------------------------

const BRIEF_RE    = /\b(short|concise|brief|quick|tldr|tl;dr|simple|succinct)\b/i;
const DETAILED_RE = /\b(detailed|thorough|comprehensive|in[\s-]depth|elaborate|extensive)\b/i;

function inferDepth(facts: readonly UserFact[]): ExplanationDepth {
  const pref = getFact(facts, "preference", "communication_style", "style", "communication");
  if (!pref) return "standard";
  if (BRIEF_RE.test(pref)) return "brief";
  if (DETAILED_RE.test(pref)) return "detailed";
  return "standard";
}

// ---------------------------------------------------------------------------
// Urgency inference
// ---------------------------------------------------------------------------

const HIGH_URGENCY_RE =
  /\b(exam|test|quiz|assessment|deadline|urgent|asap|quickly|right now|immediately)\b/i;

function inferUrgency(facts: readonly UserFact[], message: string): UrgencyLevel {
  if (HIGH_URGENCY_RE.test(message)) return "high";
  const task = getFact(facts, "task", "current_task", "goal", "studying");
  if (task && HIGH_URGENCY_RE.test(task)) return "high";
  return "normal";
}

// ---------------------------------------------------------------------------
// Continuity inference
// ---------------------------------------------------------------------------

const CONTINUATION_RE =
  /\b(continue|more|go on|next|keep going|proceed|carry on|and then|resume)\b/i;

function inferContinuity(message: string, intent: string): boolean {
  return intent === "continuation" || CONTINUATION_RE.test(message);
}

// ---------------------------------------------------------------------------
// Learning mode inference
// ---------------------------------------------------------------------------

const LEARNING_RE =
  /\b(explain|teach|help me understand|how does|what is|what are|define|describe|show me|walk me through|break down)\b/i;

const STUDY_RE = /\b(exam|study|studying|learn|learning|course|class|revision|revise)\b/i;

function inferLearningMode(
  facts: readonly UserFact[],
  message: string,
  intent: string,
): boolean {
  if (intent === "teaching") return true;
  if (LEARNING_RE.test(message)) return true;
  const task = getFact(facts, "task", "current_task", "goal");
  if (task && STUDY_RE.test(task)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Troubleshooting mode inference
// ---------------------------------------------------------------------------

const TROUBLESHOOT_RE =
  /\b(not working|broken|error|issue|problem|fix|debug|failing|crash|bug|exception|wrong|doesn't work|won't work)\b/i;

function inferTroubleshooting(message: string): boolean {
  return TROUBLESHOOT_RE.test(message);
}

// ---------------------------------------------------------------------------
// Contradiction detection
// ---------------------------------------------------------------------------

/**
 * Each entry maps a set of fact keys to a message pattern that would
 * contradict the stored value. When the pattern fires AND a matching fact
 * exists AND the message does not simply repeat the stored value, a
 * contradiction is flagged.
 */
const CONTRADICTION_SIGNALS: ReadonlyArray<{
  readonly factKeys: readonly string[];
  readonly pattern: RegExp;
}> = [
  {
    factKeys: ["occupation", "job", "profession", "role"],
    pattern:
      /\b(i graduated|i finished my (degree|studies|program)|i('m| am) now a|i became|i got my degree|i no longer|i left (school|university|college))\b/i,
  },
  {
    factKeys: ["name"],
    pattern: /\b(my name is|call me|i('m| am) called|i go by)\b/i,
  },
  {
    factKeys: ["age"],
    pattern: /\b(i('m| am) \d+ (years old|yo)|i turned \d+)\b/i,
  },
];

function detectContradictions(
  facts: readonly UserFact[],
  message: string,
): readonly ReasoningContradiction[] {
  const results: ReasoningContradiction[] = [];

  for (const signal of CONTRADICTION_SIGNALS) {
    if (!signal.pattern.test(message)) continue;

    const storedFact = facts.find((f) =>
      signal.factKeys.some((k) => f.key.toLowerCase() === k.toLowerCase()),
    );
    if (!storedFact) continue;

    // Don't flag if the message simply restates the stored value.
    if (message.toLowerCase().includes(storedFact.value.toLowerCase())) continue;

    results.push({
      field:   storedFact.key,
      stored:  storedFact.value,
      claimed: message,
      flagged: true,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Reasoning-required gate
// ---------------------------------------------------------------------------

/** Simple greetings carry no domain context — skip full reasoning. */
const TRIVIAL_RE =
  /^(hi|hello|hey|yo|sup|hiya|howdy|good morning|good afternoon|good evening|greetings)[!.?,\s]*$/i;

function isReasoningRequired(input: ReasoningInput): boolean {
  const { message, memoryContext } = input;

  const hasMemory =
    memoryContext.userFacts.length > 0 ||
    memoryContext.knowledgeRecords.length > 0 ||
    memoryContext.session !== null;

  if (!hasMemory) return false;
  if (TRIVIAL_RE.test(message.trim())) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Summary builder
// ---------------------------------------------------------------------------

function buildSummary(
  inferences: readonly string[],
  contradictions: readonly ReasoningContradiction[],
  optimizations: readonly string[],
): string {
  const lines: string[] = ["Reasoning:"];
  for (const inf of inferences) lines.push(`- ${inf}`);

  if (contradictions.length > 0) {
    lines.push("Contradictions flagged (report only — do not resolve):");
    for (const c of contradictions) {
      lines.push(`- Stored ${c.field}: "${c.stored}" — message claims otherwise.`);
    }
  }

  if (optimizations.length > 0) {
    lines.push("Context optimizations applied:");
    for (const o of optimizations) lines.push(`- ${o}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Null / trivial result (no reasoning required)
// ---------------------------------------------------------------------------

const NULL_RESULT: ReasoningResult = Object.freeze({
  required:            false,
  expertiseLevel:      "beginner" as ExpertiseLevel,
  preferredDepth:      "standard" as ExplanationDepth,
  urgency:             "normal" as UrgencyLevel,
  continuity:          false,
  learningMode:        false,
  troubleshootingMode: false,
  summary:             "",
  inferences:          Object.freeze([]) as readonly string[],
  contradictions:      Object.freeze([]) as readonly ReasoningContradiction[],
  optimizations:       Object.freeze([]) as readonly string[],
});

// ---------------------------------------------------------------------------
// Main rules function — pure, deterministic
// ---------------------------------------------------------------------------

export function reasoningRules(input: ReasoningInput): ReasoningResult {
  if (!isReasoningRequired(input)) return NULL_RESULT;

  const { message, planningResult, memoryContext } = input;
  const facts  = memoryContext.userFacts;
  const intent = planningResult.intent;

  const expertiseLevel      = inferExpertise(facts);
  const preferredDepth      = inferDepth(facts);
  const urgency             = inferUrgency(facts, message);
  const continuity          = inferContinuity(message, intent);
  const learningMode        = inferLearningMode(facts, message, intent);
  const troubleshootingMode = inferTroubleshooting(message);
  const contradictions      = detectContradictions(facts, message);

  // ------------------------------------------------------------------
  // Inferences — build a human-readable list for the prompt summary
  // ------------------------------------------------------------------
  const inferences: string[] = [];

  const occupation = getFact(facts, "occupation", "job", "profession", "role");
  if (occupation) inferences.push(`User is a ${occupation}.`);

  switch (expertiseLevel) {
    case "expert":
      inferences.push("User is an expert — omit introductory definitions.");
      break;
    case "intermediate":
      inferences.push("User has intermediate domain knowledge — use field-appropriate terminology.");
      break;
    default:
      inferences.push("Use accessible language and introductory-level explanations.");
  }

  if (preferredDepth === "brief") {
    inferences.push("User prefers concise responses — keep answers short and direct.");
  } else if (preferredDepth === "detailed") {
    inferences.push("User prefers detailed, thorough explanations.");
  }

  if (urgency === "high") {
    inferences.push("User has an imminent deadline (exam/assessment) — prioritise key points.");
  }

  const task = getFact(facts, "task", "current_task", "goal");
  if (task) inferences.push(`User is currently working on: ${task}.`);

  if (continuity) {
    const topic = getFact(facts, "task", "current_task", "topic");
    if (topic) {
      inferences.push(`Continue the existing session on: ${topic}.`);
    } else {
      inferences.push("Continue the previous session topic.");
    }
  }

  if (learningMode)        inferences.push("User is in learning mode — structure explanations clearly.");
  if (troubleshootingMode) inferences.push("User is troubleshooting — focus on diagnosis and actionable steps.");

  // ------------------------------------------------------------------
  // Context optimizations
  // ------------------------------------------------------------------
  const optimizations: string[] = [];

  if (preferredDepth !== "standard") {
    optimizations.push(`Response depth adjusted to "${preferredDepth}" based on stated preference.`);
  }
  if (expertiseLevel !== "beginner") {
    optimizations.push(`Omitted beginner-level definitions — user expertise is "${expertiseLevel}".`);
  }
  if (urgency === "high") {
    optimizations.push("Prioritised exam-critical content over comprehensive coverage.");
  }

  const summary = buildSummary(inferences, contradictions, optimizations);

  return {
    required: true,
    expertiseLevel,
    preferredDepth,
    urgency,
    continuity,
    learningMode,
    troubleshootingMode,
    summary,
    inferences:     Object.freeze([...inferences]),
    contradictions: Object.freeze([...contradictions]),
    optimizations:  Object.freeze([...optimizations]),
  };
}
