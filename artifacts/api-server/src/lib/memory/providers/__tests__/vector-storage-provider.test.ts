/**
 * Phase 3C — VectorStorageProvider contract tests (Milestone 9)
 *
 * The provider receives vectors only. These tests intentionally do not pass
 * text or an EmbeddingProvider to its constructor or methods.
 */

import { describe, expect, it } from "vitest";
import { VectorStorageProvider } from "../vector-storage-provider.js";
import type { MemoryScope } from "../../types.js";

const SCOPE: MemoryScope = {
  tenantId: "tenant",
  botId: "bot",
  userId: "user",
  requestId: "request",
};

const OTHER_SCOPE: MemoryScope = {
  ...SCOPE,
  userId: "other-user",
};

describe("VectorStorageProvider", () => {
  it("stores vectors and returns the closest matches first", async () => {
    const provider = new VectorStorageProvider();

    await provider.upsertVector(SCOPE, "weather", [1, 0], { category: "context" });
    await provider.upsertVector(SCOPE, "pizza", [0, 1], { category: "preference" });

    const results = await provider.searchVectors(SCOPE, [0, 1], { limit: 10 });

    expect(results.map((result) => result.sourceId)).toEqual(["pizza", "weather"]);
    expect(results[0]?.metadata).toEqual({ category: "preference" });
  });

  it("preserves insertion order for equal scores", async () => {
    const provider = new VectorStorageProvider();

    await provider.upsertVector(SCOPE, "first", [1, 0]);
    await provider.upsertVector(SCOPE, "second", [1, 0]);

    const results = await provider.searchVectors(SCOPE, [0, 1], { limit: 10 });

    expect(results.map((result) => result.sourceId)).toEqual(["first", "second"]);
  });

  it("applies thresholds and limits after ranking", async () => {
    const provider = new VectorStorageProvider();

    await provider.upsertVector(SCOPE, "exact", [1, 0]);
    await provider.upsertVector(SCOPE, "orthogonal", [0, 1]);

    const results = await provider.searchVectors(SCOPE, [1, 0], {
      limit: 1,
      similarityThreshold: 0.5,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.sourceId).toBe("exact");
  });

  it("rejects non-finite, empty, and dimension-incompatible vectors", async () => {
    const provider = new VectorStorageProvider();

    await expect(provider.upsertVector(SCOPE, "empty", [])).rejects.toThrow(RangeError);
    await expect(provider.upsertVector(SCOPE, "nan", [Number.NaN])).rejects.toThrow(RangeError);

    await provider.upsertVector(SCOPE, "valid", [1, 0]);
    await expect(provider.upsertVector(SCOPE, "wrong", [1, 0, 0])).rejects.toThrow(
      "Vector dimension mismatch",
    );
    await expect(provider.searchVectors(SCOPE, [1, 0, 0], { limit: 10 })).rejects.toThrow(
      "Query vector dimension mismatch",
    );
  });

  it("isolates vectors by tenant, bot, and user scope", async () => {
    const provider = new VectorStorageProvider();

    await provider.upsertVector(SCOPE, "private", [1, 0]);

    expect(await provider.searchVectors(OTHER_SCOPE, [1, 0], { limit: 10 })).toEqual([]);
    expect(await provider.searchVectors(SCOPE, [1, 0], { limit: 10 })).toHaveLength(1);
  });

  it("upserts by source ID and deletes individual vectors or a whole scope", async () => {
    const provider = new VectorStorageProvider();

    await provider.upsertVector(SCOPE, "record", [1, 0], { version: 1 });
    await provider.upsertVector(SCOPE, "record", [0, 1], { version: 2 });
    await provider.upsertVector(SCOPE, "other", [1, 0]);

    expect(provider.listIndexSize(SCOPE)).toBe(2);
    expect(provider.totalIndexSize()).toBe(2);
    expect((await provider.searchVectors(SCOPE, [0, 1], { limit: 10 }))[0]?.metadata).toEqual({
      version: 2,
    });

    await provider.deleteVector(SCOPE, "record");
    expect(provider.listIndexSize(SCOPE)).toBe(1);

    await provider.deleteScope(SCOPE);
    expect(provider.totalIndexSize()).toBe(0);
  });
});