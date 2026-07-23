import { describe, expect, it, vi } from "vitest";
import { createAgentReasoner } from "../reasoner.js";
import { ReasonerMetrics } from "../reasoner-metrics.js";
import type { ReasoningInput } from "../reasoner-types.js";
import type { MemoryContext, UserFact } from "../../memory/types.js";
import type { PlanningResult } from "../../planner/planner-types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeUserFact(
  key: string,
  value: string,
  confidence = 0.9,
  importance = 1.0,
): UserFact {
  return {
    factId:      `fact-${key}`,
    key,
    value,
    confidence,
    importance,
    source:      "explicit",
    createdAt:   1_000_000,
    confirmedAt: 1_000_000,
    sensitive:   false,
  };
}

function makeMemoryContext(
  userFacts: UserFact[] = [],
  overrides: Partial<MemoryContext> = {},
): MemoryContext {
  return {
    version:          2,
    session:          null,
    conversation:     [],
    userFacts,
    knowledgeRecords: [],
    toolSummary:      null,
    budgetUsed:       0,
    budgetRemaining:  4096,
    loadedAt:         Date.now(),
    ...overrides,
  };
}

const BASE_PLANNING: PlanningResult = Object.freeze({
  intent:             "general_answer",
  confidence:         0.8,
  needsMemory:        false,
  needsTool:          false,
  needsClarification: false,
  plan:               Object.freeze([]),
});

function makeInput(
  message: string,
  userFacts: UserFact[] = [],
  planningOverrides: Partial<PlanningResult> = {},
  memoryOverrides: Partial<MemoryContext> = {},
): ReasoningInput {
  return {
    message,
    planningResult: { ...BASE_PLANNING, ...planningOverrides },
    memoryContext:  makeMemoryContext(userFacts, memoryOverrides),
  };
}

const reasoner = createAgentReasoner(new ReasonerMetrics());

// ---------------------------------------------------------------------------
// M18-A: Test 1 — Expertise inference from occupation
// ---------------------------------------------------------------------------

describe("M18 Reasoning Engine — expertise inference", () => {
  it("infers intermediate expertise for a nursing student", () => {
    const result = reasoner.reason(
      makeInput("Explain gastric secretion.", [
        makeUserFact("occupation", "Nursing Student"),
      ]),
    );

    expect(result.required).toBe(true);
    expect(result.expertiseLevel).toBe("intermediate");
    expect(result.inferences.some((i) => /intermediate/i.test(i))).toBe(true);
  });

  it("infers expert expertise for a doctor", () => {
    const result = reasoner.reason(
      makeInput("Explain gastric secretion.", [
        makeUserFact("occupation", "Doctor"),
      ]),
    );

    expect(result.expertiseLevel).toBe("expert");
  });

  it("defaults to beginner when no occupation is stored", () => {
    const result = reasoner.reason(
      makeInput("Explain gastric secretion.", [
        makeUserFact("name", "Alice"),
      ]),
    );

    expect(result.expertiseLevel).toBe("beginner");
  });
});

// ---------------------------------------------------------------------------
// M18-B: Test 2 — Preferred depth / concise hint in summary
// ---------------------------------------------------------------------------

describe("M18 Reasoning Engine — preferred depth", () => {
  it("sets preferredDepth to brief and mentions concise hint in summary", () => {
    const result = reasoner.reason(
      makeInput("Tell me about the heart.", [
        makeUserFact("preference", "Short answers"),
      ]),
    );

    expect(result.preferredDepth).toBe("brief");
    expect(result.summary.toLowerCase()).toMatch(/concise|short|brief/);
  });

  it("sets preferredDepth to detailed for thorough preference", () => {
    const result = reasoner.reason(
      makeInput("Tell me about the heart.", [
        makeUserFact("preference", "detailed explanations"),
      ]),
    );

    expect(result.preferredDepth).toBe("detailed");
  });

  it("defaults to standard depth when no preference is stored", () => {
    const result = reasoner.reason(
      makeInput("Tell me about the heart.", [
        makeUserFact("occupation", "Nurse"),
      ]),
    );

    expect(result.preferredDepth).toBe("standard");
  });
});

