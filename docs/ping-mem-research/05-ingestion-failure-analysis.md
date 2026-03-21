# Ingestion Failure Analysis

**Date**: 2026-03-15
**Scope**: Analysis of real ingestion failures and edge cases in ping-mem, with specific codebase evidence and prevention strategies.

---

## 1. Gitlink Crash (mode 160000)

### What happened
A submodule entry (`autoresearch` in understory) has git mode 160000 (gitlink). `git ls-files --cached` returns it as a path. `fs.readFileSync()` on that path crashes because it resolves to a directory, not a file.

### Fix history
- Commit `4cc0ea4` (2026-03-14): Initial fix used `fs.accessSync(f, fs.constants.R_OK)` to filter missing files.
- Current code (uncommitted or amended): Upgraded to `fs.statSync(f)` + `stat.isFile()` check, which properly handles gitlinks by detecting they resolve to directories.

### Current protection
`/Users/umasankr/Projects/ping-mem/src/ingest/ProjectScanner.ts`, lines 77-84:
```typescript
const existingFiles = files.filter((f) => {
  try {
    const stat = fs.statSync(f);
    // Skip directories -- git ls-files can return gitlinks (submodule
    // entries at mode 160000) which resolve to directories on disk.
    return stat.isFile();
  } catch { return false; }
});
```

### Remaining gaps

**Git object types NOT handled**:

| Mode | Type | Risk |
|------|------|------|
| 160000 | gitlink/submodule | FIXED -- `stat.isFile()` rejects directories |
| 120000 | symlink | PARTIAL -- `fs.statSync` follows symlinks, so a symlink to a file passes through. A symlink to a directory would be caught by `isFile()`. But a symlink to a non-existent target would throw and be caught. Dangling symlinks pointing to large files or circular symlinks are the concern. |
| 100755 | executable | Safe -- still a regular file |
| 040000 | tree (subdirectory) | N/A -- `git ls-files` does not return tree objects |

**Symlink loops**: If a symlink points to another symlink creating a cycle, `fs.statSync` will throw ELOOP, which is caught by the try/catch. Safe.

**Symlink to huge binary**: A symlink to a file that passes the extension filter but is actually enormous (e.g., symlink `data.ts` -> `/data/50GB-file.bin`) would be read by `hashFile()` at line 185 via `fs.readFileSync(filePath)`. No size guard exists.

### Prevention recommendations
1. Add `lstatSync` check before `statSync` to detect and log symlinks.
2. Add a file size limit in `hashFile()` (e.g., skip files > 5MB).
3. Add the `.gitmodules` pattern to skip known submodule configs.

---

## 2. node_modules Ingestion via git ls-files

### Root cause analysis
The `DEFAULT_IGNORE_DIRS` set at `/Users/umasankr/Projects/ping-mem/src/ingest/ProjectScanner.ts`, line 10 includes `"node_modules"`. But this set is ONLY used by the `walkDirectory()` fallback path (line 148-149). It is NOT used by the `git ls-files` path.

The `tryGitLsFiles()` method (line 132) calls `git ls-files --cached` which returns ALL tracked files. The only filtering applied is the extension filter (lines 117-122):
```typescript
return gitFiles
  .filter(f => {
    const ext = path.extname(f).toLowerCase();
    if (this.excludeExtensions.has(ext)) return false;
    if (this.includeExtensions && !this.includeExtensions.has(ext)) return false;
    return true;
  })
```

### When does this fail?
If a project has `node_modules` committed to git (or `e2e-tests/node_modules`), `git ls-files --cached` WILL return those files. The `DEFAULT_IGNORE_DIRS` set is never consulted on the `git ls-files` path.

### Evidence
In the ping-mem repo itself, `git ls-files --cached | grep node_modules` returns zero results -- node_modules is properly gitignored. But in the reported ping-learn case, `e2e-tests/node_modules/playwright/types/test.d.ts` (8512 lines) was tracked by git and therefore ingested as vectors.

### Impact
- `.d.ts` files are NOT in `DEFAULT_EXCLUDE_EXTENSIONS` (line 29-46). Only these are excluded: images, media, documents, archives, fonts, compiled binaries, databases, and lock files.
- TypeScript definition files (`.d.ts`) pass both the extension filter and the chunker, producing thousands of chunks from vendored type definitions.
- Each chunk becomes a Qdrant vector point. 8512 lines of vendored types could easily produce 50+ chunks, each stored as a 768-dimensional vector.

