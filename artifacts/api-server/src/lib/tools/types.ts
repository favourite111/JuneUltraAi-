/**
 * Generic Tool Registry contract.
 *
 * A "tool" is a self-contained capability the chat endpoint can invoke
 * instead of forwarding a message to the AI. Every tool owns its own
 * intent matching, argument extraction, execution, and response
 * formatting -- the chat route never contains tool-specific logic.
 *
 * Tools are transport-agnostic: they don't know or care whether the
 * caller is a WhatsApp bot, Telegram bot, or a web client. They return a
 * structured result; the caller (the chat route today, any future
 * client tomorrow) decides how to render or deliver it.
 */

export interface ToolContext {
  botId: string;
  userId: string;
  groupId?: string | undefined;
}

/**
 * How the transport layer should treat the tool's output. Tools return
 * whatever they naturally produce (a passthrough URL from an external
 * API, or a locally generated Buffer) -- they never upload to storage
 * themselves.
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

export interface Tool<TArgs = unknown> {
  /** Stable machine-readable identifier, e.g. "url_shortener". */
  name: string;
  /** Short human-readable description, useful for logs/future tool listings. */
  description: string;
  /** Optional manifest for Phase 2 tools. */
  manifest?: ToolManifest;
  /**
   * Returns extracted arguments if this tool applies to the message,
   * or null if it doesn't. Matching is deterministic (regex/keyword) --
   * no AI call is involved in routing.
   */
  match(text: string): TArgs | null;
  /** Executes the tool and returns its structured result. May throw on failure. */
  execute(args: TArgs, ctx: ToolContext): Promise<ToolResult>;
}

// --- Phase 3 Contracts (Future Enhancements) ---

/**
 * TODO: Phase 3 - Add a priority field to ToolManifest for intelligent ranking.
 * This will replace the implicit ordering in the registry array.
 */
// export interface ToolManifest { ... priority: number; ... }

/**
 * TODO: Phase 3 - Interface for Confidence Scoring.
 * An LLM or heuristic could generate this score for tool selection.
 */
export interface ToolConfidence {
  score: number; // e.g., 0.0 to 1.0
  reasoning?: string; // Explanation for the score
}

/**
 * TODO: Phase 3 - Interface for the Planner.
 * The Planner will generate a sequence of actions (tool calls, LLM steps) to achieve a goal.
 */
export interface AgentPlanStep {
  type: "tool_call" | "llm_reasoning" | "user_interaction";
  toolId?: string;
  toolArgs?: Record<string, unknown>;
  llmPrompt?: string;
  // ... other planning details
}

export interface AgentPlan {
  goal: string;
  steps: AgentPlanStep[];
}

/**
 * TODO: Phase 3 - Interface for Reflection.
 * The Reflection module will evaluate the outcome of a step and decide the next action.
 */
export interface AgentReflection {
  observation: ToolResult | string; // Output from a tool or LLM
  evaluation: "success" | "failure" | "partial_success";
  nextAction: "continue_plan" | "replan" | "fallback" | "escalate_to_user";
  reasoning?: string;
}

/**
 * TODO: Phase 3 - Enhanced ToolResult schema for richer output.
 * This might include structured error codes, more detailed metadata.
 */
// export interface ToolResult { ... errorCode?: string; ... }

/**
 * TODO: Phase 3 - Tool Error schema for standardized error reporting.
 */
export interface ToolError {
  code: string; // e.g., "TOOL_EXECUTION_FAILED", "INVALID_INPUT"
  message: string;
  details?: Record<string, unknown>;
  isRetryable: boolean;
}

/**
 * TODO: Phase 3 - Interface for Tool Registry Metrics.
 * Used for observability and performance monitoring.
 */
export interface ToolRegistryMetrics {
  totalTools: number;
  manifestTools: number;
  legacyTools: number;
  toolCallCounts: Record<string, number>; // toolId -> count
  toolErrorCounts: Record<string, number>; // toolId -> error count
}

/**
 * TODO: Phase 3 - Interface for Registry Health Diagnostics.
 * Provides insights into the state and issues of the tool registry.
 */
export interface RegistryHealth {
  status: "ok" | "warning" | "error";
  message: string;
  issues?: string[]; // List of identified issues
  unreachableTools?: string[]; // Tools that failed to load/discover
}
