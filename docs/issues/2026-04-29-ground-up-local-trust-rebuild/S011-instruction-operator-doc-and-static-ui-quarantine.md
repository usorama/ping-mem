---
id: S011
title: "Instruction, operator-doc, and static-UI quarantine"
type: AFK
status: done
parent: "/Users/umasankr/Projects/ping-mem/docs/prds/2026-04-29-ground-up-local-trust-rebuild.md"
blocked_by: ["S001"]
tracks: ["OBJ-1", "OBJ-7", "OBJ-8", "OUT-7", "OUT-8", "CAP-7", "CAP-8", "FR-1", "FR-2", "FR-11", "FR-12", "AC-1", "AC-10", "AC-11", "AC-12", "ADR-011", "ADR-017"]
---

## What to build

Quarantine or correct active root instructions, user-level agent instructions, committed operator docs, runbooks, and static UI pages that still tell agents or the founder to use direct MCP, blocked maintenance scripts, default credentials, stale recovery commands, or ping-mem-first grounding before proof.

## Scope boundaries

- Owned surfaces: `README.md`, `CLAUDE.md`, `AGENT_INSTRUCTIONS.md`, active docs/runbooks, `src/static/codebase-diagram.html`, user-level instruction inventory and approved update plan.
- Out of scope: broad documentation rewrite, public product docs, GitHub issue changes, re-adoption config writes.
- Architecture/context updates required: if a doc is active but cannot be safely changed now, mark as blocked with rationale.

## Traceability

- Objectives: OBJ-1, OBJ-7, OBJ-8
- Outcomes: OUT-7, OUT-8
- Capabilities: CAP-7, CAP-8
- User stories: US-4, US-9, US-10
- Functional requirements: FR-1, FR-2, FR-11, FR-12
- Non-functional requirements: NFR-5, NFR-7, NFR-8
- Acceptance criteria: AC-1, AC-10, AC-11, AC-12
- Architecture decisions: ADR-011, ADR-017

## Acceptance criteria

- [x] Active docs/instructions/static UI no longer mandate ping-mem, direct MCP DB mode, default credentials, direct write scripts, or hidden hooks before proof.
- [x] Historical docs are labeled historical or out-of-scope instead of silently left as active operator guidance.
- [x] User-level instruction surfaces are inventoried and either updated with approval or explicitly blocked for S015.
- [x] A repeatable check reports zero active unclassified matches for blocked path patterns.

## Definition of done

- [x] Deterministic outcome: no active operator surface can re-poison agents into using unapproved ping-mem paths.
- [x] Required code/docs/tests produced: doc/static UI quarantine edits and active/historical ledger.
- [x] Required verification run with exact command(s): blocked pattern check below.
- [x] Required evidence attached: doc classification ledger and diffs.

## Verification

- [x] Structural check command: `rg -n 'direct-ingest|force-ingest|reindex-qdrant|dist/mcp/cli|ping-mem-mcp|neo4j_password|ping-mem-dev-local|use ping-mem first|ping-mem-first' README.md CLAUDE.md AGENT_INSTRUCTIONS.md docs src/static scripts package.json`
- [x] Automated test command: `bun test src/http/ui`
- [x] Automated test command: `bun run typecheck`
- [x] Runtime/manual proof steps: produce `docs/evidence/ground-up-local-trust/S011-active-surface-ledger.md` with active/historical/out-of-scope classification.
- [x] PR-zero evidence required: scope delta says operator surfaces are quarantined, but re-adoption remains blocked until S015.

## Evidence artifacts

- Artifact/path: `docs/evidence/ground-up-local-trust/S011-active-surface-ledger.md`
- Command output: blocked pattern scan and UI/static proof where changed.

## Completion evidence

- Active repo-owned docs corrected: `CLAUDE.md`, `AGENT_INSTRUCTIONS.md`, `README.md`.
- Active static UI corrected: `src/static/codebase-diagram.html`.
- Pattern scan residuals are classified in `docs/evidence/ground-up-local-trust/S011-active-surface-ledger.md`.
- UI verification passed: `bun test src/http/ui` -> `59 pass`, `0 fail`.
- Typecheck passed: `bun run typecheck`.

## Scope vs promise delta

S011 quarantines active repo-owned operator guidance and static UI. It does not edit machine-local Claude/Codex configs or user-level skills; those remain blocked until S015/S016 approval and proof.

## Stop conditions for `/to-execute`

- Stop if a user-level config or instruction file must be edited without explicit approval.
- Stop if active static UI cannot be changed without product/UI approval; route the exact page/state to `/to-architect` or a HITL doc decision.

## Blocked by

S001

## Rollout / rollback notes

Rollback is normal git revert for repo docs/static UI. Machine-local user instruction updates belong in S015 unless explicitly approved earlier.
