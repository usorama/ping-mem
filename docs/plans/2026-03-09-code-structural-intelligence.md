---
title: "feat: Code Structural Intelligence — Import Graph, Blast Radius, Repo-Map"
type: feat
date: 2026-03-09
github_issue: "#29"
research: docs/research/2026-03-09-code-structural-intelligence/ (7 documents)
synthesis: docs/research/2026-03-09-code-structural-intelligence/06-synthesis.md
eval_iteration: 1
review_iteration: 1
verification_iteration: 1
verification_method: "4-agent binary verification (67 claims, sources: actual source files + TS Compiler API docs)"
---

# feat: Code Structural Intelligence — Import Graph, Blast Radius, Repo-Map

## Problem Statement

ping-mem agents have no understanding of code structure. They can search code semantically (Qdrant) and query git history (Neo4j), but they cannot answer:

- "What files does `src/graph/TemporalCodeGraph.ts` import?"
- "If I change `src/ingest/IngestionService.ts`, what else breaks?"
- "What are the highest-risk files to touch in this codebase?"
- "Give me a map of the most important files for understanding this feature"

**Evidence from codebase audit** (`01-codebase-audit.md §3`):
- `RelationshipInferencer.ts` uses NLP text patterns, not code AST — it cannot answer any of these questions
- `TemporalCodeGraph.ts` has `HAS_FILE`, `MODIFIES`, `CHANGES` relationships but no `IMPORTS_FROM`, no `EXPORTS`, no structural edges of any kind
- `SymbolExtractor.ts` at line 48 extracts 9 symbol kinds from AST but does NOT extract import declarations

**Evidence from codebase audit** (`01-codebase-audit.md §2`):
- Neo4j has no indexes on `File(path)`, `Chunk(chunkId)`, `Symbol(symbolId)`, or `Commit(hash)` — every MERGE is a full label scan (O(N²) performance bug, pre-existing)

**Competitive evidence** (`05-competitive-analysis.md`):
- LocAgent (ACL 2025) achieved 92.7% file-level accuracy on SWE-Bench at 86% cost reduction using a ranked file+symbol skeleton
- aider's repo-map uses the same import-graph + reference-count approach
- CodeScene's temporal coupling from git history reveals hidden dependencies that static imports don't show

---

## Proposed Solution

Add three layers of structural intelligence to ping-mem:

```
Layer 1: File-Level Import Graph
  SymbolExtractor.extractImports() ──► StaticAnalyzer.analyze()
       (AST: ImportDeclaration)              (cross-file resolution)
                                                    │
                                     TemporalCodeGraph.persistStructuralEdges()
                                       (File)-[:IMPORTS_FROM]->(File)

Layer 2: Blast Radius Scoring
  TemporalCodeGraph.computeAndPersistBlastRadius()
       (fanIn + transitiveFanIn + churn)  writes File.blastRadiusScore property

Layer 3: Agent-Facing Tools (6 MCP + 2 REST)
  graph_imports │ graph_importers │ graph_impact │ symbol_definition
  hotspots │ repo_map
```

**New components:**
- `src/ingest/StaticAnalyzer.ts` — cross-file import resolution only (temporal coupling deferred to v2)

**Modified components:**
- `src/ingest/SymbolExtractor.ts` — add `private parseTypeScript()` helper + `extractImports()` method
- `src/ingest/types.ts` — add `ExtractedImport`, `ResolvedImport`, `EnrichedIngestionResult`, `FileBlastRadius`, `StaticAnalysisResult`, `BlastRadiusTier` types
- `src/ingest/IngestionService.ts` — inject StaticAnalyzer between lines 109–117; add 6 proxy query methods; blast radius call after persistIngestion()
- `src/graph/TemporalCodeGraph.ts` — extend `ensureConstraints()` with 5 indexes; add Phase 9 (persistStructuralEdges); add `computeAndPersistBlastRadius()` (private + public entry point); add 6 new query methods
- `src/mcp/handlers/index.ts` — export StructuralToolModule
- `src/mcp/PingMemServer.ts` — register StructuralToolModule in TOOLS + modules arrays
- `src/http/rest-server.ts` — 2 new REST endpoints

---

## Gap Coverage Matrix

| Gap | Resolution | Phase |
|-----|-----------|-------|
| No Neo4j indexes (O(N²) MERGE bug) | Phase 0: extend `ensureConstraints()` with 5 new indexes | Phase 0 |
| No import extraction in SymbolExtractor | Phase 1: add `extractImports()` to SymbolExtractor | Phase 1a |
| No cross-file resolution (import "./utils" → File node) | Phase 1: StaticAnalyzer.analyze() with fallback chain | Phase 1b |
| No IMPORTS_FROM Neo4j edges | Phase 1: TemporalCodeGraph Phase 9 (persistStructuralEdges) | Phase 1c |
| No blast radius scoring | Phase 2: `computeAndPersistBlastRadius()` on TemporalCodeGraph | Phase 2 |
| No agent-facing impact/map tools | Phase 3: 6 MCP tools + 2 REST endpoints | Phase 3 |

_Deferred to v2 (not in scope)_: EXPORTS edge type (no v1 query), temporal coupling TEMPORALLY_COUPLED edges (O(N²) in-memory, marginal v1 value — hotspots+churn covers the use case), call graph, symbol_references (duplicate of symbol_definition + graph_importers).

---

## Critical Questions — Answers

### Q1: What is the exact import resolution algorithm?

**Answer (binding)**: StaticAnalyzer resolves each raw import specifier to a file path using the following fallback chain (in order, first match wins):

1. **Absolute path rejection**: if specifier starts with `/`, log warning `[StaticAnalyzer] rejected absolute import: "${specifier}" in "${sourceFile}"` and skip. Absolute paths are not portable and are a path traversal risk — they are never followed.
2. **Relative path + extension trial**: if specifier starts with `./` or `../`, resolve relative to the source file's directory. Try in order: `{specifier}`, `{specifier}.ts`, `{specifier}.tsx`, `{specifier}.js`, `{specifier}.jsx`. After each candidate resolution, apply containment check: `resolvedAbsolute.startsWith(projectRoot + path.sep)` — reject and warn if outside project root (path traversal mitigation).
3. **Relative path + index barrel**: try `{specifier}/index.ts`, `{specifier}/index.tsx`, `{specifier}/index.js`, `{specifier}/index.jsx`. Same containment check applies after each candidate.
4. **tsconfig paths alias**: if `tsconfig.json` exists in the project root, read its `compilerOptions.paths` map. For each alias pattern (`@/*`, `~/*`, etc.), attempt substitution and re-apply steps 2–3. Apply containment check after alias substitution — an alias pointing outside the project root is rejected with a warning.
5. **Non-relative (external)**: any specifier not starting with `.` or `/` is treated as an external dependency (node module). Store as `{ isExternal: true, packageName: specifierRoot }`. Do NOT create a File node connection for external imports.

If no match after steps 1–5: log a warning `[StaticAnalyzer] unresolved import: "${specifier}" in "${sourceFile}"` and skip (do not create a broken edge).

### Q2: Does StaticAnalyzer re-analyze only changed files or all files on each incremental run?

**Answer (binding)**: StaticAnalyzer re-analyzes ALL files on every run. No in-memory SHA cache is maintained across process restarts (would only help within a single process lifetime, not across server restarts). Import edges use MERGE semantics in Neo4j (idempotent no-op for unchanged edges). The TypeScript AST parse is cheap (in-process, no disk I/O per file). MERGE ensures correctness regardless of how many times ingest runs.

### Q3: How do callers find references to a named symbol?

**Answer (binding)**: Use two existing tools in sequence: (1) `symbol_definition({symbolName})` returns the file path where the symbol is defined; (2) `graph_importers({filePath})` returns all files that import that file. A dedicated `symbol_references` tool is not needed — it would be a thin composition of these two, adding API surface without new capability. Call-site-level references are deferred to v2 (requires call graph).

### Q4: Is blast radius scoring computed at ingest time or query time?

**Answer (binding)**: Eager at ingest time, but in `IngestionService.ingestProject()` — NOT inside `persistIngestion()`. The sequence: (1) `persistIngestion(enrichedResult)` commits Phase 9 (IMPORTS_FROM edges) to Neo4j; (2) `this.codeGraph.computeAndPersistBlastRadius()` runs 3 project-wide aggregation queries against the now-committed import graph and writes `blastRadiusScore` + `blastRadiusTier` to each `File` node. The `graph_impact` and `hotspots` tools are then instant lookups (no traversal at query time). Blast radius scoring CANNOT run inside `persistIngestion()` because it requires querying the IMPORTS_FROM graph that is being written in that same call.

