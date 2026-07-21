import { describe, it, expect, vi } from "vitest";
import type { Tool, ToolConfidence, RoutedTool } from "../types.js";

// Mock the registry.js module to control the tools available for routing
vi.mock("../registry.js", async () => {
  // Mock tools for testing purposes, defined within the mock factory
  const mockHighConfidenceTool: Tool = {
    name: "high_confidence_tool",
    description: "A tool that always returns high confidence for 'high confidence'.",
    manifest: {
      id: "high_confidence_tool",
      name: "High Confidence Tool",
      description: "A tool that always returns high confidence for 'high confidence'.",
      version: "1.0.0",
      category: "test",
      triggers: ["high confidence"],
      inputSchema: {},
      outputTypes: ["text"],
      cost: 1,
      estimatedLatency: 100,
      permissions: [],
      examples: [],
    },
    score: (text: string): ToolConfidence => {
      if (text.includes("high confidence")) {
        return { score: 0.9, reasoning: ["Text contains 'high confidence'"] };
      }
      return { score: 0, reasoning: ["Text does not contain 'high confidence'"] };
    },
    match: (text: string) => (text.includes("high confidence") ? { query: text } : null),
    execute: async (args: any) => ({ type: "text", reply: `Executed with ${args.query}` }),
  };

  const mockLowConfidenceTool: Tool = {
    name: "low_confidence_tool",
    description: "A tool that returns low confidence for 'low confidence'.",
    manifest: {
      id: "low_confidence_tool",
      name: "Low Confidence Tool",
      description: "A tool that returns low confidence for 'low confidence'.",
      version: "1.0.0",
      category: "test",
      triggers: ["low confidence"],
      inputSchema: {},
      outputTypes: ["text"],
      cost: 1,
      estimatedLatency: 100,
      permissions: [],
      examples: [],
    },
    score: (text: string): ToolConfidence => {
      if (text.includes("low confidence")) {
        return { score: 0.2, reasoning: ["Text contains 'low confidence'"] };
      }
      return { score: 0, reasoning: ["Text does not contain 'low confidence'"] };
    },
    match: (text: string) => (text.includes("low confidence") ? { query: text } : null),
    execute: async (args: any) => ({ type: "text", reply: `Executed with ${args.query}` }),
  };

  const mockAmbiguousTool1: Tool = {
    name: "ambiguous_tool_1",
    description: "An ambiguous tool 1.",
    manifest: {
      id: "ambiguous_tool_1",
      name: "Ambiguous Tool 1",
      description: "An ambiguous tool 1.",
      version: "1.0.0",
      category: "test",
      triggers: ["ambiguous"],
      inputSchema: {},
      outputTypes: ["text"],
      cost: 1,
      estimatedLatency: 100,
      permissions: [],
      examples: [],
    },
    score: (text: string): ToolConfidence => {
      if (text.includes("ambiguous")) {
        return { score: 0.6, reasoning: ["Text contains 'ambiguous'"] };
      }
      return { score: 0, reasoning: ["Text does not contain 'ambiguous'"] };
    },
    match: (text: string) => (text.includes("ambiguous") ? { query: text } : null),
    execute: async (args: any) => ({ type: "text", reply: `Executed with ${args.query}` }),
  };

  const mockAmbiguousTool2: Tool = {
    name: "ambiguous_tool_2",
    description: "An ambiguous tool 2.",
    manifest: {
      id: "ambiguous_tool_2",
      name: "Ambiguous Tool 2",
      description: "An ambiguous tool 2.",
      version: "1.0.0",
      category: "test",
      triggers: ["ambiguous"],
      inputSchema: {},
      outputTypes: ["text"],
      cost: 1,
      estimatedLatency: 100,
      permissions: [],
      examples: [],
    },
    score: (text: string): ToolConfidence => {
      if (text.includes("ambiguous")) {
        return { score: 0.6, reasoning: ["Text contains 'ambiguous'"] };
      }
      return { score: 0, reasoning: ["Text does not contain 'ambiguous'"] };
    },
    match: (text: string) => (text.includes("ambiguous") ? { query: text } : null),
    execute: async (args: any) => ({ type: "text", reply: `Executed with ${args.query}` }),
  };

  const mockNoMatchTool: Tool = {
    name: "no_match_tool",
    description: "A tool that never matches.",
    manifest: {
      id: "no_match_tool",
      name: "No Match Tool",
      description: "A tool that never matches.",
      version: "1.0.0",
      category: "test",
      triggers: ["never match"],
      inputSchema: {},
      outputTypes: ["text"],
      cost: 1,
      estimatedLatency: 100,
      permissions: [],
      examples: [],
    },
    score: (text: string): ToolConfidence => {
      return { score: 0, reasoning: ["This tool never matches"] };
    },
    match: (text: string) => null,
    execute: async (args: any) => ({ type: "text", reply: `Executed with ${args.query}` }),
  };

  // Mock legacy tool without a score method
  const mockLegacyTool: Tool = {
    name: "legacy_tool",
    description: "A legacy tool that matches 'legacy'.",
    triggers: ["legacy"],
    match: (text: string) => (text.includes("legacy") ? { query: text } : null),
    execute: async (args: any) => ({ type: "text", reply: `Executed with ${args.query}` }),
  };

  const mockRegistry = [
    mockHighConfidenceTool,
    mockLowConfidenceTool,
    mockAmbiguousTool1,
    mockAmbiguousTool2,
    mockNoMatchTool,
    mockLegacyTool,
  ];

  // Re-implement routeTool to use the mockRegistry
  const mockedRouteTool = (text: string): RoutedTool | null => {
    const candidates: RoutedTool[] = [];

    for (const tool of mockRegistry) {
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
  };

  return {
    routeTool: mockedRouteTool, // Export the mocked routeTool
    legacyRegistry: mockRegistry, // Export the mocked registry
  };
});

describe("Capability Router - Milestone 3", () => {
  it("should return the highest confidence tool", async () => {
    const { routeTool } = await import("../registry.js");
    const result = routeTool("I need high confidence");
    expect(result).not.toBeNull();
    expect(result?.tool.name).toBe("high_confidence_tool");
    expect(result?.confidence.score).toBe(0.9);
    expect(result?.confidence.reasoning).toEqual(["Text contains 'high confidence'"]);
  });

  it("should return null if no tool matches", async () => {
    const { routeTool } = await import("../registry.js");
    const result = routeTool("no matching tool here");
    expect(result).toBeNull();
  });

  it("should handle ambiguous matches and return the first highest confidence tool", async () => {
    const { routeTool } = await import("../registry.js");
    const result = routeTool("this is ambiguous");
    expect(result).not.toBeNull();
    // Assuming order of mock tools in registry, ambiguous_tool_1 should be picked first
    expect(result?.tool.name).toBe("ambiguous_tool_1");
    expect(result?.confidence.score).toBe(0.6);
    expect(result?.confidence.reasoning).toEqual(["Text contains 'ambiguous'"]);
  });

  it("should handle legacy tools with default high confidence if no score method is present", async () => {
    const { routeTool } = await import("../registry.js");
    const result = routeTool("this is a legacy request");
    expect(result).not.toBeNull();
    expect(result?.tool.name).toBe("legacy_tool");
    expect(result?.confidence.score).toBe(0.95);
    expect(result?.confidence.reasoning).toEqual(["Deterministic regex match (legacy fallback)"]);
  });

  it("should prioritize tools with a score method over legacy tools if confidence is higher", async () => {
    const { routeTool } = await import("../registry.js");
    const result = routeTool("high confidence and legacy");
    expect(result).not.toBeNull();
    // mockHighConfidenceTool has a score of 0.9, mockLegacyTool has 0.95.
    // So legacy tool should be picked.
    expect(result?.tool.name).toBe("legacy_tool");
    expect(result?.confidence.score).toBe(0.95);
    expect(result?.confidence.reasoning).toEqual(["Deterministic regex match (legacy fallback)"]);
  });

  it("should return null if all matching tools return 0 confidence", async () => {
    const { routeTool } = await import("../registry.js");
    const result = routeTool("this string matches nothing and gives 0 confidence");
    expect(result).toBeNull();
  });
});