### Prevention recommendations
1. Apply `DEFAULT_IGNORE_DIRS` filtering to `git ls-files` results too -- check if any path component matches the ignore set.
2. Add `.d.ts` to an optional "low-value extensions" filter (or at least a configurable exclude list).
3. Add path-based ignore patterns (e.g., `vendor/`, `third_party/`, `__generated__/`).
4. Log a warning when > N files match from a single directory subtree.

---

## 3. Stale Manifest Blocking Re-ingestion

### Exact mechanism
File: `/Users/umasankr/Projects/ping-mem/src/ingest/IngestionOrchestrator.ts`, lines 84-93:

```typescript
const previousManifest = options.forceReingest
  ? null
  : this.manifestStore.load(projectPath);

const scanResult = await this.scanner.scanProject(projectPath, previousManifest ?? undefined);

// If no changes and not forcing, return null
if (!scanResult.hasChanges && !options.forceReingest) {
  return null;
}
```

The "no changes detected" condition is at `/Users/umasankr/Projects/ping-mem/src/ingest/ProjectScanner.ts`, lines 105-106:
```typescript
const hasChanges =
  !previousManifest || previousManifest.treeHash !== manifest.treeHash;
```

### When it breaks

**Scenario 1: Qdrant was down during ingestion**
- IngestionOrchestrator completes scan + chunking + git history.
- Manifest is saved at line 112 (`this.manifestStore.save(...)`) BEFORE Neo4j/Qdrant persist.
- Actually, looking at the flow: `IngestionOrchestrator.ingest()` saves the manifest at step 4 (line 112). Then `IngestionService.ingestProject()` calls `persistIngestion()` and `indexIngestion()`.
- If Qdrant indexing fails (line 131-144 in IngestionService.ts), the manifest is ALREADY saved. The error thrown says "Run force reingest to recover", but the manifest.json on disk claims the tree hash is current.
- Next normal ingestion: `scanProject()` compares tree hashes, finds them equal, returns `hasChanges: false`. Ingestion silently skips.

**Scenario 2: Files changed then reverted**
- File A changes -> ingest runs -> manifest updated with new treeHash.
- File A reverts to original -> treeHash returns to the previous value.
- If the old manifest still has the previous treeHash, no changes detected. But this is actually correct behavior.

**Scenario 3: Manifest written but Neo4j persist failed**
- Same as Scenario 1 but for Neo4j. The error message at line 124-128 does NOT suggest force reingest, so the user may not know to do so.

### Prevention recommendations
1. Move `manifestStore.save()` to AFTER successful Neo4j + Qdrant persist. Currently it's in `IngestionOrchestrator.ingest()` which has no visibility into downstream persist success.
2. Alternative: Save manifest with a `status: "pending"` field, update to `"complete"` after full pipeline success.
3. Add `--force` flag guidance in error messages for all failure modes, not just Qdrant.

---

## 4. Neo4j OOM During Cleanup

### deleteProject implementation
File: `/Users/umasankr/Projects/ping-mem/src/graph/TemporalCodeGraph.ts`, lines 281-298:

```cypher
MATCH (p:Project { projectId: $projectId })
OPTIONAL MATCH (p)-[:HAS_FILE]->(f:File)
OPTIONAL MATCH (f)-[:HAS_CHUNK]->(c:Chunk)
OPTIONAL MATCH (c)-[:DEFINES_SYMBOL]->(s:Symbol)
OPTIONAL MATCH (p)-[:HAS_COMMIT]->(commit:Commit)
DETACH DELETE p, f, c, s, commit
```

This is a single transaction that matches ALL nodes for the project and deletes them atomically. For a large project with thousands of files, hundreds of thousands of chunks, and hundreds of commits, this creates an enormous transaction log in Neo4j's memory.

### Neo4j memory settings
File: `/Users/umasankr/Projects/ping-mem/docker-compose.yml`, lines 10-13:
```yaml
- NEO4J_dbms_memory_heap_initial__size=512m
- NEO4J_dbms_memory_heap_max__size=2G
- NEO4J_dbms_memory_pagecache_size=1G
```

Total: up to 3GB for Neo4j. A DETACH DELETE of 100k+ nodes in a single transaction can exceed 2GB heap.

### Is this a risk during normal ingestion?
During ingestion, `persistIngestion()` uses batched writes with `BATCH_SIZE = 100` (line 53 of TemporalCodeGraph.ts). Each batch gets its own session (line 401-414 in `runBatched()`). The batched approach is safe for normal ingestion.

