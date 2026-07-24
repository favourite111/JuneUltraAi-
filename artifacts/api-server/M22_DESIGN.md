# M22 — Execution Observer Layer
## Design Document (pre-implementation, audit-driven)

---

## 0. Checkpoint Declaration

> **Before any M22 code is written, the following must be true:**
> - `git status` is clean on `main`
> - `v2.5-foundation` and `v2.5-tool-learning` exist on remote ✅ (confirmed below)
> - All 694 existing tests pass, `tsc --noEmit` is clean ✅ (confirmed below)
> - This design document has been reviewed and approved
>
> **Do not modify any source file until this document is approved.**

---

## 1. Audit Summary — M19 → M21 State

### 1.1 Remote tags confirmed

| Tag | Commit | Status |
|-----|--------|--------|
| `v2.5-foundation` | `100a6e1` | ✅ on remote |
| `v2.5-tool-learning` | `100a6e1` | ✅ on remote |
| `v2.4-tool-intelligence` | `032760e` | ✅ on remote |
| `v2.3-execution-orchestrator` | `90bfd87` | ✅ on remote |
| `v2.2-reasoning-engine` | `4cfea24` | ✅ on remote |

### 1.2 Baseline health

```
Tests:     694 passing, 34 test files — CLEAN
TypeScript: tsc --noEmit — CLEAN
Branch:    main (HEAD = 100a6e1)
```

### 1.3 Layer inventory (all frozen after M22)

| Module | Location | Status |
|--------|----------|--------|
| M17 Planner | `src/lib/planner/` | ✅ Frozen |
| M18 Reasoner | `src/lib/reasoner/` | ✅ Frozen |
| M19 Orchestrator | `src/lib/orchestrator/` | ✅ Frozen |
| M20 Tool Intelligence | `src/lib/tool-intelligence/` | ✅ Module complete, **NOT wired** |
| M21 Tool Learning | `src/lib/tool-learning/` | ✅ Module complete, **partially wired** |

---

## 2. Gaps Found During Audit

These are the concrete, code-verified problems M22 must fix.
**No assumptions — every gap is traceable to a specific line.**

### Gap 1 — M20 is never called (chat.ts line 21 vs. lines 939–1006)
`toolIntelligenceLayer` is imported in `chat.ts` line 21 but is never called
in `handleChat()`. The `tool_intelligence` metrics in `GET /v1/stats` will
always read zero. M20 was built but never wired into the live request pipeline.

### Gap 2 — M20 singleton has no learning reader (memory-singletons.ts line 173 vs. tool-intelligence.ts line 221)
`toolIntelligenceLayer` singleton is created with `createToolIntelligenceLayer()`
(no arguments). `ToolIntelligenceConfig.learningReader` is undefined, so
`applyLearningAdjustment()` is never reached in `evaluate()`. M21 stats never
feed back to M20 confidence scores — the whole M20↔M21 feedback loop is broken.

### Gap 3 — M21 records corrupted zeros (chat.ts lines 1018–1023, 1063–1068)
Both `toolLearningStore.record()` call sites pass:
```typescript
durationMs:            0,   // "wall-clock not yet exposed at runtime boundary"
confidenceAtSelection: 0,   // "M20 not yet consulted pre-execution in this path"
```
M21's Welford averages for `avgDurationMs` and `avgConfidenceAtSelection` are
permanently poisoned. Historical stats are structurally wrong, not just missing.

### Gap 4 — No owner for post-execution observation (chat.ts lines 1012–1082)
Post-execution recording is scattered fire-and-forget `void` calls inline in
the route handler with no structure, no error boundary, and no metrics on the
recording itself. There is no principled place to add future observation logic.

---

## 3. M22 Goal

> Introduce the **Execution Observer Layer** (`src/lib/observer/`) as the single
> authoritative owner of post-execution observation.
>
> Wire M20 ToolIntelligenceLayer into the live request pipeline.
> Close the M20↔M21 feedback loop with real confidence and timing data.
>
> **No new user-facing features. All changes are additive.**

### Pipeline after M22

```
Request
  → M17 Planner         (intent, tool selection)
  → M18 Reasoner        (advisory context)
  → M20 ToolIntelligence (pre-execution analysis — NOW CALLED)
  → M19 Runtime         (thin adapter → Orchestrator)
  → M19 Orchestrator    (sequential execution)
  → Tool Executors
  → M22 Observer        (post-execution recording — NEW OWNER)
      → M21 ToolLearning (record with real durationMs + confidenceAtSelection)
  → Response
```

### What M22 is NOT

- ❌ Not a retry engine
- ❌ Not a circuit breaker
- ❌ Not an alerting system
- ❌ Not a replacement for any existing module
- ❌ Not a new database client or storage provider
- ❌ Not a change to the public API shape (chat response fields unchanged)

---

