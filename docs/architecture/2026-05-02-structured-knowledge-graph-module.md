# Architecture Deepening: Structured Knowledge Graph Module

**Date:** 2026-05-02
**Status:** candidate architecture issue package
**Source contract:** `docs/prds/2026-04-29-ground-up-local-trust-rebuild.md`

## Goal

Deepen ping-mem from a trustworthy local search path into a relationship engine
that can answer:

- what is related to this code, decision, memory, objective, outcome,
  capability, feature, component, or evidence item;
- whether the answer is a semantic neighborhood or a complete graph answer;
- which source anchors and relationship paths justify the answer;
- what denominator was used before claiming completeness.

This serves `OBJ-3`, `OUT-1`, `OUT-3`, `CAP-4`, `CAP-5`, and `CAP-7`.

## Starting Evidence

- `S015` proved Codex-first local re-adoption through
  `/Users/umasankr/.codex/bin/ping-mem-codex`; MCP/proxy and direct DB remain
  disallowed for the approved Codex path.
- `S007` and `S008` prove codebase grounding with verify, ingest, search,
  timeline/evidence anchors, registered-project inventory, and unsafe-path
  rejection.
- Existing graph pieces include `GraphManager`, `TemporalCodeGraph`,
  `StructuralAnalyzer`, `LineageEngine`, `EvolutionEngine`,
  `HybridSearchEngine`, graph REST routes, graph CLI commands, and MCP graph
  tools.
- Graphify reports graph structure is useful for this repo, but it remains a
  navigation aid; every claim must be checked against source and runtime proof.

## Architecture Candidates

### 1. Structured Knowledge Graph Module

**Files/modules involved**

- `src/types/graph.ts`
- `src/graph/GraphManager.ts`
- `src/graph/TemporalCodeGraph.ts`
- `src/graph/StructuralAnalyzer.ts`
- `src/graph/LineageEngine.ts`
- `src/graph/EvolutionEngine.ts`
- `src/search/HybridSearchEngine.ts`
- `src/ingest/IngestionService.ts`
- `src/http/rest-server.ts`
- `src/cli/commands/graph.ts`

**Problem**

The current graph shape has several shallow interfaces. Callers can ask for
relationships, hybrid search, lineage, or evolution, but no single module owns
the product-level question: "give me a complete relationship answer, or tell me
this is only a semantic neighborhood." Provenance and denominator evidence are
not first-class at the interface.

**Solution**

Create a deep module whose interface is centered on typed graph ingestion and
typed graph answers. It should sit behind the REST runtime owner and expose one
small answer interface that returns answer kind, typed nodes, typed edges,
relationship paths, provenance, source anchors, denominator evidence, and
explicit incompleteness reasons.

**Benefits**

- **Leverage:** Codebase, memory, decision, objective, outcome, capability,
  feature, component, and evidence questions can share one graph answer shape.
- **Locality:** Completeness rules, provenance rules, path traversal, and
  semantic-vs-complete labeling live in one implementation instead of leaking
  across REST, CLI, graph tools, and search.
- **Testing:** The interface becomes the test surface: fixture graph answers,
  live-runtime graph answers, missing-denominator failures, stale-ingestion
  failures, and source-anchor checks.

### 2. Corpus Ingestion Module

**Files/modules involved**

- `src/ingest/IngestionService.ts`
- `src/ingest/IngestionOrchestrator.ts`
- `src/ingest/CodeChunker.ts`
- `src/ingest/SemanticChunker.ts`
- `src/ingest/SymbolExtractor.ts`
- `src/ingest/ManifestStore.ts`
- `src/search/CodeIndexer.ts`
- Codex corpus build evidence under
  `docs/evidence/ground-up-local-trust/S015-codex-readoption/`

**Problem**

Codebase ingestion and Codex-history ingestion are not yet one coherent module
from the product perspective. Code repos, memories, rules, prompts, thread
summaries, and raw-session inventories use different proof shapes, which makes
complete relationship claims hard.

