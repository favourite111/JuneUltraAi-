/**
 * Phase 3B — InMemoryStorageProvider unit tests (Milestone 6)
 *
 * Covers:
 *   - write + read round-trip (single value)
 *   - append + list round-trip (ordered list)
 *   - upsert + read (as plain object) + list (as value array)
 *   - WriteResult shape (revision, etag, updatedAt)
 *   - Monotonically increasing revisions
 *   - ETags are non-empty strings that change on each write
 *   - TTL expiry (lazily evicted on read)
 *   - ifNotExists guard
 *   - Optimistic concurrency — expectedRevision (success and conflict)
 *   - Optimistic concurrency — expectedEtag (success and conflict)
 *   - WriteConflictError shape
 *   - delete by exact StorageKey
 *   - delete by ScopePrefix (bulk erase)
 *   - list ordering (asc / desc)
 *   - list filtering (before / after timestamps)
 *   - list limit
 *   - read returns null for missing / expired keys
 *   - list returns [] for missing / expired keys
 *   - health() always returns "ok"
 *   - clear() resets state
 *   - Cross-user isolation (different userId same key shape)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryStorageProvider } from "../in-memory-storage-provider.js";
import { WriteConflictError, type StorageKey, type ScopePrefix } from "../../types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const KEY_A: StorageKey = {
  tier: "session",
  tenantId: "t1",
  botId: "b1",
  userId: "u1",
};

const KEY_B: StorageKey = {
  tier: "conversation",
  tenantId: "t1",
  botId: "b1",
  userId: "u1",
};

const KEY_USER2: StorageKey = {
  tier: "session",
  tenantId: "t1",
  botId: "b1",
  userId: "u2",           // different user
};

const SCOPE_U1: ScopePrefix = { tenantId: "t1", botId: "b1", userId: "u1" };

interface Turn {
  turnId: string;
  content: string;
  timestamp: number;
}

interface Fact {
  factId: string;
  key: string;
  value: string;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("InMemoryStorageProvider", () => {
  let provider: InMemoryStorageProvider;

  beforeEach(() => {
    provider = new InMemoryStorageProvider();
  });

  // ─── health ──────────────────────────────────────────────────────────────

  describe("health()", () => {
    it("always returns ok", async () => {
      expect(await provider.health()).toBe("ok");
    });
  });

  // ─── write / read ────────────────────────────────────────────────────────

  describe("write() + read()", () => {
    it("round-trips a plain object", async () => {
      const value = { greeting: "hello", count: 42 };
      await provider.write(KEY_A, value);
      expect(await provider.read(KEY_A)).toEqual(value);
    });

    it("returns null for a key that has never been written", async () => {
      expect(await provider.read(KEY_A)).toBeNull();
    });

    it("overwrites the previous value on a second write", async () => {
      await provider.write(KEY_A, { v: 1 });
      await provider.write(KEY_A, { v: 2 });
      expect(await provider.read<{ v: number }>(KEY_A)).toEqual({ v: 2 });
    });

    it("returns a WriteResult with revision, etag, updatedAt", async () => {
      const result = await provider.write(KEY_A, { x: 1 });
      expect(typeof result.revision).toBe("number");
      expect(typeof result.etag).toBe("string");
      expect(result.etag.length).toBeGreaterThan(0);
      expect(typeof result.updatedAt).toBe("number");
      expect(result.updatedAt).toBeGreaterThan(0);
    });

    it("revision increments on each write", async () => {
      const r1 = await provider.write(KEY_A, { v: 1 });
      const r2 = await provider.write(KEY_A, { v: 2 });
      expect(r2.revision).toBeGreaterThan(r1.revision);
    });

    it("etag changes when the value changes", async () => {
      const r1 = await provider.write(KEY_A, { v: 1 });
      const r2 = await provider.write(KEY_A, { v: 2 });
      expect(r2.etag).not.toBe(r1.etag);
    });

    it("revisions are monotonically increasing across different keys", async () => {
      const r1 = await provider.write(KEY_A, "a");
      const r2 = await provider.write(KEY_B, "b");
      const r3 = await provider.write(KEY_A, "c");
      expect(r1.revision).toBeLessThan(r2.revision);
      expect(r2.revision).toBeLessThan(r3.revision);
    });
  });

  // ─── TTL ─────────────────────────────────────────────────────────────────

  describe("TTL expiry", () => {
    it("returns null when ttlMs is 0 (immediately expired)", async () => {
      await provider.write(KEY_A, { alive: true }, { ttlMs: 0 });
      // With ttlMs: 0, expiresAt === updatedAt; Date.now() >= expiresAt is true
      expect(await provider.read(KEY_A)).toBeNull();
    });

    it("value is readable before TTL expires (large ttlMs)", async () => {
      await provider.write(KEY_A, { alive: true }, { ttlMs: 60_000 });
      expect(await provider.read<{ alive: boolean }>(KEY_A)).toEqual({ alive: true });
    });

    it("list returns [] for an expired list key", async () => {
      await provider.append(KEY_B, { turnId: "t1", content: "hi", timestamp: 1 }, { ttlMs: 0 });
      expect(await provider.list(KEY_B, { limit: 10, order: "asc" })).toEqual([]);
    });

    it("expired entry is lazily evicted (size decreases after read)", async () => {
      await provider.write(KEY_A, { v: 1 }, { ttlMs: 0 });
      expect(provider.size()).toBe(1);
      await provider.read(KEY_A); // triggers lazy eviction
      expect(provider.size()).toBe(0);
    });
  });

  // ─── ifNotExists ─────────────────────────────────────────────────────────

  describe("ifNotExists", () => {
    it("writes when the key is absent", async () => {
      await provider.write(KEY_A, { v: 1 }, { ifNotExists: true });
      expect(await provider.read<{ v: number }>(KEY_A)).toEqual({ v: 1 });
    });

    it("does not overwrite when the key already exists", async () => {
      await provider.write(KEY_A, { v: 1 });
      await provider.write(KEY_A, { v: 99 }, { ifNotExists: true });
      expect(await provider.read<{ v: number }>(KEY_A)).toEqual({ v: 1 });
    });

    it("returns the existing WriteResult without changing revision", async () => {
      const r1 = await provider.write(KEY_A, { v: 1 });
      const r2 = await provider.write(KEY_A, { v: 99 }, { ifNotExists: true });
      expect(r2.revision).toBe(r1.revision);
      expect(r2.etag).toBe(r1.etag);
    });
  });

  // ─── optimistic concurrency ───────────────────────────────────────────────

  describe("optimistic concurrency — expectedRevision", () => {
    it("succeeds when expectedRevision matches stored revision", async () => {
      const r1 = await provider.write(KEY_A, { v: 1 });
      const r2 = await provider.write(KEY_A, { v: 2 }, { expectedRevision: r1.revision });
      expect(await provider.read<{ v: number }>(KEY_A)).toEqual({ v: 2 });
      expect(r2.revision).toBeGreaterThan(r1.revision);
    });

    it("throws WriteConflictError when expectedRevision is wrong", async () => {
      const r1 = await provider.write(KEY_A, { v: 1 });
      await expect(
        provider.write(KEY_A, { v: 2 }, { expectedRevision: r1.revision + 999 }),
      ).rejects.toBeInstanceOf(WriteConflictError);
    });

    it("WriteConflictError contains the correct key, expected, and actual revisions", async () => {
      const r1 = await provider.write(KEY_A, { v: 1 });
      const wrongRevision = r1.revision + 999;
      let caught: WriteConflictError | null = null;
      try {
        await provider.write(KEY_A, { v: 2 }, { expectedRevision: wrongRevision });
      } catch (e) {
        caught = e as WriteConflictError;
      }
      expect(caught).not.toBeNull();
      expect(caught!.expectedRevision).toBe(wrongRevision);
      expect(caught!.actualRevision).toBe(r1.revision);
      expect(caught!.key).toMatchObject({ tier: "session", userId: "u1" });
    });

    it("does not modify the stored value when a conflict is thrown", async () => {
      await provider.write(KEY_A, { v: 1 });
      try {
        await provider.write(KEY_A, { v: 2 }, { expectedRevision: 9999 });
      } catch {
        // expected
      }
      expect(await provider.read<{ v: number }>(KEY_A)).toEqual({ v: 1 });
    });

    it("allows first write with expectedRevision: 0 when no record exists", async () => {
      // Revision 0 is the sentinel for "nothing stored yet"
      const r = await provider.write(KEY_A, { v: 1 }, { expectedRevision: 0 });
      expect(r.revision).toBeGreaterThan(0);
    });
  });

  describe("optimistic concurrency — expectedEtag", () => {
    it("succeeds when expectedEtag matches stored etag", async () => {
      const r1 = await provider.write(KEY_A, { v: 1 });
      await provider.write(KEY_A, { v: 2 }, { expectedEtag: r1.etag });
      expect(await provider.read<{ v: number }>(KEY_A)).toEqual({ v: 2 });
    });

    it("throws WriteConflictError when expectedEtag is wrong", async () => {
      await provider.write(KEY_A, { v: 1 });
      await expect(
        provider.write(KEY_A, { v: 2 }, { expectedEtag: "wrong-etag" }),
      ).rejects.toBeInstanceOf(WriteConflictError);
    });

    it("does not modify the stored value when an etag conflict is thrown", async () => {
      await provider.write(KEY_A, { v: 1 });
      try {
        await provider.write(KEY_A, { v: 2 }, { expectedEtag: "stale" });
      } catch {
        // expected
      }
      expect(await provider.read<{ v: number }>(KEY_A)).toEqual({ v: 1 });
    });
  });

  // ─── append / list ────────────────────────────────────────────────────────

  describe("append() + list()", () => {
    it("appends items in insertion order", async () => {
      await provider.append<Turn>(KEY_B, { turnId: "1", content: "a", timestamp: 100 });
      await provider.append<Turn>(KEY_B, { turnId: "2", content: "b", timestamp: 200 });
      await provider.append<Turn>(KEY_B, { turnId: "3", content: "c", timestamp: 300 });

      const items = await provider.list<Turn>(KEY_B, { limit: 10, order: "asc" });
      expect(items.map((t) => t.turnId)).toEqual(["1", "2", "3"]);
    });

    it("returns [] for a key that has never been appended to", async () => {
      expect(await provider.list(KEY_B, { limit: 10, order: "asc" })).toEqual([]);
    });

    it("respects limit", async () => {
      for (let i = 1; i <= 5; i++) {
        await provider.append<Turn>(KEY_B, { turnId: String(i), content: `msg ${i}`, timestamp: i * 100 });
      }
      const items = await provider.list<Turn>(KEY_B, { limit: 3, order: "asc" });
      expect(items).toHaveLength(3);
    });

    it("returns items in descending order when order: desc", async () => {
      for (let i = 1; i <= 3; i++) {
        await provider.append<Turn>(KEY_B, { turnId: String(i), content: `msg ${i}`, timestamp: i * 100 });
      }
      const items = await provider.list<Turn>(KEY_B, { limit: 10, order: "desc" });
      expect(items.map((t) => t.turnId)).toEqual(["3", "2", "1"]);
    });

    it("filters by after timestamp (exclusive)", async () => {
      await provider.append<Turn>(KEY_B, { turnId: "1", content: "a", timestamp: 100 });
      await provider.append<Turn>(KEY_B, { turnId: "2", content: "b", timestamp: 200 });
      await provider.append<Turn>(KEY_B, { turnId: "3", content: "c", timestamp: 300 });

      const items = await provider.list<Turn>(KEY_B, { limit: 10, order: "asc", after: 100 });
      expect(items.map((t) => t.turnId)).toEqual(["2", "3"]);
    });

    it("filters by before timestamp (exclusive)", async () => {
      await provider.append<Turn>(KEY_B, { turnId: "1", content: "a", timestamp: 100 });
      await provider.append<Turn>(KEY_B, { turnId: "2", content: "b", timestamp: 200 });
      await provider.append<Turn>(KEY_B, { turnId: "3", content: "c", timestamp: 300 });

      const items = await provider.list<Turn>(KEY_B, { limit: 10, order: "asc", before: 300 });
      expect(items.map((t) => t.turnId)).toEqual(["1", "2"]);
    });

    it("filters by both before and after", async () => {
      for (let i = 1; i <= 5; i++) {
        await provider.append<Turn>(KEY_B, { turnId: String(i), content: `m${i}`, timestamp: i * 100 });
      }
      const items = await provider.list<Turn>(KEY_B, { limit: 10, order: "asc", after: 100, before: 500 });
      expect(items.map((t) => t.turnId)).toEqual(["2", "3", "4"]);
    });

    it("passes items without a timestamp field through unfiltered", async () => {
      await provider.append(KEY_B, { id: "x" });
      const items = await provider.list(KEY_B, { limit: 10, order: "asc", after: 9999 });
      expect(items).toHaveLength(1);
    });

    it("append returns a WriteResult", async () => {
      const r = await provider.append<Turn>(KEY_B, { turnId: "1", content: "hi", timestamp: 1 });
      expect(typeof r.revision).toBe("number");
      expect(typeof r.etag).toBe("string");
      expect(typeof r.updatedAt).toBe("number");
    });

    it("append revision increases on each call", async () => {
      const r1 = await provider.append<Turn>(KEY_B, { turnId: "1", content: "a", timestamp: 1 });
      const r2 = await provider.append<Turn>(KEY_B, { turnId: "2", content: "b", timestamp: 2 });
      expect(r2.revision).toBeGreaterThan(r1.revision);
    });

    it("append respects expectedRevision for concurrency", async () => {
      const r1 = await provider.append<Turn>(KEY_B, { turnId: "1", content: "a", timestamp: 1 });
      await expect(
        provider.append<Turn>(KEY_B, { turnId: "2", content: "b", timestamp: 2 }, { expectedRevision: r1.revision + 5 }),
      ).rejects.toBeInstanceOf(WriteConflictError);
    });
  });

  // ─── upsert / read / list ─────────────────────────────────────────────────

  describe("upsert() + read() + list()", () => {
    it("stores a new fact and reads it back as a plain object", async () => {
      await provider.upsert<Fact>(KEY_A, "name", { factId: "f1", key: "name", value: "Isaac" });
      const all = await provider.read<Record<string, Fact>>(KEY_A);
      expect(all).not.toBeNull();
      expect(all!["name"]).toEqual({ factId: "f1", key: "name", value: "Isaac" });
    });

    it("overwrites an existing fact by entryKey", async () => {
      await provider.upsert<Fact>(KEY_A, "name", { factId: "f1", key: "name", value: "Isaac" });
      await provider.upsert<Fact>(KEY_A, "name", { factId: "f1", key: "name", value: "Isaac Updated" });
      const all = await provider.read<Record<string, Fact>>(KEY_A);
      expect(all!["name"].value).toBe("Isaac Updated");
    });

    it("accumulates multiple distinct fact keys", async () => {
      await provider.upsert<Fact>(KEY_A, "name", { factId: "f1", key: "name", value: "Isaac" });
      await provider.upsert<Fact>(KEY_A, "city", { factId: "f2", key: "city", value: "Lagos" });
      const all = await provider.read<Record<string, Fact>>(KEY_A);
      expect(Object.keys(all!)).toHaveLength(2);
    });

    it("list() returns map values as an array", async () => {
      await provider.upsert<Fact>(KEY_A, "name", { factId: "f1", key: "name", value: "Isaac" });
      await provider.upsert<Fact>(KEY_A, "city", { factId: "f2", key: "city", value: "Lagos" });
      const items = await provider.list<Fact>(KEY_A, { limit: 10, order: "asc" });
      expect(items).toHaveLength(2);
      expect(items.map((f) => f.key).sort()).toEqual(["city", "name"]);
    });

    it("upsert returns a WriteResult", async () => {
      const r = await provider.upsert<Fact>(KEY_A, "name", { factId: "f1", key: "name", value: "Isaac" });
      expect(typeof r.revision).toBe("number");
      expect(typeof r.etag).toBe("string");
      expect(typeof r.updatedAt).toBe("number");
    });

    it("upsert revision increases on each call", async () => {
      const r1 = await provider.upsert<Fact>(KEY_A, "name", { factId: "f1", key: "name", value: "Isaac" });
      const r2 = await provider.upsert<Fact>(KEY_A, "city", { factId: "f2", key: "city", value: "Lagos" });
      expect(r2.revision).toBeGreaterThan(r1.revision);
    });

    it("upsert respects expectedRevision for concurrency", async () => {
      const r1 = await provider.upsert<Fact>(KEY_A, "name", { factId: "f1", key: "name", value: "Isaac" });
      await expect(
        provider.upsert<Fact>(KEY_A, "city", { factId: "f2", key: "city", value: "Lagos" }, { expectedRevision: r1.revision + 99 }),
      ).rejects.toBeInstanceOf(WriteConflictError);
    });
  });

  // ─── delete ───────────────────────────────────────────────────────────────

  describe("delete(StorageKey)", () => {
    it("removes an existing single-value key", async () => {
      await provider.write(KEY_A, { v: 1 });
      await provider.delete(KEY_A);
      expect(await provider.read(KEY_A)).toBeNull();
    });

    it("removes an existing list key", async () => {
      await provider.append(KEY_B, { turnId: "1", content: "hi", timestamp: 1 });
      await provider.delete(KEY_B);
      expect(await provider.list(KEY_B, { limit: 10, order: "asc" })).toEqual([]);
    });

    it("is a no-op for a key that does not exist", async () => {
      await expect(provider.delete(KEY_A)).resolves.toBeUndefined();
    });

    it("does not delete adjacent keys with different qualifiers", async () => {
      const keyQ1: StorageKey = { ...KEY_A, qualifier: "sess-1" };
      const keyQ2: StorageKey = { ...KEY_A, qualifier: "sess-2" };
      await provider.write(keyQ1, { session: 1 });
      await provider.write(keyQ2, { session: 2 });
      await provider.delete(keyQ1);
      expect(await provider.read(keyQ1)).toBeNull();
      expect(await provider.read<{ session: number }>(keyQ2)).toEqual({ session: 2 });
    });
  });

  describe("delete(ScopePrefix)", () => {
    it("removes all keys for the specified user", async () => {
      await provider.write(KEY_A, { session: true });
      await provider.append(KEY_B, { turnId: "1", content: "hi", timestamp: 1 });
      await provider.delete(SCOPE_U1);
      expect(await provider.read(KEY_A)).toBeNull();
      expect(await provider.list(KEY_B, { limit: 10, order: "asc" })).toEqual([]);
    });

    it("leaves other users' data untouched", async () => {
      await provider.write(KEY_A, { session: true });           // u1
      await provider.write(KEY_USER2, { session: true });       // u2
      await provider.delete(SCOPE_U1);
      expect(await provider.read(KEY_A)).toBeNull();            // u1 gone
      expect(await provider.read(KEY_USER2)).not.toBeNull();    // u2 intact
    });

    it("is a no-op when the user has no stored data", async () => {
      await expect(provider.delete(SCOPE_U1)).resolves.toBeUndefined();
    });

    it("reduces store size to zero after bulk delete", async () => {
      await provider.write(KEY_A, { v: 1 });
      await provider.append(KEY_B, { turnId: "1", content: "hi", timestamp: 1 });
      await provider.delete(SCOPE_U1);
      expect(provider.size()).toBe(0);
    });
  });

  // ─── cross-user isolation ─────────────────────────────────────────────────

  describe("cross-user isolation", () => {
    it("same tier + botId but different userId stores separately", async () => {
      await provider.write(KEY_A, { owner: "u1" });
      await provider.write(KEY_USER2, { owner: "u2" });
      expect(await provider.read<{ owner: string }>(KEY_A)).toEqual({ owner: "u1" });
      expect(await provider.read<{ owner: string }>(KEY_USER2)).toEqual({ owner: "u2" });
    });

    it("writing for u2 does not affect u1's revision or etag", async () => {
      const r1 = await provider.write(KEY_A, { v: 1 });
      await provider.write(KEY_USER2, { v: 99 });
      const r2 = await provider.write(KEY_A, { v: 2 }, { expectedRevision: r1.revision });
      expect(await provider.read<{ v: number }>(KEY_A)).toEqual({ v: 2 });
      expect(r2.revision).toBeGreaterThan(r1.revision);
    });
  });

  // ─── clear() / size() / currentRevision() helpers ────────────────────────

  describe("test helpers", () => {
    it("clear() empties the store and resets revision", async () => {
      await provider.write(KEY_A, { v: 1 });
      provider.clear();
      expect(provider.size()).toBe(0);
      expect(provider.currentRevision()).toBe(0);
      expect(await provider.read(KEY_A)).toBeNull();
    });

    it("size() reflects the number of stored records", async () => {
      expect(provider.size()).toBe(0);
      await provider.write(KEY_A, { v: 1 });
      expect(provider.size()).toBe(1);
      await provider.write(KEY_B, { v: 2 });
      expect(provider.size()).toBe(2);
    });

    it("currentRevision() reflects writes across all keys", async () => {
      expect(provider.currentRevision()).toBe(0);
      await provider.write(KEY_A, "a");
      expect(provider.currentRevision()).toBe(1);
      await provider.append(KEY_B, { turnId: "1", content: "x", timestamp: 1 });
      expect(provider.currentRevision()).toBe(2);
    });
  });

  // ─── read on wrong kind ───────────────────────────────────────────────────

  describe("read() on non-single keys", () => {
    it("returns null when the key holds a list (use list() instead)", async () => {
      await provider.append(KEY_B, { turnId: "1", content: "hi", timestamp: 1 });
      expect(await provider.read(KEY_B)).toBeNull();
    });
  });

  describe("list() on a single-value key", () => {
    it("returns [] when the key holds a single value (use read() instead)", async () => {
      await provider.write(KEY_A, { v: 1 });
      expect(await provider.list(KEY_A, { limit: 10, order: "asc" })).toEqual([]);
    });
  });
});
