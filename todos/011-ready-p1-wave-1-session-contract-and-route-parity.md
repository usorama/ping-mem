---
status: ready
priority: p1
issue_id: "011"
tags: [execution, wave-1, sessions, rest, sse, mcp, shell]
dependencies: ["004", "009"]
---

## Problem Statement

Session routing still needs explicit parity across supported entry points so multi-client use stays deterministic.

## Findings

- shell routes previously bypassed the shared session resolution contract
- live logs showed requests arriving without `X-Session-ID` while multiple sessions were active
- REST, SSE, MCP, and shell behavior still need end-to-end verification rather than only route-level fixes

## Recommended Action

1. Verify session ambiguity handling across REST, shell, SSE, and MCP paths.
2. Convert any remaining implicit selection behavior into a hard, explicit contract.
3. Preserve parity in docs and acceptance tests.

## Acceptance Criteria

- [ ] No supported route silently picks an ambiguous session.
- [ ] Session requirements are consistent across supported transports.
- [ ] Deterministic session behavior is verified from real client entry points.

