import { routeTool, ToolRegistry } from "../tools/registry.js";
import type { PlannerIntent, PlanningInput, PlanningStep } from "./planner-types.js";

export interface RuleMatch {
  readonly intent: PlannerIntent;
  readonly confidence: number;
  readonly needsMemory: boolean;
  readonly needsTool: boolean;
  readonly needsClarification: boolean;
  readonly clarificationQuestion?: string;
  readonly missingInformation?: readonly string[];
  readonly toolName?: string;
  readonly toolArgs?: unknown;
  readonly plan: readonly PlanningStep[];
}

const words = (message: string): string[] =>
  message.toLowerCase().replace(/[^\w\s?]/g, " ").split(/\s+/).filter(Boolean);

function step(action: string, description: string, toolName?: string): PlanningStep {
  return { step: 0, action, description, ...(toolName ? { toolName } : {}) };
}

function renumber(plan: readonly PlanningStep[]): PlanningStep[] {
  return plan.map((item, index) => ({ ...item, step: index + 1 }));
}

function findRegisteredTool(
  message: string,
  availableTools: PlanningInput["availableTools"],
): RuleMatch | null {
  const routed = routeTool(message);
  if (routed) {
    return {
      intent: "tool_use",
      confidence: routed.confidence.score,
      needsMemory: false,
      needsTool: true,
      needsClarification: false,
      toolName: routed.tool.name,
      toolArgs: routed.args,
      plan: [step("use_tool", `Use ${routed.tool.name}.`, routed.tool.name)],
    };
  }

  const normalized = message.toLowerCase();
  const toolName =
    /\b(?:search|look up|find|latest|current news|web)\b/.test(normalized)
      ? "web_search"
      : /\b(?:weather|forecast|temperature)\b/.test(normalized)
        ? "weather"
        : /\b(?:calculate|calculator|what is \d+\s*[+*/-])\b/.test(normalized)
          ? "calculator"
          : null;

  if (!toolName) return null;
  const isAvailable = ToolRegistry.getTool(toolName) !== undefined ||
    availableTools.some((tool) => tool.name === toolName);
  return {
    intent: "tool_use",
    confidence: isAvailable ? 0.96 : 0.84,
    needsMemory: false,
    needsTool: true,
    needsClarification: false,
    toolName,
    plan: [step("use_tool", `Use ${toolName}.`, toolName)],
  };
}

export function planRules(input: PlanningInput): RuleMatch {
  const message = input.message.trim();
  const normalized = message.toLowerCase();

  if (/\bbook (?:me )?(?:a )?flight\b|\bflight\b.*\bbook\b/.test(normalized)) {
    const missing: string[] = [];
    if (!/\bto\s+[a-z][a-z -]{2,}/i.test(message)) missing.push("destination");
    if (!/\b(?:on|for)\s+(?:the\s+)?(?:\w+\s+){0,2}(?:\d{1,2}(?:st|nd|rd|th)?|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(message)) {
      missing.push("date");
    }
    if (missing.length > 0) {
      return {
        intent: "clarification",
        confidence: 0.98,
        needsMemory: false,
        needsTool: false,
        needsClarification: true,
        clarificationQuestion: `I can help book that flight. What is the ${missing.join(" and ")}?`,
        missingInformation: missing,
        plan: [step("clarify", `Ask for the missing ${missing.join(" and ")}.`)],
      };
    }
  }

  const toolMatch = findRegisteredTool(message, input.availableTools);
  if (toolMatch) return toolMatch;

  if (/\b(?:what(?:'s| is) my name|do you remember|what do you know about me|remember me)\b/.test(normalized)) {
    return {
      intent: "memory_recall",
      confidence: 0.98,
      needsMemory: true,
      needsTool: false,
      needsClarification: false,
      plan: [step("recall", "Retrieve relevant user memory before answering.")],
    };
  }

  if (/^\s*(?:continue|go on|keep going|what next|next)\b/.test(normalized)) {
    return {
      intent: "continuation",
      confidence: 0.95,
      needsMemory: true,
      needsTool: false,
      needsClarification: false,
      plan: [step("continue", "Use the current session context to continue.")],
    };
  }

  const hasTeaching = /\b(?:explain|teach|study|learn|anatomy|lesson|understand)\b/.test(normalized);
  const hasQuiz = /\b(?:quiz|test) me\b|\bthen test\b|\bthen quiz\b/.test(normalized);
  if (hasTeaching && hasQuiz) {
    return {
      intent: "teaching",
      confidence: 0.96,
      needsMemory: true,
      needsTool: false,
      needsClarification: false,
      plan: renumber([
        step("teach", "Explain the requested topic."),
        step("quiz", "Quiz the user on the topic."),
      ]),
    };
  }

  if (hasTeaching) {
    return {
      intent: "teaching",
      confidence: 0.92,
      needsMemory: true,
      needsTool: false,
      needsClarification: false,
      plan: [step("teach", "Explain the requested topic at the appropriate level.")],
    };
  }

  if (/\b(?:summari[sz]e|rewrite|rephrase|translate|shorten|convert)\b/.test(normalized)) {
    return {
      intent: "transformation",
      confidence: 0.93,
      needsMemory: false,
      needsTool: false,
      needsClarification: false,
      plan: [step("transform", "Transform the supplied content as requested.")],
    };
  }

  return {
    intent: "general_answer",
    confidence: words(message).length > 1 ? 0.72 : 0.55,
    needsMemory: false,
    needsTool: false,
    needsClarification: false,
    plan: [step("answer", "Answer directly using the available context.")],
  };
}