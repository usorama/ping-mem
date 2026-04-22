---
status: ready
priority: p1
issue_id: "013"
tags: [execution, wave-2, manifests, delete, reingest, structural]
dependencies: ["005", "010", "011"]
---

## Problem Statement

Delete and re-ingest must converge manifest, graph, and structural state without route-specific drift or stale leftovers.

## Findings

- admin delete and codebase delete previously had different cleanup semantics
- stale manifests could leave verify/re-ingest behavior inconsistent
- structural re-ingest with zero edges could preserve stale dependency edges

## Recommended Action

1. Verify delete/re-ingest behavior across REST and MCP routes.
2. Remove stale manifest and stale structural-edge drift.
3. Prove convergence with repeated delete/re-ingest cycles on real projects.

## Acceptance Criteria

- [ ] Delete and re-ingest converge regardless of entry route.
- [ ] Manifest cleanup is deterministic and leaves no stale short-circuit state.
- [ ] Structural state is cleared correctly when a new ingest yields zero edges.

