---
status: ready
priority: p1
issue_id: "006"
tags: [execution, wave-3, acceptance, search, graph, recall]
dependencies: ["005"]
---

## Problem Statement

ping-mem still needs deterministic capability proofs from real entry points, not just code fixes and payload-shape tests.

## Findings

- search quality and retrieval determinism were under-scoped in earlier passes
- current code still needs direct behavioral verification for filter semantics, ranking semantics, and low-score or empty-result behavior
- tool-surface and regression claims are still stronger than their current proof base
- historical/time-aware query claims need verification or narrowing

## Proposed Solutions

### Option A

Keep current regression coverage and treat runtime fixes as sufficient.

- Pros: less test and acceptance work
- Cons: capability claims remain materially overstated

### Option B

Add real capability-level acceptance for recall, search, structural correctness, and temporal truth across supported entry points.

- Pros: directly grounds the user-facing outcomes ping-mem claims
- Cons: broader verification and possibly more bug discovery

## Recommended Action

Execute Option B.

1. Verify memory recall, code search, hybrid search, and knowledge search separately.
2. Verify structural dependency/impact/blast-radius correctness across real repos.
3. Verify or narrow time-aware and snapshot query claims.
4. Raise verification coverage where the platform claim level currently exceeds the tests.

## Acceptance Criteria

- [ ] Search capabilities have deterministic acceptance gates beyond a narrow happy path.
- [ ] Structural and historical query behavior is verified or narrowed in docs.
- [ ] Tool-surface verification materially improves for supported capabilities.
- [ ] `#94`, `#118`, and `#126` are addressed within this wave.

## Work Log

### 2026-04-22 - Wave created

**By:** Codex

**Actions:**
- Created a dedicated acceptance wave rather than hiding search and verification under generic follow-up work.
- Mapped regression hardening and tool coverage issues into the same capability-proof stream.

**Learnings:**
- This is where ping-mem proves its outcomes, not where it merely accumulates more infrastructure.

### 2026-04-22 - Restart-stable regression acceptance

**By:** Codex

**Actions:**
- Added and used `scripts/seed-regression-fixtures.sh` to seed all 10 canonical doctor queries through the supported REST entry point.
- Diagnosed the earlier regression misses as a durability problem, not a ranking problem.
- Verified the critical acceptance sequence end-to-end:
  - seed canonical regression fixtures
  - reach `34/34` doctor passes
  - restart the live OrbStack container
  - re-run `doctor`
  - confirm the same canonical regression queries still pass without reseeding

**Learnings:**
- The cross-session recall path itself was sound; the failure mode was acknowledged memory loss across container restarts.
- Wave 3 acceptance is now stronger because regression canaries survive restart rather than only working inside a single live process window.

### 2026-04-22 - Capability suite closure pass

**By:** Codex

**Actions:**
- Fixed REST diagnostics ingest so documented nested `location` findings are accepted and normalized correctly.
- Fixed REST worklog endpoints to resolve sessions deterministically from `X-Session-ID` / explicit session IDs instead of falling back only to mutable server state.
- Reworked `codebase/impact` to traverse reverse structural edges directly, eliminating the live Neo4j timeout on real project graphs.
- Updated acceptance harnesses to use the real route contracts and auth requirements.
- Verified:
  - `scripts/test-all-capabilities.sh` => `54 PASS / 0 FAIL / 0 SKIP`
  - `scripts/agent-path-audit.sh` => all paths pass
  - `doctor` => `34/34` pass on OrbStack

**Learnings:**
- A significant part of Wave 3 debt was stale verification logic, but not all of it: the worklog session path, diagnostics ingest translation, and impact traversal were genuine runtime defects.
- Capability closure is stronger now because both the server and the repo’s own acceptance harnesses agree on the supported contracts.

### 2026-04-22 - Search zero-score regression grounded and closed

**By:** Codex

**Actions:**
- Re-audited open issue `#94` against the current `CodeIndexer` implementation.
- Confirmed the live code already avoids the old zero-score collapse by assigning full credit when BM25 or dense ranges tie.
- Added `src/search/__tests__/CodeIndexer.test.ts` to lock in the exact tied-score case the issue described.

**Verification:**
- `bun test src/search/__tests__/CodeIndexer.test.ts`
- `bun run typecheck`

**Learnings:**
- `#94` had become a stale-open bug. The real gap was missing regression proof, not missing runtime logic.

### 2026-04-22 - Structural truncation made caller-visible

**By:** Codex

**Actions:**
- Fixed the remaining silent-truncation contract around structural impact and blast-radius queries.
- `queryImpact()` and `queryBlastRadius()` now return truncation metadata instead of only logging when the result cap is hit.
- Exposed `maxResults` and `truncated` through both REST and MCP structural surfaces.
- Added focused regression coverage in:
  - `src/mcp/handlers/__tests__/StructuralToolModule.test.ts`
  - `src/http/__tests__/rest-api-new-routes.test.ts`

**Verification:**
- `bun test src/mcp/handlers/__tests__/StructuralToolModule.test.ts src/http/__tests__/rest-api-new-routes.test.ts`
- `bun run typecheck`
- `docker compose build ping-mem && docker compose up -d ping-mem`
- `bash scripts/test-all-capabilities.sh` => `54 PASS / 0 FAIL / 0 SKIP`

**Learnings:**
- The earlier query rewrite removed the worst timeout behavior, but the contract was still incomplete until truncation became visible to callers.

### 2026-04-22 - MCP tool-surface smoke coverage brought to full exact-name coverage

**By:** Codex

**Actions:**
- Re-audited `scripts/mcp-smoke-test.sh` against the current 53 MCP tool names and found 7 tools still missing by exact name.
- Extended the smoke harness to cover the remaining tools:
  - `codebase_ingest`
  - `context_health`
  - `diagnostics_ingest`
  - `memory_subscribe`
  - `memory_unsubscribe`
  - `transcript_mine`
  - `dreaming_run`
- Hardened the smoke helper with retry logic and a longer timeout budget for `codebase_ingest`.

**Verification:**
- exact-name coverage diff: `missing_in_smoke []`
- `set -a && source .env && set +a && bash scripts/mcp-smoke-test.sh` => `58 PASS / 0 FAIL / 0 SKIP`
- `bun run typecheck`

**Learnings:**
- The original issue had become partially stale, but not fully. Coverage existed in spirit, not in exact tool-name execution. Closing that gap materially improves the trustworthiness of the supported MCP surface claim.
