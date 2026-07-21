/**
 * Generic Tool Registry contract.
 *
 * A "tool" is a self-contained capability the chat endpoint can invoke
 * instead of forwarding a message to the AI. Every tool owns its own
 * intent matching, argument extraction, execution, and response
 * formatting -- the chat route never contains tool-specific logic.
 */

export interface ToolContext {
  botId: string;
  userId: string;
  groupId?: string | undefined;
}

/**
 * How the transport layer should treat the tool's output.
 */
export type ToolResponseType = "text" | "image" | "audio" | "document" | "sticker";

export interface ToolResult {
  type: ToolResponseType;
  /** Always present, even for media results -- usable as a caption or text fallback. */
  reply: string;
  /** Tool-specific payload (e.g. { shortUrl } or { buffer, mimeType }). */
  data: Record<string, unknown>;
}

/**
 * Tool Manifest metadata for intelligent discovery and routing.
 * Part of Phase 2 evolution: Self-describing tools.
 */
export interface ToolManifest {
  /** Stable machine-readable identifier, e.g. "qrcode". */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Detailed description of what the tool does. */
  description: string;
  /** Semantic version of the tool. */
  version: string;
  /** Category for grouping (e.g. "media", "utility", "search"). */
  category: string;
  /** Keywords or phrases that trigger this tool (used by legacy matcher). */
  triggers: string[];
  /** JSON Schema or similar description of expected arguments. */
  inputSchema: Record<string, unknown>;
  /** Description of what the tool returns. */
  outputTypes: ToolResponseType[];
  /** Relative operational cost (1 = cheap, 10 = expensive). */
  cost: number;
  /** Estimated latency in milliseconds. */
  estimatedLatency: number;
  /** Required permissions or scopes. */
  permissions: string[];
  /** Examples of natural language prompts that trigger this tool. */
  examples: string[];
}

/**
 * Phase 3A - Scorable tool manifest for deterministic confidence scoring.
 */
export interface ScorableToolManifest extends ToolManifest {
  /**
   * Returns a deterministic confidence score (0.0-1.0) and reasoning for how well this tool
   * matches the given text, without executing the tool.
   */
  score(text: string): ToolConfidence;
}

/**
 * Deterministic dependencies supplied by the composition root for every
 * request. The runtime never reaches for a clock or ID source directly.
 */
export interface ExecutionContextClock {
  now(): number;
}

export interface ExecutionContextIdGenerator {
  next(): string;
}

export interface ExecutionContextDependencies {
  readonly clock: ExecutionContextClock;
  readonly idGenerator: ExecutionContextIdGenerator;
}

/**
 * Input owned by the request boundary before it is snapshotted into an
 * immutable ExecutionContext. `facts` remains as a temporary legacy alias for
 * callers created before the canonical `memory` input was introduced.
 */
export interface ExecutionContextInput {
  readonly botId: string;
  readonly userId: string;
  readonly groupId?: string;
  readonly correlationId?: string;
  readonly conversationKey: string;
  readonly conversationState: unknown;
  readonly memory?: {
    readonly facts: readonly unknown[];
  };
  readonly facts?: readonly unknown[];
  readonly history: readonly unknown[];
  readonly logger: unknown;
  readonly metrics: unknown;
  readonly abortSignal?: AbortSignal;
  readonly plannerState?: Readonly<Record<string, unknown>>;
}

/**
 * Phase 3A - Immutable request snapshot shared by every runtime component.
 * Request state is copied and recursively frozen; service dependencies remain
 * interface references so they can be invoked by downstream components.
 */
