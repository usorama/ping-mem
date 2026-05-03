---
id: S013
title: "Recovery scenarios"
type: HITL
status: done
parent: "/Users/umasankr/Projects/ping-mem/docs/architecture/2026-04-29-ground-up-local-trust-rebuild.md"
blocked_by: ["S009", "S012"]
tracks: ["OBJ-6", "OUT-6", "CAP-6", "FR-9", "AC-9"]
---

## What to build

Run the architecture-defined local recovery scenarios and prove each recovers within the bounded window or reports an actionable blocker without silent repair.

## Scope boundaries

- Owned surfaces: recovery scenario scripts/checklists, readiness command use, evidence bundle, logs.
- Out of scope: autonomous self-healing, secret/config repair, re-adoption, expanding recovery to every possible machine event.
- Architecture/context updates required: human scheduling/approval is required for Mac sleep/wake, reboot/login, Docker/OrbStack disruption, and dependency restarts that may affect local work.

## Traceability

- Objectives: OBJ-6
- Outcomes: OUT-6
- Capabilities: CAP-6
- User stories: US-8
- Functional requirements: FR-9
- Non-functional requirements: NFR-1, NFR-2, NFR-7
- Acceptance criteria: AC-9
- Architecture decisions: ADR-006, ADR-010

## Acceptance criteria

- [x] ping-mem REST restart detects unavailable/degraded within 15s and recovers or blocks within 60s.
- [x] Neo4j and Qdrant restarts detect degraded status within 30s and recover or block within 120s.
- [x] Docker/OrbStack unavailable state reports dependency blocked without auto-start.
- [x] Mac sleep/wake and reboot/login are run with approval or recorded as HITL blockers.
- [x] Auth/config drift and stale launchd/watchdog state fail actionably without recreating secrets/config.

## Definition of done

- [x] Deterministic outcome: normal machine/dependency events are known quantities, not surprises.
- [x] Required code/docs/tests produced: scenario runner/checklist and evidence report.
- [x] Required verification run with exact command(s): approved scenario commands below.
- [x] Required evidence attached: recovery timings, health/status output, logs, blocker reasons.

## Verification

- [x] Structural check command: `rg -n 'docker restart|sleep|wake|reboot|launchctl|doctor|status' scripts docs src`
- [x] Automated test command: `bun test src/observability src/doctor src/cli`
- [x] Runtime/manual proof steps: `docker restart ping-mem` then poll `bun run src/cli/index.ts agent status --json --read-only`
- [x] Runtime/manual proof steps: `docker restart ping-mem-neo4j` then poll codebase/graph health through the readiness command.
- [x] Runtime/manual proof steps: `docker restart ping-mem-qdrant` then poll vector/search health through the readiness command.
- [x] Runtime/manual proof steps: approved Docker/OrbStack unavailable simulation, Mac sleep/wake, Mac reboot/login, auth/config drift, and launchd/watchdog stale-state checks.
- [x] PR-zero evidence required: each scenario row has `passed`, `blocked`, or `not-run-HITL` with exact reason.

## Evidence artifacts

- Artifact/path: `docs/evidence/ground-up-local-trust/S013-recovery-scenarios.md`
- Artifact/path: `docs/evidence/ground-up-local-trust/S013-logs/`
- Command output: timings, status JSON, docker/log excerpts, launchctl output where approved.

## Scope vs promise delta

S013 proves bounded recovery/actionable-blocker behavior for REST restart, Neo4j, Qdrant, Docker-unavailable simulation, auth/config drift simulation, and stale LaunchAgent state. Mac sleep/wake and reboot/login are explicitly `not-run-HITL` and remain unproven until a scheduled machine-event run.

## Stop conditions for `/to-execute`

- Stop if a scenario can disrupt current work and the user has not approved timing.
- Stop if read-only proof attempts repair, restart retry loops, or secret/config recreation.

## Blocked by

S009, S012

## Rollout / rollback notes

Record pre-state and post-state for every disruptive scenario. Do not proceed if rollback command/state is unknown.
