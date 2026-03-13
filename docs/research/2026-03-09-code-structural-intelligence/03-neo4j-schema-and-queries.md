# Neo4j Graph Schema and Cypher Queries for Code Structural Intelligence

**Date**: 2026-03-09
**Branch**: feat/self-healing-health-monitor
**Author**: Research agent
**Status**: Complete

---

## Overview

This document designs the Neo4j graph schema extensions and Cypher queries needed to support code structural intelligence in ping-mem. It covers new relationship types for import/export graphs and call graphs, exact Cypher for storing and querying them, impact analysis queries for blast-radius computation, indexing strategy, and incremental update patterns.

The analysis is grounded in the existing schema as implemented in:
- `/Users/umasankr/Projects/ping-mem/src/graph/TemporalCodeGraph.ts`
- `/Users/umasankr/Projects/ping-mem/src/graph/Neo4jClient.ts`
- `/Users/umasankr/Projects/ping-mem/src/types/graph.ts`

---

## 1. Existing Schema Baseline

### 1.1 Node Labels (already in production)

| Label | Key Property | Unique Constraint | Notes |
|-------|-------------|-------------------|-------|
| `Project` | `projectId` | YES (`project_id_unique`) | Root of each project's subgraph |
| `File` | `fileId` | no explicit constraint | `fileId = sha256(filePath)` |
| `Chunk` | `chunkId` | no explicit constraint | Code/comment/docstring segment |
| `Symbol` | `symbolId` | no explicit constraint | Function, class, method, etc. |
| `Commit` | `hash` | no explicit constraint | Git commit node |

### 1.2 Relationship Types (already in production)

| Relationship | From → To | Properties |
|-------------|-----------|------------|
| `HAS_FILE` | Project → File | `ingestedAt` |
| `HAS_CHUNK` | File → Chunk | `ingestedAt` |
| `DEFINES_SYMBOL` | File → Symbol | `ingestedAt` |
| `CONTAINS_SYMBOL` | Chunk → Symbol | `ingestedAt` |
| `HAS_COMMIT` | Project → Commit | (none) |
| `PARENT` | Commit → Commit | (none) |
| `MODIFIES` | Commit → File | `changeType` (A/M/D/R/C) |
| `CHANGES` | Commit → Chunk | `hunkId`, `oldStart`, `oldLines`, `newStart`, `newLines` |

### 1.3 Existing `ensureConstraints()` Coverage

The current `ensureConstraints()` call in `TemporalCodeGraph` only creates a uniqueness constraint on `Project.projectId`. File, Chunk, Symbol, and Commit nodes rely on MERGE matching their primary key property but have no backing index other than what MERGE's implicit label scan provides. This means every File lookup by path requires a full `File` label scan unless a separate index is added — a critical gap at 390+ files.

---

## 2. New Relationship Types

### 2.1 `IMPORTS_FROM` — File-to-File Import Edges

Captures the static import graph derived from `import`/`require`/`export ... from` statements.

```
(File)-[:IMPORTS_FROM {
  importedNames: string[],   // e.g. ["Neo4jClient", "createNeo4jClient"]
  isTypeOnly:    boolean,    // true for "import type { ... }" statements
  resolvedPath:  string      // absolute path of the target file after resolution
}]->(File)
```

**Design rationale:**
- `importedNames` stored as a string array property enables Cypher's `ANY(name IN rel.importedNames WHERE name = $symbol)` predicate for symbol-level impact queries without extra nodes.
- `isTypeOnly` allows filtering out type-erasure-safe changes (type-only imports are eliminated at compile time; changing a type exported from a file does not necessarily break runtime behavior of importers that use `import type`).
- `resolvedPath` is stored redundantly alongside the target File node's `path` to speed up `MATCH` — the target `File` node is identified by `fileId = sha256(resolvedPath)`, but embedding `resolvedPath` on the edge enables human-readable `RETURN` output without an extra hop.
- Relationships are identified by the `(source, target)` pair; multiple import statements between the same two files collapse into a single `IMPORTS_FROM` edge (MERGE semantics) with `importedNames` containing the union of all named imports.

