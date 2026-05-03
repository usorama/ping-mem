---
id: S009
title: "Failure-state honesty"
type: AFK
status: done
parent: "/Users/umasankr/Projects/ping-mem/docs/prds/2026-04-29-ground-up-local-trust-rebuild.md"
blocked_by: ["S005", "S006", "S007", "S008"]
tracks: ["OBJ-2", "OBJ-3", "OBJ-7", "OUT-2", "OUT-3", "OUT-7", "CAP-4", "CAP-5", "CAP-7", "FR-8", "FR-11", "AC-8", "AC-10", "ADR-006", "ADR-008", "ADR-009"]
---

## What to build

Make stale, missing, timed-out, blocked, unauthorized, dependency-down, and unavailable-runtime states first-class outcomes in approved CLI, REST, proof, health, and status paths.

## Scope boundaries

- Owned surfaces: CLI exit codes/JSON states, REST error mapping, proof failure fixtures, timeout/dependency-down interpretation.
- Out of scope: full observability UI/doctor alignment, recovery scenario execution, autonomous repair.
- Architecture/context updates required: none unless a failure state cannot be represented without changing the goal contract.

## Traceability

- Objectives: OBJ-2, OBJ-3, OBJ-7
- Outcomes: OUT-2, OUT-3, OUT-7
- Capabilities: CAP-4, CAP-5, CAP-7
- User stories: US-4, US-6, US-9
- Functional requirements: FR-8, FR-11
- Non-functional requirements: NFR-1, NFR-2, NFR-3, NFR-6, NFR-7
- Acceptance criteria: AC-8, AC-10
- Architecture decisions: ADR-006, ADR-008, ADR-009

## Acceptance criteria

- [x] Missing identity, stale data, missing data, timeout, unauthorized, dependency-down, and unavailable-runtime have distinct JSON states and exit/failure interpretation.
- [x] Approved proof commands never convert unauthorized/dependency-down/stale into empty success.
- [x] Read-only proof does not repair, restart, create credentials, or auto-start Docker.
- [x] Evidence names allowed completion claims and blocked broader claims for every negative scenario.

## Definition of done

- [x] Deterministic outcome: a broken ping-mem path tells the founder what is broken and what layer needs action.
- [x] Required code/docs/tests produced: failure-state tests and CLI/REST state mapping.
- [x] Required verification run with exact command(s): negative scenario commands and targeted tests below.
- [x] Required evidence attached: failure-state matrix and output samples.

## Verification

- [x] Structural check command: `rg -n 'timeout|unauthorized|stale|dependency|blocked|repair|tryStartDocker|currentSessionId' src scripts docs`
- [x] Automated test command: `bun test src/http src/cli src/mcp/__tests__/proxy-cli.test.ts src/observability`
- [x] Automated test command: `bun run typecheck`
- [x] Runtime/manual proof steps: `PING_MEM_REST_URL=http://127.0.0.1:9 bun run src/cli/index.ts agent status --json --timeout-ms 1000`
- [x] Runtime/manual proof steps: `bun run src/cli/index.ts agent proof memory-lifecycle --agent codex-local --project /Users/umasankr/Projects/ping-mem --simulate unauthorized --json`
- [x] Runtime/manual proof steps: `bun run src/cli/index.ts agent proof codebase-grounding --agent codex-local --project /Users/umasankr/Projects/ping-mem --simulate dependency-down --json`
- [x] PR-zero evidence required: scope delta states recovery and UI/doctor agreement remain S013/S014.

## Evidence artifacts

- Artifact/path: `docs/evidence/ground-up-local-trust/S009-failure-state-matrix.md`
- Artifact/path: `docs/evidence/ground-up-local-trust/S009-negative-samples/`
- Command output: JSON state samples and test output.

## Scope vs promise delta

S009 proves distinct approved CLI/proof failure states and read-only no-repair behavior for negative samples. It does not prove recovery scenario execution, UI/doctor/log agreement, or automatic repair; those remain S013 and S014.

## Stop conditions for `/to-execute`

- Stop if a negative scenario would require real credential destruction, service shutdown, or external writes beyond this issue.
- Stop if proof code attempts repair in a read-only acceptance path.

## Blocked by

S005, S006, S007, S008

## Rollout / rollback notes

Rollback is normal git revert. Negative fixtures must not alter real credentials or data.
