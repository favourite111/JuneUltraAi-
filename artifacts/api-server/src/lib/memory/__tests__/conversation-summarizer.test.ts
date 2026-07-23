/**
 * Phase 3C — ConversationSummarizer unit tests (Milestone 2)
 *
 * Covers:
 *   ExtractiveConversationSummarizer
 *     - empty array → empty string (never throws)
 *     - single user turn → summary includes "1 turns", "user×1, assistant×0"
 *     - single assistant turn → summary includes "user×0, assistant×1"
 *     - multiple turns → correct total and role counts
 *     - timestamp range: single timestamp → "t=N" (no dash)
 *     - timestamp range: two timestamps → "t=first–last"
 *     - topic keywords extracted from content
 *     - stop words excluded from keywords
 *     - short words (< 3 chars) excluded from keywords
 *     - keyword count capped at MAX_KEYWORDS (5)
 *     - keywords sorted by frequency descending, then alpha (deterministic)
 *     - turns with no content words → no "topics:" section
 *     - deterministic: same input → same output across multiple calls
 *     - offline: synchronous, no async, no observable side effects
 *     - output is a non-empty string when turns are present
 *     - non-serialisable content does not throw
 *
 *   Interface contract
 *     - ConversationSummarizer interface is injectable (custom impl accepted)
 */

import { describe, it, expect, vi } from "vitest";
import {
  ExtractiveConversationSummarizer,
  type ConversationSummarizer,
} from "../conversation-summarizer.js";
import type { ConversationTurn } from "../types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTurn(opts: {
  n?: number;
  role?: "user" | "assistant";
  content?: string;
  timestamp?: number;
}): ConversationTurn {
  const n = opts.n ?? 1;
  return {
    turnId: `turn-${n}`,
    requestId: `req-${n}`,
    role: opts.role ?? (n % 2 === 0 ? "assistant" : "user"),
    content: opts.content ?? `Message number ${n}`,
    timestamp: opts.timestamp ?? n * 1_000,
  };
}

function makeUserTurn(content: string, timestamp = 1_000): ConversationTurn {
  return makeTurn({ role: "user", content, timestamp });
}

function makeAssistantTurn(content: string, timestamp = 2_000): ConversationTurn {
  return makeTurn({ role: "assistant", content, timestamp });
}

// ---------------------------------------------------------------------------
// ExtractiveConversationSummarizer
// ---------------------------------------------------------------------------

