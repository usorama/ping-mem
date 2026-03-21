# Research: Self-Monitoring Ingestion Queue Patterns

**Date**: 2026-03-15
**Scope**: Production patterns for self-monitoring ingestion queues in TypeScript/Node.js, applied to ping-mem's codebase ingestion pipeline (Neo4j + Qdrant).

---

## 1. p-queue Library

**Current version**: 9.1.0 (as of March 2026)
**Package**: `p-queue` by sindresorhus (ESM-only)

### Core API

```typescript
import PQueue from 'p-queue';

const queue = new PQueue({
  concurrency: 3,        // max concurrent promises
  interval: 1000,        // rate-limit window (ms)
  intervalCap: 10,       // max tasks per interval
  timeout: 30_000,       // per-task timeout (ms)
  throwOnTimeout: true,  // throw TimeoutError on timeout
  autoStart: true,       // start processing immediately
});
```

### Adding Tasks

```typescript
// Single task with priority (0-10, higher = first)
const result = await queue.add(async () => fetchData(), {
  priority: 5,
  id: 'fetch-data',
  timeout: 10_000,       // per-task override
});

// Multiple tasks at once
const results = await queue.addAll([
  async () => task1(),
  async () => task2(),
]);
```

### Priority Management

- Tasks execute in priority order (higher number = higher priority, range 0-10)
- Priority can be updated dynamically: `queue.setPriority('task-id', 10)`
- Filter by priority: `queue.sizeBy({ priority: 5 })`
- Completion order is NOT guaranteed (depends on task duration)

### Pause / Resume

```typescript
queue.pause();                    // stop dequeuing new tasks
console.log(queue.isPaused);      // true
await queue.onPendingZero();      // wait for running tasks to finish
queue.start();                    // resume dequeuing
```

### Event Emitters

p-queue extends EventEmitter. Available events:

| Event | Payload | When |
|-------|---------|------|
| `active` | -- | Task starts executing |
| `completed` | `result` | Task resolves successfully |
| `error` | `Error` | Task rejects |
| `add` | -- | Task added to queue |
| `next` | -- | Task finishes (success or error), slot freed |
| `empty` | -- | Queue size drops to 0 (tasks may still be running) |
| `idle` | -- | Queue empty AND no tasks running |
| `rateLimit` | -- | Rate limit triggered |
| `rateLimitCleared` | -- | Rate limit window expired |

### Async Waiters

```typescript
await queue.onEmpty();             // resolves when size === 0
await queue.onIdle();              // resolves when size === 0 AND pending === 0
await queue.onPendingZero();       // resolves when pending === 0 (ignores queued)
await queue.onSizeLessThan(10);    // resolves when size < threshold
```

### State Properties

| Property | Type | Description |
|----------|------|-------------|
| `queue.size` | `number` | Tasks waiting in queue |
| `queue.pending` | `number` | Tasks currently executing |
| `queue.isPaused` | `boolean` | Whether queue is paused |
| `queue.runningTasks` | `TaskInfo[]` | Currently running tasks (id, priority, startTime, timeout) |

### Applicability to ping-mem

p-queue is a strong fit for orchestrating the ingestion pipeline stages (scan, chunk, persist-to-Neo4j, index-to-Qdrant). Key benefits:
- Priority support allows re-ingestion requests to jump ahead of periodic scans
- Pause/resume enables graceful shutdown during deployments
- Event emitters provide progress telemetry without polling
- `runningTasks` gives real-time visibility into what is being processed
- Rate limiting can throttle Neo4j/Qdrant writes to avoid overwhelming backends

