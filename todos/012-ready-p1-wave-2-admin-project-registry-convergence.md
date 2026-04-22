---
status: ready
priority: p1
issue_id: "012"
tags: [execution, wave-2, admin, projects, convergence, registry]
dependencies: ["005", "010", "011"]
---

## Problem Statement

The admin project registry and graph/search project state must converge on one authoritative view of active projects.

## Findings

- graph and admin project inventories drifted
- duplicate roots and zero-file shells existed in live state
- MCP ingest/admin parity and admin-store dedupe logic were missing before recent code changes

## Recommended Action

1. Verify the live admin DB path and active registry source of truth.
2. Reconcile duplicate project rows and directory aliases.
3. Ensure admin, REST, and MCP operations converge on the same active project set.

## Acceptance Criteria

- [ ] Active project rows are authoritative and deduplicated.
- [ ] Admin and graph/search inventories no longer disagree on active projects.
- [ ] Registry behavior is deterministic across ingest and delete routes.

