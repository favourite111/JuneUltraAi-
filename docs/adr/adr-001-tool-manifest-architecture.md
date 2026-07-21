# ADR-001: Tool Manifest Architecture

## 1. Title
Tool Manifest Architecture for JUNE_ULTRA_AI

## 2. Status
Accepted

## 3. Context
Previously, JUNE_ULTRA_AI utilized a hardcoded `Tool Registry` where each tool was explicitly imported and its matching logic (`match()` method) was solely responsible for determining applicability. This approach, while simple for a small number of tools, presented scalability challenges, made dynamic discovery difficult, and hindered the integration of advanced agentic features like LLM-driven tool selection, confidence scoring, and dynamic prioritization.

Phase 2 introduces a `Tool Manifest` to address these limitations, transforming tools into self-describing entities within the system.

## 4. Decision
We have decided to implement a `Tool Manifest` architecture for JUNE_ULTRA_AI. This involves:

1.  **Defining a `ToolManifest` Interface**: A new TypeScript interface (`ToolManifest`) has been introduced to standardize the metadata associated with each tool.
2.  **Refactoring Tools**: Existing tools will be gradually refactored to include this `ToolManifest` as part of their export, making them self-describing.
3.  **Backward-Compatible Registry**: The `Tool Registry` (`registry.ts`) has been updated to seamlessly support both legacy tools (without a manifest) and new manifest-based tools, ensuring no disruption to existing functionality.

## 5. Tool Manifest Specification

The `ToolManifest` interface is defined as follows:

```typescript
export interface ToolManifest {
  id: string;             // Stable machine-readable identifier (e.g., "qrcode")
  name: string;           // Human-readable name (e.g., "QR Generator")
  description: string;    // Detailed description of what the tool does
  version: string;        // Semantic version of the tool
  category: string;       // Category for grouping (e.g., "media", "utility")
  triggers: string[];     // Keywords or phrases that trigger this tool (for legacy matching)
  inputSchema: Record<string, unknown>; // JSON Schema for expected arguments
  outputTypes: ToolResponseType[];      // Description of what the tool returns
  cost: number;           // Relative operational cost (1 = cheap, 10 = expensive)
  estimatedLatency: number; // Estimated latency in milliseconds
  permissions: string[];  // Required permissions or scopes
  examples: string[];     // Examples of natural language prompts
}
```

## 6. Migration Strategy from Legacy to Manifest-Based Tools

The migration will be incremental and backward-compatible:

1.  **Phase 2 (Current)**: Introduce the `ToolManifest` interface and refactor a single tool (e.g., `qrcode.ts`) to include it. The `Tool` interface is updated to include an optional `manifest?: ToolManifest` property. The `registry.ts` continues to use its explicit list of tools, but now includes helper functions (`getManifestTools`, `getLegacyTools`) to differentiate between tool types.
2.  **Future Phases**: Gradually refactor all remaining legacy tools to incorporate the `ToolManifest`. During this period, the `registry.ts` will continue to support both types. Once all tools are manifest-based, the `Tool` interface can be simplified, and the `registry.ts` can transition to dynamic filesystem discovery.

## 7. Reasoning Behind the Architecture

-   **Scalability**: Decouples tool metadata from the registry logic, allowing for easier addition of new tools without modifying central registration code.
-   **Intelligent Routing Foundation**: Provides structured metadata (description, input schema, cost, latency) that is essential for future LLM-driven tool selection, confidence scoring, and dynamic prioritization.
-   **Self-Documentation**: Each tool becomes self-describing, improving maintainability and clarity for developers and future AI agents.
-   **Backward Compatibility**: Ensures that the existing system continues to function without disruption during the migration, minimizing risk.
-   **Preparation for Dynamic Discovery**: The manifest format is a prerequisite for implementing dynamic tool loading from a directory, as opposed to explicit imports.

## 8. Backward Compatibility Guarantees

-   **No API Endpoint Changes**: The public API endpoints (`/v1/chat`, etc.) remain unchanged.
-   **No Chatbot Behavior Changes**: The user-facing behavior of the chatbot is identical to its pre-Phase 2 state.
-   **No Router Changes**: The `routeTool` function in `registry.ts` continues to iterate through the same ordered list of tools and invoke their `match()` and `execute()` methods, regardless of whether a tool has a manifest.
-   **No Tool Execution Path Changes**: The internal logic of how tools are matched and executed remains the same.

## 9. Future Migration Plan

-   **Dynamic Tool Discovery (Phase 3)**: Once all tools are manifest-based, the `registry.ts` will be refactored to automatically discover and load tools from a designated directory (e.g., `/lib/tools/`). This will eliminate the need for manual imports in `registry.ts`.
-   **LLM-Driven Tool Selection**: With comprehensive manifests, the LLM can be provided with tool descriptions to enable intelligent, context-aware tool selection.
-   **Tool Prioritization and Ranking**: The `cost`, `estimatedLatency`, and other metadata in the manifest will be used by the LLM or a dedicated ranking module to select the optimal tool when multiple options exist.
-   **Input Validation**: The `inputSchema` can be used for runtime validation of arguments before tool execution, improving robustness.

## 10. Consequences

-   **Positive**: Improved scalability, maintainability, and a clear path towards advanced agentic capabilities. The system is now better prepared for future enhancements without requiring significant architectural overhauls.
-   **Negative**: Initial overhead of refactoring existing tools to the manifest format. This is mitigated by the incremental migration strategy.

## 11. Decision Makers
Manus AI, User, and User's Advisor.

## 12. Date
July 21, 2026
