---
id: S010
title: "Runtime project registry alignment"
type: AFK
status: done
parent: "/Users/umasankr/Projects/ping-mem/docs/prds/2026-04-29-ground-up-local-trust-rebuild.md"
blocked_by: ["S001", "S002"]
tracks: ["OBJ-3", "OBJ-4", "OBJ-7", "OUT-3", "OUT-4", "OUT-7", "CAP-1", "CAP-5", "CAP-7", "FR-6", "FR-8", "FR-10", "AC-5", "AC-6", "AC-10", "ADR-001", "ADR-014"]
---

## What to build

Align runtime project registry truth across REST, CLI, codebase proof, and UI/status surfaces so registered-project evidence comes from the live runtime API, not host-only assumptions or direct file reads.

## Scope boundaries

- Owned surfaces: `/api/v1/codebase/projects?scope=registered`, CLI `codebase projects --scope registered`, `src/ingest/registered-projects.ts`, UI ingestion/status reads.
- Out of scope: all-repo/language coverage, broad UI redesign, deleting real project records.
- Architecture/context updates required: record selected proof repos and any unresolvable registry source conflict.

## Traceability

- Objectives: OBJ-3, OBJ-4, OBJ-7
- Outcomes: OUT-3, OUT-4, OUT-7
- Capabilities: CAP-1, CAP-5, CAP-7
- User stories: US-5, US-6, US-9
- Functional requirements: FR-6, FR-8, FR-10
- Non-functional requirements: NFR-2, NFR-3, NFR-4, NFR-7
- Acceptance criteria: AC-5, AC-6, AC-10
- Architecture decisions: ADR-001, ADR-014

## Acceptance criteria

- [x] REST projects endpoint exposes and documents `scope=registered` as the default or explicit proof mode.
- [x] CLI supports `agent codebase projects --scope registered --json`.
- [x] UI ingestion/status surfaces stop relying on host-only `~/.ping-mem/registered-projects.txt` for readiness claims.
- [x] Evidence records the runtime registered-project denominator used by S007/S008.

## Definition of done

- [x] Deterministic outcome: codebase proof and UI/status use the same runtime project registry truth.
- [x] Required code/docs/tests produced: registry alignment tests, CLI option, UI/status alignment if needed.
- [x] Required verification run with exact command(s): endpoint, CLI, and UI tests below.
- [x] Required evidence attached: registry denominator and cross-surface output.

## Verification

- [x] Structural check command: `rg -n 'registered-projects|scope=registered|codebase/projects|~/.ping-mem/registered-projects.txt' src scripts docs`
- [x] Automated test command: `bun test src/ingest/__tests__/registered-projects.test.ts src/ingest/__tests__/IngestionService.list-projects.test.ts src/http/__tests__/rest-api-new-routes.test.ts src/http/ui/__tests__/ingestion.test.ts`
- [x] Automated test command: `bun run typecheck`
- [x] Runtime/manual proof steps: `curl -sf 'http://localhost:3003/api/v1/codebase/projects?scope=registered&limit=1000'`
- [x] Runtime/manual proof steps: `bun run src/cli/index.ts agent codebase projects --scope registered --json`
- [x] PR-zero evidence required: scope delta states registry alignment is proven only for selected local runtime paths.

## Evidence artifacts

- Artifact/path: `docs/evidence/ground-up-local-trust/S010-registry-alignment.md`
- Command output: REST and CLI project registry JSON, UI/status evidence if changed.

## Resolved blocker evidence

- Earlier REST and agent CLI registry proofs were blocked because `localhost:3003` was unavailable.
- After OrbStack/runtime recovery and app container rebuild, REST and agent CLI registry proofs both exited `0`.
- The live runtime registered-project denominator for S007/S008 is `count=3`: `/projects/vunderstory`, `/projects/ping-learn`, and `/projects/ping-learn-mobile`.

## Scope vs promise delta

S010 aligns and proves the runtime registered-project denominator for REST, CLI, agent CLI, and UI ingestion/status paths. Codebase grounding, failure-state closure, observability agreement, and re-adoption remain separate slices.

## Stop conditions for `/to-execute`

- Stop if registry reconciliation would delete or rewrite project records without a separate approved migration/cleanup issue.
- Stop if runtime and host registries conflict and no safe authoritative source can be established.

## Blocked by

S001, S002

## Rollout / rollback notes

Rollback is normal git revert. Do not remove real project records in this issue.
