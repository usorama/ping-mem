---
title: "fix: ping-mem wave 0 truth baseline"
type: evidence
date: 2026-04-22
status: active
parent_plan: docs/plans/2026-04-22-fix-deterministic-capability-grounding-plan.md
execution_plan: docs/plans/2026-04-22-deterministic-capability-execution-waves.md
github_issue: 133
verification_method: "Live runtime evidence from the running container, doctor output, REST responses, logs, MCP/tool reads, and current code-path inspection"
---

# Wave 0 Truth Baseline

This document freezes the live baseline before further remediation work.

It is intentionally evidence-first. The point is to replace stale closure claims with the current truth.

## Baseline Time

- Captured on `2026-04-22`
- Running stack:
  - `ping-mem` container up and Docker-healthy on `localhost:3003`
  - `neo4j` container up and Docker-healthy
  - `qdrant` container up and Docker-healthy

## Executive Summary

The live system is not in a closed or all-green state.

At baseline:

- Docker reports the `ping-mem` container as healthy while `/health` returns `status:"degraded"`.
- `bun run doctor --json --quiet` reports `27 pass / 7 fail / exitCode 2`.
- canonical regression behavior is partial, not green: 6 of 10 current doctor regression gates passed and 4 failed.
- project state is not converged: `40` project rows exist, `19` have `filesCount=0`, and several root paths have duplicate rows.
- session surfaces are inconsistent: direct context tooling shows multiple active sessions while the doctor gate reports `0 active / cap 100`.

So the old closure story in `state.md` is false relative to current runtime evidence.

## Evidence

### 1. Health Truth Is Contradictory Across Surfaces

#### Live `/health`

Observed response:

```json
{
  "status": "degraded",
  "components": {
    "sqlite": "healthy",
    "neo4j": "healthy",
    "qdrant": "healthy",
    "diagnostics": "healthy"
  },
  "embeddingProvider": "ollama"
}
```

Evidence:

- `curl http://localhost:3003/health`
- implementation at [src/http/rest-server.ts](/Users/umasankr/Projects/ping-mem/src/http/rest-server.ts:494)

Current code marks the response degraded when:

- the cached health snapshot is not `"ok"`, or
- `HealthMonitor` has an active critical alert, even if all visible component statuses are healthy

That behavior is visible in:

- [src/http/rest-server.ts](/Users/umasankr/Projects/ping-mem/src/http/rest-server.ts:494)
- [src/observability/HealthMonitor.ts](/Users/umasankr/Projects/ping-mem/src/observability/HealthMonitor.ts:40)

#### Docker and shallow-health still read green

Current repo surfaces still treat HTTP 200 as healthy:

- [package.json](/Users/umasankr/Projects/ping-mem/package.json:52) `health:shallow`
- [docker-compose.prod.yml](/Users/umasankr/Projects/ping-mem/docker-compose.prod.yml:87) healthcheck
- development compose still uses a bare TCP check instead of response semantics
  - [docker-compose.yml](/Users/umasankr/Projects/ping-mem/docker-compose.yml:102)
- [docs/claude/api-contract.md](/Users/umasankr/Projects/ping-mem/docs/claude/api-contract.md:23) still says `/health` is "always 200"

This means operational truth is split:

- HTTP status says healthy enough
- body says degraded
- Docker says healthy
- docs still normalize that as expected

There is also a separate concrete script bug:

- `bun run health:shallow` currently fails because it curls `http://localhost:6333/health`, which returns `404` on this Qdrant setup
- the script still claims to be a valid shallow-health signal

#### HealthMonitor log evidence

Container logs show the current degraded source:

- repeated `CRITICAL integrity_ok=0 below 1`
- module: `HealthMonitor`

Relevant code path:

- [src/observability/HealthMonitor.ts](/Users/umasankr/Projects/ping-mem/src/observability/HealthMonitor.ts:40)

Direct confirmation from inside the running container showed the alert is real, not just stale monitor state:

```json
{"quick_check":"*** in database main ***\nTree 3 page 1154 cell 13: Rowid 7759 out of order"}
```

This was reproduced three times in a row against `/data/ping-mem.db` using Bun's SQLite binding inside the container.

So the current baseline truth is:

- `/health` is degraded for a legitimate SQLite integrity reason
- other surfaces are masking or bypassing that reason differently

### 2. Doctor Is Not Green

`bun run doctor --json --quiet` returned:

- `34` gates total
- `27` pass
- `7` fail
- `exitCode: 2`

Observed failed gates:

- `service.rest-health` → `degraded`
- `data.last-ingest-age` → `oldest=ping-guard 73.5h`
- `loghyg.rotation-recent` → newest archive too old
- `regression.q2-firebase-fcm-pinglearn-c63a2` → `0 hit(s)`
- `regression.q3-classroom-redesign-worktree` → `0 hit(s)`
- `regression.q6-pinglearn-voice-tutor-livekit` → `0 hit(s)`
- `regression.q7-supabase-migration-consent-tokens` → `0 hit(s)`

Relevant doctor gate code:

- [src/doctor/gates/service.ts](/Users/umasankr/Projects/ping-mem/src/doctor/gates/service.ts:24)
- [src/doctor/gates/data.ts](/Users/umasankr/Projects/ping-mem/src/doctor/gates/data.ts:1)

This directly contradicts the repo’s active operator story that all gates are green.

### 3. `/ui/health` Mixes Historical And Live Signals

Observed behavior:

- `GET /ui/health` returns `200` and renders the doctor dashboard

Current implementation is split:

- `/ui/health` page reads persisted doctor run JSONL from `RUNS_DIR`
- nav/header health dot uses a direct live `probeSystemHealth()` partial

