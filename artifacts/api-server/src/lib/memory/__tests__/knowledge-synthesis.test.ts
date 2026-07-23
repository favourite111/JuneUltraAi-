import { describe, it, expect } from "vitest";
import { extractKnowledge } from "../knowledge-extractor.js";
import { scoreFact } from "../confidence-scorer.js";
import { isSaneFact } from "../memory-sanity-check.js";

describe("M14 Knowledge Synthesis Pipeline", () => {
  describe("Knowledge Extractor", () => {
    it("should extract name", () => {
      const facts = extractKnowledge("My name is Isaac");
      expect(facts).toHaveLength(1);
      expect(facts[0].key).toBe("name");
      expect(facts[0].value).toBe("Isaac");
    });

    it("should extract occupation", () => {
      const facts = extractKnowledge("I work as a software engineer");
      expect(facts).toHaveLength(1);
      expect(facts[0].key).toBe("occupation");
      expect(facts[0].value).toBe("software engineer");
    });

    it("should extract education", () => {
      const facts = extractKnowledge("I am studying nursing at the university");
      expect(facts).toHaveLength(1);
      expect(facts[0].key).toBe("education");
      expect(facts[0].value).toBe("nursing");
    });

    it("should extract location", () => {
      const facts = extractKnowledge("I live in Lagos, Nigeria");
      expect(facts).toHaveLength(1);
      expect(facts[0].key).toBe("location");
      expect(facts[0].value).toBe("Lagos");
    });

    it("should extract relationships", () => {
      const facts = extractKnowledge("My wife's name is Sarah");
      expect(facts).toHaveLength(1);
      expect(facts[0].key).toBe("relationship");
      expect(facts[0].value).toBe("wife: Sarah");
    });

    it("should extract goals", () => {
      const facts = extractKnowledge("I want to learn Japanese");
      expect(facts).toHaveLength(1);
      expect(facts[0].key).toBe("goal");
      expect(facts[0].value).toBe("Japanese");
    });
  });

  describe("Confidence Scorer", () => {
    it("should assign high confidence to direct statements", () => {
      const fact = extractKnowledge("My name is Isaac")[0];
      const scored = scoreFact(fact);
      expect(scored.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it("should penalize confidence for hedging", () => {
      const fact = { key: "name", value: "Isaac", rawSource: "I think my name is Isaac" };
      const scored = scoreFact(fact);
      expect(scored.confidence).toBeLessThan(0.8);
    });

    it("should penalize confidence for emoji pollution", () => {
      const fact = { key: "name", value: "Isaac", rawSource: "My name is Isaac 😂" };
      const scored = scoreFact(fact);
      expect(scored.confidence).toBeLessThan(0.7);
    });
  });

  describe("Memory Sanity Check", () => {
    it("should reject impossible names", () => {
      const fact = { key: "name", value: "President of Mars", confidence: 0.9, rawSource: "I am the President of Mars" };
      expect(isSaneFact(fact as any, {})).toBe(false);
    });

    it("should reject impossible locations", () => {
      const fact = { key: "location", value: "Mars", confidence: 0.9, rawSource: "I live on Mars" };
      expect(isSaneFact(fact as any, {})).toBe(false);
    });

    it("should reject low confidence facts", () => {
      const fact = { key: "name", value: "Isaac", confidence: 0.3, rawSource: "Maybe my name is Isaac 😂" };
      expect(isSaneFact(fact as any, {})).toBe(false);
    });

    it("should reject name changes with low confidence", () => {
      const fact = { key: "name", value: "Jacob", confidence: 0.8, rawSource: "Call me Jacob" };
      expect(isSaneFact(fact as any, { name: "Isaac" })).toBe(false);
    });

    it("should accept name changes with very high confidence", () => {
      const fact = { key: "name", value: "Jacob", confidence: 0.95, rawSource: "My name is Jacob" };
      expect(isSaneFact(fact as any, { name: "Isaac" })).toBe(true);
    });
  });
});
