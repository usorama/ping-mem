---
id: S015
title: "Controlled CLI-first re-adoption"
type: HITL
status: done
parent: "/Users/umasankr/Projects/ping-mem/docs/prds/2026-04-29-ground-up-local-trust-rebuild.md"
blocked_by: ["S001", "S002", "S003", "S004", "S005", "S006", "S007", "S008", "S009", "S010", "S011", "S012", "S013", "S014"]
tracks: ["OBJ-1", "OBJ-8", "OUT-1", "OUT-8", "CAP-8", "FR-2", "FR-12", "AC-11", "AC-12", "ADR-003", "ADR-008", "ADR-011", "ADR-013", "ADR-017"]
---

## What to build

Restore Codex and Claude Code usage only after prior proof gates pass, using the unified CLI plus skill contract first, with backups, diffs, active-process disposition, proof report, and rollback instructions.

## Scope boundaries

- Owned surfaces: Codex/Claude skill or instruction contract, machine-local config backup/update plan, re-adoption proof report, rollback commands.
- Out of scope: optional MCP proxy re-adoption, OpenCode/Cursor/all-agents support, hosted/prod deployment.
- Architecture/context updates required: explicit human approval is required before writing machine-local agent configs or enabling ping-mem by default.

## Traceability

- Objectives: OBJ-1, OBJ-8
- Outcomes: OUT-1, OUT-8
- Capabilities: CAP-8
- User stories: US-1, US-2, US-10
- Functional requirements: FR-2, FR-12
- Non-functional requirements: NFR-5, NFR-8
- Acceptance criteria: AC-11, AC-12
- Architecture decisions: ADR-003, ADR-008, ADR-011, ADR-013, ADR-017

## Acceptance criteria

- [x] AC-1 through AC-10 are done or have reviewed explicit blocker dispositions before this starts.
- [x] Codex configs/instructions are backed up before any re-adoption write. Claude Code is deferred by current-turn Codex-first scope.
- [x] Re-adoption uses unified CLI skill contract, not direct MCP DB mode or hidden hooks.
- [x] Active process inventory is clean after re-adoption or every residual process is classified.
- [x] Final completion claim is limited to proven local Codex path; Claude Code remains unclaimed.

## Definition of done

- [x] Deterministic outcome: ping-mem is re-adopted for Codex only through the proven local trust spine.
- [x] Required code/docs/tests produced: skill/config diffs, backup paths, re-adoption proof report, rollback instructions.
- [x] Required verification run with exact command(s): final proof gate and active process checks below.
- [x] Required evidence attached: re-adoption report and backup/restore details.

## Verification

- [x] Structural check command: `git status --short --branch`
- [x] Structural check command: `ps -axo pid,ppid,command | rg 'Codex\\.app|app-server|ping-mem/dist/mcp/proxy-cli|dist/mcp/proxy-cli|dist/mcp/cli'`
- [x] Automated test command: `bun run typecheck`
- [ ] Automated test command: `bun test` (ran; 2036 pass / 7 fail in memory-sync regression because clean-slate ping-mem no longer contains the legacy PingLearn/Firebase/LiveKit memories those regression fixtures expect)
- [x] Runtime/manual proof steps: `bun run src/cli/index.ts agent proof memory-lifecycle --agent codex-local --project /Users/umasankr/Projects/vunderstory --json`
- [ ] Runtime/manual proof steps: `bun run src/cli/index.ts agent proof memory-lifecycle --agent claude-code-local --project /Users/umasankr/Projects/ping-mem --json` (deferred by Codex-first scope)
- [x] Runtime/manual proof steps: `bun run src/cli/index.ts agent proof codebase-grounding --agent codex-local --project /Users/umasankr/Projects/vunderstory --json`
- [ ] Runtime/manual proof steps: `bun run src/cli/index.ts agent proof codebase-grounding --agent claude-code-local --project /Users/umasankr/Projects/ping-mem --json` (deferred by Codex-first scope)
- [x] PR-zero evidence required: final report lists allowed completion claim and blocked broader claims.

## Evidence artifacts

- Artifact/path: `docs/evidence/ground-up-local-trust/S015-readoption-report.md`
- Artifact/path: machine-local backup paths recorded in report, without secret values.
- Command output: final proof gate, process inventory, config diff summary.

## Current blocker disposition

Unblocked on 2026-05-01 by explicit approval for machine-local config writes. Additional current-turn instruction: empty ping-mem before any new writing, then re-adopt Codex first through one approved CLI-first tool path, seed one repo, and set up incremental re-indexing on change.

Final evidence:

- `docs/evidence/ground-up-local-trust/S015-readoption-report.md`
- `docs/evidence/ground-up-local-trust/S015-codex-readoption/final-projects.json`
- `docs/evidence/ground-up-local-trust/S015-codex-readoption/final-codex-search.json`
- `docs/evidence/ground-up-local-trust/S015-codex-readoption/final-vunderstory-codex-proof.json`
- `docs/evidence/ground-up-local-trust/S015-codex-readoption/final-codex-memory-lifecycle.json`
- `docs/evidence/ground-up-local-trust/S015-codex-readoption/codex-wrapper-search.json`
- `docs/evidence/ground-up-local-trust/S015-codex-readoption/vunderstory-reindex-launchagent.txt`

Scope delta:

- Completed: Codex-first re-adoption through one wrapper, Vunderstory indexing, Codex corpus indexing, and incremental Vunderstory re-indexing.
- Deferred: Claude Code re-adoption and raw Codex session event embedding.
- Guardrail: ping-mem is a discovery aid only; direct evidence remains authoritative.

## Stop conditions for `/to-execute`

- Stop if the user has not explicitly approved machine-local config writes.
- Stop if any AC-1 through AC-10 issue is incomplete or stale.
- Stop if direct MCP/proxy/hook path is required to make re-adoption pass.

## Blocked by

S001, S002, S003, S004, S005, S006, S007, S008, S009, S010, S011, S012, S013, S014

## Rollout / rollback notes

Backups:

- `/Users/umasankr/.codex/backups/ping-mem-readoption-20260501-0903`
- `/Users/umasankr/.ping-mem-empty-backups/20260501-081401`

Rollback commands are recorded in `docs/evidence/ground-up-local-trust/S015-readoption-report.md`.
