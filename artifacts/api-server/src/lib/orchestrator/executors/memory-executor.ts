import type { ExecutionContext } from "../../tools/types.js";
import type { MemoryExecutionOutput } from "../orchestrator-types.js";

// ---------------------------------------------------------------------------
// M19 — MemoryExecutor
//
// Single responsibility: signal that the memory context is loaded and
// available for the downstream LLM response builder in chat.ts.
//
// In M19 this is a thin stub — memory is already loaded before the
// Orchestrator runs (MemoryManager.load() is called in chat.ts before
// planning). Future milestones may use this executor to perform explicit
// memory operations (selective retrieval, synthesis, etc.).
//
// Contract:
//   ✗ Never writes memory
//   ✗ Never reads additional memory beyond what was already loaded
//   ✓ Acknowledge the memory step; return success so chat.ts falls through
//     to the LLM response path
// ---------------------------------------------------------------------------

export interface MemoryExecutorInput {
  readonly step: number;
  readonly prompt: string;
  readonly intent: string;
  readonly context: ExecutionContext;
}

export interface OrchestratorMemoryExecutor {
  execute(input: MemoryExecutorInput): Promise<MemoryExecutionOutput>;
}

export function createMemoryExecutor(): OrchestratorMemoryExecutor {
  return {
    async execute(input: MemoryExecutorInput): Promise<MemoryExecutionOutput> {
      const { step, context } = input;
      // Memory is pre-loaded. Signal success so the LLM path in chat.ts
      // can consume the already-loaded MemoryContext.
      return {
        step,
        executor:  "memory",
        success:   true,
        durationMs: 0,
      };
    },
  };
}
