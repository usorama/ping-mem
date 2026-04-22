---
status: ready
priority: p1
issue_id: "005"
tags: [execution, wave-2, ingestion, reconciliation, manifests, neo4j, qdrant]
dependencies: ["004"]
---

## Problem Statement

Recent fixes improved deterministic ingestion and low-memory deletion, but live graph/search/manifest state can still diverge by route or preserve stale debt.

## Findings

- project-scoped identities and low-memory deletes are now live
- old data debt existed and large orphan sweeps already proved that
- codebase delete and admin delete do not yet guarantee identical convergence semantics
- stale manifests and zero-edge structural re-ingests can preserve bad state
- existing follow-up todos `001` and `002` already cover important parts of this wave

## Proposed Solutions

### Option A

Rely on ad hoc deletes and natural re-ingestion.

- Pros: no coordinated migration work
- Cons: live state remains partially untrustworthy

### Option B

Run deliberate reconciliation across manifests, graph state, search state, and active project rows.

- Pros: aligns live state with the code and makes capability acceptance meaningful
- Cons: requires careful sequencing and verification

## Recommended Action

Execute Option B.

1. Use `001` and `002` as concrete sub-tasks inside this wave.
2. Unify delete/re-ingest semantics across routes.
3. Reconcile active project rows, manifests, structural edges, and search state together.

## Acceptance Criteria

- [ ] Active projects are authoritative after reconciliation.
- [ ] Delete and re-ingest converge without route-specific drift.
- [ ] Stale manifest and stale structural-edge behavior are closed.
- [ ] `#114`, `#134`, and the live-acceptance remainder of `#132` are grounded in this wave.

## Work Log

### 2026-04-22 - Wave created

**By:** Codex

**Actions:**
- Grouped existing runtime-ingestion follow-up todos under a larger state-convergence wave.
- Made manifest and structural cleanup mismatches first-class items in the same execution stream.

**Learnings:**
- The remaining work here is not another ingestion parser bug; it is live-state convergence.

### 2026-04-22 - Live reconciliation and persistence hardening

**By:** Codex

**Actions:**
- Removed stale zero-file graph projects and duplicate project-dir rows from the live fleet.
- Re-ingested the active project set intentionally with full-history settings.
- Hardened SQLite durability for `EventStore`, `AdminStore`, and `DiagnosticsStore` with `WAL + synchronous=FULL` and explicit `wal_checkpoint(FULL)` on close.
- Verified the earlier queue/admin-store reconciliation anomaly is closed in the live system:
  - queued no-change ingest for `/projects/rankforge`
  - confirmed admin-store `treeHash` and `lastIngestedAt` updated
  - restarted the container and confirmed the admin-store update persisted

**Learnings:**
- The earlier “admin reconciliation logged success but host-visible DB did not change” symptom was part of a broader durability/trust problem around SQLite state on the mounted volume.
- State convergence now includes persistence guarantees, not just graph cleanup.

### 2026-04-22 - Registered-set ingestion reconciliation

**By:** Codex

**Actions:**
- Re-ran the live coverage gate and found `/projects/ping-mem` at `0/211` commits despite the repo being a valid git worktree inside the container.
- Forced a full-history live re-ingest for `/projects/ping-mem`, which reconciled the Neo4j project row back to `211` commits and restored the canonical 5-project coverage gate to green.
- Force re-ingested the three continuity repos in `~/.ping-mem/registered-projects.txt`:
  - `/projects/sn-assist` -> `464` files, `334` commits
  - `/projects/understory` -> `235` files, `38` commits
  - `/projects/ping-learn-mobile` -> `32` files, `188` commits
- Verified that the current registered project set is now reconciled in live OrbStack state.
- Split the remaining stale-worktree/ad hoc project-list problem into new issue `#134` instead of overloading `#114`.

**Learnings:**
- `#114` was no longer primarily a filter bug; the active failure was stale persisted ingest state for one canonical project plus stale continuity-project rows.
- Corpus determinism and project inventory truth are adjacent but distinct wave-2 concerns.

### 2026-04-22 - Project inventory truth and stale-row reconciliation tooling

**By:** Codex

**Actions:**
- Changed `codebase_list_projects` / `GET /api/v1/codebase/projects` to return the registered/canonical project set by default.
- Added explicit `scope=all` support so stale/ad hoc ingests remain inspectable without polluting the default operator view.
- Added `scripts/reconcile-project-inventory.sh` to report and optionally delete unregistered stale rows.
- Verified live OrbStack behavior after redeploy:
  - default scope returns the 8 registered projects
  - `scope=all` returns the full 21-row ingest history

**Learnings:**
- Inventory truth is not the same as graph deletion. Operators need a truthful default view first, then deliberate cleanup tooling for historical residue.