**Rationale**: Normalization requires all-files stats (min-max). Computing it lazily per-file at query time would require a full-project scan on every `graph_impact` call. Eager pre-computation is O(N) at ingest time once, vs O(N×queries) lazily.

### Q5: Is temporal coupling (co-change analysis) included in v1?

**Answer (binding)**: No — deferred to v2. Temporal coupling (identifying file pairs that frequently change together via `(File)-[:TEMPORALLY_COUPLED]->(File)`) requires O(N²) in-memory pair scanning over all commits × all file pairs. For a 1,000-commit/300-file repo: 44,850 pairs checked on every ingest. The blast radius `churnScore` component already captures "how often does this file change" (a proxy signal) without the quadratic cost. The dedicated `temporal_coupling` MCP tool and `TEMPORALLY_COUPLED` edge type will ship in v2.

### Q6: Are test files included in the import graph?

**Answer (binding)**: Yes — test files are included in the import graph because "file X test imports source file Y" is a valid dependency edge showing which source files are tested. Each `File` node gains an `isTest: boolean` property based on path pattern matching (`*.test.ts`, `*.test.tsx`, `*.spec.ts`, `*.spec.tsx`, `__tests__/` path component). Test files are EXCLUDED from the blast radius normalization denominator — their high fan-in (test files are imported by no other files) would distort the min-max normalization of production code files. The `hotspots` tool excludes test files from results by default; `graph_impact` includes them when computing who is affected.

### Q7: What does `graph_impact` return when structural data does not yet exist for a file?

**Answer (binding)**: Returns a structured error response:
```json
{
  "error": "structural_data_not_available",
  "message": "No structural analysis found for this file. Run codebase_ingest to build the import graph.",
  "filePath": "<requested path>"
}
```
Never returns silent empty arrays. In the MCP tool handler, this produces a tool result with `isError: true`. In the REST endpoint, this produces HTTP 404 with the above JSON body.

---

## Implementation Phases

### Phase 0: Neo4j Indexes (~2 hours)

**Goal**: Eliminate O(N²) MERGE full label scans on all existing persist operations.

**Changes**:
- `src/graph/TemporalCodeGraph.ts`: Extend the existing `ensureConstraints()` method (already called at startup) to also create the 5 new indexes (exact Cypher in Schema Definitions section below). No new method is needed — adding to `ensureConstraints()` is idempotent and follows the existing pattern. Remove any reference to calling `ensureStructuralIndexes()` from `persistIngestion()`.

**Quality gate**: `bun run typecheck && bun test` — 0 errors, 0 test failures.

---

### Phase 1: Import Graph (~8 hours)

**Goal**: Extract import relationships and persist as `IMPORTS_FROM` edges in Neo4j.

_Note: EXPORTS edges are deferred to v2 (no v1 query tool uses them — YAGNI)._

**Changes**:
- **Phase 1a** — `src/ingest/SymbolExtractor.ts`: Add `extractImports(filePath, content): ExtractedImport[]` method using `ts.SyntaxKind.ImportDeclaration` + `ts.SyntaxKind.ExportDeclaration` visitor in `extractTypeScript()`. Note: `isExport: boolean` on `ExtractedImport` is metadata for callers but no EXPORTS Neo4j edge is created.
- **Phase 1b** — `src/ingest/StaticAnalyzer.ts` (NEW): `analyze(result: IngestionResult): Promise<StaticAnalysisResult>` — cross-file resolution using Q1 fallback chain; re-analyzes all files on every run (MERGE is idempotent); returns `ResolvedImport[]` only (no temporal coupling).
- **Phase 1c** — `src/ingest/types.ts`: Add `ExtractedImport`, `ResolvedImport`, `EnrichedIngestionResult`, `StaticAnalysisResult` types.
- **Phase 1d** — `src/ingest/IngestionService.ts`: Inject `StaticAnalyzer` between lines 109–117; construct as `new StaticAnalyzer(new SymbolExtractor())` internally (no new `IngestionServiceOptions` entries).
- **Phase 1e** — `src/graph/TemporalCodeGraph.ts`: Add `persistStructuralEdges()` (Phase 9, IMPORTS_FROM only) + call from `persistIngestion()`. Also extend `persistFilesBatch()` to write `f.isTest` on File nodes — computed inline in the `items` mapping: `isTest: /\.(?:test|spec)\.[tj]sx?$/.test(f.filePath) || f.filePath.includes('/__tests__/')`. Extend the Cypher SET to include `f.isTest = item.isTest`. This writes an explicit boolean to every File node (never IS NULL), enabling `WHERE f.isTest = false` in hotspots queries.

**Quality gate**: `bun run typecheck && bun test` — 0 errors, 0 test failures. Integration test: ingest ping-mem itself, verify `MATCH (f:File)-[:IMPORTS_FROM]->(g:File) RETURN count(*)` returns > 0.

---

### Phase 2: Blast Radius Scoring (~4 hours)

**Goal**: Deterministic 0–100 risk score per file, cached on File nodes.

_Note: BlastRadiusScorer is NOT a separate class/file — logic is a private method on TemporalCodeGraph where all 3 aggregation queries already live._

**Changes**:
- **Phase 2a** — `src/ingest/types.ts`: Add `FileBlastRadius`, `BlastRadiusTier` types.
- **Phase 2b** — `src/graph/TemporalCodeGraph.ts`: Add `computeAndPersistBlastRadius(projectId, allFiles, analysisTimestamp)` — runs 3 project-wide aggregation queries, normalizes, writes `blastRadiusScore` + `blastRadiusTier` to File nodes.
- **Phase 2c** — `src/ingest/IngestionService.ts`: Call `this.codeGraph.computeAndPersistBlastRadius(...)` after `persistIngestion()` returns.

**Quality gate**: Same as Phase 1. Additional: snapshot test that scoring is bit-for-bit deterministic (run twice, assert identical output).

---

### Phase 3: MCP Tools + REST Endpoints (~4 hours)

**Goal**: 6 MCP tools + 2 REST endpoints surfacing all structural data to agents.

**Changes**:
- **Phase 3a** — `src/mcp/handlers/StructuralToolModule.ts` (NEW): 6 tool definitions (`STRUCTURAL_TOOLS` constant) + handler dispatch; export from `handlers/index.ts`; register in `PingMemServer.ts` `TOOLS` spread and `modules` array (dual-import pattern — see Integration Point 7).
- **Phase 3b** — `src/ingest/IngestionService.ts`: 6 new proxy query methods delegating to `this.codeGraph`.
- **Phase 3c** — `src/http/rest-server.ts`: 2 new REST endpoints (`/api/v1/codebase/impact`, `/api/v1/codebase/hotspots`) with `requireApiKey` middleware.

**Quality gate**: `bun run typecheck && bun test` — 0 errors. Integration test: each tool returns non-empty results against ingested ping-mem.

---

## Database Schema Definitions

### Phase 0: Neo4j Indexes

```cypher
// Added to the EXISTING ensureConstraints() method in TemporalCodeGraph.ts
// (already called at Neo4j startup — no new call site needed)

CREATE INDEX file_path_idx IF NOT EXISTS FOR (f:File) ON (f.path);
CREATE INDEX file_id_idx IF NOT EXISTS FOR (f:File) ON (f.fileId);
CREATE INDEX chunk_id_idx IF NOT EXISTS FOR (c:Chunk) ON (c.chunkId);
CREATE INDEX symbol_id_idx IF NOT EXISTS FOR (s:Symbol) ON (s.symbolId);
CREATE INDEX commit_hash_idx IF NOT EXISTS FOR (cm:Commit) ON (cm.hash);
// Note: Project.projectId already has a uniqueness constraint (existing ensureConstraints())
// The unique constraint implicitly creates an index — no duplicate needed
```

### Phase 1: IMPORTS_FROM Edge Batch Upsert

