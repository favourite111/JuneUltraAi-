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
import type { VectorStorageProviderContract } from "../providers/vector-storage-provider.js";

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
  it("starts deterministic and semantic retrieval in parallel", async () => {
    let resolveRecords!: (records: KnowledgeRecord[]) => void;
    const recordsReady = new Promise<KnowledgeRecord[]>((resolve) => {
      resolveRecords = resolve;
    });
    const storage = fakeStorage();
    (storage.list as ReturnType<typeof vi.fn>).mockReturnValue(recordsReady);
    const searchVectors = vi.fn().mockResolvedValue([]);
    const embed = vi.fn().mockResolvedValue([1, 0]);
    const manager = new KnowledgeManager(storage, {
      embeddingProvider: { dimensions: 2, embed },
      vectorStorageProvider: {
        upsertVector: vi.fn(),
        searchVectors,
        deleteVector: vi.fn(),
        deleteScope: vi.fn(),
      },
    });

    const retrieval = manager.loadRelevant(SCOPE, "parallel query");
    await Promise.resolve();
    await Promise.resolve();

    // The deterministic branch is waiting on authoritative storage while the
    // semantic branch has already embedded and searched its derived index.
    expect(embed).toHaveBeenCalledWith("parallel query");
    expect(searchVectors).toHaveBeenCalledWith(
      SCOPE,
      [1, 0],
      expect.objectContaining({ limit: 200 }),
    );

    resolveRecords([]);
    await expect(retrieval).resolves.toEqual([]);
  });

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

  it("tracks pending vectors and repairs them without changing authoritative storage", async () => {
    const storage = new InMemoryStorageProvider();
    const vectors = new VectorStorageProvider();
    let shouldFail = true;
    const manager = new KnowledgeManager(storage, {
      embeddingProvider: {
        dimensions: 2,
        providerId: "test-provider",
        modelId: "test-model",
        embed: vi.fn().mockImplementation(async () => {
          if (shouldFail) throw new Error("temporary embedding failure");
          return [1, 0];
        }),
      },
      vectorStorageProvider: vectors,
    });

    await expect(manager.upsert(SCOPE, makeRecord("pending", "authoritative value")))
      .rejects.toThrow("temporary embedding failure");

    const dryRun = await manager.reconcile({ scope: SCOPE, dryRun: true });
    expect(dryRun.pending).toEqual(["pending"]);
    expect(dryRun.repaired).toEqual([]);
    expect(vectors.listIndexSize(SCOPE)).toBe(0);

    shouldFail = false;
    const repaired = await manager.reconcile({ scope: SCOPE, batchSize: 1 });
    expect(repaired.repaired).toEqual(["pending"]);
    expect(await manager.load(SCOPE)).toEqual([
      expect.objectContaining({ key: "pending", value: "authoritative value" }),
    ]);
    expect(vectors.listIndexSize(SCOPE)).toBe(1);
  });

  it("reports and repairs missing, stale, invalid, and orphaned vectors", async () => {
    const storage = new InMemoryStorageProvider();
    const vectors = new VectorStorageProvider();
    const manager = new KnowledgeManager(storage, {
      embeddingProvider: new HashingEmbeddingProvider(2),
      vectorStorageProvider: vectors,
    });
    const storageKey = {
      tier: "long_term_knowledge" as const,
      tenantId: SCOPE.tenantId,
      botId: SCOPE.botId,
      userId: SCOPE.userId,
    };

    await storage.upsert(storageKey, "missing", makeRecord("missing", "missing value"));
    await manager.upsert(SCOPE, makeRecord("stale", "original value"));
    await storage.upsert(storageKey, "stale", makeRecord("stale", "changed value", {
      updatedAt: 999_999,
      version: 2,
    }));
    await storage.upsert(storageKey, "invalid", makeRecord("invalid", "invalid vector"));
    await vectors.upsertVector(SCOPE, "orphan", [1, 0], {
      indexSchemaVersion: 1,
      providerId: "hashing",
      modelId: "feature-hashing",
      dimensions: 2,
      lifecycleState: "indexed",
    });
    await vectors.upsertVector(SCOPE, "invalid", [1, 0], {
      indexSchemaVersion: 99,
      providerId: "old-provider",
      modelId: "old-model",
      dimensions: 2,
      lifecycleState: "indexed",
    });

    const dryRun = await manager.reconcile({ scope: SCOPE, dryRun: true });
    expect(dryRun.missing).toEqual(["missing"]);
    expect(dryRun.stale).toEqual(["stale"]);
    expect(dryRun.invalid).toEqual(["invalid"]);
    expect(dryRun.orphaned).toEqual(["orphan"]);
    expect(dryRun.repaired).toEqual([]);
    expect(dryRun.deleted).toEqual([]);
    expect(vectors.listIndexSize(SCOPE)).toBe(3);

    const repaired = await manager.reconcile({ scope: SCOPE, batchSize: 10 });
    expect(repaired.repaired).toEqual(["missing", "stale", "invalid"]);
    expect(repaired.deleted).toEqual(["orphan"]);
    expect(vectors.listIndexSize(SCOPE)).toBe(3);
    expect(await manager.load(SCOPE)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "missing", value: "missing value" }),
        expect.objectContaining({ key: "stale", value: "changed value", version: 2 }),
      ]),
    );
  });

  it("stores canonical lifecycle metadata and ignores timestamps in fingerprints", async () => {
    const storage = new InMemoryStorageProvider();
    const vectors = new VectorStorageProvider();
    const manager = new KnowledgeManager(storage, {
      nowFn: () => 123_000,
      embeddingProvider: new HashingEmbeddingProvider(2),
      vectorStorageProvider: vectors,
    });
    const record = makeRecord("metadata", "stable content", {
      createdAt: 1,
      updatedAt: 2,
    });

    await manager.upsert(SCOPE, record);
    const indexed = (await vectors.listVectors(SCOPE))[0]!;
    expect(indexed.metadata).toEqual(expect.objectContaining({
      indexSchemaVersion: 1,
      providerId: "hashing",
      modelId: "feature-hashing",
      dimensions: 2,
      lifecycleState: "indexed",
      indexedAt: 123_000,
    }));
    expect(indexed.metadata.contentFingerprint).toMatch(/^[a-f0-9]{64}$/);

    await storage.upsert(
      {
        tier: "long_term_knowledge",
        tenantId: SCOPE.tenantId,
        botId: SCOPE.botId,
        userId: SCOPE.userId,
      },
      "metadata",
      makeRecord("metadata", "stable content", { createdAt: 90, updatedAt: 91 }),
    );
    const report = await manager.reconcile({ scope: SCOPE, dryRun: true });
    expect(report.stale).toEqual([]);
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

    const results = await manager.loadRelevant(SCOPE, "legacy");
    expect(results).toEqual([expect.objectContaining({ key: "legacy" })]);
  });

  it("falls back to deterministic matches when vector search fails", async () => {
    const storage = new InMemoryStorageProvider();
    const manager = new KnowledgeManager(storage, {
      embeddingProvider: {
        dimensions: 2,
        embed: vi.fn().mockResolvedValue([1, 0]),
      },
      vectorStorageProvider: {
        upsertVector: vi.fn(),
        searchVectors: vi.fn().mockRejectedValue(new Error("vector unavailable")),
        deleteVector: vi.fn(),
        deleteScope: vi.fn(),
      },
    });

    await storage.upsert(
      {
        tier: "long_term_knowledge",
        tenantId: SCOPE.tenantId,
        botId: SCOPE.botId,
        userId: SCOPE.userId,
      },
      "exact",
      makeRecord("exact", "exact fallback match"),
    );

    const results = await manager.loadRelevant(SCOPE, "exact");
    expect(results.map((record) => record.key)).toEqual(["exact"]);
  });

  it("runs deterministic and semantic retrieval together, with deterministic results first", async () => {
    const storage = new InMemoryStorageProvider();
    const vectors: VectorStorageProviderContract = {
      upsertVector: vi.fn(),
      searchVectors: vi.fn().mockResolvedValue([
        { sourceId: "semantic-only", score: 0.99, metadata: {} },
        { sourceId: "exact-key", score: 0.98, metadata: {} },
      ]),
      deleteVector: vi.fn(),
      deleteScope: vi.fn(),
    };
    const embeddingProvider = {
      dimensions: 2,
      embed: vi.fn().mockResolvedValue([1, 0]),
    };
    const manager = new KnowledgeManager(storage, {
      embeddingProvider,
      vectorStorageProvider: vectors,
    });

    await storage.upsert(
      {
        tier: "long_term_knowledge",
        tenantId: SCOPE.tenantId,
        botId: SCOPE.botId,
        userId: SCOPE.userId,
      },
      "exact-key",
      makeRecord("exact-key", "low importance exact match", { importance: 0.1 }),
    );
    await storage.upsert(
      {
        tier: "long_term_knowledge",
        tenantId: SCOPE.tenantId,
        botId: SCOPE.botId,
        userId: SCOPE.userId,
      },
      "semantic-only",
      makeRecord("semantic-only", "unrelated record", { importance: 0.99 }),
    );

    const results = await manager.loadRelevant(SCOPE, "exact-key");

    expect(results.map((record) => record.key)).toEqual(["exact-key", "semantic-only"]);
    expect(vectors.searchVectors).toHaveBeenCalledWith(
      SCOPE,
      [1, 0],
      expect.objectContaining({ limit: 200 }),
    );
  });

  it("deduplicates records found by both branches and preserves semantic-only order", async () => {
    const storage = new InMemoryStorageProvider();
    const vectors: VectorStorageProviderContract = {
      upsertVector: vi.fn(),
      searchVectors: vi.fn().mockResolvedValue([
        { sourceId: "semantic-b", score: 0.8, metadata: {} },
        { sourceId: "shared", score: 0.7, metadata: {} },
        { sourceId: "semantic-a", score: 0.6, metadata: {} },
      ]),
      deleteVector: vi.fn(),
      deleteScope: vi.fn(),
    };
    const manager = new KnowledgeManager(storage, {
      embeddingProvider: {
        dimensions: 2,
        embed: vi.fn().mockResolvedValue([1, 0]),
      },
      vectorStorageProvider: vectors,
    });

    for (const key of ["shared", "semantic-a", "semantic-b"]) {
      await storage.upsert(
        {
          tier: "long_term_knowledge",
          tenantId: SCOPE.tenantId,
          botId: SCOPE.botId,
          userId: SCOPE.userId,
        },
        key,
        makeRecord(key, key === "shared" ? "shared exact" : "unrelated"),
      );
    }

    const results = await manager.loadRelevant(SCOPE, "shared");

    expect(results.map((record) => record.key)).toEqual([
      "shared",
      "semantic-b",
      "semantic-a",
    ]);
    expect(new Set(results.map((record) => record.key)).size).toBe(results.length);
  });

  it("deduplicates within a scope without crossing tenant, bot, or user boundaries", async () => {
    const storage = new InMemoryStorageProvider();
    const otherScope: MemoryScope = {
      ...SCOPE,
      tenantId: "other-tenant",
      botId: "other-bot",
      userId: "other-user",
    };
    const manager = new KnowledgeManager(storage);
    const key = {
      tier: "long_term_knowledge" as const,
      tenantId: SCOPE.tenantId,
      botId: SCOPE.botId,
      userId: SCOPE.userId,
    };
    const otherKey = {
      ...key,
      tenantId: otherScope.tenantId,
      botId: otherScope.botId,
      userId: otherScope.userId,
    };

    await storage.upsert(key, "same-key", makeRecord("same-key", "tenant one"));
    await storage.upsert(
      otherKey,
      "same-key",
      makeRecord("same-key", "tenant two"),
    );

    const results = await manager.loadRelevant(SCOPE, "same-key");
    const otherResults = await manager.loadRelevant(otherScope, "same-key");

    expect(results.map((record) => record.value)).toEqual(["tenant one"]);
    expect(otherResults.map((record) => record.value)).toEqual(["tenant two"]);
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

  it("preserves KnowledgeManager ordering instead of applying its own ranking", async () => {
    const storage = new InMemoryStorageProvider();
    const vectors = new VectorStorageProvider();
    const knowledgeManager = new KnowledgeManager(storage, {
      embeddingProvider: {
        dimensions: 2,
        embed: vi.fn().mockResolvedValue([1, 0]),
      },
      vectorStorageProvider: vectors,
    });
    const memoryManager = new DefaultMemoryManager(
      storage,
      undefined,
      undefined,
      undefined,
      knowledgeManager,
    );

    await storage.upsert(
      {
        tier: "long_term_knowledge",
        tenantId: SCOPE.tenantId,
        botId: SCOPE.botId,
        userId: SCOPE.userId,
      },
      "exact",
      makeRecord("exact", "exact query", { importance: 0.01 }),
    );
    await storage.upsert(
      {
        tier: "long_term_knowledge",
        tenantId: SCOPE.tenantId,
        botId: SCOPE.botId,
        userId: SCOPE.userId,
      },
      "semantic",
      makeRecord("semantic", "related record", { importance: 0.99 }),
    );
    await vectors.upsertVector(SCOPE, "exact", [0, 1]);
    await vectors.upsertVector(SCOPE, "semantic", [1, 0]);

    const context = await memoryManager.load(
      { ...SCOPE, queryHint: "exact" },
      DEFAULT_CONTEXT_BUDGET,
    );

    expect(context.knowledgeRecords.map((record) => record.key)).toEqual([
      "exact",
      "semantic",
    ]);
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