## 4. New Module: `src/lib/observer/`

### 4.1 Files to create

```
src/lib/observer/
  observer-types.ts          — ObservationInput, ObservationResult, ObservationScope
  observer-metrics.ts        — ObserverMetrics, observerMetrics singleton
  observation-result.ts      — makeObservationResult() — deepFreeze builder
  execution-observer.ts      — createExecutionObserver(), executionObserver singleton
  index.ts                   — public barrel
  __tests__/
    observer.test.ts         — M22 validation tests
```

### 4.2 Type contracts

```typescript
/** What the Observer receives after execution completes. */
interface ObservationInput {
  readonly scope:               { tenantId: string; botId: string };
  readonly toolName:            string;
  readonly success:             boolean;
  readonly durationMs:          number;           // from ExecutionResult.executionTimeMs
  readonly confidenceAtSelection: number;         // from ToolIntelligenceResult.confidence
  readonly executedAt:          number;           // Date.now() at call site
}

/** What the Observer returns — immutable, deep-frozen. */
interface ObservationResult {
  readonly recorded:            boolean;          // true if M21 record() was called
  readonly durationMs:          number;           // echoed back for logging
  readonly confidenceAtSelection: number;         // echoed back for logging
  readonly storedAt:            number;           // epoch ms when record was dispatched
}
```

### 4.3 Responsibilities

```
ExecutionObserver.observe(input): Promise<ObservationResult>
  1. Validate input fields (toolName non-empty, durationMs >= 0)
  2. Build CompletedToolExecution from input
  3. Call ToolLearningStore.record() (awaited, not fire-and-forget)
  4. Record observerMetrics
  5. Return deep-frozen ObservationResult
```

**Hard boundaries:**
- ✗ Never executes tools
- ✗ Never modifies memory (only calls ToolLearningStore which goes through StorageProvider)
- ✗ Never reads from ToolLearningStore (write-only path — reads belong to M20)
- ✗ Never throws — degrades gracefully on storage failure (same contract as M21 record())
- ✓ Always returns ObservationResult regardless of storage outcome

### 4.4 Singleton

```typescript
// In execution-observer.ts
export const executionObserver = createExecutionObserver({
  store:   toolLearningStore,   // from memory-singletons.ts
  metrics: observerMetrics,
});
```

The singleton is created in `execution-observer.ts` (NOT in `memory-singletons.ts`)
to avoid circular dependencies. `chat.ts` imports `executionObserver` directly.

---

## 5. Files to Modify

All modifications are **additive only**. No existing API shapes, exports,
type signatures, or test contracts are changed.

### 5.1 `src/lib/memory-singletons.ts`
- Add `toolLearningStore` export with `learningReader` wired to `toolLearningStore` itself
  *(already exports `toolLearningStore` — no new symbol needed)*

### 5.2 `src/lib/tool-intelligence/tool-intelligence.ts` (line 221)
**Before:**
```typescript
export const toolIntelligenceLayer = createToolIntelligenceLayer();
```
**After:**
```typescript
import { toolLearningStore } from "../memory-singletons.js";
export const toolIntelligenceLayer = createToolIntelligenceLayer({
  learningReader: toolLearningStore,
});
```
This closes Gap 2. One line change. No type changes.

### 5.3 `src/routes/chat.ts` — three additive changes

**Change A — Call M20 between planning and runtime (fixes Gap 1):**
```typescript
// After reasoning = agentReasoner.reason(...)
const toolIntelResult = planning.needsTool
  ? toolIntelligenceLayer.evaluate({
      toolName:      planning.toolName,
      toolArgs:      planning.toolArgs,
      prompt,
      needsTool:     planning.needsTool,
      learningScope: { tenantId: memoryScope.tenantId, botId: memoryScope.botId },
    })
  : noToolResult();
```

**Change B — Replace ad-hoc M21 calls with Observer (fixes Gaps 3 + 4):**

Remove both inline `void toolLearningStore.record(...)` blocks.
Replace with:
```typescript
// In the "completed" branch:
void executionObserver.observe({
  scope:                 { tenantId: memoryScope.tenantId, botId: memoryScope.botId },
  toolName:              tool.name,
  success:               true,
  durationMs:            runtimeResponse.context.executionTimeMs ?? 0,  // from M19
  confidenceAtSelection: toolIntelResult.confidence,                     // from M20
  executedAt:            Date.now(),
});

// In the "failed" branch:
void executionObserver.observe({
  scope:                 { tenantId: memoryScope.tenantId, botId: memoryScope.botId },
  toolName:              runtimeResponse.tool.name,
  success:               false,
  durationMs:            runtimeResponse.context.executionTimeMs ?? 0,
  confidenceAtSelection: toolIntelResult.confidence,
  executedAt:            Date.now(),
});
```