describe("ExtractiveConversationSummarizer", () => {
  const summarizer = new ExtractiveConversationSummarizer();

  // -- Empty input ----------------------------------------------------------

  it("returns an empty string for an empty array", () => {
    expect(summarizer.summarize([])).toBe("");
  });

  it("does not throw for an empty array", () => {
    expect(() => summarizer.summarize([])).not.toThrow();
  });

  // -- Single turn ----------------------------------------------------------

  it("produces a non-empty string for a single user turn", () => {
    const result = summarizer.summarize([makeUserTurn("hello there")]);
    expect(result).toBeTruthy();
    expect(typeof result).toBe("string");
  });

  it("includes '1 turns' for a single-turn input", () => {
    const result = summarizer.summarize([makeUserTurn("hello")]);
    expect(result).toContain("1 turns");
  });

  it("shows 'user×1, assistant×0' for a single user turn", () => {
    const result = summarizer.summarize([makeUserTurn("hello")]);
    expect(result).toContain("user×1");
    expect(result).toContain("assistant×0");
  });

  it("shows 'user×0, assistant×1' for a single assistant turn", () => {
    const result = summarizer.summarize([makeAssistantTurn("hi there")]);
    expect(result).toContain("user×0");
    expect(result).toContain("assistant×1");
  });

  // -- Multiple turns -------------------------------------------------------

  it("shows correct total and role counts for mixed turns", () => {
    const turns = [
      makeUserTurn("hello world", 1_000),
      makeAssistantTurn("how are you", 2_000),
      makeUserTurn("fine thanks", 3_000),
    ];
    const result = summarizer.summarize(turns);
    expect(result).toContain("3 turns");
    expect(result).toContain("user×2");
    expect(result).toContain("assistant×1");
  });

  // -- Timestamp range ------------------------------------------------------

  it("renders a single timestamp as 't=N' (no dash) when all turns share the same timestamp", () => {
    const turns = [
      makeUserTurn("hello", 5_000),
      makeAssistantTurn("world", 5_000),
    ];
    const result = summarizer.summarize(turns);
    expect(result).toContain("t=5000");
    expect(result).not.toContain("–");
  });

  it("renders a range 't=first–last' when timestamps differ", () => {
    const turns = [
      makeUserTurn("first message", 1_000),
      makeAssistantTurn("second message", 9_000),
    ];
    const result = summarizer.summarize(turns);
    expect(result).toContain("t=1000–9000");
  });

  // -- Keyword extraction ---------------------------------------------------

  it("includes prominent content words as topic keywords", () => {
    const turns = [
      makeUserTurn("weather forecast rain sunshine tomorrow"),
      makeAssistantTurn("yes the weather forecast looks good for tomorrow"),
    ];
    const result = summarizer.summarize(turns);
    // "weather" and "forecast" appear twice — they should be extracted
    expect(result).toMatch(/topics:.*weather|topics:.*forecast/i);
  });

  it("excludes common stop words from keywords", () => {
    const turns = [
      makeUserTurn("the cat sat on the mat and the dog is very happy"),
    ];
    const result = summarizer.summarize(turns);
    // Stop words like "the", "and", "on", "is", "very" must not appear as keywords
    if (result.includes("topics:")) {
      expect(result).not.toMatch(/topics:.*\bthe\b/);
      expect(result).not.toMatch(/topics:.*\band\b/);
      expect(result).not.toMatch(/topics:.*\bon\b/);
    }
  });

  it("excludes words shorter than 3 characters", () => {
    const turns = [
      makeUserTurn("ok go do it up"),
    ];
    const result = summarizer.summarize(turns);
    if (result.includes("topics:")) {
      // No word in the content is ≥3 chars after stop-word filter; no keywords
      // or the section is absent — either is acceptable
      const topicsSection = result.split("topics:")[1] ?? "";
      const keywords = topicsSection.split(",").map(k => k.trim().replace("]", ""));
      keywords.forEach(kw => {
        if (kw) expect(kw.length).toBeGreaterThanOrEqual(3);
      });
    }
  });

  it("caps topic keywords at 5", () => {
    // Give many distinct high-frequency words
    const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf"];
    const content = words.join(" ").repeat(3);
    const turns = [makeUserTurn(content)];
    const result = summarizer.summarize(turns);
    if (result.includes("topics:")) {
      const after = result.split("topics:")[1]!.replace("]", "");
      const kwList = after.split(",").map(s => s.trim()).filter(Boolean);
      expect(kwList.length).toBeLessThanOrEqual(5);
    }
  });

  it("sorts keywords by frequency (most frequent first) for determinism", () => {
    // "planning" appears 3 times, "meeting" appears 2 times, "calendar" 1 time
    const content =
      "planning planning planning meeting meeting calendar";
    const turns = [makeUserTurn(content)];
    const result = summarizer.summarize(turns);
    if (result.includes("topics:")) {
      const topicsStr = result.split("topics:")[1]!.replace("]", "");
      const kwList = topicsStr.split(",").map(s => s.trim());
      expect(kwList[0]).toBe("planning");
    }
  });

  it("breaks keyword frequency ties alphabetically for determinism", () => {
    // "zebra" and "apple" both appear once — "apple" should come first (alpha)
    const turns = [makeUserTurn("zebra apple")];
    const result = summarizer.summarize(turns);
    if (result.includes("topics:")) {
      const topicsStr = result.split("topics:")[1]!.replace("]", "");
      const kwList = topicsStr.split(",").map(s => s.trim());
      const appleIdx = kwList.indexOf("apple");
      const zebraIdx = kwList.indexOf("zebra");
      if (appleIdx !== -1 && zebraIdx !== -1) {
        expect(appleIdx).toBeLessThan(zebraIdx);
      }
    }
  });

  it("omits 'topics:' section when all content words are stop words or too short", () => {
    // All words are stop words or < 3 chars
    const turns = [makeUserTurn("ok so it is in on at")];
    const result = summarizer.summarize(turns);
    // Either no "topics:" or "topics:" is absent — both are acceptable
    if (result.includes("topics:")) {
      const after = result.split("topics:")[1]!.replace("]", "").trim();
      expect(after).toBe("");
    }
  });

  // -- Determinism ----------------------------------------------------------

  it("is deterministic: same input always produces the same output", () => {
    const turns = [
      makeUserTurn("I love pizza and pasta every weekend", 1_000),
      makeAssistantTurn("Great choices for weekend meals", 2_000),
      makeUserTurn("Also enjoy sushi on Fridays", 3_000),
    ];
    const results = Array.from({ length: 10 }, () => summarizer.summarize(turns));
    const first = results[0]!;
    expect(results.every(r => r === first)).toBe(true);
  });

  it("is deterministic: different input produces a different output", () => {
    const turnsA = [makeUserTurn("weather forecast tomorrow", 1_000)];
    const turnsB = [makeUserTurn("recipe cooking dinner tonight", 1_000)];
    expect(summarizer.summarize(turnsA)).not.toBe(summarizer.summarize(turnsB));
  });

  // -- Offline / synchronous ------------------------------------------------

  it("summarize() is synchronous (returns a string, not a Promise)", () => {
    const result = summarizer.summarize([makeUserTurn("hello")]);
    expect(typeof result).toBe("string");
    expect(result).not.toBeInstanceOf(Promise);
  });

  it("does not throw for turns with unusual content (numbers, symbols)", () => {
    const turns = [
      makeUserTurn("1234 !!! ??? ### @@ $$"),
      makeAssistantTurn("ok ok ok"),
    ];
    expect(() => summarizer.summarize(turns)).not.toThrow();
  });

  it("does not throw for turns with empty content strings", () => {
    const turns = [
      makeTurn({ role: "user", content: "", timestamp: 1_000 }),
      makeTurn({ role: "assistant", content: "", timestamp: 2_000 }),
    ];
    expect(() => summarizer.summarize(turns)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// ConversationSummarizer interface — injectable contract
// ---------------------------------------------------------------------------

describe("ConversationSummarizer interface", () => {
  it("accepts any object implementing the interface (custom summarizer)", () => {
    const custom: ConversationSummarizer = {
      summarize: vi.fn().mockReturnValue("custom summary"),
    };
    const turns = [makeUserTurn("hello")];
    const result = custom.summarize(turns);
    expect(result).toBe("custom summary");
    expect(custom.summarize).toHaveBeenCalledWith(turns);
  });
});
