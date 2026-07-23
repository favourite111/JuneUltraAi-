# JUNE_ULTRA_AI System Architecture Overview

This document provides a comprehensive overview of the JUNE_ULTRA_AI system architecture, detailing its core components, their interactions, and the underlying design principles. It serves as a blueprint for understanding the project's current state and guiding future development.

## Table of Contents
1.  [Introduction](#1-introduction)
2.  [Core Architectural Principles](#2-core-architectural-principles)
3.  [Request Lifecycle](#3-request-lifecycle)
4.  [Runtime Lifecycle](#4-runtime-lifecycle)
5.  [Memory Lifecycle](#5-memory-lifecycle)
6.  [Hybrid LLM Lifecycle](#6-hybrid-llm-lifecycle)
7.  [Storage Architecture](#7-storage-architecture)
8.  [Dependency Graph](#8-dependency-graph)
9.  [Event Flow](#9-event-flow)
10. [Sequence Diagrams](#10-sequence-diagrams)
11. [Folder Responsibilities](#11-folder-responsibilities)
12. [References](#12-references)

## 1. Introduction
JUNE_ULTRA_AI is an advanced AI platform designed for deterministic execution, hybrid reasoning, pluggable storage, and structured memory. This document consolidates the architectural decisions and implementations across various phases, particularly focusing on Phase 3A (Deterministic Runtime) and Phase 3B (Hybrid Intelligence & Memory Architecture).

## 2. Core Architectural Principles

The design of JUNE_ULTRA_AI is guided by several key architectural principles:

*   **Deterministic Execution**: Ensures that given the same inputs, the system will always produce the same outputs, crucial for testing, debugging, and reliable operation. This is achieved through immutable execution contexts and explicit dependency injection.
*   **Layered Design**: Components are organized into distinct layers with clear responsibilities and dependencies, promoting modularity, maintainability, and scalability.
*   **Hybrid Intelligence**: Combines deterministic tool routing with flexible LLM-driven decision-making, allowing the system to leverage the strengths of both approaches.
*   **Architecture Law #15 — Role Separation**: A provider translates, a manager orchestrates, and a runtime executes. Never swap these roles.
*   **Architecture Law #17 — Retrieval Encapsulation**: Retrieval strategies are implementation details. Consumers ask for knowledge; they never select deterministic, semantic, or hybrid algorithms.
*   **Structured Memory**: Implements a tiered memory system to manage conversational context, user facts, and tool execution records, enabling more coherent and personalized interactions.
*   **Observability**: Integrates an Event Bus for emitting lifecycle events, providing insights into the system's internal workings and facilitating debugging and monitoring.
*   **ADR-Driven Development**: Architectural decisions are formally documented using Architecture Decision Records (ADRs), ensuring transparency, traceability, and consistency in design choices.

## 3. Request Lifecycle

The request lifecycle describes the journey of an incoming user prompt through the JUNE_ULTRA_AI system, from initial reception to the final response. It involves several stages, including parsing, memory loading, runtime execution, and response generation.

1.  **Receive Request**: The `/v1/chat` endpoint in `chat.ts` receives a user prompt along with `userId` and optional `groupId`.
2.  **Input Sanitization**: Raw inputs are sanitized to strip lone surrogates, ensuring valid Unicode throughout the system.
3.  **Memory Loading**: The `MemoryManager` (specifically `DefaultMemoryManager` with `PostgresStorageProvider`) is invoked by the route to load a `MemoryContext` for the current `botId`, `userId`, and `groupId`. This context includes session memory, conversation history, user facts, and tool execution summaries.
4.  **Execution Context Creation**: An immutable `ExecutionContext` is created, encapsulating the request details, loaded `MemoryContext`, and injected dependencies (clock, ID generator, event bus, logger, metrics).
5.  **Runtime Execution**: The `AgentRuntime.execute()` method is called with the prompt and the `ExecutionContext`. This initiates the core AI reasoning process.
6.  **Response Generation**: Based on the runtime's decision (tool execution or LLM response), a reply is generated.
7.  **Memory Recording**: After the response is prepared, the `MemoryManager.record()` method is invoked by the route to persist any updates to session memory, conversation history, user facts, or tool outputs.
8.  **Send Response**: The final reply is sent back to the user.

## 4. Runtime Lifecycle

The runtime lifecycle, managed by `AgentRuntime`, orchestrates the decision-making process within the `ExecutionContext`. It determines whether to use a deterministic tool, consult an LLM, or fall back to a default response.

1.  **Router Invocation**: The `AgentRuntime` first attempts to route the prompt to a deterministic tool using the `CapabilityRouter`.
2.  **Hybrid Intelligence Check**: If the deterministic router has low confidence or no tool matches, and hybrid intelligence is enabled, the system consults an LLM.
3.  **LLM Interaction**: The `PromptManager` renders a prompt for the LLM, including available tools and context. The `ModelProvider` then generates a response from the LLM.
4.  **LLM Decision Validation**: The LLM's response is parsed and validated by the `PromptManager` and `DecisionValidator`. If the decision is valid and has sufficient confidence, the corresponding tool is selected.
5.  **Tool Execution**: If a tool is selected (either deterministically or via LLM), the `ToolExecutor` executes the tool with the extracted arguments.
6.  **Reflection (Future)**: (Phase 3A) The `ReflectionEngine` observes tool execution results and may trigger further planning or re-routing based on the outcome.
7.  **Response Handling**: The runtime returns a `CompletedRuntimeResponse` (if a tool successfully executed) or a `NoCapabilityRuntimeResponse` (if no tool could be confidently selected or LLM failed).

## 5. Memory Lifecycle

The memory lifecycle, governed by the `MemoryManager` and `StorageProvider`, handles the persistence and retrieval of conversational and user-specific data. It adheres to the principles outlined in ADR-005 (Contextual Memory Architecture).

### Memory Tiers:
*   **Request Memory**: Ephemeral, per-request data.
*   **Session Memory**: Short-term conversational state, stored in the `session` tier.
*   **Conversation Memory**: Ordered list of messages, stored in the `conversations` table.
*   **User Profile Memory**: Objective personal facts about the user, stored in the `user_facts` table.
*   **Tool Execution Memory**: Records of tool invocations and their outputs.

### Operations:
*   **`load(scope, budget)`**: Retrieves memory tiers based on the `MemoryScope` (bot, user, group, request IDs) and `ContextBudget` (LLM token limits). It fetches data from the `StorageProvider` (e.g., `PostgresStorageProvider`) and assembles a frozen `MemoryContext`.
*   **`record(scope, updates)`**: Persists updates to various memory tiers after a response is generated. This is a best-effort operation, with individual write failures being swallowed to prevent blocking the main request flow.
*   **`forget(key)`**: Deletes memory entries, either for a specific key or a broader scope (e.g., all memory for a user).
*   **`health()`**: Reports the health status of the underlying `StorageProvider`.

## 6. Hybrid LLM Lifecycle

The Hybrid LLM lifecycle integrates large language models into the decision-making process, particularly when deterministic routing is insufficient. It is designed for resilience and controlled fallback.

1.  **Low Confidence Routing**: If the `CapabilityRouter` returns a low confidence score for a tool match, or no tool matches, the system considers consulting an LLM.
2.  **Circuit Breaker Check**: Before invoking the LLM, a `CircuitBreaker` checks if the LLM service is currently in an `OPEN` state due to previous failures. If open, the LLM call is skipped.
3.  **Prompt Generation**: The `PromptManager` constructs a prompt for the LLM, incorporating the user's query, available tools, and relevant context from the `ExecutionContext`.
4.  **LLM Call**: The `ModelProvider` sends the prompt to the LLM (e.g., OpenAI, Anthropic) and receives a response.
5.  **Retry Mechanism**: If the LLM call times out or fails with a retryable error, the system may retry the call based on `hybridConfig` settings.
6.  **Decision Parsing & Validation**: The LLM's raw response is parsed by the `PromptManager` into an `LLMDecision` (e.g., `tool_selection`, `clarification`, `no_action`). This decision is then validated by the `DecisionValidator`.
7.  **Confidence Thresholding**: The confidence score of the LLM's decision is evaluated against configured thresholds. If confidence is too low, or if the LLM requests clarification, the system may fall back to a `no_capability` response.
8.  **Tool Execution (LLM-driven)**: If the LLM confidently selects a tool, the `AgentRuntime` proceeds to execute that tool.
9.  **Metrics & Observability**: Metrics are recorded for LLM requests, successes, failures, timeouts, and circuit breaker events. Event Bus emissions (`llm.request`, `llm.response`, `llm.decision`) provide real-time insights.

## 7. Storage Architecture

The storage architecture is designed for pluggability and leverages PostgreSQL (via Neon) as the primary persistence layer for structured memory. It abstracts the underlying database interactions through the `StorageProvider` interface.

*   **`StorageProvider` Interface**: Defines a contract for `read`, `list`, `write`, `append`, `upsert`, `delete`, and `health` operations, allowing different storage backends to be swapped in.
*   **`InMemoryStorageProvider`**: An in-memory implementation used primarily for testing and local development, providing a lightweight and infrastructure-free option.
*   **`PostgresStorageProvider`**: The production-grade implementation that interacts with a PostgreSQL database (e.g., Neon). It maps memory tiers to specific tables:
    *   `conversation` tier → `conversations` table
    *   `user_profile` tier → `user_facts` table
    *   `session` and `tool_execution` tiers are currently in-memory fallbacks but are designed for future database integration.
*   **Schema Definition (`schema.ts`)**: Defines the database tables (`bots`, `conversations`, `user_facts`, `pending_topics`) and their relationships, ensuring data integrity and consistency.
*   **`db.ts`**: Provides a shared, lazily initialized `postgres.js` client for connecting to the PostgreSQL database.

## 8. Dependency Graph

(This section will contain a visual representation of the dependency graph, which will be generated separately or described textually if visual tools are unavailable.)

**Key Dependencies:**
*   **`chat.ts` (Route Handler)**: Depends on `MemoryManager`, `AgentRuntime`, `AgentEventBus`, `conversation-store`, `user-memory`, `pending-topics`.
*   **`AgentRuntime`**: Depends on `ExecutionContext`, `CapabilityRouter`, `ModelProvider`, `PromptManager`, `EventBus`, `MemoryManager` (optional, for context loading).
*   **`MemoryManager`**: Depends on `StorageProvider`, `EventBus` (for observability).
*   **`StorageProvider`**: (e.g., `PostgresStorageProvider`) Depends on `db.ts` (for SQL client).
*   **`ExecutionContext`**: Depends on `Clock`, `IdGenerator`, `EventBus`, `MemoryContext`.

## 9. Event Flow

The system utilizes an `AgentEventBus` for emitting and subscribing to lifecycle events, promoting loose coupling and enabling real-time observability. Events are categorized by their origin and purpose.

**Key Event Types:**
*   `planner.started`, `planner.completed`
*   `router.started`, `router.completed`
*   `tool.selected`, `tool.started`, `tool.completed`, `tool.failed`
*   `reflection.started`, `reflection.completed`, `reflection.failed`
*   `llm.request`, `llm.response`, `llm.decision`
*   `memory.load_started`, `memory.load_completed`, `memory.load_failed`
*   `memory.record_started`, `memory.record_completed`, `memory.record_failed`
*   `memory.tier_degraded`, `memory.budget_truncated`, `memory.forgotten`, `memory.write_conflict`, `memory.fact_decayed`

**Event Emission Points:**
*   **`AgentRuntime`**: Emits events related to routing, LLM interactions, and overall runtime flow.
*   **`MemoryManager`**: Emits events for memory loading and recording operations.
*   **Tools**: Emit events for their selection, start, completion, and failure.

## 10. Sequence Diagrams

(This section will contain sequence diagrams illustrating key interactions, which will be generated separately or described textually if visual tools are unavailable.)

**Example Scenarios for Sequence Diagrams:**
*   **User Prompt to Tool Execution**: Illustrates the flow from an incoming prompt, through routing, tool selection, execution, and response.
*   **User Prompt to LLM Fallback**: Shows the path when deterministic routing fails, leading to LLM consultation and decision-making.
*   **Memory Load and Record**: Details how `MemoryManager.load()` fetches data and how `MemoryManager.record()` persists updates.

## 11. Folder Responsibilities

The project's directory structure is organized to reflect logical component groupings and responsibilities.

```
JuneUltraAi/
├── artifacts/
│   └── api-server/             # Main API server application
│       ├── src/
│       │   ├── app.ts          # Express app setup, middleware, and route mounting
│       │   ├── index.ts        # Application entry point, schema migration, poller start
│       │   ├── routes/         # API route definitions (e.g., chat.ts, health.ts)
│       │   ├── lib/            # Core libraries and shared modules
│       │   │   ├── db.ts               # PostgreSQL client initialization
│       │   │   ├── logger.ts           # Centralized logging utility
│       │   │   ├── schema.ts           # Database schema definition and migration
│       │   │   ├── conversation-store.ts # Legacy conversation history persistence
│       │   │   ├── user-memory.ts      # Legacy user fact persistence
│       │   │   ├── pending-topics.ts   # Legacy pending topics persistence
│       │   │   ├── memory/             # Phase 3B: Contextual Memory Architecture
│       │   │   │   ├── index.ts              # Public surface for memory subsystem
│       │   │   │   ├── types.ts              # Memory interfaces and types (MemoryManager, StorageProvider, MemoryContext)
│       │   │   │   ├── memory-manager.ts     # DefaultMemoryManager implementation
│       │   │   │   └── providers/            # StorageProvider implementations
│       │   │   │       ├── in-memory-storage-provider.ts # In-memory provider for tests/dev
│       │   │   │       └── postgres-storage-provider.ts # Production PostgreSQL provider
│       │   │   └── tools/              # Phase 3A/3B: Agent Runtime and Tooling
│       │   │       ├── types.ts              # Core interfaces for Agent Runtime, Tools, EventBus
│       │   │       ├── runtime.ts            # AgentRuntime implementation (orchestrates tool routing, LLM fallback)
│       │   │       ├── context.ts            # ExecutionContext creation and immutability
│       │   │       ├── event-bus.ts          # AgentEventBus implementation
│       │   │       ├── registry.ts           # ToolRegistry and deterministic router
│       │   │       ├── resilience.ts         # Circuit Breaker, error normalization, metrics
│       │   │       ├── mock-model-provider.ts # Mock LLM provider for tests
│       │   │       ├── mock-prompt-manager.ts # Mock prompt manager for tests
│       │   │       └── ... (individual tool implementations)
│       │   └── ... (other API server files)
├── docs/
│   └── adr/                    # Architecture Decision Records
│   └── architecture/           # System architecture documentation
│       └── SYSTEM_OVERVIEW.md  # This document
└── ... (other project root files)
```

## 12. References

*   [1] ADR-003: Agent Runtime Architecture (docs/adr/adr-003-agent-runtime-architecture.md)
*   [2] ADR-004: Hybrid Intelligence Architecture (docs/adr/adr-004-hybrid-intelligence-architecture.md)
*   [3] ADR-005: Contextual Memory Architecture (docs/adr/adr-005-contextual-memory-architecture.md)
