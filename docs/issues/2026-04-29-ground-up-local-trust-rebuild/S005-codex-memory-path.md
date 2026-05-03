---
id: S005
title: "Codex memory path"
type: AFK
status: done
parent: "/Users/umasankr/Projects/ping-mem/docs/prds/2026-04-29-ground-up-local-trust-rebuild.md"
blocked_by: ["S003", "S004"]
tracks: ["OBJ-2", "OUT-2", "CAP-4", "FR-5", "FR-8", "AC-3", "AC-8", "ADR-003", "ADR-005", "ADR-006", "ADR-008"]
---

## What to build

Prove the Codex-approved path can save, search, retrieve, update or supersede, delete, and recall memory through the unified CLI over the live REST runtime with explicit Codex identity.

## Scope boundaries

- Owned surfaces: Codex skill contract, `ping-mem agent proof memory-lifecycle --agent codex-local`, memory lifecycle test fixtures/evidence.
- Out of scope: Claude Code proof, codebase grounding, re-adoption config writes.
- Architecture/context updates required: none unless Codex cannot use the unified CLI contract.

## Traceability

- Objectives: OBJ-2
- Outcomes: OUT-2
- Capabilities: CAP-4
- User stories: US-1, US-3, US-4
- Functional requirements: FR-5, FR-8
- Non-functional requirements: NFR-1, NFR-2, NFR-3, NFR-6
- Acceptance criteria: AC-3, AC-8
- Architecture decisions: ADR-003, ADR-005, ADR-006, ADR-008

## Acceptance criteria

- [x] Codex proof starts a session with `agentId=codex-local`, safe `projectDir`, and explicit session header reuse.
- [x] Proof covers save, search, retrieve, update/supersede, delete, and recall using unique test keys.
- [x] Delete is confirmed absent and does not leave a false-positive recall result.
- [x] The evidence bundle states allowed claim: "Codex memory lifecycle works for this approved local path."

## Definition of done

- [x] Deterministic outcome: Codex can rely on memory lifecycle behavior through the approved local path.
- [x] Required code/docs/tests produced: CLI proof command, Codex skill instructions, lifecycle assertions.
- [x] Required verification run with exact command(s): memory lifecycle proof and targeted tests below.
- [x] Required evidence attached: Codex memory lifecycle JSON bundle.

## Verification

- [x] Structural check command: `rg -n 'memory-lifecycle|codex-local|context_save|context_search|context_get|context_delete|recall' src docs .codex`
- [x] Automated test command: `bun test src/http/__tests__/agent-rest.test.ts src/memory/__tests__/MemoryManager.test.ts src/memory/__tests__/supersede-semantics.test.ts`
- [x] Automated test command: `bun run typecheck`
- [x] Runtime/manual proof steps: `bun run src/cli/index.ts agent proof memory-lifecycle --agent codex-local --project /Users/umasankr/Projects/ping-mem --json --evidence-dir docs/evidence/ground-up-local-trust/S005-codex-memory`
- [x] PR-zero evidence required: scope delta states Claude memory and codebase grounding remain unproven.

## Evidence artifacts

- Artifact/path: `docs/evidence/ground-up-local-trust/S005-codex-memory/`
- Command output: memory proof JSON and runtime target.

## Resolved blocker evidence

- Earlier CLI proof attempts were blocked by unavailable/stale runtime and then by a 5s CLI timeout while search took about 6s.
- OrbStack/runtime was brought up, the app container was rebuilt, and the memory lifecycle proof timeout was corrected to 30s.
- Final proof returned `status: "available"`, `ok: true`, and exit code `0` for `agentId=codex-local`.
- Evidence files:
  - `docs/evidence/ground-up-local-trust/S005-codex-memory/proof.json`
  - `docs/evidence/ground-up-local-trust/S005-codex-memory/proof.exit`
  - `docs/evidence/ground-up-local-trust/runtime-health-after-timeout-patch.json`

## Scope vs promise delta

S005 proves the Codex memory lifecycle only for the approved local REST path and `agentId=codex-local`. Claude memory is proven separately in S006; codebase grounding, failure-state closure, recovery, observability, and re-adoption remain separate slices.

## Stop conditions for `/to-execute`

- Stop if proof uses direct MCP DB mode, direct DB scripts, hidden hooks, or fallback session state.
- Stop if unique test memory cleanup would delete real founder data.

## Blocked by

S003, S004

## Rollout / rollback notes

Use unique test keys and clean up only those keys. Do not alter live Codex config in this slice.