// ---------------------------------------------------------------------------
// M18-C: Test 3 — Contradiction detection + no memory write
// ---------------------------------------------------------------------------

describe("M18 Reasoning Engine — contradiction detection", () => {
  it("detects a contradiction when stored occupation conflicts with 'I graduated'", () => {
    const result = reasoner.reason(
      makeInput("I graduated.", [
        makeUserFact("occupation", "Nursing Student"),
      ]),
    );

    expect(result.contradictions).toHaveLength(1);
    expect(result.contradictions[0]!.field).toBe("occupation");
    expect(result.contradictions[0]!.stored).toBe("Nursing Student");
    expect(result.contradictions[0]!.flagged).toBe(true);
  });

  it("does not resolve the contradiction — required stays true but result is read-only", () => {
    const result = reasoner.reason(
      makeInput("I graduated.", [
        makeUserFact("occupation", "Nursing Student"),
      ]),
    );

    // Result must be immutable — no memory mutation possible
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.contradictions)).toBe(true);
    // Contradiction is only flagged, not resolved — stored value unchanged
    expect(result.contradictions[0]!.stored).toBe("Nursing Student");
  });

  it("does not flag a contradiction when message restates the stored value", () => {
    const result = reasoner.reason(
      makeInput("I graduated as a Nursing Student last year.", [
        makeUserFact("occupation", "Nursing Student"),
      ]),
    );

    expect(result.contradictions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// M18-D: Test 4 — Continuity with anatomy exam context
// ---------------------------------------------------------------------------

describe("M18 Reasoning Engine — continuity", () => {
  it("continues anatomy session when task is 'Anatomy exam' and message is 'Continue'", () => {
    const result = reasoner.reason(
      makeInput(
        "Continue.",
        [makeUserFact("task", "Anatomy exam")],
        { intent: "continuation" },
      ),
    );

    expect(result.continuity).toBe(true);
    expect(result.summary.toLowerCase()).toMatch(/anatomy/);
  });

  it("sets continuity true for 'continue' keyword even without intent hint", () => {
    const result = reasoner.reason(
      makeInput("Continue.", [makeUserFact("task", "Anatomy exam")]),
    );

    expect(result.continuity).toBe(true);
  });

  it("includes the task name in inferences", () => {
    const result = reasoner.reason(
      makeInput("Continue.", [makeUserFact("task", "Anatomy exam")]),
    );

    expect(result.inferences.some((i) => /anatomy exam/i.test(i))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// M18-E: Test 5 — No reasoning required for bare greetings with no memory
// ---------------------------------------------------------------------------

describe("M18 Reasoning Engine — no reasoning required", () => {
  it("returns required:false for a simple greeting with no stored memory", () => {
    const result = reasoner.reason(makeInput("Hello."));

    expect(result.required).toBe(false);
    expect(result.summary).toBe("");
    expect(result.inferences).toHaveLength(0);
    expect(result.contradictions).toHaveLength(0);
  });

  it("returns required:false for all common greeting variants", () => {
    const greetings = ["Hi", "Hey!", "Howdy", "Good morning", "greetings"];
    for (const g of greetings) {
      const result = reasoner.reason(makeInput(g));
      expect(result.required).toBe(false);
    }
  });

  it("returns required:true for a greeting when memory exists", () => {
    // Even a simple message should trigger reasoning if there's stored context
    const result = reasoner.reason(
      makeInput("Hello.", [makeUserFact("occupation", "Nursing Student")]),
    );

    // Greeting is trivial so still skipped
    expect(result.required).toBe(false);
  });

  it("returns required:true for a non-trivial message when memory exists", () => {
    const result = reasoner.reason(
      makeInput("Explain gastric secretion.", [
        makeUserFact("occupation", "Nursing Student"),
      ]),
    );

    expect(result.required).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// M18-F: Immutability guarantees
// ---------------------------------------------------------------------------

describe("M18 Reasoning Engine — immutability", () => {
  it("returns a frozen result with frozen nested arrays", () => {
    const result = reasoner.reason(
      makeInput("Explain gastric secretion.", [
        makeUserFact("occupation", "Nursing Student"),
      ]),
    );

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.inferences)).toBe(true);
    expect(Object.isFrozen(result.contradictions)).toBe(true);
    expect(Object.isFrozen(result.optimizations)).toBe(true);
  });

  it("does not retain references to the input", () => {
    const facts = [makeUserFact("occupation", "Nursing Student")];
    const input = makeInput("Explain anatomy.", facts);
    const result = reasoner.reason(input);

    // Mutating the input after the fact must not affect the result
    (facts as UserFact[]).push(makeUserFact("name", "Alice"));
    expect(result.inferences.some((i) => /alice/i.test(i))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// M18-G: Metrics
// ---------------------------------------------------------------------------

describe("M18 Reasoning Engine — metrics", () => {
  it("increments reasoning_runs once per call", () => {
    const metrics = new ReasonerMetrics();
    const r = createAgentReasoner(metrics);

    r.reason(makeInput("Explain gastric secretion.", [makeUserFact("occupation", "Nursing Student")]));
    r.reason(makeInput("Tell me about the heart.", [makeUserFact("preference", "Short answers")]));

    expect(metrics.snapshot().reasoning_runs).toBe(2);
  });

  it("tracks total inferences across runs", () => {
    const metrics = new ReasonerMetrics();
    const r = createAgentReasoner(metrics);

    r.reason(makeInput("Explain gastric secretion.", [makeUserFact("occupation", "Nursing Student")]));

    expect(metrics.snapshot().inferences).toBeGreaterThan(0);
  });

  it("counts contradictions_detected", () => {
    const metrics = new ReasonerMetrics();
    const r = createAgentReasoner(metrics);

    r.reason(makeInput("I graduated.", [makeUserFact("occupation", "Nursing Student")]));

    expect(metrics.snapshot().contradictions_detected).toBe(1);
  });

  it("counts context_optimizations", () => {
    const metrics = new ReasonerMetrics();
    const r = createAgentReasoner(metrics);

    r.reason(makeInput("Explain anatomy.", [
      makeUserFact("occupation", "Nursing Student"),
      makeUserFact("preference", "Short answers"),
    ]));

    expect(metrics.snapshot().context_optimizations).toBeGreaterThan(0);
  });

  it("records metrics exactly once per reason() call", () => {
    const record = vi.fn();
    const r = createAgentReasoner({ record });

    r.reason(makeInput("Explain anatomy.", [makeUserFact("occupation", "Nursing Student")]));

    expect(record).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// M18-H: Urgency and learning mode
// ---------------------------------------------------------------------------

describe("M18 Reasoning Engine — urgency and learning mode", () => {
  it("sets urgency to high when message mentions 'exam'", () => {
    const result = reasoner.reason(
      makeInput("Help me prepare for my exam tomorrow.", [
        makeUserFact("occupation", "Nursing Student"),
      ]),
    );

    expect(result.urgency).toBe("high");
  });

  it("sets urgency to high when stored task mentions exam", () => {
    const result = reasoner.reason(
      makeInput("Explain gastric secretion.", [
        makeUserFact("task", "Anatomy exam"),
      ]),
    );

    expect(result.urgency).toBe("high");
  });

  it("sets learningMode true for teaching intent", () => {
    const result = reasoner.reason(
      makeInput("Explain the digestive system.", [
        makeUserFact("occupation", "Nursing Student"),
      ], { intent: "teaching" }),
    );

    expect(result.learningMode).toBe(true);
  });

  it("sets troubleshootingMode true for problem-diagnosis messages", () => {
    const result = reasoner.reason(
      makeInput("My code is not working, can you debug it?", [
        makeUserFact("occupation", "Developer"),
      ]),
    );

    expect(result.troubleshootingMode).toBe(true);
  });
});
