# SpecFlow Analysis — Code Structural Intelligence (Issue #29)

**Date**: 2026-03-09
**Analyst**: User Experience Flow Analyst
**Source spec**: `06-synthesis.md` + supporting research docs `01–05`
**Branch context**: `feat/self-healing-health-monitor`

---

## Executive Summary

The synthesis spec defines a well-researched, layered approach to adding code structural intelligence to ping-mem. The architectural decisions are sound. However, this analysis identifies **23 gaps**, **11 edge cases requiring explicit handling**, and **19 critical questions** that must be answered before implementation begins. The most severe gaps cluster around three areas: (1) import path resolution semantics are underspecified for the TypeScript ecosystem's most common patterns, (2) the 8 MCP tools have no defined input/output schemas, and (3) failure modes when Neo4j is unavailable during a structural analysis pass have no specified recovery path.

---

## Phase 1: User Flow Overview

### Flow 1 — First Ingestion (Project Has No Prior Structural Data)

```
Agent calls codebase_ingest({ projectDir, forceReingest: false })
  └── IngestionService.ingestProject()
        └── IngestionOrchestrator.ingest()   [Phase 0: existing 8-phase pipeline]
              └── Returns IngestionResult (codeFiles[], gitHistory)
        [NEW] StaticAnalyzer.analyze(ingestionResult)
              ├── For each file: SymbolExtractor.extractImports() via TS Compiler API
              ├── Path resolution: relative path → absolute → fileId
              └── Temporal coupling: Cypher aggregation over existing Commit nodes
        └── TemporalCodeGraph.persistIngestion(enrichedResult)
              ├── Phase 0 (NEW): ensureStructuralIndexes()
              ├── Phases 1–8: existing
              ├── Phase 9 (NEW): persist IMPORTS_FROM + EXPORTS edges
              └── Phase 10 (NEW): persist TEMPORALLY_COUPLED edges
        └── CodeIndexer.indexIngestion()      [unchanged]

Returns: IngestProjectResult (filesIndexed, chunksIndexed, etc.)
```

**Unspecified**: What does the caller see when Phase 9 fails but Phases 1–8 succeeded? Does `IngestProjectResult` gain new fields to indicate structural analysis status?

---

### Flow 2 — Incremental Re-ingestion (File Changed)

```
Git commit hook fires → IngestionService.ingestProject({ forceReingest: false })
  └── ProjectScanner detects changed files via SHA-256 diff
  └── IngestionOrchestrator.ingest() processes only changed files
  └── StaticAnalyzer.analyze() runs on ALL files (or only changed?)
        [GAP: Spec says "O(1 file)" but analysis is cross-file]
  └── TemporalCodeGraph Phase 9:
        For each changed file:
          MATCH (f)-[r:IMPORTS_FROM]->() DELETE r   [delete stale edges]
          Re-insert fresh edges
  └── Temporal coupling: full recompute or delta?
        [GAP: Spec does not specify]
```

**Critical**: The incremental model is described at a high level but the StaticAnalyzer's scope for incremental runs is unspecified. Does it re-analyze all files (correct but slow) or only changed files (fast but risks stale import edges from unchanged files that import the changed file)?

---

### Flow 3 — Agent Uses `graph_imports` Tool

```
Agent: "I'm about to modify src/ingest/IngestionService.ts.
        What does this file import?"

  graph_imports({ filePath: "src/ingest/IngestionService.ts", projectId: "abc123" })
    └── TemporalCodeGraph.getDirectImports(fileId, projectId)
          └── Cypher: MATCH (f:File {fileId})-[:IMPORTS_FROM]->(target)
                      WHERE project scope
                      RETURN target.path, r.importedNames, r.isTypeOnly
    └── Returns: { imports: [{ path, importedNames, isTypeOnly }] }

Unspecified: Does the agent receive absolute paths, relative paths, or fileIds?
Unspecified: What if the file has never been ingested?
Unspecified: What if the file imports 0 files (valid: entry points, leaf nodes)?
```

---

### Flow 4 — Agent Uses `graph_importers` Tool

```
Agent: "Who imports src/util/CircuitBreaker.ts?
        I need to understand blast radius before refactoring."

  graph_importers({ filePath: "src/util/CircuitBreaker.ts", projectId: "abc123", depth: 1 })
    └── TemporalCodeGraph.getDirectDependents(fileId, projectId)
          └── Cypher from 03-neo4j-schema-and-queries §4.1
    └── Returns: [{ path, fileId, edgeType: "IMPORTS_FROM"|"EXPORTS" }]

Unspecified: When depth > 1, does this call getTransitiveDependents instead?
Unspecified: Is depth a parameter on graph_importers or only on graph_impact?
Unspecified: Barrel files that re-export CircuitBreaker — do they appear as importers?
```

---

### Flow 5 — Agent Uses `graph_impact` Tool (Blast Radius Assessment)