**Solution**

Deepen corpus ingestion around a typed corpus manifest interface that can feed
search stores and the Structured Knowledge Graph with the same source anchors,
content hashes, exclusions, and freshness state.

**Benefits**

- **Leverage:** One ingestion proof can feed search, graph, provenance, and UI
  status.
- **Locality:** Corpus freshness, exclusions, hash evidence, and partial-ingest
  states stop spreading across scripts and evidence reports.
- **Testing:** The module can be tested with tiny fixture corpora and then
  proven against Vunderstory and Codex corpus.

### 3. Answer Provenance Module

**Files/modules involved**

- `src/search/HybridSearchEngine.ts`
- `src/search/CodeChunkStore.ts`
- `src/search/BM25Store.ts`
- `src/graph/TemporalCodeGraph.ts`
- `src/storage/EventStore.ts`
- `src/http/rest-server.ts`
- `src/cli/commands/agent.ts`

**Problem**

Different answer paths return different evidence shapes. Search can return
scores and content; codebase proof can check source anchors; graph routes can
return relationships. The product needs one provenance language so a founder or
agent can see why an answer is safe to use.

**Solution**

Introduce one provenance envelope used by search, graph, memory, and codebase
answers. It would normalize source anchors, evidence class, freshness, confidence
or completeness, and blocked-claim language.

**Benefits**

- **Leverage:** Every answer path can become auditable without bespoke output.
- **Locality:** Claim labeling and evidence formatting live in one place.
- **Testing:** Provenance fixtures can assert stable JSON and blocked claims.

### 4. Incremental Reindex Module

**Files/modules involved**

- `/Users/umasankr/.ping-mem/scripts/vunderstory-incremental-reindex.sh`
- `/Users/umasankr/Library/LaunchAgents/com.ping-mem.vunderstory-reindex.plist`
- `src/ingest/ManifestStore.ts`
- `src/ingest/IngestionService.ts`
- `src/observability/*`

**Problem**

Incremental reindexing exists for Vunderstory, but the deeper product need is
freshness truth: when an answer claims completeness, it must know whether the
indexed graph/search stores represent the current corpus.

**Solution**

Move incremental reindexing behind a repo-owned module/interface that reports
current, stale, changed, partial, or blocked state for each registered corpus.

**Benefits**

- **Leverage:** Search, graph, status, and proof commands all use one freshness
  contract.
- **Locality:** LaunchAgent/script state and manifest drift logic concentrate in
  one implementation.
- **Testing:** Change/no-change, stale, blocked dependency, and partial-ingest
  cases become direct tests of the module interface.

## Recommendation

Pursue candidate 1 first: **Structured Knowledge Graph Module**.

Reason: it is the highest-leverage module for the next product outcome. S015
already proved a trustworthy Codex entrypoint, and S007/S008 already proved
source-backed codebase grounding. The next gap is not more reachability; it is
answer depth. ping-mem must be able to say, "this is a complete graph answer
over this denominator" or "this is a semantic neighborhood only."

## Interface Direction

Do not start by exposing many graph commands. Start with one answer interface:

- input: question/query, population, allowed node types, allowed edge types,
  answer mode (`complete_graph` or `semantic_neighborhood`), project/session
  identity, and freshness requirement;
- output: answer kind, nodes, edges, relationship paths, source anchors,
  provenance, denominator evidence, exclusions, freshness state, and blocked
  claims.

The existing `GraphManager`, `TemporalCodeGraph`, `LineageEngine`,
`EvolutionEngine`, `HybridSearchEngine`, and `StructuralAnalyzer` should become
implementation details or adapters behind that seam.

## Completion Boundary

Allowed after this package:

- "The next architecture deepening target is defined and issue-sliced."
- "The proposed module would distinguish semantic-neighborhood answers from
  complete graph answers."

Blocked until implementation and proof:

- "ping-mem can answer complete relationship questions."
- "Graph answers are deterministic."
- "Agent/customer history and codebase relationships are fully unified."
