---
id: S014
title: "Observability and doctor alignment"
type: AFK
status: done
parent: "/Users/umasankr/Projects/ping-mem/docs/prds/2026-04-29-ground-up-local-trust-rebuild.md"
blocked_by: ["S009", "S010", "S011", "S012"]
tracks: ["OBJ-7", "OUT-7", "CAP-7", "FR-8", "FR-10", "FR-11", "AC-8", "AC-10", "ADR-006", "ADR-012", "ADR-017"]
---

## What to build

Align health, doctor/status, UI, logs, and alerts around the same capability truth model, and fix false-green checks such as direct MCP binary presence being treated as proxy readiness.

## Scope boundaries

- Owned surfaces: `/health`, doctor gates, CLI status, UI health/status pages, logs/alerts evidence, static/operator UI classification.
- Out of scope: broad dashboard redesign, new hosted observability, autonomous repair, re-adoption.
- Architecture/context updates required: if a status surface must be retired instead of corrected, record the decision in evidence and coverage.

## Traceability

- Objectives: OBJ-7
- Outcomes: OUT-7
- Capabilities: CAP-7
- User stories: US-4, US-9
- Functional requirements: FR-8, FR-10, FR-11
- Non-functional requirements: NFR-3, NFR-6, NFR-7
- Acceptance criteria: AC-8, AC-10
- Architecture decisions: ADR-006, ADR-012, ADR-017

## Acceptance criteria

- [x] Health/status reports capability states, not only component liveness.
- [x] Doctor gates prove approved adapter readiness and identity, not direct MCP binary presence.
- [x] UI/status pages distinguish healthy, empty, stale, blocked, error, unauthorized, timed out, and dependency down where relevant.
- [x] Logs/alerts include actionable layer and next action for tested failures.
- [x] The same scenario does not show green on one active surface and blocked/broken on another.

## Definition of done

- [x] Deterministic outcome: founder-facing status is honest and aligned.
- [x] Required code/docs/tests produced: doctor/status/UI/log alignment changes and tests.
- [x] Required verification run with exact command(s): status surface proof below.
- [x] Required evidence attached: cross-surface matrix and samples.

## Verification

- [x] Structural check command: `rg -n 'service.mcp-proxy-stdio|dist/mcp/cli|HealthMonitor|doctor|/health|/ui/health|alerts|blocked|stale|dependency' src scripts docs`
- [x] Automated test command: `bun test src/doctor src/observability src/http/ui src/http/__tests__/rest-api-new-routes.test.ts`
- [x] Automated test command: `bun run typecheck`
- [x] Runtime/manual proof steps: `curl -sf http://localhost:3003/health`
- [x] Runtime/manual proof steps: `bun run src/cli/index.ts doctor --json --quiet`
- [x] Runtime/manual proof steps: `curl -sf http://localhost:3003/ui/health`
- [x] Runtime/manual proof steps: `bun run src/cli/index.ts agent status --json --read-only`
- [x] PR-zero evidence required: cross-surface matrix maps every tested state to health, doctor/status, UI, logs, and alerts.

## Evidence artifacts

- Artifact/path: `docs/evidence/ground-up-local-trust/S014-observability-alignment.md`
- Artifact/path: `docs/evidence/ground-up-local-trust/S014-status-samples/`
- Command output: health, doctor, UI/HTML, logs, alerts.

## Scope vs promise delta

S014 proves cross-surface honesty for the sampled runtime state and removes the direct-MCP false-green doctor gate. It does not remediate stale sync heartbeat, data gate time budgets, or regression timeout gates; those remain visible doctor/UI failures rather than hidden status.

## Stop conditions for `/to-execute`

- Stop if fixing an active UI surface would require unapproved UX redesign rather than truthful state correction.
- Stop if a doctor gate can only pass by checking a quarantined direct-mode path.

## Blocked by

S009, S010, S011, S012

## Rollout / rollback notes

Rollback is normal git revert. Do not hide failures to make status green.
