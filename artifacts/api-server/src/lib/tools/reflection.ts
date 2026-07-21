import { ExecutionContext, ToolResult, ToolError, AgentPlanStep, ReflectionDecision, ReflectionDecisionType, AgentEvent } from "./types.js";

export function createReflectionEngine(ctx: ExecutionContext) {
  const MAX_RETRIES = 3;

  const matchesExpectedOutputs = (result: ToolResult, expectedOutputs: Record<string, unknown>): boolean => {
    // If expectedOutputs is empty, any result is considered a match.
    if (Object.keys(expectedOutputs).length === 0) {
      return true;
    }

    // Perform a shallow comparison of properties defined in expectedOutputs.
    for (const key in expectedOutputs) {
      if (Object.prototype.hasOwnProperty.call(expectedOutputs, key)) {
        // If expected output is a placeholder (e.g., empty string), consider any non-null/undefined value a match.
        // If the key is present in expectedOutputs but not in result.data, it's a mismatch.
        if (!Object.prototype.hasOwnProperty.call(result.data, key)) {
          return false;
        }

        // If expected output is an empty string, we expect any non-null/undefined value.
        if (expectedOutputs[key] === "") {
          if (result.data[key] === undefined || result.data[key] === null) {
            return false;
          }
        } else if (result.data[key] !== expectedOutputs[key]) {
          // Otherwise, we expect an exact match.
          return false;
        }
      }
    }
    return true;
  };

  return {
    reflect: (
      observation: ToolResult | ToolError,
      currentPlanStep: AgentPlanStep,
      currentStepIndex: number,
      totalSteps: number,
      reflectionHistory: { decision: ReflectionDecision }[]
    ): ReflectionDecision => {
      const timestamp = ctx.clock.now();

      // Emit reflection.started event
      ctx.eventBus?.emit({
        type: "reflection.started",
        context: ctx,
        payload: {
          observation,
          currentPlanStep,
          timestamp,
        },
      });

      let decision: ReflectionDecision;

      if ("isRetryable" in observation) {
        // Handle ToolError
        const currentRetryCount = reflectionHistory.filter(
          (entry) => entry.decision.type === ReflectionDecisionType.RETRY
        ).length;

        if (observation.isRetryable && currentRetryCount < MAX_RETRIES) {
          decision = {
            type: ReflectionDecisionType.RETRY,
            reasoning: [
              "Encountered a retryable error.",
              `Retry count (${currentRetryCount}) is below the limit (${MAX_RETRIES}).`,
            ],
            retryCount: currentRetryCount + 1,
          };
        } else {
          decision = {
            type: ReflectionDecisionType.FAIL,
            reasoning: [
              "Encountered a " + (observation.isRetryable ? "retryable error." : "non-retryable error."),
              ...(observation.isRetryable ? [`Retry count (${currentRetryCount}) has reached the limit (${MAX_RETRIES}).`] : []),
            ],
          };
          // Emit reflection.failed event for non-retryable or exhausted retries
          ctx.eventBus?.emit({
            type: "reflection.failed",
            context: ctx,
            payload: {
              error: observation,
              timestamp,
            },
          });
        }
      } else {
        // Handle ToolResult
        if (matchesExpectedOutputs(observation, currentPlanStep.expectedOutputs)) {
          if (currentStepIndex + 1 === totalSteps) {
            decision = {
              type: ReflectionDecisionType.COMPLETE,
              reasoning: [
                "Tool result matches expected outputs.",
                "This was the last step in the plan.",
              ],
            };
          } else {
            decision = {
              type: ReflectionDecisionType.CONTINUE,
              reasoning: [
                "Tool result matches expected outputs.",
                "More steps remain in the plan.",
              ],
              nextStepIndex: currentStepIndex + 1,
            };
          }
        } else {
          decision = {
            type: ReflectionDecisionType.FAIL,
            reasoning: [
              "Tool result does not match expected outputs.",
            ],
          };
          // Emit reflection.failed event for mismatch
          ctx.eventBus?.emit({
            type: "reflection.failed",
            context: ctx,
            payload: {
              error: {
                code: "OUTPUT_MISMATCH",
                message: "Tool output did not match expected outputs.",
                details: { actual: observation.data, expected: currentPlanStep.expectedOutputs },
                isRetryable: false,
              },
              timestamp,
            },
          });
        }
      }

      // Emit reflection.completed event
      ctx.eventBus?.emit({
        type: "reflection.completed",
        context: ctx,
        payload: {
          decision,
          timestamp,
        },
      });

      return decision;
    },
  };
}
