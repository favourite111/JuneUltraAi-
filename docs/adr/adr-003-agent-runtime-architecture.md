# ADR-003: Agent Runtime Architecture

## 1. Title
Agent Runtime Architecture for JUNE_ULTRA_AI (Phase 3A)

## 2. Status
Accepted

## 3. Context
Following the successful implementation of the `Tool Manifest` (ADR-001) and the conceptualization of the `Agent Planning Architecture` (ADR-002), it has become clear that a robust `Agent Runtime` is necessary before introducing LLM-driven intelligence. Directly replacing deterministic routing with LLM selection would incur unnecessary costs and latency for common, unambiguous requests. Therefore, Phase 3 will be split into sub-phases, with Phase 3A focusing on building a stable, observable, and extensible runtime that can support both deterministic and future LLM-driven routing.

## 4. Decision
We will implement an `Agent Runtime Architecture` as Phase 3A, focusing on the core pipeline, execution context, event bus, and a deterministic capability scoring mechanism. This phase will establish the foundational infrastructure for agentic behavior without introducing LLM-based tool selection or complex planning yet.

## 5. Core Runtime Components and Responsibilities

### A. The Agent Pipeline
The agent pipeline defines the flow of a user request through the system. In Phase 3A, this pipeline will be:

```
User
  ↓
Capability Router (Deterministic)
  ↓
Planner (Basic Orchestration)
  ↓
Executor
  ↓
Reflection (Basic Error Handling)
  ↓
Reply
```

### B. Capability Router
*   **Responsibility**: The initial entry point for tool selection, determining the most likely tool(s) for a given user prompt.
*   **Behavior**: It will continue to use the deterministic `routeTool()` logic, enhanced by `ToolManifest` metadata. Crucially, it will also incorporate a `Capability Score` from each tool to return not just the selected tool, but also a confidence level for that selection. This confidence will be mathematically derived, not LLM-generated.

### C. Planner
*   **Responsibility**: Orchestrates the execution of a single tool or a simple sequence of actions based on the Router's output.
*   **Behavior**: In Phase 3A, the Planner will primarily receive a `selectedTool` (and its `confidence`) from the `Capability Router`. It will then prepare the `ExecutionContext` and initiate the `Executor`. Multi-step planning will be deferred to Phase 3C.

### D. Executor
*   **Responsibility**: Executes the chosen tool and handles its immediate output.
*   **Behavior**: Receives the tool and its arguments from the Planner, invokes the tool's `execute()` method, and captures the `ToolResult` or `ToolError`. It will pass the `ExecutionContext` to the tool.

### E. Reflection
*   **Responsibility**: Evaluates the outcome of a tool execution and decides on the immediate next step.
*   **Behavior**: In Phase 3A, Reflection will be basic, primarily handling `ToolError`s by deciding on simple retries (if `isRetryable`) or formulating a user-facing error message. Complex re-planning or self-correction will be deferred.

### F. Execution Context
Every tool and component within the agent pipeline will receive a comprehensive `ExecutionContext` object. This object centralizes all relevant information for the current request.

```typescript
export interface ExecutionContext {
  user: { id: string; /* ... other user details */ };
  group?: { id: string; /* ... other group details */ };
  memory: { /* Access to user facts, conversation history, etc. */ };
  conversation: { /* Current conversation state */ };
  plannerState: { /* State specific to the current planning process */ };
  metrics: { /* Interface for emitting metrics */ };
  logger: { /* Interface for structured logging */ };
  abortSignal: AbortSignal; // For graceful cancellation
}
```

### G. Event Bus
A central `Event Bus` will be introduced to enable observability and decoupled communication between components. All significant actions within the agent runtime will emit events.

```typescript
export type AgentEvent = 
  | { type: "planner.started"; payload: { goal: string; timestamp: number; } }
  | { type: "planner.completed"; payload: { plan: AgentPlan; timestamp: number; } }
  | { type: "router.started"; payload: { prompt: string; timestamp: number; } }
  | { type: "router.completed"; payload: { toolId: string | null; confidence: number; timestamp: number; } }
  | { type: "tool.selected"; payload: { toolId: string; args: unknown; timestamp: number; } }
  | { type: "tool.started"; payload: { toolId: string; timestamp: number; } }
  | { type: "tool.completed"; payload: { toolId: string; result: ToolResult; timestamp: number; } }
  | { type: "tool.failed"; payload: { toolId: string; error: ToolError; timestamp: number; } }
  | { type: "reflection.started"; payload: { observation: ToolResult | ToolError; timestamp: number; } }
  | { type: "reflection.completed"; payload: { nextAction: string; timestamp: number; } };
// ... other relevant events

export interface EventBus {
  emit(event: AgentEvent): void;
  on(eventType: AgentEvent['type'], listener: (event: AgentEvent) => void): void;
}
```

### H. Capability Score
Every tool will expose a deterministic `score()` or `confidence()` method that returns a value between 0.0 and 1.0. The `Capability Router` will use this score to rank potential tools. This score will be based on the tool's `match()` logic (e.g., regex match quality, keyword presence, argument extraction success), not LLM inference.

## 6. Scope of Phase 3A (What will NOT be implemented)

To maintain focus and stability, Phase 3A will explicitly *not* include:

*   **LLM Tool Routing**: The `Capability Router` will remain deterministic. LLM involvement in tool selection will be introduced in Phase 3B (Hybrid Intelligence).
*   **Multi-step Planning**: The `Planner` will not generate complex sequences of actions. It will primarily facilitate the execution of a single, deterministically chosen tool.
*   **Recursive Planning**: The agent will not have the ability to dynamically re-plan or adjust its strategy based on intermediate observations beyond basic error handling.
*   **Parallel Execution**: Tools will be executed sequentially.
*   **Autonomous Loops**: The full `Plan-Execute-Observe-Reflect` loop with LLM-driven reflection and re-planning will be part of Phase 3C.

## 7. Alignment with ADR-002

This architecture directly supports the vision of ADR-002 by laying the groundwork for the `Agent Planning Architecture`. It defines the concrete interfaces and responsibilities for the `Planner`, `Executor`, and `Reflection` components, and introduces the `Event Bus` and `ExecutionContext` as essential infrastructure for a production-grade agent runtime. The `Capability Score` provides the necessary input for the `Capability Router` to evolve into a hybrid system in Phase 3B.

## 8. Consequences

-   **Positive**: Establishes a robust, observable, and extensible agent runtime. Provides a clear path for future intelligence enhancements while minimizing immediate cost and complexity. Improves debugging and monitoring capabilities.
-   **Negative**: Requires significant refactoring to integrate the `ExecutionContext` and `Event Bus` across existing tools and the core chat loop. Delays the introduction of full LLM-driven agentic behavior.

## 9. Decision Makers
Manus AI, User, and User's Advisor.

## 10. Date
July 21, 2026
