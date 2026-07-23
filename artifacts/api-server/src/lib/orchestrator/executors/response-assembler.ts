import { makeExecutionResult } from "../execution-result.js";
import type {
  ExecutionError,
  ExecutionOutput,
  ExecutionPath,
  ExecutionResult,
  ToolExecutionOutput,
} from "../orchestrator-types.js";
import type { Tool, ToolError, ToolResult } from "../../tools/types.js";

// ---------------------------------------------------------------------------
// M19 — ResponseAssembler
//
// Single responsibility: take the raw outputs from one or more executor calls
// and assemble an immutable, deep-frozen ExecutionResult.
//
// Pure function — no side-effects, no I/O.
// ---------------------------------------------------------------------------

export interface AssemblerInput {
  readonly outputs:         readonly ExecutionOutput[];
  readonly toolResults:     readonly ToolExecutionOutput[];
  readonly errors:          readonly ExecutionError[];
  readonly handledBy:       ExecutionPath;
  readonly startMs:         number;
  readonly endMs:           number;
  readonly bridgeTool?:     Tool;
  readonly bridgeToolResult?: ToolResult;
  readonly bridgeToolError?:  ToolError;
}

export function assembleExecutionResult(input: AssemblerInput): ExecutionResult {
  const success = input.errors.length === 0 && input.outputs.every((o) => o.success);

  return makeExecutionResult({
    success,
    handledBy:       input.handledBy,
    outputs:         input.outputs,
    toolResults:     input.toolResults,
    executionTimeMs: input.endMs - input.startMs,
    errors:          input.errors,
    bridgeTool:      input.bridgeTool,
    bridgeToolResult: input.bridgeToolResult,
    bridgeToolError:  input.bridgeToolError,
  });
}