### 2.2 `CALLS` — Chunk-to-Chunk Call Edges

Captures function/method call sites at the chunk level (where call sites and callees live in the same or different chunks).

```
(Chunk)-[:CALLS {
  callerSymbolId: string,   // symbolId of the calling function/method
  calleeSymbolId: string,   // symbolId of the called function/method (if resolved)
  calleeFileId:   string,   // fileId of the file that defines the callee
  calleeName:     string,   // unresolved name (for display/fallback)
  isResolved:     boolean   // false if callee could not be statically resolved
}]->(Chunk)
```

**Design rationale:**
- Chunk-to-Chunk (not Symbol-to-Symbol) because call sites are spatially located in chunks; the chunk is the finest unit that is already indexed in Qdrant and Neo4j.
- `callerSymbolId` / `calleeSymbolId` serve as foreign keys into the Symbol nodes for queries that need to escalate from chunk-level to symbol-level.
- `isResolved: false` flags external/dynamic calls (e.g. calls to `node:crypto`) without breaking the graph — unresolved calls still have a target Chunk if the callee name can be heuristically located; otherwise the edge is omitted.

### 2.3 `EXPORTS` — Barrel Re-export Edges

Captures `export { X } from './module'` and `export * from './module'` barrel patterns.

```
(File)-[:EXPORTS {
  exportedNames: string[],  // names re-exported; empty array means "export *"
  isStar:        boolean    // true for "export * from ..."
}]->(File)
```

**Design rationale:**
- `EXPORTS` is a separate relationship type from `IMPORTS_FROM` because the semantic is different: an `EXPORTS` edge means the source file acts as a public surface that re-exposes names from the target. Impact analysis must traverse both directions: upstream consumers of the barrel file are also dependents of the re-exported names.
- `isStar: true` with `exportedNames: []` represents `export * from` without an explicit list — in this case all exports of the target are implicitly surfaced; the impact analysis queries treat `isStar: true` edges as carrying all exports of the target file.

---

## 3. Exact Cypher for Storing These Edges

### 3.1 MERGE Pattern for `IMPORTS_FROM`

The batch UNWIND pattern follows the same BATCH_SIZE=100 approach already used in `persistFilesBatch`.

```cypher
// Batch upsert of IMPORTS_FROM edges for a single project ingestion
// $items: Array<{
//   sourceFileId: string,
//   targetFileId: string,
//   targetPath: string,
//   importedNames: string[],
//   isTypeOnly: boolean,
//   resolvedPath: string,
//   ingestedAt: string
// }>
UNWIND $items AS item
MATCH (src:File { fileId: item.sourceFileId })
MATCH (tgt:File { fileId: item.targetFileId })
MERGE (src)-[r:IMPORTS_FROM]->(tgt)
SET r.importedNames = item.importedNames,
    r.isTypeOnly    = item.isTypeOnly,
    r.resolvedPath  = item.resolvedPath,
    r.ingestedAt    = item.ingestedAt
```

