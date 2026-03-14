# Codebase Audit — Code Structural Intelligence Integration Points

**Date**: 2026-03-09
**Status**: Final
**Method**: Direct codebase analysis (Read + Grep)

---

## 1. `src/ingest/SymbolExtractor.ts`

**AST Library**: TypeScript Compiler API (`typescript` v5.9.3)

**Method Signatures**:
- `extractFromFile(filePath, content): ExtractedSymbol[]` — line 37. Dispatches to `extractTypeScript()` or `extractPython()` based on extension.
- `extractTypeScript(filePath, content): ExtractedSymbol[]` — line 48. Uses `ts.createSourceFile()` + `ts.forEachChild(node, visit)` AST visitor. Extracts: FunctionDeclaration, ClassDeclaration, InterfaceDeclaration, EnumDeclaration, TypeAliasDeclaration, VariableStatement, MethodDeclaration, PropertyDeclaration. Line numbers via `ts.getLineAndCharacterOfPosition()`.
- `extractPython(filePath, content): ExtractedSymbol[]` — line 185. Regex-based (no AST). `/^\s*def\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/` for functions, `/^\s*class\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*[:\(]/` for classes.
- `computeSymbolId(symbol): string` — line 270. SHA-256(filePath + name + kind + startLine).

**ExtractedSymbol interface** (lines 26-34):
```typescript
{
  symbolId: string;     // Content-addressable SHA-256
  name: string;
  kind: SymbolKind;     // "function"|"class"|"interface"|"variable"|"constant"|"enum"|"type_alias"|"method"|"property"
  filePath: string;
  startLine: number;    // 1-indexed
  endLine: number;      // 1-indexed
  signature?: string;   // First line of declaration
}
```

**Integration hooks**:
- Called by `IngestionOrchestrator.chunkCodeFiles()` at line 176
- Results persisted via `TemporalCodeGraph.persistSymbolsBatch()` (lines 494–555) → `:Symbol` nodes + `(File)-[:DEFINES_SYMBOL]->(Symbol)` edges

**GAP**: Does NOT extract relationships between symbols — no import parsing, no call graph, no type dependencies, no inheritance.

---

## 2. `src/graph/TemporalCodeGraph.ts`

**Neo4j Node Labels + Properties**:
- `:Project` — `projectId`, `name`, `rootPath`, `treeHash`, `lastIngestedAt`
- `:File` — `fileId` (SHA-256), `path`, `sha256`, `lastIngestedAt`
- `:Chunk` — `chunkId`, `type` (code|comment|docstring), `start`, `end`, `lineStart`, `lineEnd`, `content`, `lastIngestedAt`
- `:Symbol` — `symbolId`, `name`, `kind`, `startLine`, `endLine`, `signature`, `lastIngestedAt`
- `:Commit` — `hash`, `shortHash`, `authorName`, `authorEmail`, `authorDate`, `message`

**Neo4j Relationship Types (existing)**:
- `(Project)-[:HAS_FILE {ingestedAt}]->(File)` — lines 82–95, 429–442
- `(File)-[:HAS_CHUNK {ingestedAt}]->(Chunk)` — lines 475–492
- `(Chunk)-[:DEFINES_SYMBOL {ingestedAt}]->(Symbol)` — lines 525–541
- `(Chunk)-[:CONTAINS_SYMBOL {ingestedAt}]->(Symbol)` — lines 543–555
- `(Commit)-[:PARENT]->(Commit)` — lines 611–620
- `(Commit)-[:MODIFIES {changeType}]->(File)` — lines 633–644
- `(Commit)-[:CHANGES {hunkId, oldStart, newStart}]->(Chunk)` — lines 659–676
- `(Project)-[:HAS_COMMIT]->(Commit)` — line 586

