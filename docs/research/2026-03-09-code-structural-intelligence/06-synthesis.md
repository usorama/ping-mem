# Synthesis — Code Structural Intelligence (Issue #29)

**Date**: 2026-03-09
**Research inputs**: docs 01–05 (01-codebase-audit, 02-static-analysis-tools, 03-neo4j-schema-and-queries, 04-algorithms-and-scoring, 05-competitive-analysis)
**Purpose**: Bridge from research to plan — founding principles, measurable outcomes, ADRs, gap analysis

---

## 1. Founding Principles

Non-negotiable constraints that govern every design decision in this feature.

### P1: Zero new runtime dependencies
`typescript` v5.9.3 is already installed and already used by SymbolExtractor. All import/export extraction will use the TypeScript Compiler API (`ts.createSourceFile()`, `ts.forEachChild()`, `ts.SyntaxKind.ImportDeclaration`). No oxc-parser, no @typescript-eslint/parser, no tree-sitter package installs.

_Evidence_: `01-codebase-audit.md §9` — "Key finding: typescript package already in project and already used for AST. Import extraction can be added to SymbolExtractor.extractTypeScript() with zero new dependencies."

### P2: Store full graph at index time; serve ranked slices at query time
The full import/dependency graph is too large for any agent context window but is cheap to precompute and store in Neo4j and SQLite. Agent queries return filtered, ranked subsets — never raw graph dumps. This is the design principle independently arrived at by aider (repo-map), LocAgent (ACL 2025), and Sourcegraph (SCIP occurrence-based lookup).

### P3: Incremental per-file indexing
Only files whose content has changed (different SHA-256) need to be re-indexed for structural data. Store per-file import data atomically so a single-file change costs O(1 file), not O(total files). This is the core insight from GitHub's stack-graph incremental partial-graph model.

### P4: All scoring is fully deterministic
Blast radius score = deterministic formula over stored graph data. Temporal coupling = deterministic formula over git commit co-occurrence data already ingested by GitHistoryReader. No ML, no LLM, no stochastic components. Results are bit-for-bit reproducible given the same graph state. Same principle as ping-mem's existing DeterministicVectorizer.

### P5: Neo4j for graph traversal; existing SQLite for fast in-process ranking
Neo4j variable-length path queries (`[:IMPORTS_FROM*1..10]`) handle transitive impact in 1–20ms for the 390-node ping-mem graph. Result scoring and repo-map ranking happen in Bun process after Neo4j returns raw nodes. No APOC, no GDS Community Edition needed in v1.

### P6: Never guess — only explicit structural relationships
Imports extracted from actual `import` declarations in AST. Exports extracted from `export` declarations. No NLP, no heuristics, no inference from variable names. Temporal coupling inferred from git commit co-occurrence (explicit factual data, not guessed). This is the same "explicit-only" principle already applied to ping-mem's "why" extraction in git commit messages.

### P7: Layers 1→2→3 — each independently valuable
- **Layer 1 (import graph)**: `(File)-[:IMPORTS_FROM]->(File)` — enables "what breaks if X changes?"
- **Layer 2 (symbol definitions + reference counts)**: enables "what's most important in this file?"
- **Layer 3 (temporal coupling)**: enables "what tends to change together?" (CodeScene-style)
Each layer ships complete and useful without the next. v1 ships all three because they compose: blast radius score = structural (Layer 1) + temporal (Layer 3).

### P8: Fix pre-existing Neo4j index bug as part of this work
Research identified that no indexes exist on `:File(path)`, `:Chunk(chunkId)`, `:Symbol(symbolId)`, `:Commit(hash)` nodes. Every existing MERGE does a full label scan (O(N²)). Creating 6 indexes is mandatory for the new relationship queries to perform; fixing the pre-existing bug is in-scope as Phase 0.

---

## 2. Measurable Outcomes

