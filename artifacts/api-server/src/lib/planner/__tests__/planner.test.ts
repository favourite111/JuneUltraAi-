import { describe, expect, it, vi } from "vitest";
import { createAgentPlanner } from "../planner.js";
import { PlannerMetrics } from "../planner-metrics.js";
import type { PlanningInput } from "../planner-types.js";

const baseInput: Omit<PlanningInput, "message"> = {
  sessionContext: null,
  knowledge: [],
  availableTools: [
    { name: "web_search", description: "Search the web." },
    { name: "weather", description: "Get the weather." },
    { name: "calculator", description: "Perform calculations." },
  ],
  runtimeState: {},
};

function plan(message: string) {
  return createAgentPlanner(new PlannerMetrics()).plan({ ...baseInput, message });
}

describe("M17 Agent Planning Engine", () => {
  it("plans memory recall for personal-memory questions", () => {
    const result = plan("What is my name?");

    expect(result.intent).toBe("memory_recall");
    expect(result.confidence).toBeGreaterThan(0.9);
    expect(result.needsMemory).toBe(true);
    expect(result.needsTool).toBe(false);
    expect(result.needsClarification).toBe(false);
  });

  it("plans memory recall for the apostrophe-form name question", () => {
    const result = plan("What's my name?");

    expect(result.intent).toBe("memory_recall");
    expect(result.needsMemory).toBe(true);
    expect(result.needsTool).toBe(false);
    expect(result.needsClarification).toBe(false);
    expect(result.plan.map((item) => item.action)).toEqual(["recall"]);
  });

  it("creates a tool plan for web search requests", () => {
    const result = plan("Search latest Node.js");

    expect(result.intent).toBe("tool_use");
    expect(result.needsTool).toBe(true);
    expect(result.toolName).toBe("web_search");
    expect(result.plan).toHaveLength(1);
  });

  it("asks for missing destination and date instead of hallucinating a flight", () => {
    const result = plan("Book me a flight");

    expect(result.intent).toBe("clarification");
    expect(result.needsClarification).toBe(true);
    expect(result.needsTool).toBe(false);
    expect(result.missingInformation).toEqual(["destination", "date"]);
    expect(result.clarificationQuestion).toContain("destination");
    expect(result.clarificationQuestion).toContain("date");
  });

  it("returns an immutable decision with immutable nested planning data", () => {
    const result = plan("Book me a flight");

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.plan)).toBe(true);
    expect(Object.isFrozen(result.plan[0])).toBe(true);
    expect(Object.isFrozen(result.missingInformation)).toBe(true);
  });

  it("does not mutate or retain references to planning inputs", () => {
    const sessionContext = {
      sessionId: "session-1",
      lastActivityAt: 1,
      userMood: "calm",
      conversationStage: "active",
      personalityTemp: 0,
      questionChainDepth: 0,
      activeTopics: ["anatomy"],
      recentBotPhrases: [],
      greetingDone: true,
    };
    const knowledge = [{ key: "name", value: "Isaac" }];
    const input = {
      ...baseInput,
      message: "What's my name?",
      sessionContext,
      knowledge,
    };
    const result = createAgentPlanner(new PlannerMetrics()).plan(input);

    expect(input.sessionContext).toEqual(sessionContext);
    expect(input.knowledge).toEqual(knowledge);
    expect(result).not.toBe(input);
    expect(result.plan).not.toBe((input as { plan?: unknown }).plan);
  });

  it("selects only the tool plan for mixed search and memory language", () => {
    const result = plan("Search Google and remember my birthday");

    expect(result.intent).toBe("tool_use");
    expect(result.needsTool).toBe(true);
    expect(result.needsMemory).toBe(false);
    expect(result.needsClarification).toBe(false);
    expect(result.plan).toHaveLength(1);
  });

  it("creates a two-step teaching plan for explain-then-quiz requests", () => {
    const result = plan("Explain anatomy then test me");

    expect(result.intent).toBe("teaching");
    expect(result.needsMemory).toBe(true);
    expect(result.plan).toHaveLength(2);
    expect(result.plan.map((step) => step.action)).toEqual(["teach", "quiz"]);
    expect(result.plan.map((step) => step.step)).toEqual([1, 2]);
  });

  it("classifies continuations and transformations without tools", () => {
    expect(plan("Continue").intent).toBe("continuation");
    expect(plan("Summarize this paragraph").intent).toBe("transformation");
    expect(plan("Tell me about the solar system").intent).toBe("general_answer");
  });

  it("is deterministic for the same input", () => {
    const first = plan("Explain anatomy then test me");
    const second = plan("Explain anatomy then test me");

    expect(first).toEqual(second);
  });

  it("aggregates the requested planning metrics", () => {
    const metrics = new PlannerMetrics();
    const planner = createAgentPlanner(metrics);

    planner.plan({ ...baseInput, message: "What is my name?" });
    planner.plan({ ...baseInput, message: "Search latest Node.js" });
    planner.plan({ ...baseInput, message: "Book me a flight" });
    planner.plan({ ...baseInput, message: "Explain anatomy then test me" });

    expect(metrics.snapshot()).toEqual({
      plans_created: 4,
      tool_plans: 1,
      clarification_plans: 1,
      memory_plans: 2,
      average_plan_steps: 1.25,
    });
  });

  it("increments metrics exactly once per planning call", () => {
    const record = vi.fn();
    const planner = createAgentPlanner({ record });

    planner.plan({ ...baseInput, message: "Continue" });

    expect(record).toHaveBeenCalledOnce();
  });
});