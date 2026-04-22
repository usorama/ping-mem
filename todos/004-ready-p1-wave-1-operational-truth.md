---
status: ready
priority: p1
issue_id: "004"
tags: [execution, wave-1, health, doctor, sessions, transport]
dependencies: ["003"]
---

## Problem Statement

ping-mem cannot trust later capability acceptance while its operational truth surfaces still disagree.

Health, doctor, readiness, dashboard, and session semantics currently allow false-green or ambiguous states.

## Findings

- `/health` can report `degraded` while component details look healthy
- compose and shallow-health checks still treat HTTP 200 as healthy
- `/ui/health` mixes historical doctor state with live signals
- logs show repeated no-`X-Session-ID` ambiguity when multiple sessions are active
- direct-DB MCP, REST, and SSE/client semantics are not yet fully aligned

## Proposed Solutions

### Option A

Keep current semantics and document caveats.

- Pros: minimal code churn
- Cons: false-green behavior persists and every later verification remains suspect

### Option B

Fix or explicitly narrow operational truth semantics, then harden session behavior and transport parity.

- Pros: makes later waves measurable and trustworthy
- Cons: touches multiple user-entry surfaces

## Recommended Action

Execute Option B.

1. Trace the degraded health cause and align `/health`, doctor, readiness, shallow-health, and `/ui/health`.
2. Make session ambiguity deterministic across REST/SSE/MCP/shell surfaces.
3. Tighten API/transport semantics where callers currently get warnings or soft failures.

## Acceptance Criteria

- [ ] `/health`, doctor, and `/ui/health` agree on service-state semantics.
- [ ] Healthchecks and shallow-health surfaces no longer report false green.
- [ ] Session ambiguity is eliminated or converted into a hard contract.
- [ ] Relevant issue mapping is captured for `#95` and `#122`.

## Work Log

### 2026-04-22 - Wave created

**By:** Codex

**Actions:**
- Captured operational truth as its own wave ahead of runtime reconciliation.
- Folded REST contract and SSE parity work into the same trust surface.

**Learnings:**
- This wave has to precede state cleanup, otherwise later “green” evidence remains contaminated.

### 2026-04-22 - Health truth recovery + contract hardening

**By:** Codex

**Actions:**
- Captured and verified that the degraded `/health` state was caused by a real SQLite corruption, not just stale alerts.
- Recovered the live core store by rebuilding a clean SQLite database from dumpable contents, removing one orphan checkpoint row, backing up the original live DB, swapping the repaired DB into `/Users/umasankr/.ping-mem/ping-mem.db`, and restarting the container.
- Verified post-recovery `PRAGMA quick_check` is `ok`, `/health` is `status:\"ok\"`, and observability no longer carries the SQLite integrity alert.
- Patched health semantics so `docker-compose` and `health:shallow` require `status:\"ok\"` instead of raw HTTP 200/TCP-only success.
- Patched `/api/v1/observability/status` to report the same effective health truth as `/health`.
- Patched shell routes to use the same session-disambiguation logic as the rest of REST.
- Added focused REST tests for observability-status truth and shell-route ambiguity handling.

**Learnings:**
- The earlier degraded state was legitimate: the live `events` table was corrupted and `quick_check` consistently reported row-order/index errors.
- After recovery, the remaining doctor failures are no longer health-surface failures; they are stale-ingest age, log rotation, and search/regression quality issues.

### 2026-04-22 - Doctor operational truth reached live green

**By:** Codex

**Actions:**
- Updated the log-hygiene gate so a recent `log-rotate.log` execution counts as valid evidence when archives remain old only because no file crossed the rotation threshold.
- Rebuilt local `dist`, rebuilt the OrbStack container, and verified the running container ships the patched doctor gate.
- Re-ran live `doctor` against the OrbStack deployment and reached `34/34` passing gates.

**Learnings:**
- The remaining log-hygiene failure was not a real operational defect; it was a mismatch between the gate’s evidence model and the actual rotation mechanism.
- Wave 1’s critical operator-truth path is now materially stronger because `/health` and `doctor` are both green on the live deployment.
