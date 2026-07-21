import type {
  ExecutionContext,
  Tool,
  ToolError,
  ToolResult,
} from "./types.js";

export type ToolExecutionOutcome =
  | { readonly status: "completed"; readonly result: ToolResult }
  | { readonly status: "failed"; readonly error: ToolError };

function isToolError(value: unknown): value is ToolError {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<ToolError>;
  return (
    typeof candidate.code === "string" &&
    typeof candidate.message === "string" &&
    typeof candidate.isRetryable === "boolean"
  );
}

/**
 * Converts legacy thrown errors into the structured error shape required by the
 * deterministic reflection engine. Native errors are treated as retryable
 * transport/runtime failures unless a tool supplies an explicit ToolError.
 */
export function normalizeToolError(error: unknown): ToolError {
  if (isToolError(error)) {
    return error;
  }

  if (error instanceof Error) {
    return {
      code: "TOOL_EXECUTION_FAILED",
      message: error.message,
      details: { name: error.name },
      isRetryable: true,
    };
  }

  return {
    code: "TOOL_EXECUTION_FAILED",
    message: "Tool execution failed with a non-error value.",
    details: { value: String(error) },
    isRetryable: true,
  };
}

/**
 * Executes exactly one tool invocation. The executor does not decide whether
 * to retry or re-plan; it reports a structured outcome to reflection, keeping
 * orchestration deterministic and replayable.
 */
export function createToolExecutor(ctx: ExecutionContext) {
  return {
    execute: async (tool: Tool, args: unknown): Promise<ToolExecutionOutcome> => {
      ctx.eventBus?.emit({
        type: "tool.started",
        context: ctx,
        payload: { toolId: tool.name, timestamp: ctx.clock.now() },
      });

      try {
        const result = await tool.execute(args, ctx);
        ctx.eventBus?.emit({
          type: "tool.completed",
          context: ctx,
          payload: { toolId: tool.name, result, timestamp: ctx.clock.now() },
        });

        return { status: "completed", result };
      } catch (error) {
        const normalizedError = normalizeToolError(error);
        ctx.eventBus?.emit({
          type: "tool.failed",
          context: ctx,
          payload: {
            toolId: tool.name,
            error: normalizedError,
            timestamp: ctx.clock.now(),
          },
        });

        return { status: "failed", error: normalizedError };
      }
    },
  };
}