```cypher
// $items: Array<{
//   sourceFileId: string,
//   targetFileId: string,
//   targetPath: string,
//   importedNames: string[],
//   isTypeOnly: boolean,
//   resolvedPath: string
// }>
UNWIND $items AS item
MATCH (source:File { fileId: item.sourceFileId })
MATCH (target:File { fileId: item.targetFileId })
MERGE (source)-[r:IMPORTS_FROM { resolvedPath: item.resolvedPath }]->(target)
SET r.importedNames = item.importedNames,
    r.isTypeOnly    = item.isTypeOnly,
    r.ingestedAt    = $ingestedAt
```

### Phase 2: Blast Radius Score Update

```cypher
// $items: Array<{ fileId: string, blastRadiusScore: number, tier: string }>
// tier: "none" | "low" | "medium" | "high" | "critical"
UNWIND $items AS item
MATCH (f:File { fileId: item.fileId })
SET f.blastRadiusScore = item.blastRadiusScore,
    f.blastRadiusTier  = item.tier,
    f.blastRadiusScoredAt = $scoredAt
```

### Phase 3: Query Methods (Cypher)

```cypher
-- queryDirectImports (files imported by filePath, project-scoped)
MATCH (p:Project { projectId: $projectId })-[:HAS_FILE]->(f:File { path: $filePath })
MATCH (f)-[r:IMPORTS_FROM]->(target:File)
RETURN target.path AS targetPath,
       r.importedNames AS importedNames,
       r.isTypeOnly AS isTypeOnly

-- queryDirectImporters (files that import filePath, project-scoped for both sides)
MATCH (p:Project { projectId: $projectId })-[:HAS_FILE]->(f:File { path: $filePath })
MATCH (p)-[:HAS_FILE]->(importer:File)
WHERE (importer)-[:IMPORTS_FROM]->(f)
RETURN importer.path AS importerPath

-- queryTransitiveImpact (files transitively dependent on filePath, project-scoped)
-- Note: both source file and dependents must belong to same project to avoid cross-project contamination
MATCH (p:Project { projectId: $projectId })-[:HAS_FILE]->(f:File { path: $filePath })
MATCH (p)-[:HAS_FILE]->(dependent:File)
WHERE (dependent)-[:IMPORTS_FROM*1..10]->(f)
RETURN DISTINCT dependent.path AS path, dependent.blastRadiusScore AS score

-- queryBlastRadius (single file score lookup)
MATCH (p:Project { projectId: $projectId })-[:HAS_FILE]->(f:File { path: $filePath })
RETURN f.blastRadiusScore AS score, f.blastRadiusTier AS tier

-- queryHotspots (top-N files by blast radius score)
-- f.isTest = false (explicit boolean — written at persist time for all files, not IS NULL)
MATCH (p:Project { projectId: $projectId })-[:HAS_FILE]->(f:File)
WHERE f.blastRadiusScore IS NOT NULL AND f.isTest = false
RETURN f.path AS path, f.blastRadiusScore AS score, f.blastRadiusTier AS tier
ORDER BY f.blastRadiusScore DESC
LIMIT $limit

-- querySymbolDefinition (find file + location of a named symbol, project-scoped)
MATCH (p:Project { projectId: $projectId })-[:HAS_FILE]->(f:File)-[:HAS_CHUNK]->(c:Chunk)-[:DEFINES_SYMBOL]->(s:Symbol)
WHERE s.name = $symbolName
  AND ($kind IS NULL OR s.kind = $kind)
RETURN f.path AS filePath,
       s.name AS name,
       s.kind AS kind,
       s.startLine AS startLine,
       s.endLine AS endLine,
       s.signature AS signature
LIMIT 10
```

_Removed from v1 (deferred to v2)_: `queryTemporalCoupling` (TEMPORALLY_COUPLED edges not persisted in v1), `queryFileSymbols` (repo_map simplified to ranked file list — no symbol skeletons in v1, avoids untracked `isExported` property requirement on Symbol nodes).

---

## Function Signatures

### New: `ExtractedImport` type (`src/ingest/types.ts`)

```typescript
export interface ExtractedImport {
  specifier: string;       // Raw import specifier: "./utils", "@/types", "zod"
  importedNames: string[]; // Named imports: ["createServer", "ServerOptions"]
  isTypeOnly: boolean;     // true for "import type { ... }"
  isStar: boolean;         // true for "import * as X from ..."
  isExport: boolean;       // true for "export { X } from ..." (metadata only — no EXPORTS edge created in v1)
  lineNumber: number;      // 1-indexed line of the import statement
}
```

### New: `ResolvedImport` type (`src/ingest/types.ts`)

```typescript
export interface ResolvedImport {
  sourceFileId: string;    // SHA-256 of source file path
  targetFileId: string;    // SHA-256 of resolved target file path
  targetPath: string;      // Absolute path of resolved target file
  resolvedPath: string;    // Same as targetPath (stored on edge for readability)
  importedNames: string[];
  isTypeOnly: boolean;
  isExternal: boolean;     // true = node_modules or unresolvable (these are skipped — no edge created)
  packageName?: string;    // Set when isExternal = true
}
// Note: isExport removed from ResolvedImport — no EXPORTS Neo4j edge in v1.
// Only IMPORTS_FROM edges are persisted (from non-export, non-external declarations).
```

### New: `FileBlastRadius` type (`src/ingest/types.ts`)

```typescript
export type BlastRadiusTier = "none" | "low" | "medium" | "high" | "critical";

export interface FileBlastRadius {
  fileId: string;
  filePath: string;
  blastRadiusScore: number;  // 0–100 (deterministic)
  tier: BlastRadiusTier;
  fanIn: number;
  transitiveFanIn: number;
  churnScore: number;
  isTest: boolean;
}
```

### Modified: `SymbolExtractor` (`src/ingest/SymbolExtractor.ts`)

```typescript
// New private helper shared by extractTypeScript() and extractImports():
private parseTypeScript(filePath: string, content: string): ts.SourceFile
// Creates and caches a ts.SourceFile; extractTypeScript() and extractImports() both call this
// to avoid double-parsing the same file content

extractImports(filePath: string, content: string): ExtractedImport[]
// Called only for .ts/.tsx/.js/.jsx files
// Calls this.parseTypeScript() — does NOT re-parse (shared SourceFile)
// Visits ts.SyntaxKind.ImportDeclaration and ts.SyntaxKind.ExportDeclaration nodes
// Returns empty array for Python files (Python structural analysis is v2)
```

### New: `StaticAnalysisResult` type (`src/ingest/types.ts`)

```typescript
// Lives in types.ts — NOT in IngestionOrchestrator.ts — to avoid circular dependency
// (IngestionOrchestrator defines IngestionResult; StaticAnalyzer imports IngestionResult;
//  if StaticAnalysisResult were in IngestionOrchestrator.ts, adding it to IngestionResult
//  would create: Orchestrator → StaticAnalyzer → Orchestrator)
export interface StaticAnalysisResult {
  resolvedImports: ResolvedImport[];
  unresolved: { specifier: string; sourceFile: string }[];
}
```

### New: `EnrichedIngestionResult` (`src/ingest/types.ts`)

```typescript
// Lives in types.ts (NOT IngestionService.ts) to avoid circular dependency:
// TemporalCodeGraph.ts imports types.ts; TemporalCodeGraph.persistIngestion() accepts
// IngestionResult | EnrichedIngestionResult. If EnrichedIngestionResult were in
// IngestionService.ts, TemporalCodeGraph would need to import from ingest/IngestionService.ts,
// creating graph/ → ingest/IngestionService while ingest/ → graph/ already exists (circular).
export interface EnrichedIngestionResult extends IngestionResult {
  staticAnalysis: StaticAnalysisResult;
}
```

### New: `StaticAnalyzer` (`src/ingest/StaticAnalyzer.ts`)

