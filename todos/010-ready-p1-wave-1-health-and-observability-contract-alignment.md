---
status: ready
priority: p1
issue_id: "010"
tags: [execution, wave-1, health, observability, doctor, readiness]
dependencies: ["004", "009"]
---

## Problem Statement

Health surfaces must describe the same runtime truth, or every later acceptance gate remains suspect.

## Findings

- `/health`, `/api/v1/observability/status`, compose healthchecks, and `health:shallow` previously diverged
- live SQLite corruption proved that monitor alerts can be the real source of degraded status
- doctor and UI surfaces need to reflect the same effective health semantics

## Recommended Action

1. Keep `/health`, observability status, readiness, and healthcheck scripts aligned on effective health truth.
2. Verify the post-recovery behavior against live doctor and UI surfaces.
3. Close any remaining false-green or stale-history interpretation gaps.

## Acceptance Criteria

- [ ] Live health surfaces agree on health semantics.
- [ ] Compose and script healthchecks fail on degraded state, not just transport reachability.
- [ ] Doctor/UI health semantics are grounded against the live service.

