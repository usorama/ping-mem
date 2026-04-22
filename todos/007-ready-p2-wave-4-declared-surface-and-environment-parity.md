---
status: ready
priority: p2
issue_id: "007"
tags: [execution, wave-4, parity, deployment, advanced-surfaces]
dependencies: ["006"]
---

## Problem Statement

ping-mem claims a broader platform surface than the currently grounded core, and some of that surface is only partially wired, weakly verified, or environment-specific.

## Findings

- advanced subsystem issues cluster around extractor/runtime wiring, transcript mining, shell activation, event-driven consumers, admin/auth, and deployment parity
- local Docker validation is ahead of some direct/proxy/production assumptions
- tool families like diagnostics/worklog and transport surfaces need explicit support-level classification

## Proposed Solutions

### Option A

Leave advanced and environment-specific surfaces as follow-up backlog.

- Pros: keeps focus on core flows
- Cons: declared capability debt remains and future failures keep rediscovering the same gap class

### Option B

Classify and reconcile the broader declared surface after core correctness is grounded.

- Pros: produces a supportable platform surface and cleaner backlog
- Cons: wider triage effort across multiple subsystems

## Recommended Action

Execute Option B.

1. Classify declared subsystems as verified, weakly verified, partial, dormant, or docs-only.
2. Verify or narrow deployment-mode claims.
3. Group advanced subsystem issues by capability family rather than by incidental symptoms.

## Acceptance Criteria

- [ ] Deployment-mode support boundaries are explicit and truthful.
- [ ] Advanced subsystem claims are classified and updated.
- [ ] `#96`, `#97`, `#98`, `#99`, `#101`, `#102`, `#110`, and `#121` are mapped and triaged within this wave.

## Work Log

### 2026-04-22 - Wave created

**By:** Codex

**Actions:**
- Collected the “declared but ungrounded” surfaces into one explicit wave.
- Positioned environment parity as part of supportable capability truth, not an operational side quest.

**Learnings:**
- This wave should not start before core capability correctness, otherwise it becomes unbounded platform archaeology.

### 2026-04-22 - Transport and deployment parity grounded

**By:** Codex

**Actions:**
- Verified focused transport parity and security coverage with `bun test src/http/__tests__/sse-parity.test.ts src/http/__tests__/cors-security.test.ts`.
- Re-audited the live server contract in `src/http/server.ts` and `src/http/sse-server.ts`.
- Reconciled active operator docs to the real single-port runtime: unified server on `:3003`, MCP streamable HTTP at `/mcp`, and app SSE at `/api/v1/events/stream`.
- Shifted Claude Code guidance to proxy-first local MCP configuration for Docker/OrbStack deployments.

**Learnings:**
- The current parity gap was primarily documentation truth, not a missing `/mcp` implementation.
- `PING_MEM_TRANSPORT` is currently best understood as a compatibility label, not an exposure toggle for the unified HTTP server.
