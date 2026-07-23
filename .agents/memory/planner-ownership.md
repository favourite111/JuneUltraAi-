---
name: Planner ownership
description: Architectural boundary for the agent planning layer introduced after the stable memory foundation
---

Agent planning owns deterministic intent classification, clarification decisions, and the tool-versus-answer gate; it consumes memory context but does not mutate or redesign the memory subsystem.

**Why:** The memory architecture is the stable foundation, while planning needs to evolve independently as the assistant's decision layer.

**How to apply:** Add future planning rules and metrics under the planner layer, pass immutable decisions into execution/prompt construction, and keep MemoryManager, SessionAnalyzer, KnowledgeExtractor, StorageProvider, and KnowledgeManager unchanged.