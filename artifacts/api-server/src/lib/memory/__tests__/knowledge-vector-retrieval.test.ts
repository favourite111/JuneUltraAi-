/**
 * Phase 3C — Embedding/provider orchestration tests (Milestone 9)
 *
 * These tests verify the approved boundaries:
 *   KnowledgeManager -> EmbeddingProvider -> VectorStorageProvider
 *   MemoryManager -> KnowledgeManager
 *
 * StorageProvider remains the authoritative generic knowledge store.
 */

import { describe, expect, it, vi } from "vitest";
import { DefaultMemoryManager } from "../memory-manager.js";
import { KnowledgeManager } from "../knowledge-manager.js";
import { HashingEmbeddingProvider } from "../embedding-provider.js";
import { InMemoryStorageProvider } from "../providers/in-memory-storage-provider.js";
import { VectorStorageProvider } from "../providers/vector-storage-provider.js";
import {
  DEFAULT_CONTEXT_BUDGET,
  type KnowledgeRecord,
  type MemoryScope,
  type StorageProvider,
  type WriteResult,
} from "../types.js";

const SCOPE: MemoryScope = {
  tenantId: "tenant",
  botId: "bot",
  userId: "user",
  sessionId: "session",
  requestId: "request",
};

function makeRecord(
  key: string,
  value: string,
  overrides: Partial<KnowledgeRecord> = {},
): KnowledgeRecord {
  return {
    recordId: `record-${key}`,
    key,
    value,
    category: "context",
    confidence: 0.9,
    importance: 0.8,
    source: "explicit",
    tags: [],
    createdAt: 1_000,
    updatedAt: 1_000,
    version: 1,
    ...overrides,
  };
}

const WRITE_RESULT: WriteResult = {
  revision: 1,
  etag: "etag",
  updatedAt: 1_000,
};

function fakeStorage(): StorageProvider {
  return {
    read: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue([]),
    write: vi.fn().mockResolvedValue(WRITE_RESULT),
    append: vi.fn().mockResolvedValue(WRITE_RESULT),
    upsert: vi.fn().mockResolvedValue(WRITE_RESULT),
    delete: vi.fn().mockResolvedValue(undefined),
    health: vi.fn().mockResolvedValue("ok"),
  };
}

