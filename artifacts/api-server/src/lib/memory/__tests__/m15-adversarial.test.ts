import { describe, it, expect } from "vitest";
import { analyzeSession } from "../session-analyzer.js";
import { isSensitive } from "../sensitive-data-filter.js";
import { extractKnowledge } from "../knowledge-extractor.js";
import { isSaneFact } from "../memory-sanity-check.js";
import { scoreFact } from "../confidence-scorer.js";

describe("M15 Adversarial Tests", () => {
  describe("Test 1: Impossible Claims (Mars Test)", () => {
    it("should reject 'I am the president of Mars 😂'", () => {
      const prompt = "I am the president of Mars 😂";
      const rawKnowledge = extractKnowledge(prompt);
      const scored = rawKnowledge.map(scoreFact);
      const sane = scored.filter(fact => isSaneFact(fact, []));
      
      expect(sane.length).toBe(0);
    });
  });

  describe("Test 2: Sensitive Data Leakage", () => {
    it("should never store 'My password is hello123'", () => {
      const prompt = "My password is hello123";
      const rawKnowledge = extractKnowledge(prompt);
      const scored = rawKnowledge.map(scoreFact);
      
      // Filter out sensitive data
      const sane = scored.filter(fact => {
        const sensitive = isSensitive(fact.key, fact.value, fact.rawSource);
        return !sensitive && isSaneFact(fact, []);
      });
      
      expect(sane.length).toBe(0);
    });
  });

  describe("Test 3: Valid Long-term Knowledge", () => {
    it("should accept 'I am studying nursing'", () => {
      const prompt = "I am studying nursing";
      const rawKnowledge = extractKnowledge(prompt);
      const scored = rawKnowledge.map(scoreFact);
      const sane = scored.filter(fact => isSaneFact(fact, []));
      
      expect(sane.length).toBeGreaterThan(0);
      expect(sane[0].key).toBe("education");
      expect(sane[0].value).toBe("nursing");
    });
  });

  describe("Test 4: Session vs Long-term Isolation", () => {
    it("should store 'Today I am stressed' in session only", () => {
      const prompt = "Today I am stressed";
      
      // 1. Check long-term extraction (should be empty)
      const rawKnowledge = extractKnowledge(prompt);
      expect(rawKnowledge.length).toBe(0);
      
      // 2. Check session inference (should have mood)
      const session = analyzeSession(prompt);
      expect(session.userMood).toBe("stressed");
    });
  });

  describe("Test 5: High Confidence Permanent Fact", () => {
    it("should accept 'Remember my name is Isaac' with high confidence", () => {
      const prompt = "Remember my name is Isaac";
      const rawKnowledge = extractKnowledge(prompt);
      const scored = rawKnowledge.map(scoreFact);
      const sane = scored.filter(fact => isSaneFact(fact, []));
      
      expect(sane.length).toBeGreaterThan(0);
      expect(sane[0].key).toBe("name");
      expect(sane[0].value).toBe("Isaac");
      expect(sane[0].confidence).toBeGreaterThanOrEqual(0.9);
    });
  });
});
