---
status: ready
priority: p1
issue_id: "001"
tags: [ingestion, neo4j, qdrant, bm25, determinism, multi-project]
dependencies: []
---

## Problem Statement

ping-mem still has two systemic ingestion risks despite the remediation docs claiming closure:

1. History ingestion is still silently bounded by default age/count settings, which means older or larger repos can be truncated without an explicit caller choice.
2. Neo4j and code-search storage keys are not fully project-scoped, so identical relative paths or chunk IDs across repos can collide and overwrite each other.

Those two gaps directly undermine ping-mem's purpose as deterministic, reusable memory/code infrastructure across every repo and use case.

## Findings

- `state.md` says remediation is complete, but `src/ingest/GitHistoryReader.ts` still defaults to `365` days and `src/validation/api-schemas.ts` still rejects `0` as "full history".
- `TemporalCodeGraph` computes `fileId` from `filePath` only and merges `File` nodes globally.
- `CodeIndexer` uses chunk IDs that can be identical across repos when path+content match; BM25/Qdrant operate on those IDs.
- Uncommitted `StructuralAnalyzer` changes add Python import graph support for rankforge-style repos and already pass locally.

## Proposed Solutions

### Option A

Patch only the Python structural analyzer work and leave identity/default behavior untouched.

- Pros: Smallest diff
- Cons: Does not fix silent truncation or cross-repo collisions

### Option B

Make ingestion/search identities project-scoped and make default history ingestion unbounded unless the caller explicitly constrains it.

- Pros: Aligns with deterministic multi-repo infrastructure goals
- Cons: Wider blast radius across graph/search codepaths

## Recommended Action

Execute Option B with targeted regression coverage:

1. Merge the Python structural analyzer support.
2. Remove silent default history truncation by allowing `0`/unset to mean "full history".
3. Scope graph/search storage identities by `projectId`.
4. Add regression tests proving same-path/same-chunk data from different repos does not collide.

## Acceptance Criteria

- [ ] Python import relationships are extracted for rankforge-style repos.
- [ ] Default ingestion no longer silently truncates by age/count.
- [ ] Same relative file path across two projects does not share the same Neo4j file identity.
- [ ] Same chunk ID source material across two projects does not share the same search/index identity.
- [ ] Targeted typecheck/tests pass.

## Work Log

### 2026-04-22 - Initial triage

**By:** Codex

**Actions:**
- Reviewed `overview.md`, `state.md`, `CLAUDE.md`, current branch state, and ingestion/graph/search codepaths.
- Verified runtime health (`/health`, Docker) and ran targeted tests for `ProjectScanner`, `StructuralAnalyzer`, and `CodeChunkStore`.
- Identified that the remediation docs overstate closure relative to current deterministic ingestion behavior.

**Learnings:**
- The rankforge Python structural import work is already in the working tree and passes locally.
- The higher-risk remaining failures are global storage identities and bounded defaults, not parser support.

### 2026-04-22 - Code changes + verification

**By:** Codex

**Actions:**
- Added `src/ingest/identity.ts` to scope chunk/symbol identities by `projectId`.
- Patched `TemporalCodeGraph` to use project-scoped `fileKey`/`chunkKey`/`symbolKey` identities and idempotent relationships.
- Removed silent history truncation defaults by changing git history defaults to full-history (`0`) and allowing `0` through REST/MCP ingestion schemas.
- Updated `scripts/reingest-active-projects.sh` to request full-history re-ingest explicitly.
- Added regression tests for project-scoped identity normalization and Neo4j file-key behavior.
- Verified with `bun run typecheck` and targeted Bun/Vitest suites.

**Learnings:**
- The largest remaining gap is runtime/state reconciliation: the code no longer matches some “fully closed” documentation claims, so re-ingest and doc correction are still required.