```typescript
// Imports:
//   IngestionResult, CodeFileResult — from src/ingest/IngestionOrchestrator.ts (NOT types.ts)
//   StaticAnalysisResult, ResolvedImport, ExtractedImport — from src/ingest/types.ts
//   SymbolExtractor — from src/ingest/SymbolExtractor.ts
//
// Constructed in IngestionService constructor as: new StaticAnalyzer(new SymbolExtractor())
// (SymbolExtractor is not available via IngestionService fields — constructed internally here)
// Note: IngestionOrchestrator also has symbolExtractor (line 63), but it is private.
//       StaticAnalyzer constructs its own instance — cheap construction, no shared state needed.
export class StaticAnalyzer {
  constructor(private readonly symbolExtractor: SymbolExtractor) {}

  async analyze(result: IngestionResult): Promise<StaticAnalysisResult>
  // Steps:
  // 1. Build a filePath → fileId map from result.codeFiles
  // 2. For ALL files in result.codeFiles: call symbolExtractor.extractImports()
  //    (re-analyzes all on every run — MERGE handles idempotency, no in-process SHA cache)
  // 3. Resolve each ExtractedImport specifier using Q1 fallback chain
  // 4. Build ResolvedImport[] (skip externals, skip unresolvable, skip isExport=true in v1)
  // Returns: { resolvedImports, unresolved }

  private resolveImport(
    specifier: string,
    sourceFilePath: string,
    projectRoot: string,
    allFilePaths: Set<string>,
    tsconfigPaths?: Record<string, string[]>
  ): string | null
  // Returns absolute path of resolved file, or null if unresolvable/external

  private loadTsconfigPaths(projectRoot: string): Record<string, string[]> | null
  // Reads tsconfig.json at projectRoot; returns compilerOptions.paths or null
}
```

### New: `computeAndPersistBlastRadius()` method on `TemporalCodeGraph` (`src/graph/TemporalCodeGraph.ts`)

_BlastRadiusScorer is NOT a separate class/file (YAGNI — used in exactly one place, no injection needed). Logic lives as a method on TemporalCodeGraph where all 3 aggregation queries already live._

```typescript
// Called from IngestionService AFTER persistIngestion() returns:
//   await this.codeGraph.computeAndPersistBlastRadius(projectId, allFiles, ingestedAt)
// Imports: CodeFileResult from src/ingest/IngestionOrchestrator.ts (NOT types.ts)
async computeAndPersistBlastRadius(
  projectId: string,
  allFiles: CodeFileResult[],
  analysisTimestamp: string  // ISO 8601 — anchor for 90-day churn window
): Promise<void>
// Uses 3 project-wide aggregation queries (NOT one query per file):
//
// Query 1: All direct fanIn per file (project-scoped importers via HAS_FILE)
//   MATCH (p:Project { projectId: $projectId })-[:HAS_FILE]->(f:File)
//   OPTIONAL MATCH (p)-[:HAS_FILE]->(importer:File)
//   WHERE (importer)-[:IMPORTS_FROM]->(f)
//   RETURN f.fileId, f.path, f.isTest, count(importer) AS fanIn
//
// Query 2: All churn scores per file (commits in last 90 days, project-scoped via relationship)
//   MATCH (p:Project { projectId: $projectId })-[:HAS_FILE]->(f:File)
//   OPTIONAL MATCH (p)-[:HAS_COMMIT]->(c:Commit)-[:MODIFIES]->(f)
//   WHERE c.authorDate >= $since
//   RETURN f.fileId, count(c) AS churnScore
//   NOTE: Uses c.authorDate (ISO string, written by persistCommitsBatch) NOT c.timestamp
//   NOTE: Commit nodes have NO projectId property — scoped via (p)-[:HAS_COMMIT]->(c) relationship
//
// Query 3: All transitive fanIn per file (project-scoped dependents via HAS_FILE)
//   MATCH (p:Project { projectId: $projectId })-[:HAS_FILE]->(f:File)
//   OPTIONAL MATCH (p)-[:HAS_FILE]->(dep:File)
//   WHERE (dep)-[:IMPORTS_FROM*1..10]->(f)
//   RETURN f.fileId, count(DISTINCT dep) AS transitiveFanIn
//
// Merge all 3 query results by fileId in memory.
// Exclude test files (isTest = true) from normalization denominator.
// Apply min-max normalization; compute composite score; assign tier.
// Call persistBlastRadiusScores() to write File.blastRadiusScore + File.blastRadiusTier.

private normalizeScores(values: number[]): number[]
// min-max normalization: (x - min) / (max - min); returns 0 when max === min

private assignBlastRadiusTier(score: number): BlastRadiusTier
// 0→"none", 1-24→"low", 25-49→"medium", 50-74→"high", 75-100→"critical"
```

### New: TemporalCodeGraph methods (`src/graph/TemporalCodeGraph.ts`)

```typescript
// NOTE: ensureStructuralIndexes() is NOT a new method.
// The 5 new index CREATE statements are added to the EXISTING ensureConstraints() method
// (called at Neo4j startup, before any ingestion).

async persistStructuralEdges(
  projectId: string,
  ingestedAt: string,
  resolvedImports: ResolvedImport[]
): Promise<void>
// Phase 9: UNWIND batch MERGE of IMPORTS_FROM edges only (no EXPORTS in v1)

// NOTE: persistTemporalCoupling() is NOT added in v1 (temporal coupling deferred to v2)
// NOTE: persistBlastRadiusScores() is a private helper called by computeAndPersistBlastRadius()

async computeAndPersistBlastRadius(
  projectId: string,
  allFiles: CodeFileResult[],
  analysisTimestamp: string
): Promise<void>
// Public entry point — runs 3 project-wide aggregation queries, normalizes, persists scores
// Called from IngestionService AFTER persistIngestion() returns (not inside it)
// See BlastRadiusScorer section above for full query spec with bug-fix notes

async queryDirectImports(
  projectId: string,
  filePath: string
): Promise<Array<{ targetPath: string; importedNames: string[]; isTypeOnly: boolean }>>

async queryDirectImporters(
  projectId: string,
  filePath: string
): Promise<string[]>
// Project-scoped: MATCH (p)-[:HAS_FILE]->(importer) WHERE (importer)-[:IMPORTS_FROM]->(f)
// Returns file paths (relativized to project root before returning to callers)

async queryTransitiveImpact(
  projectId: string,
  filePath: string,
  maxDepth?: number  // default 10
): Promise<Array<{ path: string; score: number | null }>>
// Project-scoped: MATCH (p)-[:HAS_FILE]->(dependent) WHERE (dependent)-[:IMPORTS_FROM*1..10]->(f)

async queryBlastRadius(
  projectId: string,
  filePath: string
): Promise<{ score: number; tier: BlastRadiusTier } | null>
// Returns null if structural data not yet computed (blast radius not yet run for this file)

async queryHotspots(
  projectId: string,
  limit?: number  // default 20
): Promise<Array<{ path: string; score: number; tier: BlastRadiusTier }>>
// WHERE f.isTest = false (explicit boolean — written at persist time for all files, not IS NULL)

async querySymbolDefinition(
  projectId: string,
  symbolName: string,
  kind?: string  // optional: "function" | "class" | "interface" | "type" | etc.
): Promise<Array<{ filePath: string; name: string; kind: string; startLine: number; endLine: number; signature: string }>>
// Uses DEFINES_SYMBOL relationship (existing in TemporalCodeGraph schema)
// Project-scoped: MATCH (p)-[:HAS_FILE]->(f)-[:HAS_CHUNK]->(c)-[:DEFINES_SYMBOL]->(s)
```

_Removed from v1_: `persistTemporalCoupling()`, `queryTemporalCoupling()` (temporal coupling deferred), `queryFileSymbols()` (repo_map simplified — no symbol skeletons).

---

## Integration Points

### Integration Point 1: `TemporalCodeGraph.ensureConstraints()` — Phase 0 index additions
**File**: `src/graph/TemporalCodeGraph.ts`
**Before**: `ensureConstraints()` creates uniqueness constraint on Project.projectId
**After**: Add the 5 new `CREATE INDEX ... IF NOT EXISTS` statements to `ensureConstraints()`. This method is already called at Neo4j startup — no changes to `persistIngestion()` call sites.

### Integration Point 2: `SymbolExtractor.extractTypeScript()` — import visitor
**File**: `src/ingest/SymbolExtractor.ts`
**Before** (line 48): `private extractTypeScript(filePath: string, content: string): ExtractedSymbol[]` — visits FunctionDeclaration, ClassDeclaration, etc.; no ImportDeclaration
**After**: Add new method `extractImports(filePath: string, content: string): ExtractedImport[]` using same `ts.createSourceFile()` but visiting only `SyntaxKind.ImportDeclaration` and `SyntaxKind.ExportDeclaration` nodes