However, MERGE operations accumulate in Neo4j's transaction log. A re-ingest does not delete old data first -- it MERGEs (upserts). If a file was deleted between ingests, its File/Chunk nodes become orphaned. Over many re-ingests, orphaned nodes accumulate.

### Prevention recommendations
1. Batch the delete operation: delete chunks first (in batches of 1000), then files, then commits, then the project node. Use `CALL { ... } IN TRANSACTIONS OF 1000 ROWS` (Neo4j 5.x syntax).
2. Add a pre-ingest cleanup step that removes orphaned File nodes not in the current manifest.
3. Consider increasing `NEO4J_dbms_memory_heap_max__size` to 4G for production.

---

## 5. Concurrent Ingestion Resource Contention

### Evidence of missing concurrency control

There is NO mutex, semaphore, or ingestion queue anywhere in the ingestion pipeline:
- `IngestionService` -- no concurrency control
- `IngestionOrchestrator` -- no concurrency control
- `TemporalCodeGraph` -- creates a new session per batch but no global lock
- `CodeIndexer` -- no concurrency control
- `config/runtime.ts` -- no concurrency control

The only concurrency control in the entire codebase is `WriteLockManager` in `/Users/umasankr/Projects/ping-mem/src/storage/WriteLockManager.ts`, which manages per-agent SQLite write locks -- unrelated to ingestion.

### Neo4j connection pooling
File: `/Users/umasankr/Projects/ping-mem/src/graph/Neo4jClient.ts`, line 94:
```typescript
maxConnectionPoolSize: config.maxConnectionPoolSize ?? DEFAULT_MAX_POOL_SIZE,
```
Default pool size is 50. Each `runBatched()` call acquires a session from the pool. Three concurrent ingestions, each running 8 phases with batches of 100 items, could exhaust the pool.

The `connectionAcquisitionTimeout` is 60 seconds (line 96), so concurrent ingests would block waiting for connections, not crash. But they would be extremely slow.

### Qdrant contention
The Qdrant client has no connection pooling -- it creates a single `QdrantSDKClient` instance (line 217 of QdrantClient.ts). HTTP requests from multiple concurrent ingestions would serialize at the HTTP level. Qdrant itself handles concurrent upserts reasonably well (it has internal locks), but the `wait: true` flag in `CodeIndexer.indexIngestion()` (line 62) means each batch blocks until Qdrant confirms persistence.

### Race condition in manifest writes
`ManifestStore.save()` at `/Users/umasankr/Projects/ping-mem/src/ingest/ManifestStore.ts` line 27 uses `fs.writeFileSync()` which is NOT atomic on most filesystems. Two concurrent ingests of the same project could produce a corrupted `manifest.json`. The `load()` method (line 21) has a try/catch for JSON parse errors, treating corrupt files as absent -- so this would trigger a full re-ingest, not a crash.

### Prevention recommendations
1. Add an in-process ingestion lock (per projectId) using a Map of promises or a semaphore.
2. Add a global ingestion queue that limits concurrency to 1-2 simultaneous ingestions.
3. Use atomic file writes for manifest (write to temp file, then rename).

---

## 6. Large File Handling

### No file size limit anywhere

**hashFile()** -- `/Users/umasankr/Projects/ping-mem/src/ingest/ProjectScanner.ts`, line 185:
```typescript
const content = fs.readFileSync(filePath);
```
Reads the ENTIRE file into memory as a Buffer. No size check.

**chunkCodeFiles()** -- `/Users/umasankr/Projects/ping-mem/src/ingest/IngestionOrchestrator.ts`, line 169:
```typescript
const content = fs.readFileSync(fullPath, "utf-8");
```
Reads the entire file AGAIN as a UTF-8 string (doubles memory for large files).

