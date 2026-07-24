import { describe, it, expect } from "vitest";
import { createMemoryPolicy } from "../memory-policy.js";
import type { MemoryCandidate } from "../memory-evolution-types.js";
import type { KnowledgeRecord } from "../../memory/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCandidate(overrides: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return Object.freeze({
    candidateId: "cand-1",
    key: "tool.qrcode.reliable",
    value: "Tool qrcode is reliable.",
    category: "fact",
    confidence: 0.80,
    importance: 0.75,
    source: "reflection",
    sourceExecutionId: "exec-1",
    sourceTool: "qrcode",
    tags: Object.freeze(["tool-reliability", "qrcode"]),
    ...overrides,
  });
}

function makeRecord(key: string, overrides: Partial<KnowledgeRecord> = {}): KnowledgeRecord {
  return Object.freeze({
    recordId: "rec-1",
    key,
    value: "existing value",
    category: "fact",
    confidence: 0.60,
    importance: 0.75,
    source: "inferred",
    tags: Object.freeze([]),
    createdAt: 1000,
    updatedAt: 1000,
    version: 1,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MemoryPolicy (pure decision engine)", () => {
  const policy = createMemoryPolicy();

  // --- No existing record --------------------------------------------------

  describe("no existing record", () => {
    it("promotes high-importance candidates (importance ≥ 0.70)", () => {
      const d = policy.decide(makeCandidate({ importance: 0.75 }), []);
      expect(d.action).toBe("promote");
      expect(d.candidateId).toBe("cand-1");
    });

    it("promotes exactly at the importance boundary (0.70)", () => {
      const d = policy.decide(makeCandidate({ importance: 0.70 }), []);
      expect(d.action).toBe("promote");
    });

    it("ignores low-importance candidates (importance < 0.40)", () => {
      const d = policy.decide(makeCandidate({ importance: 0.30 }), []);
      expect(d.action).toBe("ignore");
    });

    it("ignores exactly below importance boundary (0.39)", () => {
      const d = policy.decide(makeCandidate({ importance: 0.39 }), []);
      expect(d.action).toBe("ignore");
    });

    it("merges moderate-importance candidates (0.40 ≤ importance < 0.70)", () => {
      const d = policy.decide(makeCandidate({ importance: 0.55 }), []);
      expect(d.action).toBe("merge");
    });

    it("merges at exactly 0.40 importance", () => {
      const d = policy.decide(makeCandidate({ importance: 0.40 }), []);
      expect(d.action).toBe("merge");
    });

    it("ignores records not matching the candidate key", () => {
      const existing = [makeRecord("tool.other.something")];
      const d = policy.decide(makeCandidate({ importance: 0.75 }), existing);
      // Existing key doesn't match candidate key → treated as no-existing
      expect(d.action).toBe("promote");
    });
  });

  // --- Existing record found -----------------------------------------------

  describe("existing record found", () => {
    it("ignores when existing confidence is significantly higher (≥ candidate + 0.20)", () => {
      // candidate 0.50, existing 0.80 → diff = 0.30 ≥ 0.20 → ignore
      const existing = [makeRecord("tool.qrcode.reliable", { confidence: 0.80 })];
      const d = policy.decide(makeCandidate({ confidence: 0.50 }), existing);
      expect(d.action).toBe("ignore");
    });

    it("ignores at exactly the advantage boundary (existing = candidate + 0.20)", () => {
      const existing = [makeRecord("tool.qrcode.reliable", { confidence: 0.70 })];
      const d = policy.decide(makeCandidate({ confidence: 0.50 }), existing);
      expect(d.action).toBe("ignore");
    });

    it("replaces when existing confidence ≤ 0.30", () => {
      const existing = [makeRecord("tool.qrcode.reliable", { confidence: 0.25 })];
      const d = policy.decide(makeCandidate({ confidence: 0.70 }), existing);
      expect(d.action).toBe("replace");
    });

    it("replaces at exactly the low-confidence boundary (0.30)", () => {
      const existing = [makeRecord("tool.qrcode.reliable", { confidence: 0.30 })];
      const d = policy.decide(makeCandidate({ confidence: 0.70 }), existing);
      expect(d.action).toBe("replace");
    });

    it("updates when candidate meaningfully improves confidence (> existing + 0.10)", () => {
      // existing 0.55, candidate 0.80 → improvement 0.25 > 0.10 → update
      const existing = [makeRecord("tool.qrcode.reliable", { confidence: 0.55 })];
      const d = policy.decide(makeCandidate({ confidence: 0.80 }), existing);
      expect(d.action).toBe("update");
    });

    it("decays when existing is high-confidence but candidate contradicts it", () => {
      // existing > 0.70, candidate < 0.50 → contradictory → decay
      const existing = [makeRecord("tool.qrcode.reliable", { confidence: 0.80, version: 2 })];
      const d = policy.decide(makeCandidate({ confidence: 0.40 }), existing);
      expect(d.action).toBe("decay");
    });

    it("merges when candidate reinforces existing (no strong signal for other actions)", () => {
      // existing 0.60, candidate 0.65 → small improvement (0.05 < 0.10), not contradictory → merge
      const existing = [makeRecord("tool.qrcode.reliable", { confidence: 0.60 })];
      const d = policy.decide(makeCandidate({ confidence: 0.65 }), existing);
      expect(d.action).toBe("merge");
    });
  });

  // --- Decision shape ------------------------------------------------------

  describe("decision shape", () => {
    it("always returns a decision with candidateId and rationale", () => {
      const d = policy.decide(makeCandidate({ candidateId: "my-id" }), []);
      expect(d.candidateId).toBe("my-id");
      expect(typeof d.rationale).toBe("string");
      expect(d.rationale.length).toBeGreaterThan(0);
    });

    it("returns frozen decision objects", () => {
      const d = policy.decide(makeCandidate(), []);
      expect(Object.isFrozen(d)).toBe(true);
    });
  });

  // --- Pure function verification ------------------------------------------

  describe("purity", () => {
    it("produces the same output for the same inputs", () => {
      const candidate = makeCandidate({ importance: 0.75 });
      const d1 = policy.decide(candidate, []);
      const d2 = policy.decide(candidate, []);
      expect(d1.action).toBe(d2.action);
      expect(d1.candidateId).toBe(d2.candidateId);
    });

    it("does not mutate the existingMemory array", () => {
      const existing = [makeRecord("tool.qrcode.reliable", { confidence: 0.50 })];
      const before = JSON.stringify(existing);
      policy.decide(makeCandidate(), existing);
      expect(JSON.stringify(existing)).toBe(before);
    });
  });
});