### Integration Point 3: `IngestionService.ingestProject()` — StaticAnalyzer injection
**File**: `src/ingest/IngestionService.ts`
**Before** (line 109): `const ingestionResult = await this.orchestrator.ingest(...)`
**Before** (line 117): `await this.codeGraph.persistIngestion(enrichedResult)`
**After**: Insert between lines 109 and 117:
```typescript
// Phase 1.5: Static structural analysis (import graph resolution)
const staticAnalysis = await this.staticAnalyzer.analyze(ingestionResult);
// Wrap in EnrichedIngestionResult — do NOT mutate ingestionResult directly
// (avoids circular dependency: IngestionOrchestrator does NOT import StaticAnalysisResult)
const enrichedResult: EnrichedIngestionResult = { ...ingestionResult, staticAnalysis };
```
`StaticAnalyzer` is constructed internally in the `IngestionService` constructor:
`this.staticAnalyzer = new StaticAnalyzer(new SymbolExtractor())` — no new option entries in `IngestionServiceOptions`.
_Note_: `this.symbolExtractor` does NOT exist on `IngestionService` (it lives inside `IngestionOrchestrator`). Must construct a new `SymbolExtractor()` directly.

### Integration Point 4: New types location — `src/ingest/types.ts`
**File**: `src/ingest/types.ts` (NOT IngestionOrchestrator.ts or IngestionService.ts)
**After**: Add `StaticAnalysisResult` AND `EnrichedIngestionResult` to `types.ts`.

Why `EnrichedIngestionResult` must NOT stay in `IngestionService.ts`: `TemporalCodeGraph.persistIngestion()` duck-type checks `'staticAnalysis' in result` and casts to `EnrichedIngestionResult`. If the type lives in `IngestionService.ts`, then `TemporalCodeGraph.ts` (in `src/graph/`) would need to import from `src/ingest/IngestionService.ts`. Since `IngestionService.ts` already imports from `TemporalCodeGraph.ts`, this creates `graph/ → ingest/IngestionService` while `ingest/ → graph/` already exists — a circular dependency. Placing both types in `types.ts` (which TemporalCodeGraph already imports via `IngestionResult`) eliminates the circular dep entirely.

`IngestionOrchestrator.ts` is **NOT modified** — `IngestionResult` has no `staticAnalysis?` field.

### Integration Point 5: `TemporalCodeGraph.persistIngestion()` — Phase 9
**File**: `src/graph/TemporalCodeGraph.ts`
**Before**: `persistIngestion()` ends after Phase 8 (diff hunks, line 120)
**After**: Add 1 new phase after Phase 8 (checking for `staticAnalysis` field via `'staticAnalysis' in result`):
```typescript
// Phase 9: Structural IMPORTS_FROM edges (only when EnrichedIngestionResult)
if ('staticAnalysis' in result) {
  const enriched = result as EnrichedIngestionResult;
  // EnrichedIngestionResult and StaticAnalysisResult live in src/ingest/types.ts
  // (NOT IngestionService.ts — that would create graph/ → ingest/IngestionService circular dep)
  log.info("Phase 9: Structural edges (IMPORTS_FROM)", {
    imports: enriched.staticAnalysis.resolvedImports.length,
  });
  await this.persistStructuralEdges(
    enriched.projectId, enriched.ingestedAt, enriched.staticAnalysis.resolvedImports
  );
}
```
**No blast radius phase in `persistIngestion()`** — blast radius requires the import graph to be fully committed before querying fanIn/transitiveFanIn. It runs AFTER `persistIngestion()` returns (see Integration Point 6).
**No temporal coupling phase** — deferred to v2.

### Integration Point 6: `IngestionService.ingestProject()` — blast radius call
**File**: `src/ingest/IngestionService.ts`
**After** `await this.codeGraph.persistIngestion(enrichedResult)` succeeds:
```typescript
// Phase 3 (after graph persist): Blast radius scoring
// Requires IMPORTS_FROM graph to be fully committed — cannot run inside persistIngestion()
await this.codeGraph.computeAndPersistBlastRadius(
  enrichedResult.projectId,
  enrichedResult.codeFiles,
  enrichedResult.ingestedAt
);
```
`BlastRadiusScorer` is NOT a separate class — `computeAndPersistBlastRadius()` is a method on `this.codeGraph` (TemporalCodeGraph). No `this.neo4j` field needed on IngestionService.

### Integration Point 7: `StructuralToolModule.ts` — 6 new MCP tools
**File**: `src/mcp/handlers/StructuralToolModule.ts` (NEW)

Following the existing ToolModule pattern in `src/mcp/handlers/` (match exact existing handler module structure):
1. Create `StructuralToolModule` class with **`export const STRUCTURAL_TOOLS`** constant and `handle()` method
   - The constant MUST be named `STRUCTURAL_TOOLS` (convention: `{MODULE_NAME}_TOOLS`, matching `CODEBASE_TOOLS`, `KNOWLEDGE_TOOLS`, etc.)
2. Export from `src/mcp/handlers/index.ts` (both the class and the constant — barrel export)
3. In `PingMemServer.ts`: **dual-import pattern** (existing convention):
   - Import `STRUCTURAL_TOOLS` constant directly from `handlers/StructuralToolModule.ts` (not from barrel)
   - Import `StructuralToolModule` class from `handlers/index.ts` (barrel)
   - Add `...STRUCTURAL_TOOLS` to `TOOLS` spread
   - Add `new StructuralToolModule(sessionState)` to `modules` array

**Access pattern**: All 6 tool handlers retrieve `session.ingestionService` (existing SessionState field) and call one of the new **IngestionService proxy methods** — never accessing `this.codeGraph` directly from MCP tools:

```typescript
// 6 new proxy methods on IngestionService (following searchCode() / queryTimeline() pattern):
async queryDirectImports(projectId: string, filePath: string): Promise<...>
async queryDirectImporters(projectId: string, filePath: string): Promise<...>
async queryTransitiveImpact(projectId: string, filePath: string, maxDepth?: number): Promise<...>
async queryBlastRadius(projectId: string, filePath: string): Promise<...>
async queryHotspots(projectId: string, limit?: number): Promise<...>
async querySymbolDefinition(projectId: string, symbolName: string, kind?: string): Promise<...>
```

Each delegates to `this.codeGraph.queryXxx()`. File paths returned to callers are relativized to `projectRoot` (strip leading absolute path prefix).

**SessionState is NOT modified** — new tools use the existing `session.ingestionService` field.

_Removed from v1_: `queryTemporalCoupling` proxy (temporal coupling deferred), `queryFileSymbols` proxy (repo_map simplified).

### Integration Point 8: `rest-server.ts` — 2 new REST endpoints
**File**: `src/http/rest-server.ts`
**Add** `GET /api/v1/codebase/impact` and `GET /api/v1/codebase/hotspots`
Auth: same `requireApiKey` middleware applied to all existing `/api/v1/codebase/*` routes.
Paths in responses are relativized to project root before serialization.

---

## MCP Tool Definitions

| Tool | Input | Output |
|------|-------|--------|
| `graph_imports` | `{ projectId, filePath }` | `{ imports: [{ targetPath, importedNames, isTypeOnly }] }` |
| `graph_importers` | `{ projectId, filePath }` | `{ importers: string[] }` |
| `graph_impact` | `{ projectId, filePath, maxDepth?: 10 }` | `{ affected: [{ path, score, tier }], count }` or error if no structural data |
| `symbol_definition` | `{ projectId, symbolName, kind? }` | `{ filePath, startLine, endLine, signature }` |
| `hotspots` | `{ projectId, limit?: 20 }` | `{ hotspots: [{ path, score, tier }] }` |
| `repo_map` | `{ projectId, budgetTokens?: 1024, focusPath? }` | `{ hotspots: [{ path, score, tier }], count }` — ranked file list JSON |

_Deferred to v2_: `symbol_references` (use `symbol_definition` + `graph_importers` in sequence), `temporal_coupling` (TEMPORALLY_COUPLED edges not persisted in v1).

**`repo_map` output format** (simplified to ranked file list — no symbol skeletons in v1):
```json
{
  "hotspots": [
    { "path": "src/graph/TemporalCodeGraph.ts", "score": 89, "tier": "critical" },
    { "path": "src/ingest/IngestionService.ts", "score": 76, "tier": "high" }
  ],
  "filesIncluded": 20,
  "budgetTokens": 1024
}
```
_Note_: Symbol-skeleton format (aider-style) requires `isExported` on Symbol nodes which is not currently tracked. Deferred to v2 when call graph and full symbol export tracking is added.