**CodeChunker** -- no size limits. A 50MB TypeScript file would produce a single "code" chunk for non-comment sections. That chunk's content would be stored in:
- Memory (IngestionResult object)
- Neo4j (Chunk node's `content` property)
- Qdrant (truncated to 2000 chars in payload, per CodeIndexer line 207: `content: chunk.content.substring(0, 2000)`)

**DeterministicVectorizer** -- `/Users/umasankr/Projects/ping-mem/src/search/DeterministicVectorizer.ts`:
The `tokenize()` method (line 54) processes the ENTIRE chunk content. For a 50MB code chunk, this creates millions of tokens, then `generateNgrams()` produces O(n^3) ngrams (trigrams of millions of tokens). This would OOM the process.

### Memory usage estimate for large files
- 10MB file: ~20MB in memory (Buffer + UTF-8 string), tokenizer produces ~1.5M tokens, ngram generation is ~4.5M trigrams. Each SHA-256 hash in `hashFeatures()` is expensive. Estimated: 200MB+ peak memory, 10+ seconds CPU.
- 50MB file: ~100MB raw, but ngram explosion makes this catastrophic. Process will OOM.
- 100MB file: Guaranteed crash.

### Prevention recommendations
1. Add a `MAX_FILE_SIZE` constant (e.g., 1MB or 5MB) in ProjectScanner. Skip files exceeding it with a warning log.
2. Add chunk size limits in CodeChunker -- if a single code block exceeds N bytes, split it at function boundaries or at fixed intervals.
3. Add a check in `buildIndexPoints()` to skip chunks with content > 50KB.

---

## 7. Binary/Generated Files Passing Extension Filter

### What passes through

The `DEFAULT_EXCLUDE_EXTENSIONS` at `/Users/umasankr/Projects/ping-mem/src/ingest/ProjectScanner.ts` lines 29-46 is incomplete. Notable gaps:

| Extension | Type | Risk |
|-----------|------|------|
| `.wasm` | WebAssembly binary | NOT excluded. Would be read as UTF-8 (garbled), vectorized |
| `.map` | Source maps | NOT excluded. Can be 5-50MB of JSON |
| `.min.js` | Minified JS | NOT excluded (has `.js` extension). Single-line, enormous, low-value chunks |
| `.min.css` | Minified CSS | NOT excluded. Same problem |
| `.d.ts` | TypeScript definitions | NOT excluded. Vendored types from node_modules (see #2) |
| `.snap` | Jest snapshots | NOT excluded. Large auto-generated files |
| `.patch` | Patch files | NOT excluded |
| `.log` | Log files | NOT excluded |
| `.csv`, `.tsv` | Data files | NOT excluded |
| `.json` | JSON data | NOT excluded. `package-lock.json` would be huge (covered by `.lock` only) |
| `.yaml`, `.yml` | Config | NOT excluded, but generally fine |
| `.sql` | SQL dumps | NOT excluded. Can be enormous |

### Binary file detection
There is NO binary file detection. The `hashFile()` method reads files as raw Buffer (line 185), and `chunkCodeFiles()` reads them as UTF-8 (line 169). Binary files read as UTF-8 produce garbled strings with replacement characters. These get chunked, vectorized, and stored.

The `CodeChunker` only has special handling for `.py`, `.ts`, `.tsx`, `.js`, `.jsx` (line 13-18). All other extensions get a single "code" chunk of the entire file content (line 19):
```typescript
return [{ type: "code", start: 0, end: content.length, content }];
```

So a `.wasm` file tracked by git would be read as UTF-8, turned into a single garbled chunk, vectorized (producing a meaningless vector), and stored in Neo4j + Qdrant.

### Prevention recommendations
1. Add `.wasm`, `.map`, `.min.js`, `.min.css`, `.snap`, `.patch`, `.log`, `.csv`, `.tsv`, `.sql` to `DEFAULT_EXCLUDE_EXTENSIONS`.
2. Add binary detection: check the first 512 bytes for null bytes (`\x00`). If found, skip the file.
3. Add a `.d.ts` exclusion or at least a warning when ingesting type definition files from vendored paths.
4. Consider a "supported extensions" allowlist approach instead of a blocklist, for the `git ls-files` path.

---

## Summary: Priority-Ranked Prevention Actions

| Priority | Issue | Risk | Fix Complexity |
|----------|-------|------|----------------|
| P0 | No file size limit (#6) | Process OOM on large files | Low -- add MAX_FILE_SIZE check |
| P0 | Manifest saved before persist completes (#3) | Silent data loss, blocked re-ingestion | Medium -- restructure save order |
| P1 | node_modules via git ls-files (#2) | Wasted storage, degraded search quality | Low -- apply ignoreDirs to git path |
| P1 | No binary detection (#7) | Garbled vectors, wasted storage | Low -- null byte check |
| P1 | Missing extensions in blocklist (#7) | .wasm, .map, .min.js ingested | Low -- add to set |
| P2 | No concurrency control (#5) | Slow concurrent ingests, manifest corruption | Medium -- add per-project lock |
| P2 | Neo4j OOM on delete (#4) | Crash during project cleanup | Medium -- batch deletes |
| P3 | Symlink to large file (#1) | Potential OOM via symlink | Low -- lstat check |
| P3 | Orphaned Neo4j nodes (#4) | Gradual storage bloat | Medium -- pre-ingest cleanup |
