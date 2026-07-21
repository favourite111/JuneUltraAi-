import type { Tool } from "./types.js";
import { urlShortenerTool } from "./url-shortener.js";
import { qrCodeTool } from "./qrcode.js";
import { screenshotTool } from "./screenshot.js";
import { textToPdfTool } from "./text-to-pdf.js";
import { screenshotPromptTool } from "./screenshot-prompt.js";
import { capabilitiesTool } from "./capabilities.js";

/**
 * Phase 2 Tool Registry.
 *
 * Supports both legacy tools and new manifest-based tools.
 * In a future phase, this will use dynamic filesystem discovery.
 * For now, we maintain the explicit list to ensure backward compatibility
 * and preserve the priority order.
 */
const legacyRegistry: Tool[] = [
  urlShortenerTool,
  qrCodeTool, // Refactored to include manifest, but still works here
  screenshotTool,
  screenshotPromptTool,
  textToPdfTool,
  capabilitiesTool,
];

/**
 * Helper to get all tools that have a manifest.
 * This is the first step toward dynamic discovery.
 */
export function getManifestTools(): Tool[] {
  return legacyRegistry.filter((tool) => !!tool.manifest);
}

/**
 * Helper to get all legacy tools (those without a manifest).
 */
export function getLegacyTools(): Tool[] {
  return legacyRegistry.filter((tool) => !tool.manifest);
}

export interface RoutedTool {
  tool: Tool;
  args: unknown;
}

/**
 * Deterministically checks the message against every registered tool
 * and returns the first match, or null if no tool applies.
 *
 * This remains the primary entry point for the chat route, ensuring
 * zero breaking changes to the existing flow.
 */
export function routeTool(text: string): RoutedTool | null {
  for (const tool of legacyRegistry) {
    const args = tool.match(text);
    if (args !== null) {
      return { tool, args };
    }
  }
  return null;
}

export type { Tool, ToolContext, ToolResult, ToolResponseType, ToolManifest, ToolConfidence, AgentPlanStep, AgentPlan, AgentReflection, ToolError, ToolRegistryMetrics, RegistryHealth } from "./types.js";
