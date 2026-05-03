---
id: S001
title: "Phase 0 inventory and quarantine ledger"
type: AFK
status: done
parent: "/Users/umasankr/Projects/ping-mem/docs/prds/2026-04-29-ground-up-local-trust-rebuild.md"
blocked_by: []
tracks: ["OBJ-1", "OBJ-4", "OBJ-7", "OBJ-8", "OUT-1", "OUT-4", "OUT-7", "OUT-8", "CAP-1", "CAP-2", "CAP-7", "CAP-8", "FR-1", "FR-2", "AC-1", "AC-12", "ADR-011", "ADR-013", "ADR-017"]
---

## What to build

Create the Phase 0 read-only inventory and quarantine ledger for every Codex and Claude Code ping-mem entrypoint, live process, runtime/data path, active instruction surface, operator doc, static UI surface, proof script, LaunchAgent, and seeded offender from the architecture.

## Scope boundaries

- Owned surfaces: inventory evidence under `docs/evidence/ground-up-local-trust/`, this issue file, and package coverage updates.
- Out of scope: product code changes, active config edits, LaunchAgent unload/load, GitHub issue writes, re-adoption, MCP enablement.
- Architecture/context updates required: update `COVERAGE.md` only if a new discovered population changes dependency or issue ownership.

## Traceability

- Objectives: OBJ-1, OBJ-4, OBJ-7, OBJ-8
- Outcomes: OUT-1, OUT-4, OUT-7, OUT-8
- Capabilities: CAP-1, CAP-2, CAP-7, CAP-8
- User stories: US-1, US-2, US-3, US-4, US-5, US-6, US-7, US-8, US-9, US-10
- Functional requirements: FR-1, FR-2
- Non-functional requirements: NFR-2, NFR-5, NFR-7, NFR-8
- Acceptance criteria: AC-1, AC-12
- Architecture decisions: ADR-011, ADR-013, ADR-017

## Acceptance criteria

- [x] `docs/evidence/ground-up-local-trust/S001-inventory-ledger.md` exists with a denominator, classification, evidence command, and disposition for every discovered item.
- [x] Codex static config, live Codex processes, Claude Code configs/hooks, user-level Claude workflow, MCP proxy/direct paths, REST paths, CLI/scripts, LaunchAgents, docs, and static UI are covered.
- [x] Every seeded offender row in `COVERAGE.md` is classified as `quarantined`, `approved-test-only`, `approved-re-adoption`, `offline-dev-only`, `historical`, `blocked`, or `out-of-scope`.
- [x] The ledger records `classified_count / discovered_count == 1.0`, or leaves this issue blocked with exact unclassified items.

## Definition of done

- [x] Deterministic outcome: the founder can see which ping-mem entrypoints are still active, which are quarantined, and which must not be used.
- [x] Required code/docs/tests produced: evidence ledger only; no product code.
- [x] Required verification run with exact command(s): all commands in the Verification section are run and summarized.
- [x] Required evidence attached: command outputs and classification ledger under `docs/evidence/ground-up-local-trust/`.

## Verification

- [x] Structural check command: `git status --short --branch`
- [x] Structural check command: `git worktree list --porcelain`
- [x] Structural check command: `rg -n 'ping-mem|dist/mcp/cli|proxy-cli|direct-ingest|force-ingest|reindex-qdrant|neo4j_password|ping-mem-dev-local' README.md CLAUDE.md AGENT_INSTRUCTIONS.md docs src/static scripts package.json`
- [x] Runtime/manual proof steps: `ps -axo pid,ppid,command | rg 'Codex\\.app|app-server|ping-mem/dist/mcp/proxy-cli|dist/mcp/proxy-cli|dist/mcp/cli'`
- [x] Runtime/manual proof steps: `find /Users/umasankr/Library/LaunchAgents -maxdepth 1 -name 'com.ping-mem*.plist' -print`
- [x] Runtime/manual proof steps: inspect `/Users/umasankr/.codex/config.toml`, `/Users/umasankr/.claude`, and user-level Claude workflow files without writing.
- [x] PR-zero evidence required: scope delta states that this slice proves inventory/classification only, not product trust.

## Evidence artifacts

- Artifact/path: `docs/evidence/ground-up-local-trust/S001-inventory-ledger.md`
- Artifact/path: `docs/evidence/ground-up-local-trust/S001-command-output.md`
- Command output: worktree, process, config, docs/static UI, scripts, LaunchAgent, and seeded offender inventory.

## Completion evidence

- Inventory ledger: `docs/evidence/ground-up-local-trust/S001-inventory-ledger.md`
- Command output summary: `docs/evidence/ground-up-local-trust/S001-command-output.md`
- Coverage ledger update: `docs/issues/2026-04-29-ground-up-local-trust-rebuild/COVERAGE.md` now includes the newly discovered shell startup integration population.
- Classification result: current discovered surfaces `78 / 78 == 1.0`; seeded offenders `36 / 36 == 1.0`; total S001 ledger rows `114 / 114 == 1.0`.
- Active-risk highlights: 22 live `dist/mcp/proxy-cli.js` processes, REST `localhost:3003` unreachable, Docker/OrbStack API unavailable, six ping-mem LaunchAgents present, active docs/static UI/user workflow/shell startup surfaces still teach or trigger blocked paths.

## Scope vs Promise Delta

This slice proves inventory and classification only. It does not prove product trust, memory lifecycle correctness, codebase grounding correctness, runtime ownership, recovery, truthful observability, or Codex/Claude re-adoption.

No product code, active config, LaunchAgent, GitHub issue, or ping-mem re-adoption change was made.

## Stop conditions for `/to-execute`

- Stop if evidence collection would require mutating configs, LaunchAgents, running repair commands, or re-enabling ping-mem.
- Stop if any discovered active entrypoint cannot be classified from file/process evidence.
- Escalate to `/to-architect` if a new live owner or re-adoption path is discovered that contradicts ADR-001 through ADR-017.

## Blocked by

None - can start immediately.

## Rollout / rollback notes

This is read-only. No rollback is needed unless a future executor accidentally changes machine or repo state; in that case, stop and report the exact diff/action.
