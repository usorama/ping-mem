---
id: S003
title: "Unified CLI trust spine"
type: AFK
status: done
parent: "/Users/umasankr/Projects/ping-mem/docs/architecture/2026-04-29-ground-up-local-trust-rebuild.md"
blocked_by: ["S001", "S002"]
tracks: ["OBJ-1", "OBJ-2", "OBJ-3", "OBJ-8", "OUT-1", "OUT-2", "OUT-3", "OUT-8", "CAP-2", "CAP-4", "CAP-5", "CAP-8", "FR-5", "FR-6", "FR-11", "FR-12", "AC-3", "AC-4", "AC-5", "AC-6", "AC-11", "ADR-003", "ADR-004", "ADR-006", "ADR-008", "ADR-009"]
---

## What to build

Create the shared `ping-mem agent` CLI trust spine over REST for Codex and Claude Code, with stable JSON output, bounded timeouts, secret-safe machine-local auth, read-only proof commands, evidence bundle output, and no hidden repair behavior.

## Scope boundaries

- Owned surfaces: `src/cli/*`, `src/client/rest-client.ts`, CLI auth/session storage behavior, Codex/Claude skill contract drafts, proof command skeletons.
- Out of scope: full memory/codebase proof completion for each agent; MCP proxy re-adoption.
- Architecture/context updates required: route back to `/to-architect` if CLI cannot talk only to REST.

## Traceability

- Objectives: OBJ-1, OBJ-2, OBJ-3, OBJ-8
- Outcomes: OUT-1, OUT-2, OUT-3, OUT-8
- Capabilities: CAP-2, CAP-4, CAP-5, CAP-8
- User stories: US-1, US-2, US-3, US-5, US-6, US-10
- Functional requirements: FR-5, FR-6, FR-11, FR-12
- Non-functional requirements: NFR-1, NFR-2, NFR-5, NFR-6, NFR-8
- Acceptance criteria: AC-3, AC-4, AC-5, AC-6, AC-11
- Architecture decisions: ADR-003, ADR-004, ADR-006, ADR-008, ADR-009

## Acceptance criteria

- [x] CLI command family exists as `ping-mem agent ... --json` or an explicitly equivalent package command.
- [x] CLI talks only to REST and does not import DB/EventStore/MemoryManager/service classes for approved paths.
- [x] CLI emits stable JSON, exit codes, elapsed time, runtime target, and evidence bundle paths.
- [x] CLI proof/status commands are read-only by default; repair requires separate explicit command or flag.
- [x] Secret values are read from machine-local auth files/env and are never committed or printed.
- [x] Docker/REST unavailable state returns a blocked/unavailable result without auto-starting Docker.

## Definition of done

- [x] Deterministic outcome: both agents have one shared command surface for later memory and codebase proof.
- [x] Required code/docs/tests produced: CLI commands, tests, skill-contract draft docs, evidence format.
- [x] Required verification run with exact command(s): commands below pass or fail with expected blocked states.
- [x] Required evidence attached: JSON schema examples and unavailable-runtime negative proof.

## Verification

- [x] Structural check command: `rg -n 'from .*EventStore|from .*MemoryManager|from .*IngestionService|from .*Neo4j|from .*Qdrant' src/cli src/client`
- [x] Automated test command: `bun test src/cli src/client`
- [x] Automated test command: `bun run typecheck`
- [x] Runtime/manual proof steps: `bun run src/cli/index.ts agent status --json --timeout-ms 5000`
- [x] Runtime/manual proof steps: `PING_MEM_REST_URL=http://127.0.0.1:9 bun run src/cli/index.ts agent status --json --timeout-ms 1000`
- [x] Runtime/manual proof steps: `bun run src/cli/index.ts agent proof memory-lifecycle --agent codex-local --project /Users/umasankr/Projects/ping-mem --dry-run --json`
- [x] PR-zero evidence required: scope delta says the CLI spine exists but agent lifecycle proofs remain S005-S008.

## Evidence artifacts

- Artifact/path: `docs/evidence/ground-up-local-trust/S003-cli-contract.md`
- Artifact/path: `docs/evidence/ground-up-local-trust/S003-cli-json-examples/`
- Command output: CLI status, dry-run proof, unavailable-runtime negative proof.

## Stop conditions for `/to-execute`

- Stop if the CLI needs direct DB imports for approved paths.
- Stop if a proof command starts Docker or mutates runtime state without explicit repair flag.
- Stop if auth requires committing or printing a secret.

## Blocked by

S001, S002

## Rollout / rollback notes

Rollback is normal git revert. Do not modify live Codex/Claude configs in this slice.

## Completion evidence

- Evidence artifact: `docs/evidence/ground-up-local-trust/S003-cli-contract.md`
- JSON examples: `docs/evidence/ground-up-local-trust/S003-cli-json-examples/`
- Code: `src/cli/agent-trust.ts`, `src/cli/commands/agent.ts`
- Tests: `src/cli/__tests__/agent-trust.test.ts`
- Structural check: no direct `EventStore`, `MemoryManager`, `IngestionService`, `Neo4j`, or `Qdrant` imports in `src/cli` or `src/client`.
- Automated tests: `bun test src/cli src/client` -> `31 pass, 0 fail`.
- Typecheck: `bun run typecheck` passed.
- Runtime negative proof: localhost and forced-unavailable runtime both returned blocked JSON and exit `2` without repair.
- Dry-run proof: `agent proof memory-lifecycle --dry-run` returned read-only JSON and exit `0`.

## Scope vs Promise Delta

S003 proves the shared REST-only CLI trust spine and evidence format. It does not prove operational memory lifecycle, codebase grounding, full identity enforcement, registry alignment, recovery, observability alignment, or re-adoption. Those remain owned by S004-S015.