| Outcome | Target | Measurement Method |
|---------|--------|--------------------|
| Import accuracy (TS/JS) | ≥95% of `import`/`export` statements extracted correctly | Unit tests against synthetic fixtures with known import counts |
| Transitive impact query | ≤100ms for repos up to 500 files (p95) | Benchmark test: `MATCH (f:File {path:$p})<-[:IMPORTS_FROM*1..10]-(d)` timing |
| Blast radius scoring | 100% deterministic (same graph → same score) | Run twice on same data, assert identical output |
| Ingestion overhead | ≤20% increase in total ingestion time vs. baseline | Benchmark before/after on ping-mem repo (~200 files) |
| MCP tool response | ≤200ms (p95) for all 8 new tools | Integration test with timing assertions |
| Repo-map output | ≤1,024 tokens for default budget | Test that `repo_map({budget:1024})` output is within token limit |
| Neo4j index fix | Full label scan eliminated — MERGE time drops from O(N) to O(log N) | Compare EXPLAIN output before/after index creation |
| Zero new deps | `bun install` produces no new packages | Assert `package.json` unchanged after implementation |

---

## 3. Architecture Decision Records

### ADR-01: TypeScript Compiler API (installed) over oxc-parser (new dep) for import extraction
**Decision**: Use TypeScript Compiler API for all TS/JS import/export extraction.
**Rationale**: `typescript` is already installed and already used in `SymbolExtractor.extractTypeScript()` at line 48. Adding import extraction to the same AST visitor walk adds ~50 lines of code with zero new dependencies. oxc-parser is faster (~150ms/500files vs ~200ms) but the 25% speed improvement doesn't justify a new Rust NAPI dependency.
**Rejected alternative**: oxc-parser (would add new npm dep), @typescript-eslint/typescript-estree (same dep concern), tree-sitter (same).

### ADR-02: Neo4j (existing) over SQLite for import graph storage
**Decision**: Store import/export edges as Neo4j relationships (`(File)-[:IMPORTS_FROM]->(File)`), not SQLite tables.
**Rationale**: The primary access pattern is graph traversal — "find all files that transitively import X." This is O(1) in Neo4j (`MATCH (:File)-[:IMPORTS_FROM*1..10]->(:File {path:$p})`) but requires recursive CTE in SQLite. Neo4j is already the temporal code graph substrate; adding structural edges to the same graph leverages existing infrastructure and keeps all code relationships in one queryable store.
**Rejected alternative**: SQLite adjacency table with recursive CTE (would work but slower to query, requires separate join logic, splits graph from Neo4j).

### ADR-03: Add temporal coupling alongside static imports (both v1)
**Decision**: Compute temporal coupling (CodeScene-style `shared_commits / total_commits_A`) from existing git history and surface it as a separate Neo4j relationship `(File)-[:TEMPORALLY_COUPLED {coupling_pct, shared_commits}]->(File)`.
**Rationale**: Temporal coupling is free — GitHistoryReader already ingests full commit history including `(Commit)-[:MODIFIES]->(File)` edges. A single Cypher aggregation query computes all temporal coupling pairs at persist time. This catches hidden architectural coupling (files that always change together but have no import relationship) that static analysis cannot find. High value, near-zero cost.
**Rejected alternative**: Defer to v2 (unnecessarily delayed for a free computation).

### ADR-04: No call graphs in v1
**Decision**: Do not extract function-level call graphs in v1.
**Rationale**: Call graph extraction requires: (a) resolving call expressions to their definition sites across files (requires type resolution or scope analysis, not just AST walk), (b) handling dynamic calls, closures, callbacks, higher-order functions. This is the hardest part of static analysis. The import graph (file-level) + symbol reference counts provide 80% of the agent value at 20% of the complexity. Call graphs are v2.
**Rejected alternative**: Attempt call graphs in v1 (would delay delivery significantly for marginal agent value gain).

