import { describe, it, expect, vi } from "vitest";
import { createKnowledgeReader } from "../knowledge-reader.js";
import type { KnowledgeReaderStore } from "../memory-evolution-types.js";
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

function makeRecord(key: string, overrides: Partial<KnowledgeRecord> = {}): KnowledgeRecord {
  return Object.freeze({
    recordId: `rec-${key}`,
    key,
    value: `value for ${key}`,
    category: "fact",
    confidence: 0.70,
    importance: 0.75,
    source: "inferred",
    tags: Object.freeze([]),
    createdAt: 1000,
    updatedAt: 1000,
    version: 1,
    ...overrides,
  });
}

function makeStore(records: KnowledgeRecord[]): KnowledgeReaderStore {
  return {
    load: vi.fn().mockResolvedValue(records),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("KnowledgeReader", () => {
  it("returns an empty array when keys is empty (no store call)", async () => {
    const store = makeStore([makeRecord("tool.qrcode.reliable")]);
    const reader = createKnowledgeReader(store);
    const result = await reader.read(SCOPE, []);
    expect(result).toHaveLength(0);
    expect(store.load).not.toHaveBeenCalled();
  });

  it("returns records matching the requested keys", async () => {
    const store = makeStore([
      makeRecord("tool.qrcode.reliable"),
      makeRecord("tool.qrcode.failure_pattern"),
      makeRecord("tool.pdf.latency_concern"),
    ]);
    const reader = createKnowledgeReader(store);
    const result = await reader.read(SCOPE, ["tool.qrcode.reliable", "tool.pdf.latency_concern"]);
    expect(result).toHaveLength(2);
    const keys = result.map((r) => r.key);
    expect(keys).toContain("tool.qrcode.reliable");
    expect(keys).toContain("tool.pdf.latency_concern");
    expect(keys).not.toContain("tool.qrcode.failure_pattern");
  });

  it("returns [] when no stored records match the requested keys", async () => {
    const store = makeStore([makeRecord("tool.other.thing")]);
    const reader = createKnowledgeReader(store);
    const result = await reader.read(SCOPE, ["tool.qrcode.reliable"]);
    expect(result).toHaveLength(0);
  });

  it("calls store.load with the supplied scope", async () => {
    const store = makeStore([]);
    const reader = createKnowledgeReader(store);
    await reader.read(SCOPE, ["tool.qrcode.reliable"]);
    expect(store.load).toHaveBeenCalledWith(SCOPE, { limit: 200 });
  });

  it("propagates store errors to the caller (engine handles isolation)", async () => {
    const store: KnowledgeReaderStore = {
      load: vi.fn().mockRejectedValue(new Error("DB down")),
    };
    const reader = createKnowledgeReader(store);
    await expect(reader.read(SCOPE, ["tool.x.y"])).rejects.toThrow("DB down");
  });
});