export interface ExecutionContext {
  readonly requestId: string;
  readonly correlationId: string;
  readonly userId: string;
  readonly groupId?: string;
  readonly metadata: {
    readonly requestId: string;
    readonly correlationId: string;
    readonly timestamp: number;
  };
  readonly user: {
    readonly id: string;
    readonly botId: string;
  };
  readonly group?: {
    readonly id: string;
  };
  readonly conversation: {
    readonly key: string;
    readonly state: unknown;
  };
  readonly history: readonly unknown[];
  readonly memory: {
    readonly facts: readonly unknown[];
    readonly history: readonly unknown[];
  };
  readonly plannerState?: Readonly<Record<string, unknown>>;
  readonly abortSignal: AbortSignal;
  readonly logger: unknown;
  readonly metrics: unknown;
  readonly clock: ExecutionContextClock;
  readonly idGenerator: ExecutionContextIdGenerator;
}

export interface Tool<TArgs = unknown> {
  /** Stable machine-readable identifier, e.g. "url_shortener". */
  name: string;
  /** Short human-readable description, useful for logs/future tool listings. */
  description: string;
  /** Optional manifest for Phase 2 tools. */
  manifest?: ToolManifest;
  /** Optional score method for Phase 3A. */
  score?(text: string): ToolConfidence;
  /**
   * Returns extracted arguments if this tool applies to the message,
   * or null if it doesn't.
   */
  match(text: string): TArgs | null;
  /** Executes the tool and returns its structured result. */
  execute(args: TArgs, ctx: ExecutionContext | ToolContext): Promise<ToolResult>;
}

/**
 * Phase 3A - Agent Event types for the Event Bus.
 */
export type AgentEvent =
  | { type: "planner.started"; context: ExecutionContext; payload: { goal: string; timestamp: number; } }
  | { type: "planner.completed"; context: ExecutionContext; payload: { plan: AgentPlan; timestamp: number; } }
  | { type: "router.started"; context: ExecutionContext; payload: { prompt: string; timestamp: number; } }
  | { type: "router.completed"; context: ExecutionContext; payload: { toolId: string | null; confidence: number; timestamp: number; } }
  | { type: "tool.selected"; context: ExecutionContext; payload: { toolId: string; args: unknown; timestamp: number; } }
  | { type: "tool.started"; context: ExecutionContext; payload: { toolId: string; timestamp: number; } }
  | { type: "tool.completed"; context: ExecutionContext; payload: { toolId: string; result: ToolResult; timestamp: number; } }
  | { type: "tool.failed"; context: ExecutionContext; payload: { toolId: string; error: ToolError; timestamp: number; } }
  | { type: "reflection.started"; context: ExecutionContext; payload: { observation: ToolResult | ToolError; timestamp: number; } }
  | { type: "reflection.completed"; context: ExecutionContext; payload: { nextAction: string; timestamp: number; } };

/**
 * Phase 3A - Event Bus interface.
 */
export interface EventBus {
  emit(event: AgentEvent): void;
  on(eventType: AgentEvent["type"], listener: (event: AgentEvent) => void): void;
  once(eventType: AgentEvent["type"], listener: (event: AgentEvent) => void): void;
  off(eventType: AgentEvent["type"], listener: (event: AgentEvent) => void): void;
}

export interface ToolConfidence {
  score: number;
  reasoning: string[];
}

export interface AgentPlanStep {
  type: "tool_call" | "llm_reasoning" | "user_interaction";
  toolId?: string;
  toolArgs?: Record<string, unknown>;
  llmPrompt?: string;
}

export interface AgentPlan {
  goal: string;
  steps: AgentPlanStep[];
}

export interface AgentReflection {
  observation: ToolResult | string;
  evaluation: "success" | "failure" | "partial_success";
  nextAction: "continue_plan" | "replan" | "fallback" | "escalate_to_user";
  reasoning?: string;
}

export interface ToolError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  isRetryable: boolean;
}

export interface ToolRegistryMetrics {
  totalTools: number;
  manifestTools: number;
  legacyTools: number;
  toolCallCounts: Record<string, number>;
  toolErrorCounts: Record<string, number>;
}

export interface RegistryHealth {
  status: "ok" | "warning" | "error";
  message: string;
  issues?: string[];
  unreachableTools?: string[];
}
