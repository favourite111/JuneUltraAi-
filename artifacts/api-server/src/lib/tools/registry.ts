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
  const candidates: RoutedTool[] = [];

  for (const tool of legacyRegistry) {
    const args = tool.match(text);
    if (args !== null) {
      let confidence: ToolConfidence;
      if (tool.score) {
        confidence = tool.score(text);
      } else {
        // Legacy fallback for tools without a score method
        confidence = { score: 0.95, reasoning: ["Deterministic regex match (legacy fallback)"] };
      }

      // Only consider tools with a positive confidence score
      if (confidence.score > 0) {
        candidates.push({
          tool,
          args,
          confidence,
        });
      }
    }
  }

  if (candidates.length === 0) {
    return null;
  }

  // Sort candidates by confidence score in descending order
  candidates.sort((a, b) => b.confidence.score - a.confidence.score);

  // Return the highest confidence tool
  return candidates[0];
}

export type {
  Tool,
  ToolContext,
  ToolResult,
  ToolResponseType,
  ToolManifest,
  ToolConfidence,
  AgentPlanStep,
  AgentPlan,
  ToolError,
  ToolRegistryMetrics,
  RegistryHealth,
  ExecutionContext,
  ExecutionContextClock,
  ExecutionContextIdGenerator,
  ExecutionContextDependencies,
  ExecutionContextInput,
  AgentEvent,
  EventBus,
} from "./types.js";