**`persistIngestion()` phases** (lines 61–121):
| Phase | Content | Method |
|-------|---------|--------|
| 1/8 | Project node MERGE | line 77 |
| 2/8 | Files batch | line 102, persistFilesBatch() line 418 |
| 3/8 | Chunks batch | line 105, persistChunksBatch() line 444 |
| 4/8 | Symbols batch | line 108, persistSymbolsBatch() line 494 |
| 5/8 | Commits batch | line 111, persistCommitsBatch() line 557 |
| 6/8 | Parent relationships | line 114, persistParentsBatch() line 593 |
| 7/8 | File changes | line 117, persistFileChangesBatch() line 623 |
| 8/8 | Diff hunks | line 120, persistHunksBatch() line 646 |

**Query methods**:
- `queryFilesAtTime(projectId, treeHash?)` — line 126
- `queryFileChunks(projectId, filePath)` — line 154
- `queryCommitHistory(projectId, limit?)` — line 187
- `queryFileHistory(projectId, filePath)` — line 248
- `listProjects(options)` — line 304

**Integration hook**: Phase 9 (structural relationships) would slot after Phase 4 (symbols) since it references `:Symbol` nodes by `symbolId`.

**GAP**: No `IMPORTS_FROM`, `CALLS`, `EXTENDS`, `IMPLEMENTS`, `TYPE_USES` relationships exist.

---

## 3. `src/graph/RelationshipInferencer.ts`

**Relationship types** (from `src/types/graph.ts` enum):
`DEPENDS_ON`, `IMPLEMENTS`, `USES`, `REFERENCES`, `CAUSES`, `BLOCKS`, `RELATED_TO`, `CONTAINS`, `FOLLOWS`, `DERIVED_FROM`

**DEPENDS_ON rule** (lines 62–94):
- Source types: CODE_FILE, CODE_FUNCTION, CODE_CLASS, TASK
- Target types: CODE_FILE, CODE_CLASS, CODE_FUNCTION
- Patterns: `/\b(?:import|require)\s+(?:.*?\s+from\s+)?['"]?([^'";\s]+)['"]?/gi`, /\bimports?\s+from/gi, /\bdepends?\s+on\b/gi
- Weight: 0.8 (code), 0.7 (tasks)

**CRITICAL FINDING**: RelationshipInferencer operates on **text patterns extracted from memory context**, NOT from code AST. DEPENDS_ON is inferred from natural language, not from actual `import` statements in code files. No wiring to SymbolExtractor or TypeScript compiler API.

**Integration hooks**: `infer(entities, context)` — line 402. Checks entity pairs bidirectionally. Not relevant to structural code analysis — this is for memory entity relationship inference.

---

## 4. `src/ingest/IngestionService.ts`

**Pipeline sequence** in `ingestProject()` (lines 94–157):
1. Line 109: `orchestrator.ingest()` → `IngestionResult` (scan + chunk + git)
2. Line 117: `graph.persistIngestion()` → Neo4j (8 phases)
3. Line 132: `codeIndexer.indexIngestion()` → Qdrant vectors

**SLOT FOR StaticAnalyzer**: Between lines 109 and 117 — after `IngestionResult` is ready, before Neo4j persistence. StaticAnalyzer reads `IngestionResult.codeFiles` (which includes file content + symbols), adds structural data, then `persistIngestion()` receives the enriched result.

**Other methods**: `verifyProject()` line 163, `queryTimeline()` line 197, `searchCode()` line 254, `deleteProject()` line 270, `listProjects()` line 298.

---

## 5. `src/ingest/IngestionOrchestrator.ts`

**Pipeline sequence** in `ingest()` (lines 77–120):
1. Lines 83–88: `ProjectScanner.scanProject()` → `ProjectScanResult`
2. Line 96: `chunkCodeFiles()` → `CodeFileResult[]`
3. Line 106: `GitHistoryReader.readHistory()` → `GitHistoryResult`
4. Line 112: `ManifestStore.save()`
5. Lines 114–120: Return composite `IngestionResult`

**`CodeFileResult` structure** (lines 26–31):
```typescript
{
  filePath: string;
  sha256: string;
  chunks: ChunkWithId[];
  symbols: ExtractedSymbol[];   // from SymbolExtractor
}
```