**Change C — Add `toolIntelResult` to successful tool response (debug field, opt-in):**
```typescript
res.json({
  success:    true,
  handledBy:  "tool",
  tool:       tool.name,
  type:       result.type,
  reply:      result.reply,
  data:       result.data,
  planning,
  tool_intelligence: {          // new debug field — additive, never breaks existing clients
    confidence:         toolIntelResult.confidence,
    fallbacks:          toolIntelResult.fallbackCandidates,
    availability:       toolIntelResult.availability,
    conflicts:          toolIntelResult.conflicts.length,
  },
  conversationKey: convKey,
});
```

### 5.4 `src/routes/stats.ts`
Add `observer` key to the stats response:
```typescript
import { observerMetrics } from "../lib/observer/index.js";
// In the res.json():
observer: observerMetrics.snapshot(),
```

---

## 6. What is Frozen (Cannot Be Changed)

| Module | Frozen Elements |
|--------|----------------|
| M17 Planner | All types, all rules, all exports |
| M18 Reasoner | All types, all inference rules, all exports |
| M19 Orchestrator | All types, execution-orchestrator.ts logic, all exports |
| M20 Tool Intelligence | All types, evaluate() logic, all exports (singleton changes only) |
| M21 Tool Learning | All types, store logic, mergeStats(), all exports |
| Memory subsystem (M9–M16) | Entire `src/lib/memory/` — no changes permitted |

---

## 7. Integration Points

| Point | Direction | Contract |
|-------|-----------|----------|
| M20 → chat.ts | `toolIntelligenceLayer.evaluate()` called pre-execution | Synchronous, read-only, returns `ToolIntelligenceResult` |
| M19 → Observer | `ExecutionResult.executionTimeMs` passed as `durationMs` | Observer reads, never writes to M19 |
| M20 → Observer | `ToolIntelligenceResult.confidence` passed as `confidenceAtSelection` | Observer reads, never writes to M20 |
| Observer → M21 | `toolLearningStore.record()` called post-execution | Async, best-effort, one-way write |
| M21 → M20 singleton | `learningReader: toolLearningStore` in `createToolIntelligenceLayer()` | Sync read in `evaluate()`, N+1 determinism preserved |

---

## 8. Test Plan

### New test file: `src/lib/observer/__tests__/observer.test.ts`

Minimum test groups (mirror M19 and M21 test discipline):

| Group | Cases |
|-------|-------|
| `observe() — success path` | records with correct toolName, success=true, real durationMs, real confidence |
| `observe() — failure path` | records with success=false, error does not throw |
| `observe() — storage failure` | store.record() throws → ObservationResult.recorded=false, no throw |
| `observe() — input validation` | empty toolName → recorded=false; durationMs<0 → clamped to 0 |
| `Immutability` | ObservationResult is deep-frozen |
| `Metrics` | observerMetrics.snapshot() increments correctly per call |
| `Determinism` | does NOT call store.read() or store.getStats() — write-only |

### Regression requirement
All 694 existing tests must continue to pass unchanged.
No existing test file is modified.

---

## 9. Validation Gates (before tagging `v2.6-observer`)

In order:

```bash
# 1. TypeScript
npx tsc --noEmit
# Expected: 0 errors

# 2. All tests
npx vitest run --reporter=verbose
# Expected: all existing 694 + new M22 tests pass

# 3. Production build
node build.mjs
# Expected: clean, no warnings

# 4. Workflow restart
# Restart "artifacts/api-server: API Server"
# Expected: healthy, no port errors

# 5. Push and tag
git add .
git commit -m "feat(m22): execution observer layer — wire M20, close M20↔M21 loop"
git push origin main
git tag v2.6-observer
git push origin v2.6-observer
```

---

## 10. Golden Rules (carried from M21)

1. **No redesign of completed milestones** — M17–M21 modules are frozen.
2. **No breaking existing APIs** — all type exports, response shapes, and test contracts are unchanged.
3. **Changes are additive** — new files, new imports, new optional fields only.
4. **Push checkpoint before major implementation** — commit design doc + empty module scaffold before writing logic.
5. **Run tests before release** — all 694 tests + new M22 tests must pass before tagging.
6. **Tag every milestone** — `v2.6-observer` pushed to remote before declaring M22 complete.

---

## 11. Non-Goals (explicitly excluded from M22)

- No retry logic in Observer
- No circuit-breaker logic
- No parallel observation (Observer is synchronous per request)
- No new database tables or schema changes
- No changes to the M21 `ToolLearningStore` logic or `mergeStats()`
- No changes to how the M17 Planner selects tools
- No changes to how the M19 Orchestrator executes
- No A/B testing, confidence routing, or fallback-on-failure (deferred to future milestones)
- No M23+ features

---

*Document status: DRAFT — awaiting review before implementation begins.*
*Author: Audit-driven, session date 2026-07-24*