```
Agent: "I'm going to change the CircuitBreaker API.
        What is the full blast radius?"

  graph_impact({ filePath: "src/util/CircuitBreaker.ts", projectId: "abc123" })
    └── BlastRadiusScorer.score(filePath, projectId)
          ├── fanIn = getDirectDependents count
          ├── transitiveFanIn = getTransitiveDependents count (depth=10)
          ├── churnScore = commits touching file in last 90 days
          ├── Min-max normalization across all project files
          └── score = round((0.30 × fi_norm) + (0.40 × tfi_norm) + (0.30 × churn_norm)) × 100
    └── Returns: {
          score: 73,
          tier: "high",
          directDependents: 8,
          transitiveDependents: 31,
          churnScore: 12,
          dependents: [{ path, churnCount }]
        }

Unspecified: Does normalization happen per-call or is it cached?
Unspecified: If Neo4j is down, what does this return?
Unspecified: What if the file has no IMPORTS_FROM edges (not yet analyzed)?
```

---

### Flow 6 — Agent Uses `symbol_definition` Tool

```
Agent: "Where is CircuitBreaker defined? I need to read it before editing."

  symbol_definition({ symbolName: "CircuitBreaker", projectId: "abc123" })
    └── TemporalCodeGraph query: MATCH (s:Symbol {name: "CircuitBreaker"})
                                  WHERE project scope
                                  RETURN s.filePath, s.startLine, s.kind
    └── Returns: { filePath, startLine, endLine, kind, signature }

AMBIGUITY: Multiple files may define a symbol with the same name.
  - "CircuitBreaker" may exist as a class in src/util/CircuitBreaker.ts
    AND as a type alias in src/types/errors.ts
  - Spec does not define disambiguation strategy
  - Does the tool return all matches or only the "best" one?
  - If all matches: what is the return type shape?
```

---

### Flow 7 — Agent Uses `symbol_references` Tool

```
Agent: "How widely is the CircuitBreaker class actually used?
        Help me understand refactor scope."

  symbol_references({ symbolName: "CircuitBreaker", projectId: "abc123" })
    └── [CRITICAL GAP: How are references stored?]

    The spec defines:
      - IMPORTS_FROM edge stores importedNames: string[] on the relationship
      - Symbol nodes exist from SymbolExtractor
    But: reference-counting requires knowing WHICH symbols from a file
         are actually USED by importing files, not just which files import which files.

    Current schema: (File)-[:IMPORTS_FROM {importedNames}]->(File)

    This gives: "file A imports ['CircuitBreaker'] from file B"
    But NOT: "CircuitBreaker is used at line 47 in file A"

    Gap: The spec mentions "symbol reference counts" in Layer 2
    but provides NO schema design for how individual symbol references
    are stored or how they differ from the importedNames array on IMPORTS_FROM.
```

---

### Flow 8 — Agent Uses `temporal_coupling` Tool

```
Agent: "IngestionService.ts keeps having bugs.
        What else tends to change with it?"

  temporal_coupling({ filePath: "src/ingest/IngestionService.ts", projectId: "abc123", minCouplingPct: 50 })
    └── Cypher: MATCH (c:Commit)-[:MODIFIES]->(fileA)
                WHERE fileA.path = $filePath
                WITH count(c) as totalCommitsA
                MATCH (c)-[:MODIFIES]->(fileB)
                WHERE fileB <> fileA
                RETURN fileB.path, count(c)/totalCommitsA as couplingPct
                HAVING couplingPct >= 0.50
    └── Returns: [{ path, couplingPct, sharedCommits }]

Unspecified: Is the TEMPORALLY_COUPLED relationship pre-computed at ingest time
             or computed on demand from Commit graph?
Unspecified: What is the default minCouplingPct if not supplied?
Unspecified: What is the analysis window (days)?
Unspecified: Are the thresholds from code-maat (min 10 shared commits, max 50 files/changeset)
             applied by default or configurable?
```

---

### Flow 9 — Agent Uses `hotspots` Tool

```
Agent: "Before a refactor sprint, show me the riskiest files
        in this project."

  hotspots({ projectId: "abc123", limit: 20 })
    └── For all files in project:
          blastRadiusScore(f) computed and ranked
    └── Returns top-N sorted by score DESC: [{ path, score, tier, fanIn, churnScore }]

Unspecified: Is this a batch operation run at query time (expensive for 390 files)
             or pre-computed and cached at ingest time?
Unspecified: Cache invalidation — when does the hotspot list go stale?
Unspecified: Is hotspot computation triggered as part of ingestion or lazy on first query?
```

---

### Flow 10 — Agent Uses `repo_map` Tool

```
Agent: "Give me a structural overview of this project
        before I start working on a new feature."

  repo_map({ projectId: "abc123", budget: 1024, seedFiles: ["src/mcp/PingMemServer.ts"] })
    └── BlastRadiusScorer ranks all files by score
    └── Starting from seedFiles, expand to neighbors via IMPORTS_FROM
    └── Token counting: each file entry = ~15-30 tokens
    └── Within budget: include filename + exported symbol signatures
    └── Returns: formatted skeleton string (markdown? plain text? JSON?)

Unspecified: Output format — is it a string for direct context injection or structured JSON?
Unspecified: seedFiles behavior when not provided (no seed = full project ranking)
Unspecified: Token counting method — characters/4, tiktoken, or character count?
Unspecified: How are exported symbols obtained? From Symbol nodes or from EXPORTS edges?
Unspecified: What if seedFiles paths are not found in the graph?
```

---

### Flow 11 — Force Reingest After Structural Analysis Added