---

## Blast Radius Scoring Formula

```
// Inputs per file:
fanIn(F)           = count of IMPORTS_FROM edges pointing TO F
transitiveFanIn(F) = count of files that transitively import F (depth ≤ 10)
churnScore(F)      = count of commits touching F in last 90 days (from MODIFIES edges)

// Normalization (per-project, min-max across all non-test files):
normFanIn(F)      = (fanIn(F) - min_fanIn) / (max_fanIn - min_fanIn)
normTransFanIn(F) = (transitiveFanIn(F) - min_tFanIn) / (max_tFanIn - min_tFanIn)
normChurn(F)      = (churnScore(F) - min_churn) / (max_churn - min_churn)
// Edge case: if max === min, normalization returns 0 for all files

// Composite score (weights sum to 1.0):
blastRadiusScore(F) = round(((0.30 × normFanIn(F)) + (0.40 × normTransFanIn(F)) + (0.30 × normChurn(F))) × 100)

// Tier assignment:
tier = "none"     if score = 0
tier = "low"      if 1 ≤ score ≤ 24
tier = "medium"   if 25 ≤ score ≤ 49
tier = "high"     if 50 ≤ score ≤ 74
tier = "critical" if score ≥ 75
```

**Source**: `04-algorithms-and-scoring.md §5`

---

## Verification Checklist

Phase 0:
- [ ] `bun run typecheck` — 0 errors after extending `ensureConstraints()` with 5 new indexes
- [ ] Neo4j EXPLAIN on `MATCH (f:File {path: $p})` shows index seek (not label scan)
- [ ] Existing 8-phase `persistIngestion()` still passes all existing tests

Phase 1:
- [ ] `bun run typecheck` — 0 errors after all Phase 1 changes
- [ ] Unit test: `extractImports("src/test.ts", "import { A } from './utils'; import type { B } from './types'")` returns 2 `ExtractedImport` items with correct `isTypeOnly` flags
- [ ] Unit test: `StaticAnalyzer.resolveImport('./utils', 'src/test.ts', root, allPaths)` returns the correct absolute path
- [ ] Integration test: ingest ping-mem, `MATCH ()-[:IMPORTS_FROM]->() RETURN count(*)` > 0
- [ ] Integration test: `graph_imports({projectId, filePath: "src/ingest/IngestionService.ts"})` returns TemporalCodeGraph, CodeIndexer, IngestionOrchestrator in output

Phase 2:
- [ ] `bun run typecheck` — 0 errors
- [ ] Determinism test: ingest ping-mem twice, assert all `File.blastRadiusScore` values identical
- [ ] `hotspots({projectId, limit: 10})` returns 10 files sorted by score DESC, none with `isTest: true`
- [ ] All scores in [0, 100] range
- [ ] Tier distribution sanity: not all files are "critical"

Phase 3:
- [ ] `bun run typecheck` — 0 errors
- [ ] Each of 6 MCP tools returns non-error results against ingested ping-mem
- [ ] `graph_impact({projectId, filePath: "src/ingest/IngestionService.ts"})` returns > 0 affected files
- [ ] `repo_map({projectId, budgetTokens: 1024})` output is ≤ 1,024 tokens
- [ ] `graph_impact` on an uningested project returns `{error: "structural_data_not_available"}`
- [ ] GET `/api/v1/codebase/impact?projectId=...&filePath=...` returns 200 with JSON body
- [ ] GET `/api/v1/codebase/hotspots?projectId=...` returns 200 with JSON body
- [ ] Both REST endpoints blocked by `requireApiKey` middleware

---

## Acceptance Criteria

**Functional:**
1. After `codebase_ingest`, `graph_imports(filePath)` returns accurate import list matching `grep "^import" <file>` output
2. `graph_impact(filePath)` returns the complete set of files that would be affected by a change to the given file (transitive, depth ≤ 10)
3. `hotspots(projectId)` returns files ranked by blast radius score; top file has measurably higher fan-in or churn than bottom file
4. `repo_map(projectId, budgetTokens: 1024)` returns ranked file list JSON within token budget
5. Blast radius score is deterministic: two runs on the same data produce identical scores for all files
6. All query results are project-scoped: no files from other projects appear in any tool output

**Non-functional:**
7. `graph_impact` query completes ≤ 100ms (p95) for ping-mem's ~200-file codebase
8. Total ingestion time increase ≤ 20% vs. baseline (Phase 1+2 overhead)
9. `bun run typecheck` — 0 errors
10. `bun test` — 0 failures

---

## Risk Analysis

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|-----------|
| TS Compiler API parses imports differently from runtime (e.g., conditional exports) | Medium | Low | Unit tests against known import forms; log unresolved; never fail ingestion |
| Extension-less imports not resolved without tsconfig | High | Medium | Step 3 of resolution chain always tries all 4 extensions; log unresolved count |
| tsconfig `paths` aliases unresolved (no tsconfig or complex paths) | Medium | Medium | Step 4 is best-effort; log; mark as unresolved but continue ingestion |
| Circular imports cause infinite loop in transitive traversal | High | Low | Cypher variable-length path `*1..10` auto-terminates; no infinite loop possible |
| Blast radius normalization unstable for small projects (1-3 files) | Low | Medium | Edge case: if max === min, normalize returns 0 for all — "none" tier for all |
| Cross-project file contamination in import queries | High | Medium | All 5 query methods scope dependents via `(p)-[:HAS_FILE]->(dependent)` pattern; never global File scans |
| Test files skewing blast radius scores | Medium | High | `isTest` flag + exclusion from normalization denominator (Q6 answer) |
| ingestion time increase > 20% | Medium | Low | StaticAnalyzer is a pure in-process AST pass; Neo4j phases use same UNWIND batching |

---

## Complete File Structure (Post-Implementation)

```
src/
├── ingest/
│   ├── SymbolExtractor.ts          MODIFIED: + private parseTypeScript() helper,
│   │                                           + extractImports() (uses shared SourceFile)
│   ├── StaticAnalyzer.ts           NEW: cross-file import resolution only
│   ├── IngestionService.ts         MODIFIED: + staticAnalyzer (new StaticAnalyzer(new SymbolExtractor())),
│   │                                           + 6 proxy query methods
│   ├── IngestionOrchestrator.ts    UNCHANGED (IngestionResult NOT modified — avoids circular dep)
│   ├── types.ts                    MODIFIED: + ExtractedImport, ResolvedImport,
│   │                                           FileBlastRadius, BlastRadiusTier,
│   │                                           StaticAnalysisResult, EnrichedIngestionResult
│   ├── index.ts                    MODIFIED: + export StaticAnalyzer
│   ├── CodeChunker.ts              (unchanged)
│   ├── GitHistoryReader.ts         (unchanged)
│   ├── ManifestStore.ts            (unchanged)
│   ├── ProjectScanner.ts           (unchanged)
│   └── SafeGit.ts                  (unchanged)
├── graph/
│   └── TemporalCodeGraph.ts        MODIFIED: + ensureConstraints() extended with 5 indexes,
│                                               + persistStructuralEdges() (IMPORTS_FROM only),
│                                               + computeAndPersistBlastRadius() (inlined scorer),
│                                               + queryDirectImports(),
│                                               + queryDirectImporters() (project-scoped),
│                                               + queryTransitiveImpact() (project-scoped),
│                                               + queryBlastRadius(),
│                                               + queryHotspots(),
│                                               + querySymbolDefinition()
├── mcp/
│   ├── handlers/
│   │   ├── StructuralToolModule.ts NEW: STRUCTURAL_TOOLS constant + 6 tool definitions + handler
│   │   └── index.ts                MODIFIED: + export StructuralToolModule
│   └── PingMemServer.ts            MODIFIED: + STRUCTURAL_TOOLS in TOOLS spread,
│                                               + StructuralToolModule in modules array
├── http/
│   └── rest-server.ts              MODIFIED: + 2 REST endpoints with requireApiKey
```

**New files**: `src/ingest/StaticAnalyzer.ts`, `src/mcp/handlers/StructuralToolModule.ts`
_Removed from new files_: `src/ingest/BlastRadiusScorer.ts` (logic inlined into TemporalCodeGraph as `computeAndPersistBlastRadius()`).

---

## Dependencies

