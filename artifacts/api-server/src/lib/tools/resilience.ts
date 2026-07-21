import { 
  LLMDecision, 
  RuntimeErrorCode, 
  ToolError, 
  ExecutionContext,
  CircuitBreakerConfig,
  ExecutionContextClock
} from "./types.js";

/**
 * Validates the LLM decision before execution.
 */
export class DecisionValidator {
  static validate(decision: LLMDecision): { isValid: boolean; error?: string } {
    if (!decision.type) {
      return { isValid: false, error: "Missing decision type" };
    }

    if (decision.type === "tool_selection") {
      if (!decision.toolName) {
        return { isValid: false, error: "Missing toolName for tool_selection" };
      }
      if (typeof decision.confidence !== "number") {
        return { isValid: false, error: "Missing or invalid confidence for tool_selection" };
      }
    }

    if (decision.type === "clarification" && !decision.clarificationQuestion) {
      return { isValid: false, error: "Missing clarificationQuestion for clarification" };
    }

    return { isValid: true };
  }
}

/**
 * Normalizes provider-specific errors into RuntimeErrorCode.
 */
export function normalizeError(error: any): ToolError {
  const message = error.message || "Unknown error";
  let code: RuntimeErrorCode = "UNKNOWN_ERROR";
  let retryable = false;

  if (error.name === "AbortError" || message.includes("timeout") || message.includes("TIMEOUT")) {
    code = "TIMEOUT";
    retryable = true;
  } else if (message.includes("rate limit") || message.includes("429")) {
    code = "RATE_LIMIT";
    retryable = true;
  } else if (message.includes("network") || message.includes("fetch") || message.includes("ECONNRESET")) {
    code = "NETWORK_ERROR";
    retryable = true;
  } else if (code === "VALIDATION_FAILED" || code === "INVALID_RESPONSE") {
    retryable = false;
  }

  return {
    code,
    message,
    isRetryable: retryable,
    details: { originalError: error.toString() }
  };
}

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

/**
 * Provider-agnostic Circuit Breaker.
 */
export class CircuitBreaker {
  private state: CircuitState = "CLOSED";
  private failures = 0;
  private lastFailureTime = 0;

  constructor(
    private readonly config: CircuitBreakerConfig,
    private readonly clock: ExecutionContextClock
  ) {}

  getState(overrideClock?: ExecutionContextClock): CircuitState {
    if (this.state === "OPEN") {
      const clock = overrideClock ?? this.clock;
      const now = clock.now();
      if (now - this.lastFailureTime >= this.config.cooldownPeriodMs) {
        this.state = "HALF_OPEN";
      }
    }
    return this.state;
  }

  isOpen(): boolean {
    return this.getState() === "OPEN";
  }

  recordSuccess(): void {
    this.failures = 0;
    this.state = "CLOSED";
  }

  recordFailure(): void {
    if (this.state === "HALF_OPEN" || this.getState() === "HALF_OPEN") {
      this.state = "OPEN";
      this.failures = this.config.failureThreshold;
    } else {
      this.failures++;
      if (this.failures >= this.config.failureThreshold) {
        this.state = "OPEN";
      }
    }
    this.lastFailureTime = this.clock.now();
  }
}

/**
 * Injectable Metrics Collector.
 */
export class MetricsCollector {
  private metrics: Record<string, number> = {
    llm_requests: 0,
    llm_success: 0,
    llm_retries: 0,
    llm_timeout: 0,
    llm_validation_failures: 0,
    circuit_breaker_opens: 0,
    circuit_breaker_skips: 0,
    fallback_count: 0
  };

  record(name: string, value: number = 1): void {
    if (this.metrics[name] !== undefined) {
      this.metrics[name] += value;
    } else {
      this.metrics[name] = value;
    }
  }

  getSnapshot(): Record<string, number> {
    return { ...this.metrics };
  }
}