```
User (via admin panel or CLI): forceReingest = true
  └── IngestionOrchestrator: full rescan, all files re-chunked
  └── StaticAnalyzer: full re-analysis
  └── Phase 9: Full wipe of existing IMPORTS_FROM + EXPORTS edges
               then reinsert all
  └── Phase 10: Full wipe of TEMPORALLY_COUPLED edges
                then recompute from scratch

CRITICAL: The wipe Cypher in 03-neo4j-schema §6.4 is:
  MATCH (p:Project)-[:HAS_FILE]->(f:File)
  MATCH (f)-[r:IMPORTS_FROM|EXPORTS]->()
  DELETE r

This is correct but assumes the File nodes already exist.
On a truly fresh ingest where the project never existed before,
there are no File nodes yet — the DELETE is a no-op (safe but unnecessary).
Spec does not distinguish these two sub-cases explicitly.
```

---

## Phase 2: Flow Permutations Matrix

### Dimension 1: Import Extraction Scenarios

| Import Form | TS AST Node | Spec Handles? | Gap |
|---|---|---|---|
| `import X from './y'` | ImportDeclaration | Yes (default import) | None |
| `import { A, B } from './y'` | ImportDeclaration, named specifiers | Yes | None |
| `import type { T } from './y'` | ImportDeclaration, isTypeOnly=true | Yes (isTypeOnly flag) | None |
| `import * as ns from './y'` | ImportDeclaration, namespace | Implicit | isTypeOnly handling unclear for namespace |
| `import './y'` | ImportDeclaration, side-effect | Not addressed | importedNames=[] or omit edge? |
| `import('./y')` | CallExpression (dynamic) | Explicitly excluded by ADR-05 | See Gap #7 |
| `export { A } from './y'` | ExportDeclaration with source | Yes (EXPORTS edge) | None |
| `export * from './y'` | ExportDeclaration, isStar=true | Yes | Edge direction semantics ambiguous |
| `export * as ns from './y'` | ExportDeclaration, namespaced star | Not addressed | Gap — distinct from plain `export *` |
| `export type { T } from './y'` | ExportDeclaration, type-only | Not addressed | Gap — should isTypeOnly apply to EXPORTS? |
| `require('./y')` | CallExpression | Not addressed | CommonJS in TS files — ignored? |
| `module.exports = ...` | ExpressionStatement | Not addressed | CommonJS exports — ignored? |

### Dimension 2: Path Resolution Scenarios

| Import Path | Resolution Needed | Spec Handles? | Gap |
|---|---|---|---|
| `'./utils'` (no extension) | Try `.ts`, `.tsx`, `.js` | Not specified | Gap #1 — most common pattern |
| `'./utils.js'` (explicit .js) | Direct mapping | Implied | None |
| `'../types'` (parent dir) | Resolve relative to caller | Implied | None |
| `'@/utils'` (path alias) | Read tsconfig.json paths | Not addressed | Gap #2 — breaks import graph |
| `'~/utils'` | Project-root alias | Not addressed | Gap #2 |
| `'../utils/index'` (explicit index) | Direct + .ts extension | Implied | None |
| `'../utils'` (resolves to index.ts) | index.ts barrel | Not specified | Gap #3 |
| `'react'` (npm package) | Cannot resolve to File node | Not addressed | Gap #4 |
| `'node:fs'` (Node built-in) | Cannot resolve to File node | Not addressed | Gap #4 |
| `'bun:test'` (Bun built-in) | Cannot resolve to File node | Not addressed | Gap #4 |
| `/absolute/path` | OS-absolute import | Not addressed | Gap #5 |

### Dimension 3: Graph State at Query Time

| State | `graph_imports` behavior | `graph_impact` behavior | Spec handles? |
|---|---|---|---|
| File never ingested | No File node exists | No data | Not specified |
| File ingested, no structural analysis | File node exists, no IMPORTS_FROM | No edge data | Not specified |
| File ingested + structural data | Full data available | Score computable | Yes |
| Neo4j down | Error thrown | Error thrown | Not specified |
| Neo4j up, structural indexing in-progress | Partial data | Partial/wrong score | Not specified |
| File deleted in latest commit | File node retained, edges stale? | Undefined | Gap #6 |

### Dimension 4: Agent User Types

| User Type | Tool Usage Pattern | Special Considerations |
|---|---|---|
| Coding agent (pre-change) | `graph_impact` → assess blast radius → proceed | Needs fast response (<200ms per spec) |
| Debugging agent | `temporal_coupling` → find co-changed files | Needs historical window config |
| Architecture agent | `repo_map` + `hotspots` | Needs token budget awareness |
| Planning agent | All 8 tools for broad analysis | May call tools in sequence; cache valuable |
| CI/CD agent (post-commit) | Triggers re-ingestion; queries impact | Timing sensitivity |
| First-time agent (cold start) | No data exists yet | Must gracefully handle empty graph |

### Dimension 5: Project Scale Scenarios

| Scale | Files | IMPORTS_FROM edges (est.) | Transitive query time | Risk |
|---|---|---|---|---|
| Tiny | <50 | <100 | <5ms | None |
| Small (ping-mem) | ~390 | ~600-800 | 15-40ms | None per spec |
| Medium | 500-2000 | 1000-4000 | 50-150ms | Possible SLA breach |
| Large | >2000 | >4000 | >200ms | SLA breach (200ms target) |
| Monorepo | >5000 | >10000 | timeout risk | Not addressed |

