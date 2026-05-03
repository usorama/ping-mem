---
id: S002
title: "REST runtime ownership and direct-mode quarantine"
type: AFK
status: done
parent: "/Users/umasankr/Projects/ping-mem/docs/architecture/2026-04-29-ground-up-local-trust-rebuild.md"
blocked_by: ["S001"]
tracks: ["OBJ-4", "OUT-4", "CAP-1", "FR-3", "FR-4", "AC-2", "ADR-001", "ADR-002", "ADR-015"]
---

## What to build

Make the live REST/server process the explicit approved owner for active writes, sessions, memory state, codebase indexing, and project registry truth, while direct MCP DB mode and write-capable maintenance scripts are blocked from approved agent proof or classified offline/dev-only.

## Scope boundaries

- Owned surfaces: `package.json` direct-mode scripts/bin policy, MCP direct/proxy classification, write-capable maintenance scripts, REST ownership tests/docs, evidence ledger.
- Out of scope: implementing the full unified CLI, re-enabling MCP proxy, deleting direct-mode code without architecture review.
- Architecture/context updates required: any exception to REST ownership must be routed to `/to-architect`.

## Traceability

- Objectives: OBJ-4
- Outcomes: OUT-4
- Capabilities: CAP-1
- User stories: US-3
- Functional requirements: FR-3, FR-4
- Non-functional requirements: NFR-4, NFR-5
- Acceptance criteria: AC-2
- Architecture decisions: ADR-001, ADR-002, ADR-015

## Acceptance criteria

- [x] Approved-path docs/tests say REST is the only live owner for active writes, sessions, memory state, codebase indexes, and runtime registry truth.
- [x] `ping-mem-mcp`, `start:mcp`, direct `src/mcp/PingMemServer.ts` mode, and direct DB maintenance scripts are blocked from acceptance/re-adoption proof or labeled offline/dev-only.
- [x] Write-capable scripts that touch Neo4j, Qdrant, EventStore, or local DBs outside REST cannot run as acceptance, recovery, doctor, or agent proof commands.
- [x] Evidence distinguishes "direct mode still exists for offline/dev" from "direct mode is approved for live agents" so the final claim cannot overreach.

## Definition of done

- [x] Deterministic outcome: no approved issue or proof command can use direct DB paths as evidence of local agent trust.
- [x] Required code/docs/tests produced: narrow guardrails/tests/docs needed to enforce or verify the ownership boundary.
- [x] Required verification run with exact command(s): `bun run typecheck` and targeted tests listed below.
- [x] Required evidence attached: direct-mode quarantine ledger and test output.

## Verification

- [x] Structural check command: `rg -n 'dist/mcp/cli|ping-mem-mcp|start:mcp|direct-ingest|force-ingest|reindex-qdrant|migrate-from-memory-keeper' package.json scripts src docs README.md CLAUDE.md AGENT_INSTRUCTIONS.md`
- [x] Automated test command: `bun test src/mcp/__tests__/PingMemServer.test.ts src/mcp/__tests__/proxy-cli.test.ts src/storage/__tests__/EventStore.test.ts`
- [x] Automated test command: `bun run typecheck`
- [x] Runtime/manual proof steps: produce `docs/evidence/ground-up-local-trust/S002-direct-mode-quarantine.md` with each direct/offline path and its approved disposition.
- [x] PR-zero evidence required: scope delta says runtime ownership is constrained, but memory/codebase/identity proof is still blocked until S003-S008.

## Evidence artifacts

- Artifact/path: `docs/evidence/ground-up-local-trust/S002-direct-mode-quarantine.md`
- Command output: `rg`, targeted tests, `bun run typecheck`

## Stop conditions for `/to-execute`

- Stop if runtime ownership requires deleting local data, stopping production-like services, or changing machine-local configs without approval.
- Stop if direct mode must remain active for a live agent path; route to `/to-architect`.

## Blocked by

S001

## Rollout / rollback notes

If scripts or package exports are changed, rollback is normal git revert. Do not remove user data or machine-local backups.

## Completion evidence

- Evidence artifact: `docs/evidence/ground-up-local-trust/S002-direct-mode-quarantine.md`
- Product/code guardrail: `scripts/agent-path-audit.sh` now starts proof through REST `/api/v1/tools` instead of spawning `dist/mcp/cli.js`.
- Test guardrail: `src/mcp/__tests__/proxy-cli.test.ts` asserts the agent-path audit active lines use `/api/v1/tools` and do not use `dist/mcp/cli.js` or `ping-mem-mcp`.
- Required targeted tests: `63 pass, 0 fail`.
- Required typecheck: `bun run typecheck` passed.
- Additional checks: `bash -n scripts/agent-path-audit.sh`, `git diff --check`, and static `rg` guard passed.
- Live REST note: `curl -sS -m 3 http://localhost:3003/api/v1/tools` could not connect, so S002 does not claim live runtime health.

## Scope vs Promise Delta

S002 proves the direct-mode quarantine boundary for approved proof: direct MCP and direct DB maintenance scripts cannot be used to claim local agent trust, and the previous agent-path audit direct-MCP proof was replaced with REST-owned discovery.

S002 does not prove memory lifecycle, codebase grounding, explicit identity, recovery, doctor/UI/log alignment, or re-adoption. Those remain owned by S003 through S015 according to `COVERAGE.md`.
