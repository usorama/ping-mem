---
status: ready
priority: p1
issue_id: "017"
tags: [execution, wave-3, memory, recall, hooks, entrypoints]
dependencies: ["014"]
---

## Problem Statement

ping-mem’s core purpose still needs end-to-end proof that memory written from supported entry points is recallable deterministically.

## Findings

- canonical recall behaviors exist, but the full post-drift capability surface has not been re-proved
- session behavior and search semantics directly affect whether recall is trustworthy
- this capability must be measured from user entry points, not inferred from stores alone

## Recommended Action

1. Verify memory write/read/recall behavior from real REST, MCP, and automation-style entry points.
2. Cover hook-like and sessioned flows that operators actually depend on.
3. Record durable acceptance evidence for deterministic recall.

## Acceptance Criteria

- [ ] Supported memory entry points persist and recall data deterministically.
- [ ] Sessioned recall behavior is reproducible under multi-client conditions.
- [ ] Evidence exists for the core memory outcome, not just indirect component behavior.

