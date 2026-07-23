/**
 * M20 — Tool availability checks.
 *
 * Reads from ToolRegistry to determine whether a tool is registered.
 * Does NOT execute any tool.
 */

import { ToolRegistry } from "../tools/registry.js";
import type { ToolAvailabilityStatus } from "./tool-intelligence-types.js";

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

/**
 * Returns the availability status of a named tool.
 * Does NOT execute the tool — only checks registry membership.
 */
export function checkToolAvailability(
  toolName: string | null | undefined,
): ToolAvailabilityStatus {
  if (!toolName) return "unknown";
  return ToolRegistry.getTool(toolName) !== undefined ? "available" : "unavailable";
}

/**
 * Returns true if the named tool is currently registered.
 */
export function isToolAvailable(toolName: string): boolean {
  return ToolRegistry.getTool(toolName) !== undefined;
}

/**
 * Returns the names of all currently registered tools.
 * Used by ranking and fallback selection — no execution involved.
 */
export function getRegisteredToolNames(): string[] {
  return ToolRegistry.listTools().map((t) => t.name);
}
