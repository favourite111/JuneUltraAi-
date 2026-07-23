---
name: Hybrid retrieval ownership
description: Approved ordering and fallback rules for combining deterministic and semantic knowledge retrieval.
---

KnowledgeManager runs deterministic and semantic retrieval in parallel, returns plain ordered KnowledgeRecord arrays, puts deterministic matches first, deduplicates by record key, and appends semantic-only candidates in vector-score order. MemoryManager must never reorder knowledge results.

**Why:** Deterministic retrieval is authoritative and exact matches must not lose to semantic similarity; vector indexes are derived and may be stale or unavailable.

**How to apply:** Keep all branch orchestration, duplicate merging, exact-match precedence, semantic ordering, and vector-failure fallback inside KnowledgeManager. Treat StorageProvider failure as inability to trust vector-only metadata.