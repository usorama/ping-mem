---
status: ready
priority: p2
issue_id: "020"
tags: [execution, wave-4, deployment, docker, orbstack, parity]
dependencies: ["015", "016", "017"]
---

## Problem Statement

Deployment mode differences can silently redefine supported behavior; OrbStack/local Docker parity must be treated as a capability concern, not an afterthought.

## Findings

- the active stack runs in OrbStack-backed Docker
- local direct mode, proxy mode, and production assumptions are not yet fully verified against the grounded capability set
- compose config and runtime mounts already affected prior truth and cleanup work

## Recommended Action

1. Verify which behaviors are guaranteed in OrbStack/local Docker and which differ by mode.
2. Ground production/deployment assumptions against actual compose/runtime config.
3. Capture any required environment limitations explicitly.

## Acceptance Criteria

- [ ] Deployment mode boundaries are explicit and verified.
- [ ] OrbStack-backed runtime behavior is included in capability acceptance.
- [ ] No major support claim depends on undocumented environment assumptions.

## Work Log

### 2026-04-22 - Unified-server deployment model re-grounded on OrbStack

**By:** Codex

**Actions:**
- Reconciled dev and prod compose files to use the unified-server transport label consistently.
- Rebuilt and redeployed the live OrbStack container from the current worktree.
- Re-verified live post-deploy behavior:
  - `/health` returns `ok`
  - `doctor` returns `34/34`
  - `/mcp` security headers and rate limiting are present on the deployed service

**Learnings:**
- The important deployment boundary is not “REST vs SSE server”; it is “unified server on `:3003` vs direct local stdio fallback”.
- OrbStack parity work should keep distinguishing live shared-server behavior from isolated direct-mode behavior, because only the former reflects the operator-facing runtime.