No new npm packages. Zero new runtime dependencies.

| Existing dependency | How used here |
|--------------------|--------------------|
| `typescript ^5.9.3` | TypeScript Compiler API: `ts.createSourceFile()`, `ts.SyntaxKind.ImportDeclaration`, `ts.SyntaxKind.ExportDeclaration` — same API already used by `SymbolExtractor.ts` |
| `neo4j-driver ^5.x` | New Cypher queries in `TemporalCodeGraph.ts` — same driver already in use |
| `bun:sqlite` | No new usage (no SQLite changes in this feature) |

---

## Success Metrics

| Metric | Baseline | Target | Measurement |
|--------|----------|--------|-------------|
| Files with `IMPORTS_FROM` edges (ping-mem) | 0 | ≥ 180 | `MATCH ()-[:IMPORTS_FROM]->() RETURN count(DISTINCT source)` |
| `graph_impact` p95 latency | N/A | ≤ 100ms | Integration benchmark test |
| Ingestion time overhead | baseline | ≤ +20% | Benchmark test: time ping-mem ingest before/after |
| Blast radius determinism | N/A | 100% (identical 2nd run) | Snapshot test |
| Unresolved imports (ping-mem) | N/A | ≤ 15% of total imports | Log output during integration test |
| Cross-project query isolation | N/A | 0 files from other projects | Integration test: ingest 2 projects, assert no cross-contamination |
| TypeScript errors | 0 | 0 | `bun run typecheck` |

---

## EVAL Amendments (eval_iteration: 1)

All amendments made after 3 EVAL agents (Completeness/Feasibility, Security/Performance, Architectural Coherence) evaluated the plan. Combined: 73 claims checked, 15+ bugs found.

| Bug | Severity | Finding | Fix Applied |
|-----|----------|---------|-------------|
| Temporal coupling dual-path | CRITICAL | Plan had both in-memory StaticAnalyzer computation AND a self-contained Cypher aggregation — mutually exclusive | Deleted Cypher aggregation from Schema section; in-memory only via StaticAnalyzer.computeTemporalCoupling() |
| Dead blast radius block in persistIngestion() | CRITICAL | Integration Point 5 had `if (result.staticAnalysis.blastRadiusScores)` block — dead code since scores are set AFTER persistIngestion() returns | Removed dead block; blast radius runs exclusively in IngestionService.ingestProject() after persistIngestion() |
| SessionState has no codeGraph field | CRITICAL | MCP tools can't reach TemporalCodeGraph query methods via SessionState | Added 6 proxy query methods to IngestionService (like existing searchCode/queryTimeline); tools use session.ingestionService (subsequently reduced from 8 to 6 in REVIEW — temporal_coupling + queryFileSymbols removed) |
| IngestionResult mutation / circular dep | HIGH | Adding staticAnalysis? to IngestionResult in IngestionOrchestrator.ts creates circular import | EnrichedIngestionResult defined locally in IngestionService.ts; StaticAnalysisResult moved to types.ts; IngestionOrchestrator.ts UNCHANGED |
| N-queries-per-file in BlastRadiusScorer | HIGH | Spec implied 1 Neo4j query per file × 3 metrics = 1,500 queries for 500 files | Replaced with 3 project-wide aggregation queries (one per metric, all files returned at once) |
| Path traversal in resolveImport() | HIGH | Q1 step 1 "absolute path: use as-is" passes absolute paths through; tsconfig aliases could point outside project | Q1 step 1 now rejects absolute specifiers; containment check (startsWith projectRoot) applied after every resolution step |
| MCP registration pattern wrong | HIGH | "add handlers in setupTools()" — no setupTools() exists; wrong registration pattern | Specified StructuralToolModule.ts following existing handler module pattern; registered in TOOLS + modules arrays in PingMemServer constructor |
| Missing querySymbolDefinition() | HIGH | symbol_definition MCP tool had no backing TemporalCodeGraph method | Added querySymbolDefinition() with exact Cypher using DEFINES_SYMBOL relationship |
| Missing queryTemporalCoupling() | HIGH | temporal_coupling MCP tool had no backing TemporalCodeGraph method | Added queryTemporalCoupling() traversing TEMPORALLY_COUPLED edges bidirectionally |
| Missing queryFileSymbols() | HIGH | repo_map tool needs symbol data for skeleton output but no method specified | Added queryFileSymbols() returning exported symbols for a file |
| BlastRadiusScorer construction unspecified | HIGH | Who constructs BlastRadiusScorer with Neo4jClient? | Inlined into TemporalCodeGraph as `computeAndPersistBlastRadius()` — no separate class (see REVIEW amendments) |
| queryDirectImports wrong Cypher direction | MEDIUM | `(f)-[:HAS_FILE]-(p)` undirected + reversed | Fixed: `MATCH (p)-[:HAS_FILE]->(f)` (Project owns HAS_FILE, directed) |
| isTest tristate (IS NULL) | MEDIUM | `WHERE f.isTest IS NULL` fragile — new File nodes have no isTest property set | `isTest = false` written explicitly for all non-test files at persist time; hotspots query uses `f.isTest = false` |
| persistTemporalCoupling atomicity | MEDIUM | Risk Analysis claimed "atomic" but no transaction specified | Added explicit `session.executeWrite()` spanning both DELETE and UNWIND statements |
| extractImports() double-parses | MEDIUM | extractImports() cannot reuse private ts.SourceFile from extractTypeScript() — would re-parse same content | Added `private parseTypeScript()` helper shared by both methods |
| ensureStructuralIndexes() wrong placement | LOW | Was specified as new method called from persistIngestion() — wrong; indexes should be startup-time | Merged into existing ensureConstraints() (called at Neo4j startup, not at each persist) |

---

## Evidence-Based Predictability

EVAL iteration 1 complete. All claims in this plan are grounded in:
- `01-codebase-audit.md`: exact file paths, line numbers, method signatures verified against actual source
- `03-neo4j-schema-and-queries.md`: Cypher queries grounded in actual TemporalCodeGraph schema
- `04-algorithms-and-scoring.md`: blast radius formula derived from Microsoft/CodeScene research + ping-mem's existing data model
- `05-competitive-analysis.md`: repo-map format from aider/LocAgent ACL 2025 paper
- `IngestionService.ts:109,117`: exact line numbers verified by reading actual file
- `SymbolExtractor.ts:48`: exact method location verified by reading actual file
- EVAL amendments: 16 bugs across 3 agents — all CRITICAL and HIGH fixed in this iteration

Predictability score will be computed after VERIFY pass: `VERIFIED / TOTAL_CLAIMS × 100`.

---

## REVIEW Amendments (review_iteration: 1)

All amendments made after 3 REVIEW agents evaluated the plan. Combined: architecture (8 findings), simplicity (8 findings), TypeScript patterns (4 bugs). Total: 20 findings addressed.

### Scope Reductions (accepted from Simplicity Review)

| Finding | Severity | Rationale | Change Applied |
|---------|----------|-----------|----------------|
| EXPORTS edge type never queried in v1 | HIGH (YAGNI) | No v1 tool queries EXPORTS; speculative schema; zero test coverage | Removed EXPORTS edge schema, EXPORTS Cypher block, `isExport` field from `ResolvedImport`. Kept `isExport` on `ExtractedImport` as metadata only. |
| Temporal coupling (TEMPORALLY_COUPLED) deferred | HIGH (YAGNI) | O(N²) in-memory pair scan (44,850 pairs for 300-file/1k-commit repo); churnScore in blast radius already captures temporal signal; `temporal_coupling` MCP tool not in stated user stories | Removed `TemporalCoupling` type, `computeTemporalCoupling()`, `persistTemporalCoupling()`, `queryTemporalCoupling()`, `temporal_coupling` MCP tool. Simplified `StaticAnalysisResult` to `resolvedImports + unresolved` only. |
| BlastRadiusScorer as separate class | MEDIUM (YAGNI) | Single-method class, constructed once, never injected — private method suffices | Removed `src/ingest/BlastRadiusScorer.ts`. Logic inlined as `computeAndPersistBlastRadius()` on `TemporalCodeGraph` (where all 3 aggregation queries live). |
| repo_map symbol skeleton requires untracked `isExported` | HIGH (silent failure) | `queryFileSymbols` filters `s.isExported = true` but `persistSymbolsBatch` never writes `isExported`; would silently return 0 rows; Symbol schema has no `isExported` field | Simplified `repo_map` to ranked file list JSON (calls `queryHotspots`, returns structured data). Removed `queryFileSymbols` from TemporalCodeGraph. Avoids requiring `isExported` schema change. |
| `symbol_references` duplicates existing tools | MEDIUM | file-level = `symbol_definition` + `graph_importers` in sequence; no new capability | Removed `symbol_references` MCP tool. Tool count: 8 → 6. Documented composition in Q3. |
| In-memory SHA cache in StaticAnalyzer | LOW (YAGNI) | Only helps within single process lifetime; server restarts make it cold; MERGE handles idempotency | Removed SHA cache from `StaticAnalyzer`. All files re-analyzed on every run. |

