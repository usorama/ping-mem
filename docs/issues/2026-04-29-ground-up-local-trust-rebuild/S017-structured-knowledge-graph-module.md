---
id: S017
title: "Structured Knowledge Graph module"
type: AFK
status: done
parent: "/Users/umasankr/Projects/ping-mem/docs/prds/2026-04-29-ground-up-local-trust-rebuild.md"
blocked_by: ["S015"]
tracks: ["OBJ-1", "OBJ-3", "OBJ-7", "OUT-1", "OUT-3", "OUT-7", "CAP-4", "CAP-5", "CAP-7"]
---

## What to build

Define and implement a deep Structured Knowledge Graph module that can answer
typed relationship questions over codebase context and agent/customer history.
The module must explicitly distinguish:

- semantic-neighborhood answers, which are useful discovery results but not
  complete;
- complete-graph answers, which can claim completeness only for a declared
  finite population and denominator.

## Scope boundaries

- Owned surfaces: graph answer module, typed node/edge model additions,
  complete-vs-semantic answer contract, provenance/source-anchor envelope,
  denominator evidence, REST route, CLI wrapper command, focused tests.
- Existing implementation inputs: `GraphManager`, `TemporalCodeGraph`,
  `StructuralAnalyzer`, `LineageEngine`, `EvolutionEngine`,
  `HybridSearchEngine`, `IngestionService`, `EventStore`, and codebase source
  anchors.
- Out of scope: optional MCP proxy re-adoption, UI redesign, all-repos/all-agent
  claims, direct DB mode, raw Codex session exhaustive embedding.
- Architecture/context updates required: keep
  `docs/architecture/2026-05-02-structured-knowledge-graph-module.md` current
  if the implemented shape changes.

## Traceability

- Objectives: OBJ-1, OBJ-3, OBJ-7
- Outcomes: OUT-1, OUT-3, OUT-7
- Capabilities: CAP-4, CAP-5, CAP-7
- User stories: US-1, US-5, US-6, US-9
- Functional requirements: FR-6, FR-8, FR-10
- Non-functional requirements: NFR-2, NFR-3, NFR-6, NFR-7
- Acceptance criteria: extends AC-5, AC-6, AC-8, AC-10 for graph-depth answers

## Acceptance criteria

- [x] A single module interface returns answer kind:
  `semantic_neighborhood` or `complete_graph`.
- [x] Complete-graph answers require a declared population and return denominator
  evidence: roots/corpus ids, node count, edge count, relationship types,
  ingestion run/tree or corpus hash, and exclusions.
- [x] Semantic-neighborhood answers are labeled as incomplete and cannot use
  completion language.
- [x] Results return typed nodes, typed edges, relationship paths, source
  anchors, provenance, freshness state, and blocked claims.
- [x] Codebase graph answers can cite real file/line anchors checked against
  disk.
- [ ] Agent/customer history graph answers can cite memory/session/event/corpus
  anchors where the indexed corpus supports them. Deferred: this slice proves
  finite codebase population answers; session/event corpus unification remains
  blocked from final claims.
- [x] Missing graph backend, stale corpus, incomplete denominator, unsafe
  project path, and unsupported population fail loudly with actionable reasons.
- [x] REST and CLI surfaces use the approved REST runtime owner and explicit
  `agentId`, `project`, and session/project identity where stateful.
- [x] Tests cover fixture complete graph, fixture semantic neighborhood,
  denominator failure, stale freshness failure, and source-anchor proof.

## Definition of done

- [x] Deterministic outcome: ping-mem can answer at least one complete graph
  relationship question over a finite codebase population with denominator and
  source anchors.
- [x] Deterministic outcome: ping-mem can answer at least one semantic
  neighborhood question and label it as incomplete.
- [x] Required code/docs/tests produced: module implementation, REST route, CLI
  command, tests, architecture note update if needed, evidence bundle.
- [x] Required verification run with exact command(s): focused tests plus one
  live-runtime proof through the approved CLI path.
- [x] Required evidence attached:
  `docs/evidence/ground-up-local-trust/S017-structured-knowledge-graph/`.

## Verification

- [x] Structural check command:
  `rg -n 'complete_graph|semantic_neighborhood|denominator|sourceAnchors|provenance|Structured Knowledge Graph' src docs`
- [x] Automated test command:
  `bun test src/graph src/http src/cli`
- [x] Automated test command:
  `bun run typecheck`
- [x] Runtime/manual proof command:
  `bun run src/cli/index.ts agent graph answer --agent codex-local --project /Users/umasankr/Projects/ping-mem --mode complete_graph --json --evidence-dir docs/evidence/ground-up-local-trust/S017-structured-knowledge-graph`
- [x] Runtime/manual proof command:
  `bun run src/cli/index.ts agent graph answer --agent codex-local --project /Users/umasankr/Projects/ping-mem --mode semantic_neighborhood --json --evidence-dir docs/evidence/ground-up-local-trust/S017-structured-knowledge-graph`

## Evidence artifacts

- Artifact/path:
  `docs/evidence/ground-up-local-trust/S017-structured-knowledge-graph/`
- Artifact/path:
  `docs/evidence/ground-up-local-trust/S017-structured-knowledge-graph.md`
- Command output: answer JSON, denominator proof, source-anchor disk checks,
  failure-state examples.

Final evidence:

- `docs/evidence/ground-up-local-trust/S017-structured-knowledge-graph.md`
- `docs/evidence/ground-up-local-trust/S017-structured-knowledge-graph/complete_graph-answer.json`
- `docs/evidence/ground-up-local-trust/S017-structured-knowledge-graph/semantic_neighborhood-answer.json`

Scope delta:

- Completed: finite codebase graph answer contract, REST route, approved agent
  CLI command, denominator evidence, provenance envelope, source-anchor disk
  checks, freshness failure, incomplete semantic-neighborhood labeling.
- Deferred: full agent/customer history graph answers over memory/session/event
  corpora and Neo4j-backed exhaustive graph traversal. The completed slice does
  not expand claims beyond the declared finite population.

## Scope vs promise delta

S017 may prove graph-depth answers for selected finite populations only. It does
not prove all repos, all languages, all agent histories, optional MCP proxy
graph usage, or exhaustive raw Codex session event search.

## Stop conditions for `/to-execute`

- Stop if the design collapses semantic-neighborhood and complete-graph answers
  into one ambiguous result shape.
- Stop if complete answers lack a denominator, source anchors, or freshness
  proof.
- Stop if implementation bypasses the REST runtime owner or uses direct DB mode
  as an approved agent path.
- Stop if provenance is a string blob rather than a stable typed output shape.

## Blocked by

S015

## Rollout / rollback notes

Keep this behind the approved CLI/REST path. Do not re-enable MCP proxy or add
agent config writes in this slice. If Neo4j or corpus freshness is unavailable,
return blocked/degraded proof instead of silently falling back to semantic
search.