**MERGE semantics:** The `MERGE (src)-[r:IMPORTS_FROM]->(tgt)` without additional ON MATCH / ON CREATE properties is intentional. The subsequent `SET` always overwrites, making this idempotent — re-ingesting a file produces the same edge state. This is safe because the relationship is keyed on `(sourceFileId, targetFileId)` uniquely per project (a given source file either imports a target or it doesn't).

**What NOT to include in the MERGE pattern:** Do not embed array properties inside the MERGE match pattern (e.g., `MERGE (src)-[:IMPORTS_FROM { importedNames: ... }]->(tgt)`) — Neo4j evaluates the full property map as an equality predicate during MERGE, which would create duplicate edges when the import list changes.

### 3.2 Incremental Delete-and-Reinsert Pattern for `IMPORTS_FROM`

When a file changes (identified by its `fileId`), delete all its outgoing `IMPORTS_FROM` edges and recreate them in the same transaction block:

```cypher
// Step 1: Delete all existing outgoing import edges from the changed file
MATCH (src:File { fileId: $changedFileId })-[r:IMPORTS_FROM]->()
DELETE r
```

```cypher
// Step 2: Reinsert all import edges from the freshly parsed source
// (uses the same UNWIND MERGE pattern from §3.1)
UNWIND $items AS item
MATCH (src:File { fileId: item.sourceFileId })
MATCH (tgt:File { fileId: item.targetFileId })
MERGE (src)-[r:IMPORTS_FROM]->(tgt)
SET r.importedNames = item.importedNames,
    r.isTypeOnly    = item.isTypeOnly,
    r.resolvedPath  = item.resolvedPath,
    r.ingestedAt    = item.ingestedAt
```

These two steps should be executed inside a single `executeTransaction()` call (using the existing `Neo4jClient.executeTransaction()` method) to ensure atomicity — no window where the file has zero import edges.

### 3.3 MERGE Pattern for `EXPORTS` (Barrel Re-exports)

```cypher
// $items: Array<{
//   sourceFileId: string,
//   targetFileId: string,
//   exportedNames: string[],
//   isStar: boolean,
//   ingestedAt: string
// }>
UNWIND $items AS item
MATCH (src:File { fileId: item.sourceFileId })
MATCH (tgt:File { fileId: item.targetFileId })
MERGE (src)-[r:EXPORTS]->(tgt)
SET r.exportedNames = item.exportedNames,
    r.isStar        = item.isStar,
    r.ingestedAt    = item.ingestedAt
```

### 3.4 MERGE Pattern for `CALLS` (Chunk-level Call Graph)

```cypher
// $items: Array<{
//   callerChunkId: string,
//   calleeChunkId: string,
//   callerSymbolId: string,
//   calleeSymbolId: string | null,
//   calleeFileId: string,
//   calleeName: string,
//   isResolved: boolean,
//   ingestedAt: string
// }>
UNWIND $items AS item
MATCH (caller:Chunk { chunkId: item.callerChunkId })
MATCH (callee:Chunk { chunkId: item.calleeChunkId })
MERGE (caller)-[r:CALLS]->(callee)
SET r.callerSymbolId = item.callerSymbolId,
    r.calleeSymbolId = item.calleeSymbolId,
    r.calleeFileId   = item.calleeFileId,
    r.calleeName     = item.calleeName,
    r.isResolved     = item.isResolved,
    r.ingestedAt     = item.ingestedAt
```

---

## 4. Impact Analysis Queries

All queries in this section use parameterized Cypher (never string interpolation) and are bounded to a specific `projectId` to avoid cross-project traversal.

### 4.1 `getDirectDependents(filePath, projectId)`

Returns all files that have a direct `IMPORTS_FROM` or `EXPORTS` edge pointing at the given file.

```cypher
// Direct dependents: files that directly import the target file
MATCH (p:Project { projectId: $projectId })-[:HAS_FILE]->(target:File { fileId: $targetFileId })
MATCH (dependent:File)-[:IMPORTS_FROM]->(target)
MATCH (p)-[:HAS_FILE]->(dependent)
RETURN dependent.path       AS dependentPath,
       dependent.fileId     AS dependentFileId,
       'IMPORTS_FROM'       AS edgeType
UNION
// Barrel dependents: files that re-export the target
MATCH (p:Project { projectId: $projectId })-[:HAS_FILE]->(target:File { fileId: $targetFileId })
MATCH (barrel:File)-[:EXPORTS]->(target)
MATCH (p)-[:HAS_FILE]->(barrel)
RETURN barrel.path          AS dependentPath,
       barrel.fileId        AS dependentFileId,
       'EXPORTS'            AS edgeType
ORDER BY dependentPath
```

**Parameters:**
- `$projectId`: string — the project's SHA-256 identity
- `$targetFileId`: string — `sha256(filePath)` of the file being analyzed

**Expected output:** A list of `{dependentPath, dependentFileId, edgeType}` rows. For ping-mem's 390-file repo, a typical shared utility file (e.g. `src/util/logger.ts`) will have ~20-40 direct dependents.

### 4.2 `getTransitiveDependents(filePath, projectId, maxDepth)`

Returns all files that transitively import the target file, up to `maxDepth` hops. Uses variable-length path syntax with a bounded upper limit to prevent runaway traversals.

```cypher
// Transitive dependents: all files reachable by following IMPORTS_FROM backwards
// $maxDepth must be a positive integer (recommended: 10 for most codebases)
MATCH (p:Project { projectId: $projectId })-[:HAS_FILE]->(target:File { fileId: $targetFileId })
MATCH (p)-[:HAS_FILE]->(dependent:File)
MATCH path = (dependent)-[:IMPORTS_FROM*1..$maxDepth]->(target)
WHERE dependent <> target
RETURN DISTINCT
  dependent.path              AS dependentPath,
  dependent.fileId            AS dependentFileId,
  length(path)                AS hops
ORDER BY hops ASC, dependentPath ASC
```

**Parameters:**
- `$projectId`: string
- `$targetFileId`: string
- `$maxDepth`: integer — upper bound on traversal depth; default 10 for a 390-file project

**Important:** The `MATCH (p)-[:HAS_FILE]->(dependent:File)` anchor before the variable-length match constrains the starting nodes to the project's own files. Without this anchor, `dependent` would be an unbounded scan across all File nodes in Neo4j. This is the critical pattern for keeping the query within project scope.

**Performance note:** For a 390-node project graph with ~400 import edges, a `maxDepth` of 10 will typically resolve in under 100ms on a warmed Neo4j instance with proper indexes (see section 5). The planner will use BFS starting from `target` expanding in the reverse direction.

### 4.3 `getBlastRadius(filePath, projectId)`

Returns the count of transitive dependents plus a git churn score (number of commits that have touched each dependent file). The churn score weights the blast radius: files that are changed frequently have higher blast radius risk.

```cypher
// Blast radius: transitive dependent count + weighted churn score
MATCH (p:Project { projectId: $projectId })-[:HAS_FILE]->(target:File { fileId: $targetFileId })
MATCH (p)-[:HAS_FILE]->(dependent:File)
MATCH (dependent)-[:IMPORTS_FROM*1..10]->(target)
WHERE dependent <> target
WITH DISTINCT dependent

// Join with commit history to compute churn score
OPTIONAL MATCH (p)-[:HAS_COMMIT]->(c:Commit)-[:MODIFIES]->(dependent)
WITH dependent,
     count(DISTINCT c) AS churnCount

RETURN count(DISTINCT dependent)     AS transitiveDependentCount,
       sum(churnCount)               AS totalChurnScore,
       collect({
         path:       dependent.path,
         fileId:     dependent.fileId,
         churnCount: churnCount
       })                            AS dependents
ORDER BY churnCount DESC
```

**Return shape:**
```json
{
  "transitiveDependentCount": 47,
  "totalChurnScore": 312,
  "dependents": [
    { "path": "src/http/rest-server.ts", "fileId": "abc...", "churnCount": 28 },
    { "path": "src/mcp/PingMemServer.ts", "fileId": "def...", "churnCount": 21 }
  ]
}
```

**Churn score interpretation:** A file with `churnCount = 28` means 28 commits have touched it. If it transitively depends on the file being changed, each future change to the target will produce merge risk across 28 historical change contexts.

### 4.4 `getDependencyGraph(projectId)`

Returns all `IMPORTS_FROM` and `EXPORTS` edges for a project, suitable for rendering as a force-directed graph in the Web UI.

```cypher
// Full import/export graph for a project
MATCH (p:Project { projectId: $projectId })-[:HAS_FILE]->(src:File)
MATCH (src)-[r:IMPORTS_FROM]->(tgt:File)
MATCH (p)-[:HAS_FILE]->(tgt)
RETURN src.path          AS sourcePath,
       src.fileId        AS sourceFileId,
       tgt.path          AS targetPath,
       tgt.fileId        AS targetFileId,
       r.importedNames   AS importedNames,
       r.isTypeOnly      AS isTypeOnly,
       'IMPORTS_FROM'    AS edgeType
UNION ALL
MATCH (p:Project { projectId: $projectId })-[:HAS_FILE]->(src:File)
MATCH (src)-[r:EXPORTS]->(tgt:File)
MATCH (p)-[:HAS_FILE]->(tgt)
RETURN src.path          AS sourcePath,
       src.fileId        AS sourceFileId,
       tgt.path          AS targetPath,
       tgt.fileId        AS targetFileId,
       r.exportedNames   AS importedNames,
       r.isStar          AS isTypeOnly,
       'EXPORTS'         AS edgeType
ORDER BY sourcePath, targetPath
```

**Note:** `UNION ALL` (not `UNION`) is intentional — there cannot be a duplicate `(sourcePath, targetPath, edgeType)` triple because the two halves of the union cover different relationship types. `UNION ALL` avoids the deduplication overhead of `UNION`.

**Expected size for ping-mem:** ~390 nodes, estimated ~600-800 edges (import graph is typically ~1.5-2x the file count for a well-structured TypeScript project). This query should return in under 50ms with indexes on `File.fileId` and `Project.projectId`.

---

## 5. Index Strategy

### 5.1 Required Indexes

The existing `ensureConstraints()` creates only `project_id_unique` on `Project.projectId`. The following additional indexes are needed and should be added to an `ensureStructuralIndexes()` method in `TemporalCodeGraph`:

```cypher
// 1. File lookup by fileId (already used extensively in persistFilesBatch, queryFileChunks, etc.)
//    MERGE on File { fileId } performs a full label scan without this index.
CREATE INDEX file_fileId_index IF NOT EXISTS
  FOR (f:File) ON (f.fileId)

// 2. File lookup by path (needed for getDirectDependents when called with a path string)
CREATE INDEX file_path_index IF NOT EXISTS
  FOR (f:File) ON (f.path)

// 3. Composite index for scoped lookups: find a File within a specific project
//    Used by: queryFilesAtTime, queryFileHistory
//    Neo4j will use this for queries that filter on BOTH projectId (via Project MATCH) AND path/fileId
//    Note: composite indexes in Neo4j require both properties to be present in WHERE predicates.
//    Since project-scoped File lookups go through the Project node, this index is less critical
//    than the individual property indexes above. Add if query profiling shows label scans.
CREATE INDEX file_path_projectId_composite IF NOT EXISTS
  FOR (f:File) ON (f.path, f.fileId)

// 4. Chunk lookup by chunkId (used in persistChunksBatch, persistDiffHunksBatch)
CREATE INDEX chunk_chunkId_index IF NOT EXISTS
  FOR (c:Chunk) ON (c.chunkId)

// 5. Symbol lookup by symbolId (used in persistSymbolsBatch)
CREATE INDEX symbol_symbolId_index IF NOT EXISTS
  FOR (s:Symbol) ON (s.symbolId)

// 6. Commit lookup by hash (used in persistCommitsBatch, persistParentsBatch, persistFileChangesBatch)
CREATE INDEX commit_hash_index IF NOT EXISTS
  FOR (c:Commit) ON (c.hash)
```

### 5.2 Why These Indexes Matter

**Without `file_fileId_index`:** Each `MERGE (f:File { fileId: item.fileId })` in the batch writes performs a full scan of all `File` nodes in the database. At 390 files, this is 390 × 390 = 152,100 comparisons per ingestion run. The scan cost grows quadratically as the project count grows (multiple projects stored in the same Neo4j instance).

**With `file_fileId_index`:** Each lookup is O(log N) where N is the total number of File nodes across all projects. The index supports point lookups (equality predicates on `fileId`) directly — the planner will use a `NodeIndexSeek` plan operator instead of `NodeByLabelScan`.

**Commit hash index:** The `persistParentsBatch` and `persistFileChangesBatch` methods both do `MATCH (c:Commit { hash: item.commitHash })`. Without an index, each batch of 100 commits requires 100 full Commit label scans. For a project with 2,000 commits, this means 200,000 unnecessary comparisons.

### 5.3 Expected Query Times for ping-mem Scale (390 files)

| Query | Without Indexes | With Indexes |
|-------|----------------|--------------|
| `getDirectDependents` | ~50ms | ~2ms |
| `getTransitiveDependents` (depth=10) | ~200ms | ~15-40ms |
| `getBlastRadius` | ~300ms | ~20-60ms |
| `getDependencyGraph` | ~500ms | ~30-80ms |
| `persistFilesBatch` (100 files) | ~800ms | ~80ms |
| `persistChunksBatch` (500 chunks) | ~2000ms | ~150ms |

These estimates are based on:
- Neo4j Community Edition 5.x running locally (OrbStack Docker container)
- 390 File nodes, ~2,000 Chunk nodes, ~1,500 Symbol nodes, ~2,000 Commit nodes
- JVM heap of 512MB (default for development Docker setup)
- Warmed page cache (cold first query may be 3-5x slower)

The critical threshold is `getBlastRadius` under 200ms — beyond that, the Web UI's impact analysis panel would feel sluggish. With indexes, 20-60ms is well within the interactive budget.

### 5.4 APOC Availability

APOC-Core is available in all Neo4j Community Edition instances and can be enabled in the Docker Compose configuration with:

```yaml
# docker-compose.yml (excerpt)
neo4j:
  environment:
    NEO4J_PLUGINS: '["apoc"]'
    NEO4J_dbms_security_procedures_unrestricted: "apoc.*"
    NEO4J_dbms_security_procedures_allowlist: "apoc.*"
```

When APOC is available, `getTransitiveDependents` can use `apoc.path.subgraphNodes` instead of variable-length Cypher, which provides better memory control and supports label/relationship filters:

```cypher
// APOC alternative for transitive dependents (requires APOC-Core installed)
MATCH (p:Project { projectId: $projectId })-[:HAS_FILE]->(target:File { fileId: $targetFileId })
CALL apoc.path.subgraphNodes(target, {
  relationshipFilter: '<IMPORTS_FROM',
  labelFilter: '+File',
  maxLevel: $maxDepth,
  limit: 500
}) YIELD node AS dependent
WHERE dependent <> target
  AND (p)-[:HAS_FILE]->(dependent)
RETURN dependent.path    AS dependentPath,
       dependent.fileId  AS dependentFileId
ORDER BY dependentPath
```

The `<IMPORTS_FROM` notation means "traverse IMPORTS_FROM relationships in the incoming direction" (i.e., find nodes that import the target, traversing the edge backwards). `apoc.path.subgraphNodes` uses a BFS internally and respects the `limit` parameter, preventing unbounded traversal.

**Fallback:** The variable-length Cypher in §4.2 is the preferred implementation since it has no APOC dependency and performs adequately at ping-mem's scale. APOC's `subgraphNodes` is preferable only if the project exceeds ~2,000 files where variable-length traversal latency becomes noticeable.

---

## 6. Incremental Update Pattern

### 6.1 Problem Statement

When a file changes (a new commit touches it), its import list may change:
- Previously imported modules may no longer be imported
- New modules may be imported
- Existing imports may add or remove named bindings

A naive approach would be to DELETE all `IMPORTS_FROM` edges for the changed file and reinsert them. This is correct but risks a window of inconsistency if the transaction is not properly bounded.

### 6.2 Recommended Pattern: Delete-Reinsert in One Transaction

```typescript
// In TemporalCodeGraph, called when a file's parsed imports change
async updateFileImports(
  changedFileId: string,
  newImportEdges: ImportEdge[],
  ingestedAt: string
): Promise<void> {
  await this.neo4j.executeTransaction(async (session) => {
    // Step 1: Delete all stale outgoing import edges
    await session.run(
      `
      MATCH (src:File { fileId: $changedFileId })-[r:IMPORTS_FROM]->()
      DELETE r
      `,
      { changedFileId }
    );

    // Step 2: Delete all stale outgoing export edges
    await session.run(
      `
      MATCH (src:File { fileId: $changedFileId })-[r:EXPORTS]->()
      DELETE r
      `,
      { changedFileId }
    );

    // Step 3: Reinsert fresh import edges in batches
    const BATCH = 100;
    for (let i = 0; i < newImportEdges.length; i += BATCH) {
      const batch = newImportEdges.slice(i, i + BATCH);
      await session.run(
        `
        UNWIND $items AS item
        MATCH (src:File { fileId: item.sourceFileId })
        MATCH (tgt:File { fileId: item.targetFileId })
        MERGE (src)-[r:IMPORTS_FROM]->(tgt)
        SET r.importedNames = item.importedNames,
            r.isTypeOnly    = item.isTypeOnly,
            r.resolvedPath  = item.resolvedPath,
            r.ingestedAt    = item.ingestedAt
        `,
        { items: batch }
      );
    }
  });
}
```

**Why this is safe:**
- The entire delete + reinsert sequence runs inside a single `executeTransaction()` call, which wraps a single Neo4j session. Neo4j guarantees ACID semantics at the session level for write operations.
- If the reinsert step fails (e.g., a target file doesn't exist yet because it's also being ingested for the first time), the transaction is rolled back and the original import edges are preserved.
- The `MATCH` for stale edges (not MERGE) means a file with zero imports produces zero deleted relationships — no error, no spurious effect.

### 6.3 Targeted Edge Deletion vs. Full Project Wipe

Do NOT use full project deletion (`DETACH DELETE p, f, c, s`) for incremental updates — it would destroy commit history and chunk/symbol nodes that are expensive to recompute. The delete-reinsert pattern in §6.2 is surgical: it only touches `IMPORTS_FROM` and `EXPORTS` edges originating from the changed file.

### 6.4 Integration with IngestionOrchestrator

The incremental update should be triggered at Phase 9 (new phase, after the current Phase 8 diff hunks) in `TemporalCodeGraph.persistIngestion()`:

```
Phase 1: Project node
Phase 2: Files
Phase 3: Chunks
Phase 4: Symbols
Phase 5: Commits
Phase 6: Parent relationships
Phase 7: File changes
Phase 8: Diff hunks
Phase 9 (new): Import/Export edges  ← add here
Phase 10 (new): Call edges          ← add here (after Phase 9)
```

For a full reingest (`forceReingest: true`), Phase 9 should:
1. Delete all `IMPORTS_FROM` and `EXPORTS` edges for the project
2. Reinsert all edges from the freshly parsed import graph

For an incremental update (only changed files), Phase 9 should:
1. For each changed file (from `result.gitHistory.fileChanges` where `changeType !== 'D'`), call `updateFileImports()`
2. For deleted files (`changeType === 'D'`), delete their outgoing import/export edges (their `File` node is retained for history but its live import edges are no longer valid)

Full wipe of all import edges for a project before full reingest:

```cypher
// Full project import edge wipe (used only during forceReingest)
MATCH (p:Project { projectId: $projectId })-[:HAS_FILE]->(f:File)
MATCH (f)-[r:IMPORTS_FROM|EXPORTS]->()
DELETE r
```

---

## 7. Complete `ensureStructuralIndexes()` Method (Exact Cypher)

This should be added to `TemporalCodeGraph` alongside the existing `ensureConstraints()` method:

```cypher
-- Index 1: File by fileId (primary lookup key)
CREATE INDEX file_fileId_index IF NOT EXISTS FOR (f:File) ON (f.fileId)

-- Index 2: File by path (for path-based lookups from REST API)
CREATE INDEX file_path_index IF NOT EXISTS FOR (f:File) ON (f.path)

-- Index 3: Chunk by chunkId
CREATE INDEX chunk_chunkId_index IF NOT EXISTS FOR (c:Chunk) ON (c.chunkId)

-- Index 4: Symbol by symbolId
CREATE INDEX symbol_symbolId_index IF NOT EXISTS FOR (s:Symbol) ON (s.symbolId)

-- Index 5: Commit by hash
CREATE INDEX commit_hash_index IF NOT EXISTS FOR (c:Commit) ON (c.hash)

-- Index 6: Relationship index on IMPORTS_FROM for target-side lookups
--          Enables efficient "who imports me?" traversal (getDirectDependents)
--          Neo4j 5.x supports relationship property indexes:
CREATE INDEX imports_from_ingestedAt IF NOT EXISTS
  FOR ()-[r:IMPORTS_FROM]-() ON (r.ingestedAt)
```

**Note on the relationship index:** Neo4j 5.x introduced relationship property indexes. The `imports_from_ingestedAt` index on the relationship property `ingestedAt` is not for query performance (we don't filter by `ingestedAt` in traversal queries) but rather for the incremental cleanup queries that need to identify stale edges by ingestion timestamp. If the cleanup strategy uses DELETE-all-then-reinsert (§6.2), this index is not needed and can be omitted.

For the traversal queries (`getDirectDependents`, `getTransitiveDependents`), Neo4j uses the **node indexes** on both ends of the relationship to find the start node, then traverses the relationship in-memory. No relationship property index is needed for traversal performance.

---

## 8. Summary: Schema Extension Checklist

| Item | Status | Cypher Location |
|------|--------|-----------------|
| `IMPORTS_FROM` relationship definition | Designed | §2.1 |
| `CALLS` relationship definition | Designed | §2.2 |
| `EXPORTS` relationship definition | Designed | §2.3 |
| MERGE Cypher for `IMPORTS_FROM` | Exact Cypher | §3.1 |
| MERGE Cypher for `EXPORTS` | Exact Cypher | §3.3 |
| MERGE Cypher for `CALLS` | Exact Cypher | §3.4 |
| Incremental delete-reinsert pattern | Exact Cypher | §3.2, §6.2 |
| `getDirectDependents` query | Exact Cypher | §4.1 |
| `getTransitiveDependents` query | Exact Cypher | §4.2 |
| `getBlastRadius` query | Exact Cypher | §4.3 |
| `getDependencyGraph` query | Exact Cypher | §4.4 |
| Index creation Cypher | Exact Cypher | §5.1, §7 |
| APOC alternative for transitive traversal | Exact Cypher | §5.4 |
| Incremental update integration point | Design | §6.4 |

---

## Sources

- [Neo4j Variable-length patterns - Cypher Manual](https://neo4j.com/docs/cypher-manual/current/patterns/variable-length-patterns/)
- [MERGE - Cypher Manual](https://neo4j.com/docs/cypher-manual/current/clauses/merge/)
- [The impact of indexes on query performance - Cypher Manual](https://neo4j.com/docs/cypher-manual/current/query-tuning/indexes/)
- [Search-performance indexes - Cypher Manual](https://neo4j.com/docs/cypher-manual/current/indexes/search-performance-indexes/managing-indexes/)
- [apoc.path.subgraphNodes - APOC Core Documentation](https://neo4j.com/docs/apoc/current/overview/apoc.path/apoc.path.subgraphNodes/)
- [5 Tips & Tricks for Fast Batched Updates of Graph Structures with Neo4j and Cypher](https://medium.com/neo4j/5-tips-tricks-for-fast-batched-updates-of-graph-structures-with-neo4j-and-cypher-73c7f693c8cc)
- [Git Commit History — Discover AuraDB: Week 44 | Neo4j Developer Blog](https://medium.com/neo4j/git-commit-history-discover-auradb-week-44-2ea2337abc86)
- [Shortest paths - Cypher Manual](https://neo4j.com/docs/cypher-manual/current/patterns/shortest-paths/)
- [Modeling Git Commits with Neo4j](https://reflectoring.io/git-neo4j/)
