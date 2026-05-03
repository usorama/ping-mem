---
id: S006
title: "Claude Code memory path"
type: AFK
status: done
parent: "/Users/umasankr/Projects/ping-mem/docs/prds/2026-04-29-ground-up-local-trust-rebuild.md"
blocked_by: ["S003", "S004"]
tracks: ["OBJ-2", "OUT-2", "CAP-4", "FR-5", "FR-8", "AC-4", "AC-8", "ADR-003", "ADR-005", "ADR-006", "ADR-008"]
---

## What to build

Prove the Claude Code-approved path can save, search, retrieve, update or supersede, delete, and recall memory through the unified CLI over the live REST runtime with explicit Claude Code identity.

## Scope boundaries

- Owned surfaces: Claude Code skill contract, `ping-mem agent proof memory-lifecycle --agent claude-code-local`, memory lifecycle evidence.
- Out of scope: Codex proof, codebase grounding, Claude MCP config re-adoption, hooks/native sync.
- Architecture/context updates required: none unless Claude Code cannot use the unified CLI contract.

## Traceability

- Objectives: OBJ-2
- Outcomes: OUT-2
- Capabilities: CAP-4
- User stories: US-2, US-3, US-4
- Functional requirements: FR-5, FR-8
- Non-functional requirements: NFR-1, NFR-2, NFR-3, NFR-6
- Acceptance criteria: AC-4, AC-8
- Architecture decisions: ADR-003, ADR-005, ADR-006, ADR-008

## Acceptance criteria

- [x] Claude Code proof starts a session with `agentId=claude-code-local`, safe `projectDir`, and explicit session header reuse.
- [x] Proof covers save, search, retrieve, update/supersede, delete, and recall using unique test keys.
- [x] Delete is confirmed absent and stale/missing results are not reported as empty success.
- [x] The evidence bundle states allowed claim: "Claude Code memory lifecycle works for this approved local path."

## Definition of done

- [x] Deterministic outcome: Claude Code can rely on memory lifecycle behavior through the approved local path.
- [x] Required code/docs/tests produced: CLI proof command, Claude Code skill instructions, lifecycle assertions.
- [x] Required verification run with exact command(s): memory lifecycle proof and targeted tests below.
- [x] Required evidence attached: Claude Code memory lifecycle JSON bundle.

## Verification

- [x] Structural check command: `rg -n 'memory-lifecycle|claude-code-local|context_save|context_search|context_get|context_delete|recall' src docs .claude`
- [x] Automated test command: `bun test src/http/__tests__/agent-rest.test.ts src/memory/__tests__/MemoryManager.test.ts src/memory/__tests__/agent-scope.test.ts`
- [x] Automated test command: `bun run typecheck`
- [x] Runtime/manual proof steps: `bun run src/cli/index.ts agent proof memory-lifecycle --agent claude-code-local --project /Users/umasankr/Projects/ping-mem --json --evidence-dir docs/evidence/ground-up-local-trust/S006-claude-memory`
- [x] PR-zero evidence required: scope delta states Codex proof and codebase grounding are separate claims.

## Evidence artifacts

- Artifact/path: `docs/evidence/ground-up-local-trust/S006-claude-memory/`
- Command output: memory proof JSON and runtime target.

## Resolved blocker evidence

- Earlier CLI proof attempts were blocked by unavailable/stale runtime and then by a 5s CLI timeout while search took about 6s.
- OrbStack/runtime was brought up, the app container was rebuilt, and the memory lifecycle proof timeout was corrected to 30s.
- Final proof returned `status: "available"`, `ok: true`, and exit code `0` for `agentId=claude-code-local`.
- Evidence files:
  - `docs/evidence/ground-up-local-trust/S006-claude-memory/proof.json`
  - `docs/evidence/ground-up-local-trust/S006-claude-memory/proof.exit`
  - `docs/evidence/ground-up-local-trust/runtime-health-after-timeout-patch.json`

## Scope vs promise delta

S006 proves the Claude Code memory lifecycle only for the approved local REST path and `agentId=claude-code-local`. Codex memory is proven separately in S005; codebase grounding, failure-state closure, recovery, observability, and re-adoption remain separate slices.

## Stop conditions for `/to-execute`

- Stop if proof uses Claude MCP direct DB mode, disabled hooks, or fallback session state.
- Stop if proof requires writing Claude Code config before S015.

## Blocked by

S003, S004

## Rollout / rollback notes

Use unique test keys and clean up only those keys. Do not alter live Claude Code config in this slice.
