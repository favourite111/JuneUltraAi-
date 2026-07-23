import type { MemoryContext, SessionMemory } from "../memory/types.js";

export type PlannerIntent =
  | "memory_recall"
  | "tool_use"
  | "continuation"
  | "teaching"
  | "transformation"
  | "clarification"
  | "general_answer";

export interface PlannerTool {
  readonly name: string;
  readonly description: string;
}

export interface PlanningStep {
  readonly step: number;
  readonly action: string;
  readonly description: string;
  readonly toolName?: string;
}

export interface PlanningInput {
  readonly message: string;
  readonly sessionContext?: SessionMemory | null;
  readonly knowledge: readonly unknown[];
  readonly availableTools: readonly PlannerTool[];
  readonly runtimeState?: Readonly<Record<string, unknown>> | MemoryContext;
}

export interface PlanningResult {
  readonly intent: PlannerIntent;
  readonly confidence: number;
  readonly needsMemory: boolean;
  readonly needsTool: boolean;
  readonly needsClarification: boolean;
  readonly clarificationQuestion?: string;
  readonly missingInformation?: readonly string[];
  readonly toolName?: string;
  readonly toolArgs?: unknown;
  readonly plan: readonly PlanningStep[];
}