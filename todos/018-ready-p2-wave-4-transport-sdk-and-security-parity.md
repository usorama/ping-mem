---
status: ready
priority: p2
issue_id: "018"
tags: [execution, wave-4, rest, sse, sdk, security, parity]
dependencies: ["015", "016", "017"]
---

## Problem Statement

Transport and client surfaces are part of the product claim; they must be supportable and consistent, including security and rate-limiting behavior.

## Findings

- open issue `#122` tracks SSE header/rate-limit parity
- REST, SSE, MCP, and SDK/client semantics still need broader capability-level verification
- environment-specific behavior can silently redefine what is actually supported

## Recommended Action

1. Verify supported transport modes and client SDK behavior against the grounded capability set.
2. Fix SSE security/rate-limit parity and any transport-specific contract drift.
3. Narrow unsupported transport claims where needed.

## Acceptance Criteria

- [ ] Supported transports have explicit, verified contract boundaries.
- [ ] SSE parity gaps are closed or demoted from claims.
- [ ] Client behavior is consistent with the documented support level.

## Work Log

### 2026-04-22 - `/mcp` transport parity grounded and hardened

**By:** Codex

**Actions:**
- Verified existing focused transport tests: `src/http/__tests__/sse-parity.test.ts` and `src/http/__tests__/cors-security.test.ts`.
- Fixed issue `#122` in `src/http/sse-server.ts` by adding API-focused security headers and per-IP sliding-window rate limiting for the MCP-over-HTTP surface.
- Added regression coverage in `src/http/__tests__/sse-security.test.ts`.
- Updated compose/runtime labels and active operator docs to reflect the real unified-server model.
- Rebuilt and redeployed the OrbStack container, then verified live:
  - `OPTIONS /mcp` returns the expected security headers
  - authenticated burst traffic now reaches `429`
  - `/health` remains `ok`
  - `doctor` remains `34/34`

**Learnings:**
- The main remaining transport gap was specific to the Node-handled `/mcp` path, not the REST app or the broader server architecture.
- Deployment-label truth matters here because stale `rest`-mode wording hid a real parity defect on the MCP-over-HTTP surface.
