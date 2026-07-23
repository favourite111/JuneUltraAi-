import { describe, it, expect, vi } from "vitest";
import { DefaultMemoryManager } from "../memory-manager.js";
import { StoragePruner } from "../storage-pruner.js";
import { InMemoryStorageProvider } from "../providers/in-memory-storage-provider.js";
import { type MemoryScope, type ContextBudget, DEFAULT_CONTEXT_BUDGET } from "../types.js";

const SCOPE: MemoryScope = {
  tenantId: "t1",
  botId: "b1",
  userId: "u1",
  sessionId: "s1",
  requestId: "r1",
};

const BUDGET: ContextBudget = DEFAULT_CONTEXT_BUDGET;

describe("Milestone 15 Stability Fixes (v1.15.1)", () => {
  describe("Session Persistence & Restart", () => {
    it("should restore session data from provider", async () => {
      const provider = new InMemoryStorageProvider();
      const manager = new DefaultMemoryManager(provider);
      
      // 1. Save session data
      await manager.record(SCOPE, {
        session: {
          userMood: "stressed",
          currentTask: "Preparing anatomy exam"
        } as any
      });
      
      // 2. Simulate "restart" by creating a new manager with the same provider
      const newManager = new DefaultMemoryManager(provider);
      const ctx = await newManager.load(SCOPE, BUDGET);
      
      expect(ctx.session).toBeDefined();
      expect(ctx.session?.userMood).toBe("stressed");
      expect((ctx.session as any).currentTask).toBe("Preparing anatomy exam");
    });
  });

  describe("Tool Execution Persistence", () => {
    it("should persist and reload tool executions", async () => {
      const provider = new InMemoryStorageProvider();
      const manager = new DefaultMemoryManager(provider);
      
      const toolRecord = {
        executionId: "exec-1",
        requestId: "req-1",
        toolName: "calculator",
        toolVersion: "1.0.0",
        args: { query: "2+2" },
        result: { answer: 4 },
        success: true,
        reflectionDecision: "useful",
        durationMs: 100,
        timestamp: Date.now()
      };
      
      await manager.record(SCOPE, {
        toolOutputs: [toolRecord]
      });
      
      const ctx = await manager.load(SCOPE, BUDGET);
      expect(ctx.toolSummary).toContain("calculator");
    });
  });

  describe("Scheduler & Pruner (M15-F1)", () => {
    it("should prune expired records and preserve active ones", async () => {
      const provider = new InMemoryStorageProvider();
      const pruner = new StoragePruner(provider, { sessionTtlMs: 1000 });
      
      const now = Date.now();
      const oldTime = now - 5000; // Expired
      const freshTime = now;      // Active
      
      // 1. Expired session
      await provider.write({ tier: "session", ...SCOPE, qualifier: "expired" }, { lastActivityAt: oldTime });
      // 2. Active session
      await provider.write({ tier: "session", ...SCOPE, qualifier: "active" }, { lastActivityAt: freshTime });
      
      const result = await pruner.runPruneAll(now);
      expect(result.sessionsRemoved).toBe(1);
      
      expect(await provider.read({ tier: "session", ...SCOPE, qualifier: "expired" })).toBeNull();
      expect(await provider.read({ tier: "session", ...SCOPE, qualifier: "active" })).not.toBeNull();
    });
  });

  describe("StoragePruner Global Sweep (M15-F4)", () => {
    it("should discover and prune multiple scopes", async () => {
      const provider = new InMemoryStorageProvider();
      const pruner = new StoragePruner(provider, { sessionTtlMs: 100 });
      
      const scope1: MemoryScope = { ...SCOPE, userId: "u1", sessionId: "s1" };
      const scope2: MemoryScope = { ...SCOPE, userId: "u2", sessionId: "s2" };
      
      // Create expired sessions
      const oldTime = Date.now() - 1000;
      await provider.write({ tier: "session", ...scope1, qualifier: "s1" }, { lastActivityAt: oldTime });
      await provider.write({ tier: "session", ...scope2, qualifier: "s2" }, { lastActivityAt: oldTime });
      
      // Verify they exist
      expect(await provider.listActiveScopes()).toHaveLength(2);
      
      // Run global prune
      const result = await pruner.runPruneAll();
      
      expect(result.scopeCount).toBe(2);
      expect(result.sessionsRemoved).toBe(2);
      
      // Verify sessions are gone
      expect(await provider.read({ tier: "session", ...scope1, qualifier: "s1" })).toBeNull();
      expect(await provider.read({ tier: "session", ...scope2, qualifier: "s2" })).toBeNull();
    });
  });
});
