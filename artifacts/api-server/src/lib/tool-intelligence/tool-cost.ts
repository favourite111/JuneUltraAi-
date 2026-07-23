/**
 * M20 — Tool cost and latency estimation.
 *
 * Reads from tool manifests only — no tool execution.
 */

import { ToolRegistry } from "../tools/registry.js";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_COST       = 1;
const DEFAULT_LATENCY_MS = 500;

// ---------------------------------------------------------------------------
// Estimators
// ---------------------------------------------------------------------------

/**
 * Estimate the relative operational cost for a named tool.
 * Derived from tool.manifest.cost (1 = cheap, 10 = expensive).
 * Returns DEFAULT_COST when the tool has no manifest.
 * Does NOT execute the tool.
 */
export function estimateCost(toolName: string): number {
  const tool = ToolRegistry.getTool(toolName);
  return tool?.manifest?.cost ?? DEFAULT_COST;
}

/**
 * Estimate execution latency for a named tool in milliseconds.
 * Derived from tool.manifest.estimatedLatency.
 * Returns DEFAULT_LATENCY_MS when the tool has no manifest.
 * Does NOT execute the tool.
 */
export function estimateLatency(toolName: string): number {
  const tool = ToolRegistry.getTool(toolName);
  return tool?.manifest?.estimatedLatency ?? DEFAULT_LATENCY_MS;
}

/**
 * Return cost and latency as a combined profile, noting whether they
 * originated from manifest data or from the default fallback.
 */
export function getToolCostProfile(toolName: string): {
  cost: number;
  latencyMs: number;
  fromManifest: boolean;
} {
  const tool = ToolRegistry.getTool(toolName);
  if (!tool?.manifest) {
    return { cost: DEFAULT_COST, latencyMs: DEFAULT_LATENCY_MS, fromManifest: false };
  }
  return {
    cost:        tool.manifest.cost,
    latencyMs:   tool.manifest.estimatedLatency,
    fromManifest: true,
  };
}
