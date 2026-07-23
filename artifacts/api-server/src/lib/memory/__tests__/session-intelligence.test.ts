import { describe, it, expect } from "vitest";
import { analyzeSession } from "../session-analyzer.js";
import { isSensitive } from "../sensitive-data-filter.js";

describe("Milestone 15: Session Intelligence", () => {
  describe("Session Analyzer", () => {
    it("should infer stressed mood from message", () => {
      const result = analyzeSession("I am so stressed about my anatomy exam 😭");
      expect(result.userMood).toBe("stressed");
      expect(result.currentTask).toBe("Preparing anatomy exam");
      expect(result.temporaryToneAdjustment).toBe("more empathetic");
    });

    it("should infer debugging stage", () => {
      const result = analyzeSession("My bot is not working, help me fix the error");
      expect(result.conversationStage).toBe("debugging");
      expect(result.currentTask).toBe("Debugging bot");
      expect(result.temporaryToneAdjustment).toBe("more direct and technical");
    });

    it("should extract active topics", () => {
      const result = analyzeSession("Let's talk about gastric secretion and digestion");
      expect(result.activeTopics).toContain("gastric");
      expect(result.activeTopics).toContain("secretion");
    });
  });

  describe("Sensitive Data Filter", () => {
    it("should reject API keys", () => {
      expect(isSensitive("key", "sk_live_51P2x...", "My key is sk_live_51P2x...")).toBe(true);
    });

    it("should reject passwords", () => {
      expect(isSensitive("password", "secret123", "My password is secret123")).toBe(true);
    });

    it("should reject potential OTPs in context", () => {
      expect(isSensitive("code", "123456", "Your OTP is 123456")).toBe(true);
    });

    it("should accept non-sensitive facts", () => {
      expect(isSensitive("name", "Isaac", "My name is Isaac")).toBe(false);
    });
  });
});
