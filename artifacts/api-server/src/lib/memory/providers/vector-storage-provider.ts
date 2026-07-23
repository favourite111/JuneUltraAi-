/**
 * Phase 3C — VectorStorageProvider (Milestone 9)
 *
 * This provider stores and searches already-generated vectors.
 * It deliberately has no EmbeddingProvider dependency and accepts no text.
 *
 * KnowledgeManager owns text preparation and embedding orchestration. This
 * provider owns vector packaging, dimension compatibility, indexing, scoring,
 * metadata retention, and deletion.
 */

import type { MemoryScope } from "../types.js";

export type VectorMetadata = Readonly<Record<string, unknown>>;

/**
 * Maintenance view of one vector entry in a scope-isolated derived index.
 * The vector values themselves are intentionally omitted from inspection.
 */
export interface VectorIndexEntry {
  /** Authoritative KnowledgeRecord.key represented by this vector. */
  readonly sourceId: string;
  /** Number of dimensions in the stored vector. */
  readonly dimensions: number;
  /** Lifecycle and source-compatibility metadata retained by the index. */
  readonly metadata: VectorMetadata;
}

export interface VectorSearchOptions {
  readonly limit: number;
  readonly similarityThreshold?: number;
}

export interface VectorSearchResult {
  readonly sourceId: string;
  readonly score: number;
  readonly metadata: VectorMetadata;
}

/**
 * Vector persistence/search contract consumed by KnowledgeManager.
 *
 * The sourceId and metadata are domain-facing inputs. The concrete provider
 * decides how to package them into namespaces, partitions, indexes, or rows.
 */
export interface VectorStorageProviderContract {
  upsertVector(
    scope: MemoryScope,
    sourceId: string,
    vector: readonly number[],
    metadata?: VectorMetadata,
  ): Promise<void>;

  searchVectors(
    scope: MemoryScope,
    queryVector: readonly number[],
    options: VectorSearchOptions,
  ): Promise<readonly VectorSearchResult[]>;

  deleteVector(scope: MemoryScope, sourceId: string): Promise<void>;

  deleteScope(scope: MemoryScope): Promise<void>;

  /**
   * Optional maintenance capability. Retrieval does not depend on it.
   * Implementations that support reconciliation return only entries in scope.
   */
  listVectors?(scope: MemoryScope): Promise<readonly VectorIndexEntry[]>;
}

interface StoredVector {
  readonly sourceId: string;
  readonly vector: readonly number[];
  readonly metadata: VectorMetadata;
}

function encodeScope(scope: Pick<MemoryScope, "tenantId" | "botId" | "userId">): string {
  return `${scope.tenantId}:${scope.botId}:${scope.userId}`;
}

function isFiniteVector(vector: readonly number[]): boolean {
  return vector.length > 0 && vector.every((value) => Number.isFinite(value));
}

function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;

  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let index = 0; index < a.length; index += 1) {
    const aValue = a[index]!;
    const bValue = b[index]!;
    dot += aValue * bValue;
    aNorm += aValue * aValue;
    bNorm += bValue * bValue;
  }

  if (aNorm === 0 || bNorm === 0) return 0;
  return dot / Math.sqrt(aNorm * bNorm);
}

export class VectorStorageProvider implements VectorStorageProviderContract {
  private readonly vectors = new Map<string, Map<string, StoredVector>>();
  private readonly dimensionsByScope = new Map<string, number>();

  async upsertVector(
    scope: MemoryScope,
    sourceId: string,
    vector: readonly number[],
    metadata: VectorMetadata = {},
  ): Promise<void> {
    this.validateVector(vector);

    const scopeKey = encodeScope(scope);
    const existingDimensions = this.dimensionsByScope.get(scopeKey);
    if (existingDimensions !== undefined && existingDimensions !== vector.length) {
      throw new RangeError(
        `Vector dimension mismatch for scope ${scopeKey}: expected ${existingDimensions}, received ${vector.length}`,
      );
    }

    this.dimensionsByScope.set(scopeKey, vector.length);
    const index = this.vectors.get(scopeKey) ?? new Map<string, StoredVector>();
    index.set(sourceId, {
      sourceId,
      vector: [...vector],
      metadata: { ...metadata },
    });
    this.vectors.set(scopeKey, index);
  }

  async searchVectors(
    scope: MemoryScope,
    queryVector: readonly number[],
    options: VectorSearchOptions,
  ): Promise<readonly VectorSearchResult[]> {
    this.validateVector(queryVector);

    const scopeKey = encodeScope(scope);
    const expectedDimensions = this.dimensionsByScope.get(scopeKey);
    if (expectedDimensions !== undefined && expectedDimensions !== queryVector.length) {
      throw new RangeError(
        `Query vector dimension mismatch for scope ${scopeKey}: expected ${expectedDimensions}, received ${queryVector.length}`,
      );
    }

    const threshold = options.similarityThreshold ?? -1;
    return [...(this.vectors.get(scopeKey)?.values() ?? [])]
      .map((stored, insertionIndex) => ({
        sourceId: stored.sourceId,
        score: cosineSimilarity(queryVector, stored.vector),
        metadata: stored.metadata,
        insertionIndex,
      }))
      .filter((result) => result.score >= threshold)
      .sort((left, right) => {
        const scoreDifference = right.score - left.score;
        return scoreDifference !== 0
          ? scoreDifference
          : left.insertionIndex - right.insertionIndex;
      })
      .slice(0, options.limit)
      .map(({ sourceId, score, metadata }) => ({ sourceId, score, metadata }));
  }

  async deleteVector(scope: MemoryScope, sourceId: string): Promise<void> {
    const scopeKey = encodeScope(scope);
    const index = this.vectors.get(scopeKey);
    index?.delete(sourceId);
    if (index?.size === 0) {
      this.vectors.delete(scopeKey);
      this.dimensionsByScope.delete(scopeKey);
    }
  }

  async deleteScope(scope: MemoryScope): Promise<void> {
    const scopeKey = encodeScope(scope);
    this.vectors.delete(scopeKey);
    this.dimensionsByScope.delete(scopeKey);
  }

  async listVectors(scope: MemoryScope): Promise<readonly VectorIndexEntry[]> {
    return [...(this.vectors.get(encodeScope(scope))?.values() ?? [])].map(
      ({ sourceId, vector, metadata }) => ({
        sourceId,
        dimensions: vector.length,
        metadata,
      }),
    );
  }

  listIndexSize(scope: MemoryScope): number {
    return this.vectors.get(encodeScope(scope))?.size ?? 0;
  }

  totalIndexSize(): number {
    let total = 0;
    for (const index of this.vectors.values()) total += index.size;
    return total;
  }

  private validateVector(vector: readonly number[]): void {
    if (!isFiniteVector(vector)) {
      throw new RangeError("Vectors must contain at least one finite numeric value");
    }
  }
}