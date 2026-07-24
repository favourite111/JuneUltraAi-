import { describe, it, expect, vi } from "vitest";
import { createMemoryReader } from "../memory-reader.js";
import type { MemoryReaderStore } from "../memory-evolution-types.js";
import type { KnowledgeRecord, MemoryScope } from "../../memory/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SCOPE: MemoryScope = {
  tenantId: "t1",
  botId: "b1",
  userId: "u1",
  requestId: "req-1",
};

function makeRecord(key: string, confidence = 0.70): KnowledgeRecord {
  return Object.freeze({
    recordId: `rec-${key}`,
    key,
    value: `value for ${key}`,
    category: "fact",
    confidence,
    importance: 0.75,
    source: "inferred",
    tags: Object.freeze([]),
    createdAt: 1000,
    updatedAt: 1000,
    version: 1,
  });
}

function makeStore(records: KnowledgeRecord[]): MemoryReaderStore {
  return {
    loadRelevant: vi.fn().mockResolvedValue(records),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MemoryReader", () => {
  it("returns a MemoryReaderResult with the records from the store", async () => {
    const records = [makeRecord("preference.verbosity"), makeRecord("goal.deploy_by_q4")];
    const store = makeStore(records);
    const reader = createMemoryReader(store);

    const result = await reader.read(SCOPE, "how do I deploy?");

    expect(result.records).toHaveLength(2);
    expect(result.query).toBe("how do I deploy?");
    expect(result.loadedAt).toBeGreaterThan(0);
  });

  it("calls loadRelevant with scope, query, limit=10, and minConfidence=0.40", async () => {
    const store = makeStore([]);
    const reader = createMemoryReader(store);

    await reader.read(SCOPE, "test query");

    expect(store.loadRelevant).toHaveBeenCalledWith(
      SCOPE,
      "test query",
      { limit: 10, minConfidence: 0.40 },
    );
  });

  it("returns an empty records array when store returns nothing", async () => {
    const store = makeStore([]);
    const reader = createMemoryReader(store);
    const result = await reader.read(SCOPE, "anything");
    expect(result.records).toHaveLength(0);
  });

  it("returns a frozen result object", async () => {
    const store = makeStore([makeRecord("fact.x")]);
    const reader = createMemoryReader(store);
    const result = await reader.read(SCOPE, "q");
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("propagates store errors to the caller (chat.ts handles isolation)", async () => {
    const store: MemoryReaderStore = {
      loadRelevant: vi.fn().mockRejectedValue(new Error("vector error")),
    };
    const reader = createMemoryReader(store);
    await expect(reader.read(SCOPE, "q")).rejects.toThrow("vector error");
  });
});