describe("KnowledgeManager provider orchestration", () => {
  it("generates embeddings through injection and stores vectors separately", async () => {
    const storage = new InMemoryStorageProvider();
    const vectorStorage = new VectorStorageProvider();
    const embeddingProvider = new HashingEmbeddingProvider(8);
    const embed = vi.spyOn(embeddingProvider, "embed");
    const manager = new KnowledgeManager(storage, {
      embeddingProvider,
      vectorStorageProvider: vectorStorage,
    });

    await manager.upsert(SCOPE, makeRecord("project", "building a memory system"));

    expect(embed).toHaveBeenCalledWith("project building a memory system");
    expect(vectorStorage.listIndexSize(SCOPE)).toBe(1);
    expect(await manager.loadRelevant(SCOPE, "memory system")).toEqual([
      expect.objectContaining({ key: "project" }),
    ]);
  });

  it("keeps storage authoritative when vector indexing fails", async () => {
    const storage = new InMemoryStorageProvider();
    const vectorStorage = new VectorStorageProvider();
    const embeddingProvider = {
      dimensions: 2,
      embed: vi.fn().mockRejectedValue(new Error("provider unavailable")),
    };
    const manager = new KnowledgeManager(storage, {
      embeddingProvider,
      vectorStorageProvider: vectorStorage,
    });

    await expect(manager.upsert(SCOPE, makeRecord("fact", "stored value"))).rejects.toThrow(
      "provider unavailable",
    );
    expect(await manager.load(SCOPE)).toEqual([
      expect.objectContaining({ key: "fact" }),
    ]);
  });

  it("rejects an embedding whose dimensions do not match the provider contract", async () => {
    const storage = new InMemoryStorageProvider();
    const manager = new KnowledgeManager(storage, {
      embeddingProvider: {
        dimensions: 3,
        embed: vi.fn().mockResolvedValue([1, 0]),
      },
      vectorStorageProvider: new VectorStorageProvider(),
    });

    await expect(manager.upsert(SCOPE, makeRecord("fact", "value"))).rejects.toThrow(
      "Embedding dimension mismatch",
    );
  });

  it("uses vector ranking only through KnowledgeManager", async () => {
    const storage = new InMemoryStorageProvider();
    const vectors = new VectorStorageProvider();
    const embeddingProvider = new HashingEmbeddingProvider(32);
    const manager = new KnowledgeManager(storage, {
      embeddingProvider,
      vectorStorageProvider: vectors,
    });

    await manager.upsert(SCOPE, makeRecord("weather", "rain forecast"));
    await manager.upsert(SCOPE, makeRecord("food", "pizza cooking recipe"));

    const results = await manager.loadRelevant(SCOPE, "pizza cooking", { limit: 1 });
    expect(results).toHaveLength(1);
    expect(results[0]?.key).toBe("food");
  });

  it("removes derived vectors with knowledge records", async () => {
    const storage = new InMemoryStorageProvider();
    const vectors = new VectorStorageProvider();
    const manager = new KnowledgeManager(storage, {
      embeddingProvider: new HashingEmbeddingProvider(8),
      vectorStorageProvider: vectors,
    });

    await manager.upsert(SCOPE, makeRecord("fact", "value"));
    expect(vectors.listIndexSize(SCOPE)).toBe(1);

    await manager.remove(SCOPE, "fact");
    expect(vectors.listIndexSize(SCOPE)).toBe(0);
    expect(await manager.load(SCOPE)).toEqual([]);
  });

  it("falls back to authoritative storage when vectors are missing", async () => {
    const storage = new InMemoryStorageProvider();
    const vectors = new VectorStorageProvider();
    const manager = new KnowledgeManager(storage, {
      embeddingProvider: new HashingEmbeddingProvider(8),
      vectorStorageProvider: vectors,
    });

    await storage.upsert(
      {
        tier: "long_term_knowledge",
        tenantId: SCOPE.tenantId,
        botId: SCOPE.botId,
        userId: SCOPE.userId,
      },
      "legacy",
      makeRecord("legacy", "written before vector indexing"),
    );

    const results = await manager.loadRelevant(SCOPE, "vector query");
    expect(results).toEqual([expect.objectContaining({ key: "legacy" })]);
  });
});

describe("DefaultMemoryManager knowledge boundary", () => {
  it("uses KnowledgeManager for semantic knowledge loading", async () => {
    const storage = new InMemoryStorageProvider();
    const knowledgeManager = new KnowledgeManager(storage, {
      embeddingProvider: new HashingEmbeddingProvider(16),
      vectorStorageProvider: new VectorStorageProvider(),
    });
    const memoryManager = new DefaultMemoryManager(
      storage,
      undefined,
      undefined,
      undefined,
      knowledgeManager,
    );

    await knowledgeManager.upsert(SCOPE, makeRecord("project", "vector architecture"));
    const context = await memoryManager.load(
      { ...SCOPE, queryHint: "vector architecture" },
      DEFAULT_CONTEXT_BUDGET,
    );

    expect(context.knowledgeRecords[0]?.key).toBe("project");
  });

  it("does not pass semantic query text to generic StorageProvider", async () => {
    const storage = fakeStorage();
    const memoryManager = new DefaultMemoryManager(storage);

    await memoryManager.load(
      { ...SCOPE, queryHint: "semantic query" },
      DEFAULT_CONTEXT_BUDGET,
    );

    const knowledgeCall = (storage.list as ReturnType<typeof vi.fn>).mock.calls.find(
      ([key]) => (key as { tier?: string }).tier === "long_term_knowledge",
    );
    expect(knowledgeCall?.[1].similarityQuery).toBeUndefined();
  });

  it("preserves the existing load signature and generic-storage fallback", async () => {
    const storage = new InMemoryStorageProvider();
    const memoryManager = new DefaultMemoryManager(storage);

    await storage.upsert(
      {
        tier: "long_term_knowledge",
        tenantId: SCOPE.tenantId,
        botId: SCOPE.botId,
        userId: SCOPE.userId,
      },
      "priority",
      makeRecord("priority", "stored directly", { importance: 0.99 }),
    );

    const context = await memoryManager.load(SCOPE, DEFAULT_CONTEXT_BUDGET);
    expect(context.knowledgeRecords[0]?.key).toBe("priority");
  });
});