---

## Phase 3: Missing Elements and Gaps

### Category: Import Path Resolution

**Gap #1 — Extension-less imports are unresolved**
- Description: TypeScript code overwhelmingly imports without extensions (`import { X } from './utils'`) but the target file on disk is `utils.ts`. The TS Compiler API does not auto-resolve extensions without a tsconfig.json project context.
- Impact: Every extension-less import produces an unresolvable target path. If resolution fails, no IMPORTS_FROM edge is created. The entire import graph is hollow.
- Current ambiguity: The spec states "relative path → File node" but does not specify the resolution algorithm.
- Resolution needed: Must define an ordered fallback chain: `path → path.ts → path.tsx → path.js → path/index.ts → path/index.tsx → path/index.js`.

**Gap #2 — TypeScript path aliases (tsconfig paths) are not handled**
- Description: Many TypeScript projects (and ping-mem may use them) define `"@/*": ["src/*"]` or similar in `tsconfig.json`. An import like `import { X } from '@/utils'` resolves to `src/utils.ts`, but without reading `tsconfig.json`, StaticAnalyzer sees only the string `@/utils` with no resolution strategy.
- Impact: All alias-based imports produce unresolved edges. Projects using aliases (common in Next.js, NestJS, Vite projects) produce incomplete graphs.
- Current ambiguity: Not mentioned in the spec at all.
- Resolution needed: StaticAnalyzer must either read `tsconfig.json` at the project root to extract `compilerOptions.paths` and apply them, or explicitly declare that path aliases are out of scope (with a `resolvedPath: null` sentinel).

**Gap #3 — Barrel file index.ts resolution**
- Description: `import { X } from '../utils'` where `../utils/` is a directory containing `index.ts`. Without directory → index.ts fallback, this import is unresolvable.
- Impact: Barrel-heavy codebases (most TypeScript projects with proper module structure) have a large fraction of their imports unresolvable.
- Current ambiguity: Mentioned in the static analysis tools doc as a known pattern but not addressed in the synthesis.

**Gap #4 — External package imports create dangling references**
- Description: `import { useState } from 'react'` has no corresponding File node in the graph. The import path `react` cannot be resolved to any ingested file.
- Impact: These imports either (a) silently produce no edge, (b) throw an error during resolution, or (c) create placeholder File nodes for external packages.
- Current ambiguity: The spec's Cypher for IMPORTS_FROM uses `MATCH (tgt:File { fileId: item.targetFileId })` which silently fails if tgt does not exist — no edge is created, no error is thrown.
- Resolution needed: Define policy: skip external imports (create no edge) and log them, or create external package nodes with a different label (`:ExternalPackage`), or surface them in the result as `unresolvedImports: string[]`.

**Gap #5 — Absolute path imports are not addressed**
- Description: Some projects import with absolute paths (`import X from '/lib/utils'`). These cannot be resolved relative to the project root.
- Impact: Low frequency in practice but should have explicit handling.

### Category: Import Graph Semantics

**Gap #6 — Deleted files have stale import edges**
- Description: When a file is deleted (git `changeType = 'D'`), its File node is retained for history (per the temporal graph design). But any IMPORTS_FROM edges pointing TO the deleted file are stale — no file at that path exists anymore. Any IMPORTS_FROM edges pointing FROM the deleted file are also stale.
- Impact: Impact analysis for surviving files shows phantom dependents on deleted files. The blast radius score inflates.
- Current spec coverage: Mentioned briefly in 03-neo4j-schema §6.4 as "deleted files — delete outgoing edges" but incoming edges (edges pointing TO the deleted file) are not addressed.

**Gap #7 — Dynamic imports are out of scope but not explicitly excluded from the graph**
- Description: `import('./y')` (dynamic imports) cannot be statically resolved in the general case. However, when the path is a string literal (`import('./utils')`), it is fully resolvable.
- Impact: Lazy-loaded modules, code-split chunks, and conditional imports are invisible to the import graph.
- Current spec: ADR-04 excludes call graphs. ADR-05 excludes LSP. Neither ADR explicitly covers dynamic imports.
- Resolution needed: Declare scope — static literal dynamic imports: included (they are resolvable). Dynamic imports with expressions: excluded.

**Gap #8 — Side-effect imports produce an edge with no named imports**
- Description: `import './polyfills'` is a valid import with zero named specifiers. If this creates an IMPORTS_FROM edge with `importedNames: []`, the edge exists but carries no information about what is imported. If impact analysis filters edges where `importedNames` is empty, these dependencies are missed.
- Impact: Side-effect-only modules (polyfills, CSS modules in TS, global registrations) are invisible to impact analysis if edges require named imports.

**Gap #9 — EXPORTS edge direction semantics**
- Description: `(File A)-[:EXPORTS]->(File B)` means "File A re-exports from File B." This is the opposite of the import direction: when someone changes File B, both direct importers of B AND all barrel files (A) that re-export from B are affected. The blast radius query must traverse BOTH IMPORTS_FROM and EXPORTS edges in reverse. The spec acknowledges this (§2.3 in 03-neo4j-schema-and-queries) but the blast radius formula in §4.3 only traverses IMPORTS_FROM.
- Impact: Blast radius is systematically underestimated for any file exported through a barrel.

