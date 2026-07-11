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

export interface Tool<TArgs = unknown> {
  /** Stable machine-readable identifier, e.g. "url_shortener". */
  name: string;
  /** Short human-readable description, useful for logs/future tool listings. */
  description: string;
  /**
   * Returns extracted arguments if this tool applies to the message,
   * or null if it doesn't. Matching is deterministic (regex/keyword) --
   * no AI call is involved in routing.
   */
  match(text: string): TArgs | null;
  /** Executes the tool and returns its structured result. May throw on failure. */
  execute(args: TArgs, ctx: ToolContext): Promise<ToolResult>;
}