### ADR-05: No Language Server Protocol (LSP) integration in v1
**Decision**: No TypeScript Language Server, no ts-morph, no `typescript-language-server` integration.
**Rationale**: LSP is designed for interactive IDE use — it initializes a project-wide type-checker, which takes 2–30 seconds and consumes significant memory. Import extraction from AST (not type-checked) is sufficient for the import graph. Symbol definitions and reference counts can be computed from the symbol table already built by SymbolExtractor plus the new import edges.
**Rejected alternative**: ts-morph (higher-level TS API but still initializes TS compiler project, slower startup).

### ADR-06: StaticAnalyzer as a separate class, not merged into SymbolExtractor
**Decision**: Create `src/ingest/StaticAnalyzer.ts` as a new class called by `IngestionService` after `orchestrator.ingest()` returns `IngestionResult`.
**Rationale**: SymbolExtractor handles per-file symbol extraction (already in chunkCodeFiles() loop). Cross-file resolution (import → target file, temporal coupling across commit history) requires the full `IngestionResult` with all files available simultaneously. These are fundamentally different scopes: per-file vs. project-wide.
**Integration point**: `IngestionService.ts` between line 109 (`orchestrator.ingest()`) and line 117 (`graph.persistIngestion()`). Per `01-codebase-audit.md §4`.

### ADR-07: Adopt aider repo-map output format (ranked skeleton, token-budgeted)
**Decision**: `repo_map` MCP tool outputs a token-budgeted skeleton of the most structurally important files: filenames + exported symbol signatures, ranked by blast radius score. Default budget: 1,024 tokens (configurable up to 8,192).
**Rationale**: LocAgent (ACL 2025) achieved 92.7% file-level accuracy on SWE-Bench-Lite at 86% cost reduction using this approach. Repomix's flat dump approach saturates context windows. The ranked skeleton is what agents actually need: "what files are relevant to this task and what do they export?"
**Rejected alternative**: Raw graph dump, SCIP format (too complex), flat file concatenation.

---

## 4. Gap Analysis

### Current State

| Component | What Exists | What's Missing |
|-----------|------------|----------------|
| `SymbolExtractor.ts` | Extracts 9 symbol kinds via TS AST | Import/export extraction, call graph, references |
| `TemporalCodeGraph.ts` | 8-phase ingestion: Project, File, Chunk, Symbol, Commit, Parent, FileChange, HunkDiff | No indexes on any node label; no structural relationship types |
| `IngestionOrchestrator.ts` | Scan + chunk + git history | No cross-file static analysis pass |
| `IngestionService.ts` | Orchestrates 3 phases | No StaticAnalyzer phase |
| MCP tools | 14 existing tools | No `graph_imports`, `graph_importers`, `graph_impact`, `symbol_definition`, `symbol_references`, `temporal_coupling`, `hotspots`, `repo_map` |
| REST endpoints | `/api/v1/codebase/search`, `/api/v1/codebase/timeline` | No `/api/v1/codebase/impact`, `/api/v1/codebase/repo-map` |
| Neo4j relationships | `HAS_FILE, HAS_CHUNK, DEFINES_SYMBOL, CONTAINS_SYMBOL, PARENT, MODIFIES, CHANGES` | No `IMPORTS_FROM`, `EXPORTS`, `TEMPORALLY_COUPLED` |

### Target State

| Component | After Implementation |
|-----------|---------------------|
| `SymbolExtractor.ts` | + import declaration extraction (ImportDeclaration, ExportDeclaration AST nodes) returning `ExtractedImport[]` |
| `StaticAnalyzer.ts` | New class — cross-file import resolution, temporal coupling computation, blast radius scoring |
| `TemporalCodeGraph.ts` | + 6 Neo4j indexes (Phase 0); + Phase 9 (import/export edges); + Phase 10 (temporal coupling edges); + 5 new query methods |
| `IngestionService.ts` | + StaticAnalyzer.analyze() call between orchestrator.ingest() and graph.persistIngestion() |
| `PingMemServer.ts` | + 8 new MCP tool handlers |
| `rest-server.ts` | + 2 new REST endpoints |
| Neo4j graph | Full code dependency graph: structural (import-based) + temporal (co-commit-based) |