**Gap #10 — `export * as ns from './y'` (namespace re-export) creates an ambiguous edge**
- Description: This creates an EXPORTS edge with `isStar: false` (it is not a plain star re-export) but `exportedNames: ["ns"]` — but "ns" is a synthetic namespace, not any actual named export of the target file. An agent asking "what does the barrel file export?" cannot determine from the edge alone that `ns` is the namespace alias for all of `./y`'s exports.
- Impact: Agents get incorrect information about what names are available through namespace re-exports.

### Category: BlastRadius Scoring

**Gap #11 — Normalization requires all files to be scored first**
- Description: The formula `normalize(fanIn(f), min_fi, max_fi)` requires knowing `min_fi` and `max_fi` across all files in the project. This means `blastRadiusScore` for a single file cannot be computed in isolation — a full project scan must precede any individual file score.
- Impact: The `graph_impact` tool (which returns a score for one file) is implicitly a batch operation. This must be either pre-computed at ingest time or triggered lazily with project-wide context.
- Current ambiguity: The spec describes the formula but does not specify when normalization bounds are computed or stored.

**Gap #12 — Churn score is time-anchored but the anchor is not stored**
- Description: Per 04-algorithms-and-scoring §5.1, the 90-day window "must use a fixed anchor time per analysis run." But the analysis is triggered during ingestion. The `ingestedAt` timestamp exists on the IngestionResult, but the spec does not state that `churnScore` is anchored to `ingestedAt`.
- Impact: If blast radius is re-queried days after ingestion, the churn window shifts and produces a different score from the same graph state — violating the determinism requirement (P4).

**Gap #13 — New project has no historical data for normalization**
- Description: On first ingestion, all files have `churnScore = 0` if no commits exist yet (or if `maxCommitAgeDays` cuts them all off). When all files have identical metrics, normalization returns 0 for all → all scores are 0. This is technically correct but makes the tool useless immediately after first ingestion.
- Impact: An agent calling `hotspots` after the first ingestion sees all zeros.

### Category: Temporal Coupling

**Gap #14 — Temporal coupling computation timing is unspecified**
- Description: The spec says "A single Cypher aggregation query computes all temporal coupling pairs at persist time." But the exact trigger is unclear: does Phase 10 run the aggregation Cypher and write TEMPORALLY_COUPLED edges, or does it write them on demand when `temporal_coupling` MCP tool is called?
- Impact: If computed at persist time for a 200-commit project with 200 files, this is ~40,000 file pairs to evaluate. The Cypher aggregation may take significant time and should not be part of the synchronous ingestion path without a timeout.

**Gap #15 — CodeScene's noise filters are not specified as defaults**
- Description: The competitive analysis doc (05-competitive-analysis §3) lists CodeScene's noise filters: min 10 shared commits, min 10 revisions per file, min 50% coupling, max 50 files per changeset. The spec's ADR-03 adopts temporal coupling but does not carry these thresholds forward explicitly.
- Impact: Without noise filters, temporal coupling produces high-cardinality false positives — bulk commits (dependency updates, formatting runs) create spurious coupling between unrelated files.

### Category: MCP Tool Schemas

**Gap #16 — None of the 8 MCP tools have defined input/output schemas**
- Description: The spec names 8 tools (`graph_imports`, `graph_importers`, `graph_impact`, `symbol_definition`, `symbol_references`, `temporal_coupling`, `hotspots`, `repo_map`) and lists them in a table, but provides no Zod schema, no TypeScript interface, no JSON example for any tool's input or output.
- Impact: Implementation must invent these schemas, leading to inconsistency. Agents cannot predict the output shape.
- Resolution needed: Each tool needs: input params (required/optional), input validation rules, output schema, error response schema.

**Gap #17 — `repo_map` token counting is undefined**
- Description: The spec states "≤1,024 tokens for default budget" but does not define what "token" means: characters/4 (GPT-4 approximation), tiktoken BPE encoding, or character count. Different counting methods produce different budgets.
- Impact: The repo-map output may exceed context windows if a loose counting method is used.