**SymbolExtractor call** at line 176:
```typescript
const symbols = this.symbolExtractor.extractFromFile(entry.path, content);
```

**StaticAnalyzer slot**: After line 176 (or as a post-pass over all `CodeFileResult[]`). Cross-file analysis (e.g., resolving imports to target files) requires all files to be scanned first, so a post-pass over the full `codeFiles[]` array is preferred.

---

## 6. `src/ingest/CodeChunker.ts`

**Chunk types**: `"code"` | `"comment"` | `"docstring"`

**ChunkWithId** (added by IngestionOrchestrator, lines 33–40):
```typescript
{
  chunkId: string;      // SHA-256 hash
  type: ChunkType;
  start: number;        // Byte offset
  end: number;
  lineStart: number;    // 1-indexed
  lineEnd: number;
  content: string;
}
```

**Chunking strategy**: TS/JS chunks preserve full code (including import statements at top of file). Import statements are always in "code" type chunks. Import lines are at lineStart 1–N for top-of-file imports.

**Integration hook**: Import extraction reads the "code" chunks that contain import statements at the top of each file — no re-parsing needed if we can identify which chunks contain imports by line range.

---

## 7. `src/graph/Neo4jClient.ts`

**Session pattern**: `this.neo4j.getSession()` → `session.run(cypher, params)` → `session.close()` in finally
**Batch pattern**: `UNWIND $items AS item` — 100 items per transaction
**Error types**: `Neo4jQueryError` (includes query + paramKeys in message), `Neo4jConnectionError`
**executeQuery<T>** method wraps session lifecycle

---

## 8. `src/ingest/ProjectScanner.ts`

**File discovery**: `git ls-files` first (line 98), fallback to `walkDirectory()` (line 127)
**Ignore dirs** (lines 10–27): `.git`, `node_modules`, `dist`, `.cache`, `.ping-mem`, `.worktrees`, `.claude`
**Exclude extensions** (lines 29–46): images, media, documents, archives, fonts, compiled binaries, `.db`, `.sqlite`, `.lock`

**Manifest structure** (lines 82–89):
```typescript
{
  projectId: string;      // SHA-256(remoteUrl + "::" + relativeToGitRoot)
  rootPath: string;
  treeHash: string;       // Merkle tree of all file hashes
  files: { path: string; sha256: string }[];
  generatedAt: string;
  schemaVersion: number;
}
```

---

## 9. `package.json` — AST Libraries Available

**Already installed**:
- `typescript: ^5.9.3` — TypeScript Compiler API. Can parse TS/JS AST, extract import declarations, type usage, call expressions. **Already used by SymbolExtractor**.

**Not installed** (would be new deps):
- `@babel/parser` — Alternative JS/TS parser
- `@typescript-eslint/parser` — Scope analysis on top of TS
- `ts-morph` — High-level TS AST wrapper
- `tree-sitter` — Multi-language, Wasm-compatible

**Key finding**: `typescript` package already in project and already used for AST. Import extraction can be added to `SymbolExtractor.extractTypeScript()` with zero new dependencies.

---

## Summary: Integration Map

```
IngestionOrchestrator.ingest()
  ├── ProjectScanner.scanProject()       [file discovery]
  ├── chunkCodeFiles()                   [chunk + symbols]
  │     └── SymbolExtractor             [AST → symbols]
  │         ← INSERT: import/call extraction here (same TS compiler API)
  ├── GitHistoryReader.readHistory()     [git commits + diffs]
  └── [return IngestionResult]
         ↓
IngestionService.ingestProject()
  ← INSERT: StaticAnalyzer.analyze(ingestionResult) here [cross-file resolution]
         ↓
TemporalCodeGraph.persistIngestion()   [8 phases → Neo4j]
  ← INSERT: Phase 9 — structural edges (IMPORTS_FROM, CALLS, EXTENDS)
         ↓
CodeIndexer.indexIngestion()           [Qdrant vectors]
```

**Zero new dependencies needed** — TypeScript Compiler API is already installed and used.
