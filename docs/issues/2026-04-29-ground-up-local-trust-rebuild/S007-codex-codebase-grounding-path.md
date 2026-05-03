---
id: S007
title: "Codex codebase grounding path"
type: AFK
status: done
parent: "/Users/umasankr/Projects/ping-mem/docs/prds/2026-04-29-ground-up-local-trust-rebuild.md"
blocked_by: ["S003", "S004", "S010"]
tracks: ["OBJ-3", "OUT-3", "CAP-5", "FR-6", "FR-8", "AC-5", "AC-8", "ADR-014", "ADR-016"]
---

## What to build

Prove Codex can verify, ingest, search, inspect timeline/evidence, list registered projects, and return real source anchors through the unified CLI over REST.

## Scope boundaries

- Owned surfaces: Codex codebase proof command, source-anchor checks, runtime registered-project proof, unsafe-path negative proof.
- Out of scope: Claude Code proof, every repo/language coverage, optional MCP proxy.
- Architecture/context updates required: selected real repos beyond ping-mem must be recorded in evidence before proof.

## Traceability

- Objectives: OBJ-3
- Outcomes: OUT-3
- Capabilities: CAP-5
- User stories: US-5, US-6
- Functional requirements: FR-6, FR-8
- Non-functional requirements: NFR-2, NFR-6
- Acceptance criteria: AC-5, AC-8
- Architecture decisions: ADR-014, ADR-016

## Acceptance criteria

- [x] Codex proof covers verify, ingest, search, timeline/evidence anchors, registered-project inventory, and source-anchor disk checks.
- [x] Search results include file paths and line/source anchors that are checked against disk.
- [x] Registered project inventory comes from runtime API truth, not host-only file reads.
- [x] Unsafe project paths fail actionably before proof can count.

## Definition of done

- [x] Deterministic outcome: Codex codebase grounding returns current source-backed answers for selected local repos.
- [x] Required code/docs/tests produced: CLI proof, source-anchor verifier, timeout/failure interpretation.
- [x] Required verification run with exact command(s): codebase proof and tests below.
- [x] Required evidence attached: Codex codebase grounding bundle.

## Verification

- [x] Structural check command: `rg -n 'codebase-grounding|scope=registered|timeline|source anchor|verifyProject|isProjectDirSafe' src docs`
- [x] Automated test command: `bun test src/http/__tests__/rest-api-new-routes.test.ts src/ingest/__tests__/IngestionService.list-projects.test.ts src/util/__tests__/path-safety.test.ts`
- [x] Automated test command: `bun run typecheck`
- [x] Runtime/manual proof steps: `bun run src/cli/index.ts agent proof codebase-grounding --agent codex-local --project /Users/umasankr/Projects/ping-mem --json --evidence-dir docs/evidence/ground-up-local-trust/S007-codex-codebase`
- [x] Runtime/manual proof steps: `bun run src/cli/index.ts agent codebase verify --agent codex-local --project /etc --json` must fail as unsafe.
- [x] PR-zero evidence required: scope delta names tested repos and blocked broader claim "all repos/languages are covered."

## Evidence artifacts

- Artifact/path: `docs/evidence/ground-up-local-trust/S007-codex-codebase/`
- Artifact/path: `docs/evidence/ground-up-local-trust/S007-codex-codebase.md`
- Command output: proof JSON, source-anchor disk checks, registered-project denominator.

## Scope vs promise delta

S007 proves Codex codebase grounding for `/Users/umasankr/Projects/ping-mem` through the approved REST CLI path. The proof translated that local path to `/projects/ping-mem` for the container runtime, ingested current source, searched, checked a source anchor on disk, read timeline evidence, used S010's runtime registered-project denominator, and confirmed `/etc` fails before fetch. It does not claim all repos/languages, Claude Code grounding, or MCP proxy grounding.

## Stop conditions for `/to-execute`

- Stop if proof relies on stale manifests, host-only registry files, direct ingest scripts, or source anchors that cannot be checked against disk.
- Stop if ingest timeout semantics are unclear enough to risk repeated writes.

## Blocked by

S003, S004, S010

## Rollout / rollback notes

Use selected test repos and avoid deleting or reindexing real project state unless the issue explicitly creates isolated proof data.