### Gap Severity Ratings

| Gap | Severity | Why |
|----|----------|-----|
| No import/export extraction | **Critical** | Foundation for all structural features — nothing else works without this |
| No Neo4j indexes | **High** | Pre-existing performance bug; new queries will be O(N²) without indexes |
| No cross-file analysis (StaticAnalyzer) | **High** | Required to resolve `import "./utils"` to actual `File` nodes |
| No blast radius scoring | **Medium** | High agent value but computable from import graph once it exists |
| No temporal coupling | **Medium** | High-value insight but depends on existing git data already ingested |
| No MCP tools | **Low** | Straightforward to add once data layer exists |
| No REST endpoints | **Low** | Thin wrappers around same queries |

---

## 5. Implementation Strategy

Three phases, each independently shippable:

**Phase 0 — Neo4j Indexes (pre-existing bug fix, ~2 hours)**
Add `ensureStructuralIndexes()` called at TemporalCodeGraph startup. 6 indexes: `File(path)`, `File(fileId)`, `Chunk(chunkId)`, `Symbol(symbolId)`, `Commit(hash)`, `Project(projectId)`. Eliminates O(N²) full label scans on every existing MERGE.

**Phase 1 — Import Graph (StaticAnalyzer + Neo4j phases 9-10, ~1 day)**
- `SymbolExtractor.extractTypeScript()`: add ImportDeclaration + ExportDeclaration visitor branch, return `ExtractedImport[]`
- `StaticAnalyzer.analyze(result)`: cross-file resolution (relative path → File node), temporal coupling computation from existing Commit data
- `TemporalCodeGraph.persistIngestion()`: add Phase 9 (IMPORTS_FROM + EXPORTS edges) and Phase 10 (TEMPORALLY_COUPLED edges)
- `IngestionService`: inject StaticAnalyzer call

**Phase 2 — MCP Tools + REST (~0.5 days)**
Add 8 MCP tools and 2 REST endpoints wrapping the 5 new Neo4j query methods. Implement `repo_map` tool with token-budget ranking.

**Phase 2.5 — Blast Radius Scoring (~0.5 days)**
Implement `BlastRadiusScorer.score(filePath, projectId)` using the deterministic formula `round((0.30 × normalize(fanIn)) + (0.40 × normalize(transitiveFanIn)) + (0.30 × normalize(churnScore))) × 100`. Called by `graph_impact` and `hotspots` MCP tools.

---

## 6. Files to Create / Modify

| File | Action | Change Summary |
|------|--------|----------------|
| `src/ingest/StaticAnalyzer.ts` | CREATE | Cross-file resolution, temporal coupling, blast radius orchestration |
| `src/ingest/BlastRadiusScorer.ts` | CREATE | Deterministic 0–100 score computation |
| `src/ingest/SymbolExtractor.ts` | MODIFY | Add `extractImports()` returning `ExtractedImport[]` |
| `src/ingest/types.ts` | MODIFY | Add `ExtractedImport`, `ResolvedImport`, `TemporalCoupling` types |
| `src/ingest/IngestionService.ts` | MODIFY | Inject StaticAnalyzer.analyze() between lines 109–117 |
| `src/graph/TemporalCodeGraph.ts` | MODIFY | Add `ensureStructuralIndexes()`, Phase 9, Phase 10, 5 new query methods |
| `src/mcp/PingMemServer.ts` | MODIFY | Add 8 new tool handlers |
| `src/http/rest-server.ts` | MODIFY | Add 2 new endpoints |
| `src/ingest/index.ts` | MODIFY | Export StaticAnalyzer, BlastRadiusScorer |

No new files outside `src/ingest/` except MCP/HTTP wiring. Zero new npm dependencies.