Relevant code:

- [src/http/ui/health.ts](/Users/umasankr/Projects/ping-mem/src/http/ui/health.ts:1)
- [src/http/ui/partials/health.ts](/Users/umasankr/Projects/ping-mem/src/http/ui/partials/health.ts:1)

This confirms the Wave 0 claim: operators can read a greener historical dashboard even while the live probe surface is degraded.

There is another split truth surface:

- `/api/v1/observability/status` returns `health.status:"ok"` from a live probe with `skipIntegrityCheck:true`
- the same payload can still include `monitor.activeAlerts` containing a critical SQLite integrity alert
- `/health` then degrades from the alert state even while `observability/status.health` is `"ok"`

So the repo currently exposes three different “truth” interpretations:

- `/health`
- `/api/v1/observability/status`
- `/ui/health` plus its live dot partial

### 4. Project State Is Not Converged

Current `codebase_list_projects` baseline:

- `40` total project rows
- `19` rows with `filesCount=0`
- duplicate root paths still exist for:
  - `/projects/Business-apps/agent-os`
  - `/projects/auto-os`
  - `/projects/thrivetree`
  - `/projects/command-center`

Recent authoritative active rows do exist for major repos, for example:

- `/projects/ping-mem` → `514 files / 2025 chunks / 211 commits`
- `/projects/rankforge` → `192 files / 1112 chunks / 90 commits`
- `/projects/ping-learn` → `1191 files / 3420 chunks / 728 commits`

But the overall project list is not authoritative because the stale zero-file rows remain.

This is a Wave 2 state-convergence problem, but it is already present in the Wave 0 baseline.

### 5. Session Surfaces Are Inconsistent

Direct context tooling currently shows multiple active sessions, including:

- several `ping-mem-doctor` sessions
- `native-sync`
- the current execution-grounding session

At the same time, the doctor gate `service.session-cap-utilization` reported:

- `0 active / cap 100`

And container logs show real ambiguity warnings:

- `no X-Session-ID header and multiple active sessions — cannot pick one`

Relevant code:

- [src/http/rest-server.ts](/Users/umasankr/Projects/ping-mem/src/http/rest-server.ts:3976)

There is also route-level inconsistency:

- the canonical REST helper rejects ambiguity when no `X-Session-ID` is present
- shell-facing routes bypass that stricter logic and fall back differently

This means session determinism is not currently uniform across the exposed REST surface.

Observed authenticated REST check:

- `/api/v1/session/list?status=active&limit=200` returned `0` active sessions

That means session truth differs across at least two surfaces:

- direct context/session storage view
- authenticated REST list used by the doctor gate

This is exactly the kind of contract mismatch Wave 1 has to resolve.

### 6. Search / Regression Truth Is Partial

Doctor’s current regression baseline is not green.

Passing at capture time:

- q1 `ping-learn pricing research`
- q4 `PR #236 JWT secret isolation`
- q5 `DPDP consent age 18`
- q8 `ollama qwen3 8b recovery brain`
- q9 `ping-mem doctor gates 29`
- q10 `native sync hook truncation fix`

Failing at capture time:

- q2 `Firebase FCM pinglearn-c63a2`
- q3 `classroom redesign worktree`
- q6 `pinglearn voice tutor livekit`
- q7 `supabase migration consent tokens`

Direct authenticated REST confirmation for q2 also returned `0` hits.

So the current regression story is materially weaker than the older repo narrative of universal green search/recall behavior.

### 7. Code Paths Already Confirm Known Contract Drift

Current code inspection confirms known mismatches are still real:

- `/health` returns `status:"degraded"` with HTTP `200` unless SQLite itself is unreachable
  - [src/http/rest-server.ts](/Users/umasankr/Projects/ping-mem/src/http/rest-server.ts:494)
- session routing intentionally fails ambiguous calls when multiple sessions exist and no `X-Session-ID` is provided
  - [src/http/rest-server.ts](/Users/umasankr/Projects/ping-mem/src/http/rest-server.ts:3976)
- `ManifestStore` only loads/saves and does not itself participate in delete cleanup
  - [src/ingest/ManifestStore.ts](/Users/umasankr/Projects/ping-mem/src/ingest/ManifestStore.ts:1)
- `IngestionOrchestrator` still short-circuits on unchanged manifests when not forcing re-ingest
  - [src/ingest/IngestionOrchestrator.ts](/Users/umasankr/Projects/ping-mem/src/ingest/IngestionOrchestrator.ts:82)
- structural-edge cleanup still only happens when new structural edges exist
  - [src/ingest/IngestionService.ts](/Users/umasankr/Projects/ping-mem/src/ingest/IngestionService.ts:457)
- low-memory project deletion is now batched and live
  - [src/graph/TemporalCodeGraph.ts](/Users/umasankr/Projects/ping-mem/src/graph/TemporalCodeGraph.ts:291)

## Invalid Active Claims

These active repo claims are invalid at baseline:

- [state.md](/Users/umasankr/Projects/ping-mem/state.md:1) says all 8 phases are closed and all gates are green
- `state.md` also claims 10/10 regression queries pass and baseline soak day 0 is green
- current runtime evidence shows 7 doctor failures and 4 failing doctor regression queries

## What This Means For Execution

Wave 0 is now grounded enough to proceed.

The next correct move is Wave 1, starting with:

1. trace the `sqlite integrity_ok=0` degraded-health path
2. reconcile `/health`, doctor, Docker healthchecks, and `/ui/health`
3. resolve the session-surface mismatch between direct context/session truth and authenticated REST truth

Wave 2 should not begin until those operational truth surfaces are credible.
