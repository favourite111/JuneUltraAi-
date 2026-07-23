---
name: Embedding and vector boundaries
description: Durable architecture rules for semantic knowledge indexing and retrieval.
---

Embedding providers translate text into fixed-dimensional vectors, vector providers store and search supplied vectors, and KnowledgeManager owns the orchestration between them. Generic StorageProvider remains the authoritative knowledge source.

**Why:** Derived vector indexes may be cold, stale, unavailable, or partially populated; allowing them to become the retrieval source of truth can make valid knowledge disappear.

**How to apply:** Construct concrete providers only at the composition root, inject abstractions into KnowledgeManager, keep MemoryManager embedding-agnostic, and fall back to authoritative storage when semantic indexing cannot resolve results.