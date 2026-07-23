---
name: Memory maintenance startup order
description: Startup sequencing constraint for the database-backed memory maintenance scheduler
---

Background memory maintenance must start only after application schema initialization completes.

**Why:** The scheduler performs its first sweep immediately; starting it during module import can query tables before a fresh database has been initialized.

**How to apply:** Keep scheduler activation behind the successful schema/setup boundary, while still allowing the singleton instances to be imported by request handlers.