**Gap #18 — `repo_map` output format is undefined**
- Description: Is the output a Markdown string (like aider's format), plain text, or a structured JSON object? Agents consuming this tool have different needs: some need to inject it into a system prompt (string), others need to parse it programmatically (JSON).

### Category: Infrastructure and Failure Modes

**Gap #19 — Neo4j unavailable during StaticAnalyzer phase**
- Description: StaticAnalyzer.analyze() runs before graph.persistIngestion(). The analyzer reads from existing Commit nodes in Neo4j to compute temporal coupling. If Neo4j is down at StaticAnalyzer time, the coupling computation fails.
- Impact: No specification for what happens: should the ingestion continue without temporal coupling (partial success), or fail the entire ingestion, or skip only the temporal coupling step?

**Gap #20 — StaticAnalyzer failure mode when a file has 0 imports**
- Description: A valid TypeScript file may have zero import statements (e.g., a standalone utility with no dependencies, a constants file). StaticAnalyzer must handle this gracefully: produce no IMPORTS_FROM edges for that file, not error.
- Current spec: Implied but not stated. The Cypher MATCH + DELETE on empty set is a no-op in Neo4j (safe), but the StaticAnalyzer code must not throw if `extractImports()` returns an empty array.

**Gap #21 — What happens when target file is not yet ingested but the import resolves**
- Description: In a monorepo or when ingesting one package that imports another, `import { X } from '../../shared/utils'` may resolve to a valid path that is outside the project root and therefore not a known File node in Neo4j. The MATCH in the IMPORTS_FROM insert query silently fails — no edge is created, no error is surfaced.
- Impact: Cross-package imports within a monorepo are silently dropped from the graph.

**Gap #22 — Circular imports are not handled**
- Description: Circular imports are legal in TypeScript (`A imports B imports A`) and common in practice. The TS Compiler API handles them without error. The IMPORTS_FROM graph would contain a cycle: `(A)-[:IMPORTS_FROM]->(B)-[:IMPORTS_FROM]->(A)`.
- Impact: Variable-length Cypher queries like `MATCH (d)-[:IMPORTS_FROM*1..10]->(target)` will loop and potentially time out on cycles without the `WHERE d <> target` guard. The spec includes `WHERE dependent <> target` in the transitive query (03-neo4j-schema §4.2) but this only prevents returning the start node — it does not prevent traversal through cycles.
- Neo4j does handle cycles in variable-length patterns by tracking visited nodes during traversal, but this is not explicitly verified in the spec.

**Gap #23 — `ensureStructuralIndexes()` is not called anywhere in the specified control flow**
- Description: The spec states Phase 0 adds `ensureStructuralIndexes()` at `TemporalCodeGraph` startup. But the existing `ensureConstraints()` is called via `IngestionService.ensureConstraints()` which must be called explicitly by the caller. There is no specification of when `ensureStructuralIndexes()` is invoked: at class instantiation, at first ingestion, or as a separate explicit call.
- Impact: If indexes are not created before the first MERGE operation, all the performance improvements from Phase 0 are not realized for the first ingestion.

---

## Phase 4: Critical Questions Requiring Clarification

### Priority 1 — Critical (Blocks Implementation or Creates Data Correctness Risks)

**Q1 — What is the exact import resolution algorithm?**

Without this, the import graph is hollow for the most common TypeScript import patterns. The implementation must answer:

- What ordered fallback extensions are tried when an import has no extension? Recommended: `['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js']`
- Is `tsconfig.json` read to resolve path aliases? If yes, from which directory?
- What is the output when resolution fails — skip edge, create a null-target edge, return `unresolvedImport`?
- If you skip: are unresolved imports logged? surfaced on the MCP tool result?

**Default assumption if not answered**: Skip external/unresolvable imports. Log at debug level. Surface count of unresolved imports in IngestProjectResult. Do not fail ingestion.

**Q2 — How does StaticAnalyzer interact with the incremental ingestion model?**

Specifically: when file A changes, only A's imports change. But B (an unchanged file) still imports A. The IMPORTS_FROM edge `(B)-[:IMPORTS_FROM]->(A)` is stored on B's "side" and should not change. Only `(A)-[:IMPORTS_FROM]->(X)` edges need updating. Is this the implementation, or does StaticAnalyzer re-process all files on every incremental run?

**Default assumption if not answered**: StaticAnalyzer re-processes only files where `sha256` changed (as identified by ProjectScanner). B's edge pointing to A is left intact since B's content did not change.

**Q3 — What is the schema for `symbol_references`?**

The spec mentions "symbol reference counts" as Layer 2 but provides no storage design. The IMPORTS_FROM edge carries `importedNames: string[]` which tells you which symbols a file imports from another — but this is not the same as a reference. A file can import `CircuitBreaker` and reference it 47 times in its body.

Options for `symbol_references`:
- Option A: Count `importedNames` occurrences across all IMPORTS_FROM edges as proxy (cheap, imprecise)
- Option B: Walk the AST for all `Identifier` nodes and match against imported names (accurate, expensive)
- Option C: Use `importedNames` count on edges as the reference count — number of edges = number of importing files, not number of calls

Which semantics does `symbol_references` use? This defines whether the tool is "who imports this symbol" or "how many times is this symbol referenced."

**Q4 — Does blast radius scoring run at ingest time or query time?**

This is an architectural fork. Two models:

- **Eager (at ingest)**: Score all files after Phase 9+10 complete. Store `blastRadiusScore` as a property on File nodes. Query is O(1). Stale until next ingestion.
- **Lazy (at query time)**: Score computed on-demand when `graph_impact` or `hotspots` is called. Always fresh. `hotspots` for 390 files runs 390 individual scoring queries — potentially slow.

The spec says the score is "deterministic given the same graph state" which implies it can be cached. But also says "MCP tool response ≤200ms (p95)" — which is only achievable with pre-computation for `hotspots`.

**Q5 — What does the TEMPORALLY_COUPLED relationship actually store, and when is it computed?**

The spec defines the relationship as `(File)-[:TEMPORALLY_COUPLED {coupling_pct, shared_commits}]->(File)` but:

- Is this computed once at full ingestion and stored as relationships?
- Or is it computed on-demand from Commit nodes when `temporal_coupling` MCP is called?
- If stored: how is it invalidated when new commits arrive?
- If on-demand: the Cypher aggregation over all file pairs is O(N²) Commit-File joins — is this within the 200ms SLA?

**Q6 — What is the explicit scope of files that receive structural analysis?**

The existing `ProjectScanner` excludes: `.git`, `node_modules`, `dist`, `.cache`, `.ping-mem`, `.worktrees`, `.claude`, plus binary/media file extensions. But for structural analysis, additional exclusions may be relevant:

- `*.d.ts` (TypeScript declaration files) — these have import/export statements but are not real source files
- `*.test.ts` / `*.spec.ts` — test files import from many places but are not part of the production dependency graph
- Generated files (e.g., Prisma client, GraphQL generated types)

Should test files be included in the import graph? Including them inflates the blast radius of test-shared utilities. Excluding them may miss test-only dependencies.

**Q7 — What does the `graph_impact` tool return when the file has no structural data?**

Three scenarios where a file has no IMPORTS_FROM edges:
1. File was just added and not yet analyzed (first ingestion)
2. File genuinely has no imports (entry points, pure data files)
3. All imports are external (only npm packages)

Scenarios 1 and 2/3 require different responses. The tool must distinguish them:
- Scenario 1: Return 503 or a "not yet indexed" indicator
- Scenarios 2/3: Return a valid response with score=0 and an empty dependents list

### Priority 2 — Important (Significantly Affects UX or Maintainability)

**Q8 — What is the output format of `repo_map`?**

Two viable options:

Option A (string, for direct context injection):
```
src/ingest/IngestionService.ts
  class IngestionService
    ensureConstraints(): Promise<void>
    ingestProject(opts: IngestProjectOptions): Promise<IngestProjectResult | null>

src/graph/TemporalCodeGraph.ts
  class TemporalCodeGraph
    persistIngestion(result: IngestionResult): Promise<void>
```

Option B (structured JSON):
```json
{
  "files": [
    {
      "path": "src/ingest/IngestionService.ts",
      "blastRadiusScore": 67,
      "symbols": ["IngestionService", "IngestProjectOptions", "IngestProjectResult"]
    }
  ],
  "tokenCount": 312,
  "budget": 1024
}
```

The choice affects how agents use the tool. Option A is ready for system-prompt injection. Option B enables agent-side processing and filtering.

**Q9 — Are EXPORTS edges traversed in blast radius queries?**

The synthesis spec includes the EXPORTS relationship in the schema and in `getDirectDependents` (which UNIONs EXPORTS into the result). But the `getBlastRadius` Cypher in 03-neo4j-schema §4.3 only traverses `IMPORTS_FROM`. This inconsistency means barrel files that re-export a module are counted in direct dependents but NOT in transitive dependents, producing an undercount.

Should the transitive query be:
```cypher
MATCH (d)-[:IMPORTS_FROM|EXPORTS*1..10]->(target)
```
instead of:
```cypher
MATCH (d)-[:IMPORTS_FROM*1..10]->(target)
```

**Q10 — How are the 2 new REST endpoints specified?**

The synthesis mentions `GET /api/v1/codebase/impact` and `GET /api/v1/codebase/repo-map` but provides no schema. Minimum needed:

- `GET /api/v1/codebase/impact?projectId=...&filePath=...` → response shape?
- `GET /api/v1/codebase/repo-map?projectId=...&budget=...&seedFiles=...` → response shape?
- Authentication: do these endpoints require API key like existing codebase endpoints?
- Error codes: 404 when file not found? 503 when Neo4j unavailable? 202 when structural data not yet computed?

**Q11 — What is the `IngestProjectResult` change to surface structural analysis status?**

Currently `IngestProjectResult` returns `filesIndexed`, `chunksIndexed`, `commitsIndexed`. After this feature, it should also surface structural analysis results. Candidates:

```typescript
interface IngestProjectResult {
  // existing fields
  filesIndexed: number;
  chunksIndexed: number;
  commitsIndexed: number;
  // new fields
  importsIndexed: number;         // count of IMPORTS_FROM edges created
  unresolvedImports: number;      // count of imports that could not be resolved
  temporallyCoupledPairs: number; // count of TEMPORALLY_COUPLED edges created
  structuralAnalysisDurationMs: number;
}
```

If `IngestProjectResult` is unchanged, agents cannot know whether structural analysis succeeded.

**Q12 — How does the StaticAnalyzer handle the missing `forceReingest` distinction for structural data?**

The existing `forceReingest` flag controls whether the orchestrator re-processes files even if SHA-256 matches. Should this flag also control structural re-analysis? If yes, `forceReingest: false` skips structural re-analysis for unchanged files. If no, structural analysis always runs on the full result.

**Q13 — What are the exact error responses for each MCP tool?**

Each tool can fail in multiple ways. For `graph_impact`:
- File not found in project
- Project not found
- Structural data not yet computed
- Neo4j unavailable
- Timeout on transitive query

The existing MCP tools return errors as thrown exceptions that the MCP framework converts to error responses. The new tools need the same convention, but the specific error strings and codes are not defined.

**Q14 — How does Python file structural analysis fit in?**

`SymbolExtractor.extractPython()` uses regex-based extraction. Python has its own import syntax (`import X`, `from X import Y`, `from . import Z`). The synthesis spec focuses entirely on TypeScript/JavaScript imports using the TS Compiler API. Does the feature:

- Exclude Python files from structural analysis (they get no IMPORTS_FROM edges)?
- Include Python files with a separate regex-based import extractor?
- Note that the existing `SymbolExtractor.extractPython()` is regex-based, so an analogous import extractor could follow the same pattern?

**Q15 — Is `symbol_definition` a lookup by symbol name (string) or by symbolId (hash)?**

The existing Symbol nodes have:
- `symbolId`: SHA-256(filePath + name + kind + startLine)
- `name`: the human-readable name (e.g., "CircuitBreaker")

An agent querying by human-readable name may get multiple results (same name defined in multiple files, or same name with different kinds in the same file). The spec does not define disambiguation. Options:
- Return all matches (accurate, requires agents to pick)
- Return the first match by some ordering (simple, potentially wrong)
- Require `projectId` + `filePath` + `symbolName` to uniquely identify (precise, forces agent to already know the file)

### Priority 3 — Nice to Have (Reasonable Defaults Exist)

**Q16 — Should the `hotspots` tool support filtering by tier?**

`hotspots({ projectId, tier: "critical" })` to return only score ≥75 files. The default of returning all files ranked by score is workable, but tier filtering reduces response size.

**Q17 — Should `graph_imports` and `graph_importers` support depth > 1?**

The spec shows `graph_imports` and `graph_importers` with `depth=1`, and `graph_impact` for deep traversal. But an agent doing "show me the 2-hop import neighborhood" would have to call `graph_imports` on each result of `graph_imports`. Should depth be a shared parameter on all three tools?

**Q18 — Should temporal coupling be bi-directional or directional?**

CodeScene's formula is directional: `coupling(A→B) = shared / total_A`. This means `coupling(A→B)` may differ from `coupling(B→A)`. The TEMPORALLY_COUPLED edge is directed in the schema. But the `temporal_coupling` MCP tool says "what changes with file X" — does it traverse outgoing edges only (X→Y), incoming edges only (Y→X), or both?

**Q19 — Is there a maximum depth cap on `graph_impact` depth parameter?**

The synthesis says depth=10 is the default. Should the tool enforce a maximum (e.g., depth ≤ 15) to prevent inadvertent O(N²) queries from agents providing depth=1000?

---

## Phase 5: Recommended Next Steps

### Step 1 — Answer Critical Questions Before Writing Code (1–2 hours)

Resolve Q1, Q2, Q3, Q4, Q5, Q6, Q7 in a short design decision document. These are the foundation of the implementation. Getting them wrong means rewriting StaticAnalyzer.

**Minimum viable decisions:**
- Import resolution: `['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js']` — no tsconfig alias support in v1 (document this as known limitation)
- StaticAnalyzer scope: incremental (only changed files re-analyzed)
- `symbol_references`: uses `importedNames` on IMPORTS_FROM edges as a proxy (number of importing files, not call count)
- Blast radius: computed eagerly at end of Phase 10, stored as `blastRadiusScore` property on File nodes
- Temporal coupling: stored as TEMPORALLY_COUPLED edges at Phase 10, recomputed on force-reingest

### Step 2 — Define MCP Tool Schemas in types.ts Before Implementing Handlers (1 hour)

Add TypeScript interfaces for all 8 tool inputs and outputs to a new file `src/ingest/structural-types.ts` before writing any handler code. This prevents API drift between the spec and the implementation. Include Zod schemas for validation.

### Step 3 — Write Import Extraction Unit Tests with Synthetic Fixtures Before Implementing SymbolExtractor Changes (0.5 hours)

Per measurable outcome: "≥95% of import/export statements extracted correctly." Write test fixtures covering all 12 import forms in the permutations matrix. Run these against `extractImports()` to validate coverage before wiring into the pipeline.

### Step 4 — Fix Gap #9 Before Implementing BlastRadiusScorer (0.5 hours)

Ensure the transitive dependents query traverses both IMPORTS_FROM and EXPORTS edges:
```cypher
MATCH (d)-[:IMPORTS_FROM|EXPORTS*1..10]->(target)
```
This is a one-line change in the Cypher but has significant correctness impact for barrel-heavy codebases.

### Step 5 — Document the Known Limitations as Part of the Feature Delivery

The following are explicitly not supported in v1. Document them in the implementation summary:
- TypeScript path aliases (`@/`, `~/`, or any `tsconfig.json` paths)
- Dynamic imports with non-literal paths
- CommonJS (`require()`) imports
- Python import extraction for structural graph
- Cross-project import resolution (imports to files outside the project root)
- Function-level reference counts (only file-level counts via importedNames)

This documentation prevents consumer projects from filing bugs against unspecified behavior.

---

## Summary Statistics

| Category | Count |
|---|---|
| Identified user flows | 11 |
| Permutation dimensions | 5 |
| Identified gaps | 23 |
| Critical questions | 19 (7 Critical, 8 Important, 4 Nice-to-have) |
| Import forms requiring explicit handling | 12 |
| Path resolution scenarios | 11 |
| Failure modes identified | 8 |

**Verdict**: The spec is implementation-ready for the core pipeline (Phases 0, 1, 2) but requires answers to Q1–Q7 before StaticAnalyzer and BlastRadiusScorer can be written correctly. The MCP tool layer (Phase 2) requires all 8 tool schemas to be defined first. The blast radius formula is correct and deterministic once the IMPORTS_FROM graph exists.
