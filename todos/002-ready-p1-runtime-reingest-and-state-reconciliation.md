---
status: ready
priority: p1
issue_id: "002"
tags: [runtime, migration, neo4j, qdrant, soak, docs]
dependencies: ["001"]
---

## Problem Statement

The code now closes key deterministic ingestion gaps, but the live system state still reflects the pre-fix model and the documentation still overstates closure.

Without a controlled runtime migration, ping-mem can continue serving stale graph/search state even after the code is correct.

## Findings

- `state.md` and `docs/AGENT_INTEGRATION_GUIDE.md` still assert the remediation is fully closed and runtime-verified.
- Existing Neo4j/Qdrant/BM25 data was written with unscoped file/chunk identities.
- The new code path requires full project re-ingestion to realize the fix in live data.

## Proposed Solutions

### Option A

Leave runtime data as-is and rely on natural future ingests.

- Pros: No immediate operational work
- Cons: Old collisions/stale graph state remain live

### Option B

Run a controlled cleanup + full re-ingest for active projects, then verify outcomes and correct the state docs.

- Pros: Aligns live state with the code
- Cons: Requires careful verification and may expose additional data migration issues

## Recommended Action

Execute Option B:

1. Restart ping-mem so new constraints/defaults load.
2. Delete and re-ingest the active projects with full-history settings.
3. Verify `codebase_list_projects`, search hits, and graph dependency queries across multiple repos.
4. Reconcile `state.md` and related docs to reflect verified reality, not prior claims.

## Acceptance Criteria

- [ ] Active projects are re-ingested with the new code.
- [ ] Cross-repo same-path collisions are absent in live graph/search behavior.
- [ ] Runtime evidence exists for the post-fix state.
- [ ] Status docs no longer overclaim unverified closure.

## Work Log

### 2026-04-22 - Created follow-up runtime task

**By:** Codex

**Actions:**
- Split code-level deterministic fixes from runtime migration work.
- Captured the remaining operational tasks required to realize the fix in the live stack.

**Learnings:**
- Code correctness and live-state correctness are separate deliverables here.
