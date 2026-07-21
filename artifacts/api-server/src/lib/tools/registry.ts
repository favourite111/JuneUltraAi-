import type { Tool, ToolConfidence } from "./types.js";
import { urlShortenerTool } from "./url-shortener.js";
import { qrCodeTool } from "./qrcode.js";
import { screenshotTool } from "./screenshot.js";
import { textToPdfTool } from "./text-to-pdf.js";
import { screenshotPromptTool } from "./screenshot-prompt.js";
import { capabilitiesTool } from "./capabilities.js";

/**
 * Phase 3A Tool Registry.
 *
 * Supports both legacy tools and new manifest-based tools.
 */
const legacyRegistry: Tool[] = [
  urlShortenerTool,
  qrCodeTool,
  screenshotTool,
  screenshotPromptTool,
  textToPdfTool,
  capabilitiesTool,
];

/**
 * Helper to get all tools that have a manifest.
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
  confidence: ToolConfidence;
}

/**
 * Deterministically checks the message against every registered tool
 * and returns the best match with a confidence score.
 *
 * In Phase 3A, routing remains deterministic.
 */
export function routeTool(text: string): RoutedTool | null {
  for (const tool of legacyRegistry) {
    // Phase 3A: Check if tool has a custom score method
    let score = 0;
    if (tool.score) {
      score = tool.score(text);
    }

    const args = tool.match(text);
    if (args !== null) {
      // If match() succeeds but no score() is provided, default to high confidence
      // to preserve legacy behavior.
      const finalScore = tool.score ? score : 0.95;

      return {
        tool,
        args,
        confidence: {
          score: finalScore,
          reasoning: tool.score ? "Calculated via tool.score()" : "Deterministic regex match (legacy fallback)",
        },
      };
    }
  }
  return null;
}

export type { Tool, ToolContext, ToolResult, ToolResponseType, ToolManifest, ToolConfidence, AgentPlanStep, AgentPlan, AgentReflection, ToolError, ToolRegistryMetrics, RegistryHealth, ExecutionContext, AgentEvent, EventBus } from "./types.js";