### Bug Fixes (from Architecture + TypeScript REVIEW agents)

| Bug | Severity | Finding | Fix Applied |
|-----|----------|---------|-------------|
| `BlastRadiusScorer(this.neo4j)` — `this.neo4j` doesn't exist on IngestionService | CRITICAL | IngestionService has only `orchestrator`, `codeGraph`, `codeIndexer` fields; Neo4jClient stored in TemporalCodeGraph but not retained on IngestionService | Resolved by inlining blast radius into TemporalCodeGraph — no Neo4jClient needed on IngestionService at all |
| `new StaticAnalyzer(this.symbolExtractor)` — field doesn't exist | HIGH | `symbolExtractor` lives inside IngestionOrchestrator (line 63), not accessible from IngestionService | Changed to `new StaticAnalyzer(new SymbolExtractor())` — SymbolExtractor is cheap to construct |
| `queryTransitiveImpact` + `queryDirectImporters` not project-scoped | HIGH | `MATCH (dependent:File)-[:IMPORTS_FROM*1..10]->(f)` scans all files globally — returns files from other projects sharing same paths | Fixed both: use `MATCH (p)-[:HAS_FILE]->(dependent:File) WHERE (dependent)-[:IMPORTS_FROM*1..10]->(f)` pattern throughout |
| Blast radius fanIn + transitiveFanIn queries not project-scoped | HIGH | `OPTIONAL MATCH (importer:File)-[:IMPORTS_FROM]->(f)` and `OPTIONAL MATCH (dep:File)-[:IMPORTS_FROM*1..10]->(f)` scan all files globally | Fixed: `OPTIONAL MATCH (p)-[:HAS_FILE]->(importer:File) WHERE (importer)-[:IMPORTS_FROM]->(f)` and same for transitiveFanIn |
| Churn query uses `Commit.projectId` (doesn't exist) and `Commit.timestamp` (doesn't exist) | HIGH | Commit nodes have no `projectId` property (only hash, authorName, authorDate, etc.); project scoping is via `(p)-[:HAS_COMMIT]->(c)` relationship; `authorDate` is the correct field name | Fixed churn query: `MATCH (p)-[:HAS_COMMIT]->(c:Commit)-[:MODIFIES]->(f) WHERE c.authorDate >= $since` |
| `EnrichedIngestionResult` in `IngestionService.ts` creates circular dep | MEDIUM | `TemporalCodeGraph` (in `graph/`) would need to import from `ingest/IngestionService.ts` to type-check the duck-type cast; `ingest/` already imports `graph/` — circular | Moved `EnrichedIngestionResult` to `src/ingest/types.ts` (already imported by TemporalCodeGraph via IngestionResult) |
| `StructuralToolModule` export name not specified | MEDIUM | Convention is `{MODULE_NAME}_TOOLS`; PingMemServer imports constants by exact name; wrong name breaks import | Specified `export const STRUCTURAL_TOOLS` as the required constant name; documented dual-import pattern |
| Verification checklist references `ensureStructuralIndexes()` | LOW | Plan explicitly says this method should NOT be created — indexes go into existing `ensureConstraints()` | Fixed checklist item to reference `ensureConstraints()` |
| `persistTemporalCoupling` atomicity uses wrong API | HIGH | `session.executeWrite()` on Neo4jClient accepts a Cypher string (single query); two-statement atomicity requires `executeTransaction()` callback | Moot — `persistTemporalCoupling` removed entirely (temporal coupling deferred to v2) |

---

## VERIFY Amendments (verification_iteration: 1)

**Verification method**: 4-agent binary verification — 67 claims checked against actual source files.
**Score**: 57/67 verified (85%) — 10 bugs found and fixed (4 critical, 5 medium, 1 low).

### Evidence-Based Predictability

- **Paper-verifiable claims**: 57/67 = 85.1% verified directly against source code
- **Fixed in this pass**: 4 amendments to plan text (all bugs resolved)
- **Runtime unknowns** (cannot be paper-verified — listed with binary tests):

| Unknown | Binary Test | Mitigation |
|---------|-------------|------------|
| `ts.SyntaxKind.ImportDeclaration` visitor extracts all import forms correctly | `extractImports()` unit test: 5 import forms (default, named, namespace, type-only, side-effect) all return correct `ExtractedImport[]` | If test fails: inspect TS AST with `console.log(node.kind)` to identify unhandled SyntaxKind |
| `resolveImport()` fallback chain resolves ≥95% of ping-mem's actual imports | Integration test: `MATCH ()-[:IMPORTS_FROM]->() RETURN count(*)` ≥ 300 after ingesting ping-mem (~280 files) | If < 300: add logging to each fallback step, identify which patterns fail |
| `computeAndPersistBlastRadius()` fanIn query returns all file nodes even when fanIn=0 | Unit test: assert result set count equals number of files with `blastRadiusScore IS NOT NULL` | If missing files: OPTIONAL MATCH returns NULL for fanIn — verify merge logic handles NULL correctly |
| `IMPORTS_FROM*1..10` transitive path does not timeout on cyclic imports | Integration test: neo4j query completes < 100ms on ping-mem (all files) | If slow: reduce depth limit from 10 to 5 (still sufficient for most codebases) |

### Verification Bugs Fixed (4 amendments)

| Bug | Severity | Finding | Fix Applied |
|-----|----------|---------|-------------|
| `IngestionResult` / `CodeFileResult` import location unspecified | CRITICAL | Both types are defined in `src/ingest/IngestionOrchestrator.ts` (lines 26–49), NOT `types.ts`. StaticAnalyzer and TemporalCodeGraph must import from `IngestionOrchestrator.ts`. | Added import source annotation to StaticAnalyzer class block and to `computeAndPersistBlastRadius()` signature |
| `isTest` write location unspecified | HIGH | Plan says "`isTest = false` written at persist time" but never specified WHERE or HOW. `persistFilesBatch` items mapping and Cypher SET clause not updated. Without this, `WHERE f.isTest = false` in `queryHotspots` returns 0 rows. | Added to Phase 1e: extend `persistFilesBatch` items mapping with `isTest: /\.(?:test\|spec)\.[tj]sx?$/.test(f.filePath) \|\| f.filePath.includes('/__tests__/')` and add `f.isTest = item.isTest` to SET clause |
| `ExportNamedDeclaration`/`ExportAllDeclaration` — false positive | CRITICAL (false positive) | Verification agent flagged these as potential issues. Confirmed: plan already correctly uses `ts.SyntaxKind.ExportDeclaration` throughout — NOT Babel/React AST naming. No fix needed. | No change — plan text is correct |
| `persistHunkDiffsBatch` vs `persistDiffHunksBatch` | MEDIUM | Actual method name is `persistDiffHunksBatch` (TemporalCodeGraph.ts:646). Plan does not reference this method by name at all. | No plan change needed — plan describes phases, not internal method names of UNCHANGED code |

### Remaining VERIFY Findings (documentation only — no code impact)

| Finding | Severity | Impact on Implementation |
|---------|----------|--------------------------|
| Symbol node docs say `line` — actual is `startLine`, `endLine`, `signature` | MEDIUM (docs) | No impact — plan uses `symbolId`, `name`, `kind` for `symbol_definition` query; `startLine`/`endLine`/`signature` are returned as-is from existing schema |
| File node docs say `bytes` — actual has no `bytes` property | MEDIUM (docs) | No impact — plan never reads or writes `bytes` property |
| `typescript ^5.9.3` — plan says "v5.9.3" | LOW | `^5.9.3` allows patch/minor upgrades. SyntaxKind API is stable across minor versions. No impact. |