**Sources**:
- [p-queue on npm](https://www.npmjs.com/package/p-queue)
- [p-queue GitHub](https://github.com/sindresorhus/p-queue)
- [p-queue source (index.ts)](https://github.com/sindresorhus/p-queue/blob/main/source/index.ts)
- [p-queue API docs (jsDocs.io)](https://www.jsdocs.io/package/p-queue)

---

## 2. Node.js EventEmitter Patterns for Pipeline Progress

### Webpack's Tapable Architecture

Webpack's plugin system is the gold standard for event-driven build pipelines. It uses the `tapable` library, which extends the publish-subscribe pattern with typed hooks:

| Hook Type | Behavior |
|-----------|----------|
| `SyncHook` | Synchronous, all handlers called |
| `SyncBailHook` | Synchronous, short-circuits on truthy return |
| `AsyncSeriesHook` | Async, handlers called sequentially |
| `AsyncParallelHook` | Async, handlers called in parallel |

**Key lifecycle hooks** (in order):

```
beforeRun -> run -> beforeCompile -> compile ->
thisCompilation -> compilation -> make (parallel) ->
afterCompile -> shouldEmit -> emit -> afterEmit -> done
```

**ProgressPlugin** reports phases to stderr using middleware on `compiler.hooks.emit` and `compiler.hooks.afterEmit`. Plugins tap into hooks via:

```typescript
compiler.hooks.emit.tapAsync('MyPlugin', (compilation, callback) => {
  // report progress, modify assets
  callback();
});
```

### Patterns Applicable to ping-mem

**Phased progress events** (webpack-inspired):

```typescript
type IngestionPhase =
  | 'scanning'       // ProjectScanner: merkle tree
  | 'chunking'       // CodeChunker: splitting files
  | 'git-history'    // GitHistoryReader: commit DAG
  | 'neo4j-persist'  // TemporalCodeGraph: writing nodes
  | 'qdrant-index'   // CodeIndexer: vectorizing
  | 'complete'
  | 'error';

interface IngestionProgress {
  phase: IngestionPhase;
  current: number;       // items processed in this phase
  total: number;         // total items in this phase
  projectId: string;
  elapsed: number;       // ms since ingestion started
  message?: string;      // human-readable status
}
```

**Recommended pattern**: Use a typed EventEmitter (or `eventemitter3` for performance) with a small set of well-defined events rather than many granular hooks. Webpack's hook-per-phase model is powerful but adds complexity; for ping-mem, a single `progress` event with a phase discriminator is simpler and sufficient.

```typescript
emitter.on('progress', (p: IngestionProgress) => {
  log.info(`[${p.phase}] ${p.current}/${p.total} -- ${p.message}`);
});

emitter.on('error', (err: Error, context: { phase: IngestionPhase; file?: string }) => {
  log.error(`Ingestion error in ${context.phase}: ${err.message}`);
});
```

**Sources**:
- [Webpack Compiler Hooks](https://webpack.js.org/api/compiler-hooks/)
- [Webpack Plugin API](https://webpack.js.org/api/plugins/)
- [Tapable library (webpack core)](https://codecrumbs.io/library/webpack-tapable-core/)
- [Writing a Webpack Plugin](https://webpack.js.org/contribute/writing-a-plugin/)
- [eventemitter3 on npm](https://www.npmjs.com/package/eventemitter3)

---

## 3. Git Submodule and Gitlink Detection

### How git ls-files Handles Submodules

Submodules appear in the Git index as **gitlinks** -- special entries with file mode `160000` and object type `commit` (not `blob`).

### Key Flags

| Flag | Purpose |
|------|---------|
| `--cached` (`-c`) | Show all tracked files in the index (default) |
| `--stage` (`-s`) | Show mode bits, object name, and stage number |
| `--recurse-submodules` | Recursively call ls-files on each active submodule (only supports `--cached` and `--stage`) |
| `--format=<fmt>` | Custom output format using `%(fieldname)` interpolation |

### Detecting Gitlinks

```bash
# Output format with --stage:
# <mode> <object> <stage> <path>
# Example gitlink:
# 160000 c931a7bbe7df798d559e172bcf7c80a086c82f1d 0 my-submodule

# Detect gitlinks by mode:
git ls-files --stage | grep '^160000'

# Or with --format for structured parsing:
git ls-files --format='%(objectmode) %(objecttype) %(objectname) %(path)'
# Output: 160000 commit c931a7bb... my-submodule
```

### Mode Values Reference

| Mode | Meaning |
|------|---------|
| `100644` | Regular file |
| `100755` | Executable file |
| `120000` | Symbolic link |
| `160000` | Gitlink (submodule) |

### Status Tags (with -t flag)

| Tag | Meaning |
|-----|---------|
| `H` | Tracked file |
| `S` | Skip-worktree |
| `M` | Unmerged |
| `R` | Unstaged removal |
| `C` | Unstaged modification |

### Applicability to ping-mem

The `ProjectScanner` currently uses `git ls-files --cached` to enumerate files. This will include gitlink entries (mode 160000) for submodules. If the scanner then tries to read these paths as files, it will fail or produce garbage. The fix is to use `--stage` output and filter by mode:

```typescript
// Filter out gitlinks from git ls-files --stage output
const output = run('git', ['ls-files', '--stage'], { cwd: projectDir });
const files = output.split('\n')
  .filter(line => !line.startsWith('160000'))  // skip gitlinks
  .map(line => {
    const parts = line.split('\t');
    return parts[1]; // path is after the tab
  });
```

Alternatively, detect gitlinks first and log them as skipped:

```typescript
const gitlinks = output.split('\n')
  .filter(line => line.startsWith('160000'))
  .map(line => line.split('\t')[1]);

if (gitlinks.length > 0) {
  log.warn(`Skipping ${gitlinks.length} submodule(s): ${gitlinks.join(', ')}`);
}
```

**Sources**:
- [git-ls-files documentation](https://git-scm.com/docs/git-ls-files)
- [git-ls-files kernel.org](https://www.kernel.org/pub/software/scm/git/docs/git-ls-files.html)
- [gitsubmodules documentation](https://git-scm.com/docs/gitsubmodules)
- [Git Tools - Submodules](https://git-scm.com/book/en/v2/Git-Tools-Submodules)

---

## 4. Nested Git Repo Detection

### The Problem

A directory may contain a `.git` subdirectory (making it a separate Git repository) without being registered as a submodule. This happens with:
- Vendored dependencies cloned in-place
- Developer experiments (`git init` inside a subdirectory)
- Monorepo tools that clone repos into subdirectories

### Detection Methods

**Method 1: Check for .git directory/file**

```typescript
import { existsSync } from 'fs';
import { join, dirname } from 'path';

function isNestedGitRepo(dirPath: string, projectRoot: string): boolean {
  if (dirPath === projectRoot) return false; // skip the root itself
  const gitPath = join(dirPath, '.git');
  return existsSync(gitPath); // .git can be a directory or a file (worktree)
}
```

**Method 2: Use git rev-parse --show-toplevel**

```typescript
function getGitRoot(filePath: string): string | null {
  try {
    const result = run('git', ['rev-parse', '--show-toplevel'], {
      cwd: dirname(filePath),
    });
    return result.trim();
  } catch {
    return null; // not in a git repo
  }
}

// If the git root for a file differs from the project root,
// the file is inside a nested repo
const fileGitRoot = getGitRoot(filePath);
if (fileGitRoot && fileGitRoot !== projectRoot) {
  log.warn(`File ${filePath} is inside nested repo ${fileGitRoot}`);
}
```

### How Monorepo Tools Handle This

| Tool | Approach |
|------|----------|
| **Android `repo`** | Manages a manifest of git repos; each project is a separate clone under a common root. Uses `.repo/` metadata directory. Never nests git repos -- they are siblings. |
| **`mr` (myrepos)** | Scans for `.git` directories to discover repos. Config file lists repo paths. Treats each `.git` as an independent repo. |
| **Meta** | Creates a `.meta` config listing sub-repos. Runs commands across all repos. Does not nest -- repos are side-by-side under a parent directory. |
| **Turborepo / Nx / Lerna** | Operate within a single git repo (monorepo). Use package.json workspaces for project boundaries. No nested `.git` directories. |
| **`tomono`** | Merges multiple repos into one monorepo, preserving history. Removes individual `.git` directories. |

### Best Practice for ping-mem

Before scanning, detect and exclude nested repos:

```typescript
async function findNestedGitRepos(projectDir: string): Promise<string[]> {
  const nested: string[] = [];
  // Walk directories looking for .git
  for (const entry of walkDirs(projectDir)) {
    if (entry.name === '.git' && entry.path !== projectDir) {
      nested.push(dirname(entry.fullPath));
    }
  }
  return nested;
}
```

Then filter these paths from `git ls-files` output, or add them to the exclude list alongside `node_modules`, `.git`, etc.

**Sources**:
- [Monorepos in Git (Atlassian)](https://www.atlassian.com/git/tutorials/monorepos)
- [awesome-monorepo (GitHub)](https://github.com/korfuri/awesome-monorepo)
- [Monorepo Explained](https://monorepo.tools/)
- [Nested git projects (Hacker News discussion)](https://news.ycombinator.com/item?id=26239575)
- [Managing monorepos with Git (Graphite)](https://graphite.com/guides/git-monorepo)

---

## 5. Pre-Validation Patterns for File Ingestion

### How RAG Frameworks Validate Files

#### LlamaIndex

LlamaIndex's `IngestionPipeline` applies a chain of **Transformations** to input data:

1. **SimpleDirectoryReader** -- reads files from a directory, supporting Markdown, PDFs, Word, PowerPoint, images, audio, video
2. **Deduplication** -- hashes each `(node, transformation)` pair and caches results; skips unchanged data on re-runs
3. **Document ID tracking** -- uses `doc_id` / `ref_doc_id` to detect duplicate documents; if hash changed, re-processes and upserts

LlamaIndex does NOT perform explicit pre-validation (file size limits, encoding checks) at the framework level. It relies on individual readers/loaders to handle format-specific validation.

#### Haystack

Haystack 2.x uses a more explicit validation model:

1. **FileTypeRouter** -- routes files based on MIME type to appropriate converters
2. **Converters** -- `PyPDFToDocument`, `TextFileToDocument`, `MarkdownToDocument`
3. **Pipeline validation** -- when calling `.connect()`, Haystack validates:
   - Components exist in the pipeline
   - Input/output types match between connected components
   - Input slots are not already occupied
4. **DocumentCleaner** -- removes extra whitespace, short lines, etc.

#### LangChain

LangChain's document loaders handle validation internally per loader type. No centralized pre-validation framework.

### Recommended Pre-Validation Checklist for ping-mem

Based on production patterns across these frameworks:

```typescript
interface FileValidationResult {
  path: string;
  valid: boolean;
  skipReason?: string;
}

function validateFile(filePath: string, stats: Stats): FileValidationResult {
  // 1. File size check
  const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
  if (stats.size > MAX_FILE_SIZE) {
    return { path: filePath, valid: false, skipReason: `too large (${stats.size} bytes)` };
  }
  if (stats.size === 0) {
    return { path: filePath, valid: false, skipReason: 'empty file' };
  }

  // 2. File extension check (supported languages)
  const SUPPORTED = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.md', '.json', '.yaml', '.yml']);
  if (!SUPPORTED.has(ext)) {
    return { path: filePath, valid: false, skipReason: `unsupported extension: ${ext}` };
  }

  // 3. Binary detection (read first 8KB, check for null bytes)
  if (buffer.includes(0x00)) {
    return { path: filePath, valid: false, skipReason: 'binary file detected' };
  }

  // 4. Encoding validation (attempt UTF-8 decode)
  // Use TextDecoder with fatal: true to reject invalid UTF-8

  // 5. Permissions check
  // Use fs.accessSync with R_OK to verify readability

  return { path: filePath, valid: true };
}
```

**Additional checks specific to code ingestion**:
- **Gitlink detection** (mode 160000) -- skip submodule entries
- **Symlink resolution** -- follow or skip depending on policy
- **Generated file detection** -- skip files matching patterns like `*.generated.ts`, `*.min.js`, `dist/`, `build/`
- **Lock files** -- skip `package-lock.json`, `bun.lockb`, `yarn.lock` (large, no code value)

**Sources**:
- [LlamaIndex Ingestion Pipeline](https://developers.llamaindex.ai/python/framework/module_guides/loading/ingestion_pipeline/)
- [LlamaIndex Loading Data](https://developers.llamaindex.ai/python/framework/module_guides/loading/)
- [Haystack File Type Preprocessing](https://haystack.deepset.ai/tutorials/30_file_type_preprocessing_index_pipeline)
- [Haystack Document Store](https://docs.haystack.deepset.ai/docs/document-store)
- [Haystack Pipelines](https://docs.haystack.deepset.ai/docs/pipelines)

---

## 6. Qdrant Collection Management During Bulk Ingestion

### Indexing Strategies

Qdrant incrementally builds an HNSW index for dense vectors as data arrives. During bulk ingestion, frequent index updates waste CPU/RAM. Three strategies:

| Strategy | Config | Tradeoff |
|----------|--------|----------|
| **Disable indexing** | `indexing_threshold: 0` | Fastest upload, but high RAM (unoptimized storage) |
| **Defer HNSW graph** | `m: 0` | Low RAM during upload, recommended by Qdrant docs |
| **Default** | `m: 16`, `indexing_threshold: 20000` | Balanced; index available sooner after upload |

### Recommended Flow for ping-mem

```typescript
// 1. Before bulk ingestion: disable HNSW graph construction
await qdrantClient.updateCollection(collectionName, {
  hnsw_config: { m: 0 },
});

// 2. Upsert vectors in batches of 1000-10000
for (const batch of chunks(points, BATCH_SIZE)) {
  await qdrantClient.upsert(collectionName, {
    wait: true,
    points: batch,
  });
}

// 3. After ingestion: re-enable HNSW with production settings
await qdrantClient.updateCollection(collectionName, {
  hnsw_config: { m: 16 },
});

// 4. Optionally re-enable optimizer threshold
await qdrantClient.updateCollection(collectionName, {
  optimizers_config: { indexing_threshold: 20000 },
});
```

### Batch Size Recommendations

- **1,000-10,000 points per upsert** -- balances network overhead vs memory
- Qdrant docs: "the bottleneck is usually on the client side, not the server side"
- Use `wait: true` for consistency, `wait: false` for throughput (fire-and-forget)

### Parallel Upload via Sharding

For very large datasets, create multiple shards to parallelize:

```typescript
await qdrantClient.createCollection(collectionName, {
  vectors: { size: 768, distance: 'Cosine' },
  shard_number: 2, // 2-4 shards per machine
});
```

Each shard maintains a separate Write-Ahead Log, enabling true parallel writes.

### On-Disk Storage for Large Datasets

Use `on_disk: true` for billion-scale datasets to avoid loading all vectors into RAM:

```typescript
await qdrantClient.createCollection(collectionName, {
  vectors: { size: 768, distance: 'Cosine', on_disk: true },
});
```

**Sources**:
- [Qdrant Bulk Upload Tutorial](https://qdrant.tech/documentation/tutorials-develop/bulk-upload/)
- [Qdrant Indexing Optimization](https://qdrant.tech/articles/indexing-optimization/)
- [Qdrant Collections](https://qdrant.tech/documentation/concepts/collections/)
- [Qdrant Optimizer](https://qdrant.tech/documentation/concepts/optimizer/)
- [Qdrant Large-Scale Ingestion Course](https://qdrant.tech/course/essentials/day-4/large-scale-ingestion/)

---

## 7. Neo4j Bulk Import Patterns

### Three Approaches

| Approach | Best For | Batch Size |
|----------|----------|------------|
| **UNWIND + driver** | Application-level bulk writes | 1,000-10,000 rows |
| **APOC `periodic.iterate`** | Server-side batch processing | 500-10,000 rows |
| **`neo4j-admin import`** | Initial load of massive datasets | Millions+ (offline only) |

### UNWIND Pattern (Recommended for ping-mem)

The UNWIND approach sends a single parameterized query with all data as an array, letting Neo4j process it in one transaction:

```typescript
// Batch create nodes
const files = [...]; // array of { id, path, hash, ... }

await session.executeWrite(async (tx) => {
  await tx.run(`
    UNWIND $files AS f
    MERGE (file:File { id: f.id })
    SET file.path = f.path,
        file.hash = f.hash,
        file.validFrom = datetime()
  `, { files });
});
```

**Recommended batch sizes**: 1,000-10,000 rows per UNWIND. Beyond 50,000, transaction memory pressure increases.

### APOC periodic.iterate

For server-side batch processing (useful for graph refactoring or large migrations):

```cypher
CALL apoc.periodic.iterate(
  'MATCH (f:File) WHERE f.needsUpdate = true RETURN f',
  'SET f.processed = true, f.needsUpdate = false',
  { batchSize: 5000, parallel: true, retries: 3 }
)
```

**Config parameters**:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `batchSize` | 10,000 | Rows per transaction |
| `parallel` | `true` | Run batches concurrently (risk of deadlocks if conflicting) |
| `retries` | 0 | Retry count on failure (100ms sleep between) |
| `batchMode` | `"BATCH"` | `BATCH` (auto-unwind), `SINGLE` (one at a time), `BATCH_SINGLE` (manual unwind) |
| `concurrency` | num CPUs | Concurrent tasks when `parallel: true` |

### Performance Tips for Neo4j

1. **Use `CREATE` instead of `MERGE` when data is known to be new** -- `CREATE` is roughly 2x faster (single index lookup vs. read-then-write)
2. **Create indexes BEFORE bulk import** on properties used in `MERGE` or `MATCH`:
   ```cypher
   CREATE INDEX file_id_idx FOR (f:File) ON (f.id);
   CREATE INDEX chunk_id_idx FOR (c:Chunk) ON (c.id);
   CREATE INDEX commit_hash_idx FOR (c:Commit) ON (c.hash);
   ```
3. **Use parameterized queries** -- enables query plan caching
4. **Batch relationships separately from nodes** -- create all nodes first, then all relationships
5. **Specify node labels in queries** -- helps the query planner
6. **Profile with `PROFILE`/`EXPLAIN`** to identify slow patterns
7. **Route read queries with `routing: 'READ'`** in cluster setups

### TypeScript Pattern for ping-mem

```typescript
const BATCH_SIZE = 5000;

async function bulkPersistFiles(
  session: Session,
  files: FileNode[],
): Promise<void> {
  for (const batch of chunks(files, BATCH_SIZE)) {
    await session.executeWrite(async (tx) => {
      await tx.run(`
        UNWIND $batch AS f
        MERGE (file:File { id: f.id })
        SET file.path = f.path,
            file.hash = f.hash,
            file.size = f.size,
            file.validFrom = datetime($validFrom)
      `, { batch, validFrom: new Date().toISOString() });
    });
  }
}

async function bulkPersistRelationships(
  session: Session,
  rels: Array<{ projectId: string; fileId: string }>,
): Promise<void> {
  for (const batch of chunks(rels, BATCH_SIZE)) {
    await session.executeWrite(async (tx) => {
      await tx.run(`
        UNWIND $batch AS r
        MATCH (p:Project { id: r.projectId })
        MATCH (f:File { id: r.fileId })
        MERGE (p)-[:HAS_FILE]->(f)
      `, { batch });
    });
  }
}
```

**Sources**:
- [Neo4j JavaScript Driver Performance](https://neo4j.com/docs/javascript-manual/current/performance/)
- [APOC Periodic Execution](https://neo4j.com/docs/apoc/current/graph-updates/periodic-execution/)
- [APOC periodic.iterate](https://neo4j.com/labs/apoc/4.2/overview/apoc.periodic/apoc.periodic.iterate/)
- [Neo4j Bulk Insert (GitHub issue)](https://github.com/neo4j/neo4j-javascript-driver/issues/227)
- [Using TypeScript with Neo4j](https://dev.to/adamcowley/using-typescript-with-neo4j-478c)

---

## Summary: Recommended Architecture for ping-mem Ingestion Queue

```
+------------------------------------------------------------------+
|  IngestionQueue (p-queue, concurrency: 1-3)                      |
|                                                                   |
|  Events: 'progress' | 'error' | 'complete'                       |
|                                                                   |
|  +----------+   +----------+   +----------+   +----------+       |
|  | Phase 1  | > | Phase 2  | > | Phase 3  | > | Phase 4  |       |
|  | Scan     |   | Chunk    |   | Neo4j    |   | Qdrant   |       |
|  |          |   |          |   | Persist  |   | Index    |       |
|  +----------+   +----------+   +----------+   +----------+       |
|                                                                   |
|  Pre-validation:                                                  |
|  - Skip gitlinks (mode 160000)                                    |
|  - Skip nested .git repos                                         |
|  - Skip binary files (null byte detection)                        |
|  - Skip files > 10MB                                              |
|  - Skip unsupported extensions                                    |
|  - Skip generated/lock files                                      |
|                                                                   |
|  Neo4j batching:                                                  |
|  - UNWIND with batch size 5,000                                   |
|  - Nodes first, relationships second                              |
|  - CREATE for new data, MERGE for idempotent                      |
|  - Indexes on id properties                                       |
|                                                                   |
|  Qdrant batching:                                                 |
|  - Disable HNSW (m: 0) before bulk upsert                        |
|  - Upsert batches of 5,000 points                                |
|  - Re-enable HNSW (m: 16) after completion                       |
|                                                                   |
|  Self-monitoring:                                                 |
|  - EventEmitter with typed progress events                        |
|  - Phase + current/total counters                                 |
|  - Elapsed time tracking                                          |
|  - queue.runningTasks for real-time visibility                    |
|  - SSE broadcast to /api/v1/events/stream                        |
+------------------------------------------------------------------+
```

### Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Queue library | `p-queue` v9.1.0 | Events, priority, pause/resume, TypeScript, ESM |
| Progress pattern | Single `progress` event with phase discriminator | Simpler than webpack's hook-per-phase; sufficient for pipeline monitoring |
| Gitlink detection | `git ls-files --stage` + filter mode 160000 | Reliable, uses git's own index; handles submodules and gitlinks |
| Nested repo detection | Check for `.git` in subdirectories during scan | Simple, handles vendored repos and developer experiments |
| File validation | Size + extension + binary + encoding checks | Prevents chunker crashes on unexpected input |
| Neo4j batch size | 5,000 rows per UNWIND | Balance of transaction memory and throughput |
| Qdrant strategy | Disable HNSW (`m: 0`) during bulk, re-enable after | Recommended by Qdrant docs; low RAM during ingestion |
| Qdrant batch size | 5,000 points per upsert | Within recommended 1k-10k range |
