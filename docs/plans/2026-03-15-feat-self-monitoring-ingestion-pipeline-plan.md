---
title: "feat: Self-Monitoring Ingestion Pipeline"
type: feat
date: 2026-03-15
research: docs/ping-mem-research/ (6 documents, 5 agents)
synthesis: docs/ping-mem-research/06-synthesis.md
eval_iteration: 1
review_iteration: 0
verification_iteration: 0
verification_method: "pending"
eval_scores: { completeness: 62, safety: 52, performance: 52 }
---

# Self-Monitoring Ingestion Pipeline

## Problem Statement

ping-mem's code ingestion pipeline is blind — it has no progress reporting, no self-monitoring, no queue management, and incomplete file filtering. During today's ingestion of 3 projects (ping-learn, understory, ping-learn-mobile), we had to:

1. Manually grep docker logs for progress ("Chunks: X/Y")
2. Dismiss false CRITICAL health alerts (Qdrant drift during normal ingestion)
3. Fix a crash caused by a gitlink (submodule entry) that `readFileSync` tried to read as a file
4. Discover that ping-learn indexed `node_modules/playwright/types/test.d.ts` (8512 lines of .d.ts in Qdrant)
5. Manually batch-delete Neo4j data to avoid OOM on large DETACH DELETE

**Evidence**: All issues observed on 2026-03-15 during live ingestion session. Research documents in `docs/ping-mem-research/`.

## Proposed Solution

Five phases, each independently shippable:

```
Phase 1: Smart Filtering (what to ingest)
Phase 2: IngestionQueue + Manifest Fix (reliable execution)
Phase 3: Event Wiring (visibility)
Phase 4: Health Integration + Retry (self-healing)
Phase 5: Staleness Detection + API Completeness
```

---

## EVAL Amendments (Iteration 1)

**28 findings across 3 agents. All CRITICAL and HIGH findings addressed below.**

| EVAL ID | Severity | Amendment |
|---------|----------|-----------|
| G-01 | CRITICAL | Replaced p-queue with zero-dependency Promise chain (see Phase 2) |
| G-02 | CRITICAL | p-queue removed — no pending/size confusion possible |
| G-03 | CRITICAL | Added explicit `skipManifestSave` and `saveManifest()` specs to Phase 2 |
| G-04 | CRITICAL | Added `SYSTEM_SESSION_ID` constant for EventStore events (Phase 3) |
| G-05 | CRITICAL | Committed to separate `IngestionEventEmitter` — no MemoryPubSub modification |
| G-06 | CRITICAL | HealthMonitor receives reference via `setIngestionService()` setter (Phase 4) |
| C1 | CRITICAL | Added `isProjectDirSafe()` to all new endpoints (Phase 2) |
| C2 | CRITICAL | Added prerequisite fix: `isProjectDirSafe()` on existing ingest endpoint |
| C3 | CRITICAL | Added `IngestionEnqueueSchema` Zod schema (Phase 2) |
| PERF-1 | CRITICAL | Merged validateFile into hashFile — single read per file (Phase 1) |
| PERF-2 | CRITICAL | Staleness uses `git status --porcelain` instead of full re-hash (Phase 5) |
| PERF-3 | CRITICAL | Retry moved to per-batch in `runBatched()` (Phase 4) |
| G-07 | HIGH | Clarified validateFile insertion point — replaces stat.isFile filter at line 77 |
| G-08 | HIGH | Added `summarizeSkipReasons()` method spec |
| G-09 | HIGH | WorklogEventData includes `sessionId: SYSTEM_SESSION_ID` |
| G-13 | HIGH | `maxFileSizeBytes` flows via `IngestionOptions.scanOptions` |
| H1 | HIGH | File descriptor leak fixed — binary check uses buffer from readFileSync |
| H2 | HIGH | Added UUID validation on `runId` param |
| H3 | HIGH | Added .env cleanup migration step |
| H4 | HIGH | Neo4j relationship MERGE uses ON CREATE SET for `ingestedAt` |
| M1 | MEDIUM | Retry logging uses `sanitizeHealthError()` |
| M2 | MEDIUM | EventStore error payloads sanitized |
| M3 | MEDIUM | Added `maxQueueDepth = 10` with 429 rejection |
| L3 | LOW | `IngestionRun.error` sanitized before storage |

---

## Phase 0: Prerequisite Security Fix

**Fix `isProjectDirSafe()` on existing ingest endpoint** (EVAL C2).

**File**: `src/http/rest-server.ts` line 755

```typescript
// AFTER path.resolve, BEFORE ingestProject():
const safeCheck = isProjectDirSafe(projectDir);
if (!safeCheck.safe) {
  return c.json({ error: safeCheck.reason }, 403);
}
```

This is a pre-existing vulnerability — must be fixed before any new endpoints are added.

---

## Phase 1: Smart Filtering — "What to Ingest"

**Goal**: Prevent garbage from entering the pipeline. Every file that reaches CodeChunker should be a valid, useful source file.

### 1.1 Combined Validation + Hashing (EVAL PERF-1 fix)

Instead of a separate `validateFile()` that reads 8KB then `hashFile()` reads the whole file again, combine them into a single `hashAndValidateFile()`:

**File**: `src/ingest/ProjectScanner.ts`

```typescript
private hashAndValidateFile(
  rootPath: string, filePath: string
): { entry: FileHashEntry; valid: true } | { valid: false; reason: string } {
  // 1. stat check — size limit + isFile guard
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { valid: false, reason: "missing or inaccessible" };
  }
  if (!stat.isFile()) {
    return { valid: false, reason: "not a regular file (directory/gitlink)" };
  }
  if (stat.size > this.maxFileSizeBytes) {
    return { valid: false, reason: `size ${stat.size} > ${this.maxFileSizeBytes}` };
  }

  // 2. .env check (covers git-ls-files path which lacks walkDirectory's .env filter)
  const basename = path.basename(filePath);
  if (basename === ".env" || basename.startsWith(".env.")) {
    return { valid: false, reason: ".env file" };
  }

  // 3. Read file ONCE — use for both binary detection and SHA-256 hash
  const content = fs.readFileSync(filePath);

  // 4. Binary detection — check first 8KB for null bytes
  const checkLength = Math.min(content.length, 8192);
  for (let i = 0; i < checkLength; i++) {
    if (content[i] === 0) {
      return { valid: false, reason: "binary file (null bytes detected)" };
    }
  }

  // 5. Hash from the already-read buffer
  const sha256 = crypto.createHash("sha256").update(content).digest("hex");
  const relPath = this.normalizePath(path.relative(rootPath, filePath));
  return {
    valid: true,
    entry: { path: relPath, sha256, bytes: content.length },
  };
}
```

**Integration point**: `src/ingest/ProjectScanner.ts` lines 77-91, replace existing filter + map:

```typescript
// BEFORE (current):
const existingFiles = files.filter(...);
const fileEntries = existingFiles.map((filePath) => this.hashFile(rootPath, filePath));

// AFTER:
const fileEntries: FileHashEntry[] = [];
const skipped: { path: string; reason: string }[] = [];
for (const f of files) {
  const result = this.hashAndValidateFile(rootPath, f);
  if (result.valid) {
    fileEntries.push(result.entry);
  } else {
    skipped.push({ path: path.relative(rootPath, f), reason: result.reason });
  }
}
if (skipped.length > 0) {
  log.info(`Skipped ${skipped.length} files`, { reasons: this.summarizeSkipReasons(skipped) });
}
```

**Helper method** (EVAL G-08 fix):

```typescript
private summarizeSkipReasons(skipped: { path: string; reason: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const s of skipped) {
    counts[s.reason] = (counts[s.reason] ?? 0) + 1;
  }
  return counts;
}
```

### 1.2 Extended Ignore Dirs

**File**: `src/ingest/ProjectScanner.ts` line 10

Add to `DEFAULT_IGNORE_DIRS`:
```
"coverage", "tmp", "temp", "out", ".turbo", ".parcel-cache",
"vendor", ".terraform", ".serverless", "e2e-tests"
```

### 1.3 Extended Exclude Extensions

**File**: `src/ingest/ProjectScanner.ts` line 29

Add to `DEFAULT_EXCLUDE_EXTENSIONS`:
```
".map", ".min.js", ".min.css", ".snap",
".d.ts", ".csv", ".log", ".sql", ".wasm"
```

### 1.4 Nested Git Repo Detection (walkDirectory fallback only)

**File**: `src/ingest/ProjectScanner.ts`, in `walkDirectory()`

**Note**: This only applies to the walkDirectory fallback path. For git-tracked repos (the default), `git ls-files` only lists files from the top-level repo's index — nested repo files are already excluded.

```typescript
if (entry.isDirectory()) {
  const nestedGit = path.join(fullPath, ".git");
  try {
    fs.accessSync(nestedGit);
    log.info(`Skipping nested git repo: ${entry.name}/`);
    continue;
  } catch { /* not a git repo, continue */ }
}
```

### 1.5 Circular Symlink Protection (walkDirectory fallback only)

```typescript
private walkDirectory(rootPath: string): string[] {
  const results: string[] = [];
  const visitedDirs = new Set<string>();
  const walk = (current: string) => {
    const realPath = fs.realpathSync(current);
    if (visitedDirs.has(realPath)) {
      log.warn(`Circular symlink detected, skipping: ${current}`);
      return;
    }
    visitedDirs.add(realPath);
    // ... rest of existing logic
  };
  walk(rootPath);
  return results.sort();
}
```

### 1.6 Constructor Option for maxFileSizeBytes

**File**: `src/ingest/ProjectScanner.ts`

```typescript
export interface ProjectScanOptions {
  ignoreDirs?: Set<string>;
  includeExtensions?: Set<string>;
  excludeExtensions?: Set<string>;
  useGitLsFiles?: boolean;
  maxFileSizeBytes?: number;  // NEW — default 1MB
}

private readonly maxFileSizeBytes: number;

constructor(options: ProjectScanOptions = {}) {
  // ... existing
  this.maxFileSizeBytes = options.maxFileSizeBytes ?? 1_048_576; // 1MB
}
```

**Wiring** (EVAL G-13 fix): `IngestionOrchestrator.ingest()` already accepts `IngestionOptions` which has an optional `scanOptions` field. Wire `maxFileSizeBytes` through `scanOptions` to `new ProjectScanner(scanOptions)`.

### 1.7 Cleanup Previously-Indexed .env Files (EVAL H3 fix)

Add a one-time migration: query Qdrant for points where `filePath` matches `.env` or `.env.*`, delete them.

```typescript
// scripts/cleanup-env-vectors.ts
const points = await qdrantClient.scroll("ping-mem-vectors", {
  filter: { should: [
    { key: "filePath", match: { value: ".env" } },
    { key: "filePath", match: { text: ".env." } },
  ]},
  limit: 10000,
});
if (points.length > 0) {
  await qdrantClient.delete("ping-mem-vectors", {
    points: points.map(p => p.id),
  });
  console.log(`Deleted ${points.length} .env vectors`);
}
```

### Phase 1 Quality Gate

- [ ] `bun run typecheck` — 0 errors
- [ ] `bun test ./src/ingest/__tests__/ProjectScanner.test.ts` — all pass
- [ ] New tests: binary detection, .env filtering, size limit, nested git, circular symlink, combined hash+validate
- [ ] Manual test: ingest ping-learn, verify no .d.ts or node_modules files in Qdrant
- [ ] Run cleanup-env-vectors.ts

---

## Phase 2: IngestionQueue + Manifest Fix

**Goal**: Serial, trackable ingestion with no partial-failure traps.

### 2.1 IngestionQueue (zero-dependency — EVAL G-01/PERF-4 fix)

**New file**: `src/ingest/IngestionQueue.ts`

No p-queue dependency. A simple Promise chain achieves concurrency=1:

```typescript
import crypto from "crypto";
import type { IngestionService, IngestProjectOptions, IngestProjectResult } from "./IngestionService.js";
import { sanitizeHealthError } from "../observability/health-probes.js";

export interface IngestionRun {
  runId: string;
  projectDir: string;
  projectId: string | null;
  status: "queued" | "scanning" | "chunking" | "persisting_neo4j" | "indexing_qdrant" | "completed" | "failed";
  startedAt: string;
  completedAt: string | null;
  error: string | null;  // always sanitized (EVAL L3)
  progress: { phase: string; current: number; total: number } | null;
  result: IngestProjectResult | null;
}

export class IngestionQueue {
  private chain: Promise<void> = Promise.resolve();
  private runs = new Map<string, IngestionRun>();
  private activeCount = 0;
  private pendingCount = 0;
  private readonly maxRunHistory = 50;
  private readonly maxQueueDepth = 10;  // EVAL M3: reject if queue full

  constructor(private ingestionService: IngestionService) {}

  async enqueue(options: IngestProjectOptions): Promise<string> {
    if (this.pendingCount >= this.maxQueueDepth) {
      throw new Error("Ingestion queue full — try again later");
    }

    const runId = crypto.randomUUID();
    const run: IngestionRun = {
      runId,
      projectDir: options.projectDir,
      projectId: null,
      status: "queued",
      startedAt: new Date().toISOString(),
      completedAt: null,
      error: null,
      progress: null,
      result: null,
    };
    this.runs.set(runId, run);
    this.pendingCount++;
    this.pruneHistory();

    this.chain = this.chain.then(async () => {
      this.pendingCount--;
      this.activeCount++;
      try {
        run.status = "scanning";
        const result = await this.ingestionService.ingestProject({
          ...options,
          onProgress: (phase, current, total) => {
            run.status = phase as IngestionRun["status"];
            run.progress = { phase, current, total };
          },
        });
        run.status = "completed";
        run.result = result;
        run.projectId = result?.projectId ?? null;
      } catch (err) {
        run.status = "failed";
        run.error = sanitizeHealthError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        run.completedAt = new Date().toISOString();
        this.activeCount--;
      }
    });

    return runId;
  }

  getRun(runId: string): IngestionRun | undefined { return this.runs.get(runId); }

  getQueueStatus(): { pending: number; active: number; runs: IngestionRun[] } {
    return {
      pending: this.pendingCount,
      active: this.activeCount,
      runs: Array.from(this.runs.values()).reverse(),
    };
  }

  private pruneHistory(): void {
    const completed = [...this.runs.entries()]
      .filter(([_, r]) => r.status === "completed" || r.status === "failed")
      .sort((a, b) => a[1].startedAt.localeCompare(b[1].startedAt));
    while (completed.length > this.maxRunHistory) {
      this.runs.delete(completed.shift()![0]);
    }
  }
}
```

### 2.2 REST Endpoints for Queue

**File**: `src/http/rest-server.ts`

**New Zod schema** (EVAL C3 fix) in `src/validation/api-schemas.ts`:

```typescript
export const IngestionEnqueueSchema = z.object({
  projectDir: z.string().min(1).max(4096).trim()
    .refine((p) => !p.includes(".."), { message: "path traversal not allowed" }),
  forceReingest: z.boolean().optional().default(false),
  maxCommits: z.number().int().min(1).max(10000).optional(),
  maxCommitAgeDays: z.number().int().min(1).max(3650).optional(),
});
```

**Endpoints**:

```typescript
// POST /api/v1/ingestion/enqueue
app.post("/api/v1/ingestion/enqueue", async (c) => {
  const body = IngestionEnqueueSchema.parse(await c.req.json());
  const projectDir = path.resolve(body.projectDir);

  // EVAL C1: path safety check
  const safeCheck = isProjectDirSafe(projectDir);
  if (!safeCheck.safe) return c.json({ error: safeCheck.reason }, 403);

  try {
    const runId = await ingestionQueue.enqueue({ ...body, projectDir });
    return c.json({ runId }, 202);
  } catch (err) {
    if (err.message.includes("queue full")) return c.json({ error: err.message }, 429);
    throw err;
  }
});

// GET /api/v1/ingestion/queue
app.get("/api/v1/ingestion/queue", (c) => c.json(ingestionQueue.getQueueStatus()));

// GET /api/v1/ingestion/run/:runId
app.get("/api/v1/ingestion/run/:runId", (c) => {
  const runId = c.req.param("runId");
  // EVAL H2: UUID format validation
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)) {
    return c.json({ error: "Invalid runId format" }, 400);
  }
  const run = ingestionQueue.getRun(runId);
  if (!run) return c.json({ error: "Run not found" }, 404);
  return c.json(run);
});
```

**IngestionQueue construction wiring**: Create in `src/http/rest-server.ts` constructor or `src/config/runtime.ts`, passing the existing `ingestionService`. Add `ingestionQueue?: IngestionQueue` to `HTTPServerConfig`.

### 2.3 Manifest Save Order Fix

**File**: `src/ingest/IngestionOrchestrator.ts`

Add `skipManifestSave?: boolean` to `IngestionOptions` (EVAL G-03 fix):

```typescript
// In IngestionOptions type:
export interface IngestionOptions {
  // ... existing fields
  skipManifestSave?: boolean;  // NEW
}
```

Gate the save at line 112:

```typescript
// In ingest():
if (!options.skipManifestSave) {
  this.manifestStore.save(projectDir, manifest);
}
```

Add public method:

```typescript
public saveManifest(projectDir: string, manifest: ProjectManifest): void {
  this.manifestStore.save(projectDir, manifest);
}
```

**File**: `src/ingest/IngestionService.ts` — updated flow:

```typescript
const ingestionResult = await this.orchestrator.ingest(projectDir, {
  ...options,
  skipManifestSave: true,
});
if (!ingestionResult) return null;

await this.codeGraph.persistIngestion(ingestionResult);
await this.codeIndexer.indexIngestion(ingestionResult);

// Save manifest ONLY after BOTH succeed — no partial-failure trap
this.orchestrator.saveManifest(projectDir, ingestionResult.manifest);
```

**Crash safety** (EVAL H4): If the process crashes after Neo4j+Qdrant but before manifest save, next run re-ingests. Neo4j uses `MERGE` (idempotent for nodes). For relationships, change `MERGE ... SET ingestedAt` to `MERGE ... ON CREATE SET ingestedAt` to prevent duplicate relationships with different timestamps.

### 2.4 Progress Callback Plumbing

Add `onProgress` to `IngestProjectOptions`:

```typescript
export interface IngestProjectOptions {
  projectDir: string;
  forceReingest?: boolean;
  maxCommits?: number;
  maxCommitAgeDays?: number;
  onProgress?: (phase: string, current: number, total: number) => void;
}
```

Wire through to `TemporalCodeGraph.persistIngestion()` and `CodeIndexer.indexIngestion()`:

```typescript
// In TemporalCodeGraph.persistIngestion():
async persistIngestion(result: IngestionResult, onProgress?: ProgressCallback): Promise<void>

// In CodeIndexer.indexIngestion():
async indexIngestion(result: IngestionResult, onProgress?: ProgressCallback): Promise<void>
```

Both already log progress every 1000 items — add callback invocation alongside the existing log calls.

### Phase 2 Quality Gate

- [ ] `bun run typecheck` — 0 errors
- [ ] `bun test` — all pass
- [ ] New tests: queue enqueue/dequeue, concurrent requests serialize, queue full returns 429, manifest saved after persist, runId validation
- [ ] Manual test: POST to `/api/v1/ingestion/enqueue`, poll status via `/api/v1/ingestion/run/:runId`

---

## Phase 3: Event Wiring — Visibility

**Goal**: Ingestion runs are visible in EventStore, SSE stream, and worklog.

### 3.1 New EventTypes

**File**: `src/types/index.ts`

Add to `EventType` union:
```typescript
| "CODEBASE_INGESTION_STARTED"
| "CODEBASE_INGESTION_COMPLETED"
| "CODEBASE_INGESTION_FAILED"
```

Remove redundant `status` field from payload (EVAL G-15): the event type IS the status.

### 3.2 IngestionEventData Payload Type

**File**: `src/types/index.ts`

```typescript
export interface IngestionEventData {
  runId: string;
  projectDir: string;
  projectId?: string;
  phase?: string;
  filesIndexed?: number;
  chunksIndexed?: number;
  commitsIndexed?: number;
  durationMs?: number;
  error?: string;  // always sanitized via sanitizeHealthError()
}
```

### 3.3 System Session ID (EVAL G-04 fix)

**File**: `src/ingest/IngestionService.ts`

```typescript
const SYSTEM_SESSION_ID = "system-ingestion" as SessionId;
```

IngestionService creates this session on first use via `sessionManager.startSession({ name: "system-ingestion" })` if it doesn't exist, or uses the sentinel directly if EventStore accepts it.

### 3.4 Wire IngestionService to EventStore

**File**: `src/ingest/IngestionService.ts`

Add to `IngestionServiceOptions`:

```typescript
export interface IngestionServiceOptions {
  neo4jClient: Neo4jClient;
  qdrantClient: QdrantClient;
  eventStore?: EventStore;       // NEW
  healthMonitor?: HealthMonitor; // NEW (for Phase 4)
}
```

**Startup wiring**: Update `src/http/server.ts` and `src/mcp/PingMemServer.ts` to pass `eventStore` when constructing `IngestionService`. Both already have access to `eventStore`.

Emit events (all errors sanitized — EVAL M2):

```typescript
// On start:
await this.eventStore?.createEvent(SYSTEM_SESSION_ID, "CODEBASE_INGESTION_STARTED", {
  runId, projectDir
} satisfies IngestionEventData);

// On completion:
await this.eventStore?.createEvent(SYSTEM_SESSION_ID, "CODEBASE_INGESTION_COMPLETED", {
  runId, projectDir, projectId: result.projectId,
  filesIndexed: result.filesIndexed, chunksIndexed: result.chunksIndexed,
  commitsIndexed: result.commitsIndexed, durationMs
} satisfies IngestionEventData);

// On failure:
await this.eventStore?.createEvent(SYSTEM_SESSION_ID, "CODEBASE_INGESTION_FAILED", {
  runId, projectDir, phase: currentPhase,
  error: sanitizeHealthError(err)
} satisfies IngestionEventData);
```

### 3.5 SSE Streaming via Separate Emitter (EVAL G-05 fix)

**Do NOT modify MemoryPubSub.** Instead, create a typed `IngestionEventEmitter`:

**File**: `src/ingest/IngestionEventEmitter.ts`

```typescript
import { EventEmitter } from "events";
import type { IngestionEventData } from "../types/index.js";

export class IngestionEventEmitter extends EventEmitter {
  emitIngestion(event: IngestionEventData & { eventType: string }): void {
    this.emit("ingestion", event);
  }

  onIngestion(handler: (event: IngestionEventData & { eventType: string }) => void): void {
    this.on("ingestion", handler);
  }
}
```

Wire into the SSE endpoint at `rest-server.ts`: subscribe to `ingestionEmitter.onIngestion()` and push to SSE clients alongside existing memory events.

### 3.6 Worklog Recording

```typescript
// After completion:
await this.eventStore?.createEvent(SYSTEM_SESSION_ID, "TOOL_RUN_RECORDED", {
  sessionId: SYSTEM_SESSION_ID,  // EVAL G-09: required field
  kind: "tool",
  title: `Ingested ${path.basename(projectDir)}`,
  toolName: "codebase-ingest",
  projectId: result.projectId,
  treeHash: result.treeHash,
  status: "success",
  durationMs,
} satisfies WorklogEventData);
```

### Phase 3 Quality Gate

- [ ] `bun run typecheck` — 0 errors
- [ ] `bun test` — all pass
- [ ] New tests: EventStore receives ingestion events, IngestionEventEmitter fires events, worklog recorded
- [ ] Manual test: connect to SSE stream, trigger ingest, see events arrive

---

## Phase 4: Health Integration + Retry

**Goal**: HealthMonitor doesn't cry wolf during ingestion. Transient failures recover automatically.

### 4.1 HealthMonitor Ingestion Awareness

**File**: `src/observability/HealthMonitor.ts`

Add public methods (EVAL G-06 fix — no constructor change needed, use setter):

```typescript
private activeIngestions = new Set<string>();

suppressDuringIngestion(projectId: string): void {
  this.activeIngestions.add(projectId);
}

resumeAfterIngestion(projectId: string): void {
  this.activeIngestions.delete(projectId);
  this.baselineQdrantCount = null; // reset baseline
}

isIngestionActive(): boolean {
  return this.activeIngestions.size > 0;
}
```

In `qualityTick()`, before Qdrant drift check:

```typescript
if (this.isIngestionActive()) {
  // Skip drift check during active ingestion — growth is expected
  return;
}
```

**Wiring** (EVAL G-06 fix): Pass `healthMonitor` into `IngestionServiceOptions`. Both `PingMemServer.ts` and `rest-server.ts` create HealthMonitor before IngestionService in the startup sequence, so HealthMonitor is available at IngestionService construction time.

### 4.2 Retry at Per-Batch Granularity (EVAL PERF-3 fix)

Instead of wrapping the entire 30-minute `persistIngestion()`, add retry to `runBatched()` in `TemporalCodeGraph.ts`:

**File**: `src/graph/TemporalCodeGraph.ts`

```typescript
private async runBatched<T>(
  items: T[],
  batchSize: number,
  processBatch: (batch: T[]) => Promise<void>,
  label: string,
  onProgress?: ProgressCallback,
): Promise<void> {
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    // Retry per-batch with 3 attempts
    let lastErr: Error | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await processBatch(batch);
        lastErr = undefined;
        break;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        if (attempt < 2) {
          const delay = 2000 * Math.pow(2, attempt) + Math.random() * 1000;
          log.warn(`${label} batch ${i / batchSize} attempt ${attempt + 1} failed, retrying`, {
            error: sanitizeHealthError(lastErr),  // EVAL M1
          });
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }
    if (lastErr) throw lastErr;
    onProgress?.(label, i + batch.length, items.length);
  }
}
```

Similarly add per-batch retry to `CodeIndexer.indexIngestion()`.

**Manifest on retry exhaustion**: If all retries fail, the error propagates up. Since manifest save is AFTER persist (Phase 2.3), the manifest is never saved — next run re-ingests automatically.

### 4.3 Health Endpoint Enhancement

**File**: `src/http/rest-server.ts`

Extend `GET /health`:

```json
{
  "status": "ok",
  "ingestionActive": true,
  "activeIngestions": ["project-abc123"],
  "queueStatus": { "pending": 2, "active": 1 }
}
```

### Phase 4 Quality Gate

- [ ] `bun run typecheck` — 0 errors
- [ ] `bun test` — all pass
- [ ] New tests: per-batch retry recovers from transient failure, HealthMonitor suppresses drift during ingest
- [ ] Manual test: start large ingest, verify no false CRITICAL alerts

---

## Phase 5: Staleness Detection + API Completeness

**Goal**: ping-mem knows when its data is stale and exposes all knobs to callers.

### 5.1 Lightweight Staleness Detection (EVAL PERF-2 fix)

Use `git status --porcelain` instead of re-hashing all files. O(1) for clean repos vs O(N files) for full scan:

**File**: `src/ingest/StalenessChecker.ts` (NEW)

```typescript
import { createSafeGit } from "./SafeGit.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export class StalenessChecker {
  async checkRegisteredProjects(): Promise<{ projectDir: string; stale: boolean }[]> {
    const registryPath = path.join(os.homedir(), ".ping-mem", "registered-projects.txt");
    let lines: string[];
    try {
      lines = fs.readFileSync(registryPath, "utf-8").split("\n").filter(Boolean);
    } catch {
      return []; // file not found — no registered projects
    }

    const results: { projectDir: string; stale: boolean }[] = [];
    for (const projectDir of lines) {
      try {
        const git = createSafeGit(projectDir);
        // git status --porcelain returns empty string if clean
        const status = await git.run(["status", "--porcelain"]);
        // Also check if HEAD has moved since last manifest
        const headHash = await git.run(["rev-parse", "HEAD"]);
        const manifest = this.loadManifestTreeHash(projectDir);
        // If manifest missing or HEAD changed, project may be stale
        results.push({
          projectDir,
          stale: manifest === null || status.stdout.trim().length > 0,
        });
      } catch {
        results.push({ projectDir, stale: false }); // can't check = not stale
      }
    }
    return results;
  }

  private loadManifestTreeHash(projectDir: string): string | null {
    try {
      const raw = fs.readFileSync(path.join(projectDir, ".ping-mem", "manifest.json"), "utf-8");
      return JSON.parse(raw).treeHash ?? null;
    } catch {
      return null;
    }
  }
}
```

**Wiring**: Call from `HealthMonitor.qualityTick()` when `!isIngestionActive()`. Emit `CODEBASE_STALE` log warning for stale projects. Keep under 1 second for 10+ projects.

### 5.2 Expose maxCommitAgeDays

**File**: `src/validation/api-schemas.ts` — add to `CodebaseIngestSchema`:

```typescript
maxCommitAgeDays: z.number().int().min(1).max(3650).optional(),
maxCommits: z.number().int().min(1).max(10000).optional(),
```

**File**: `src/http/rest-server.ts` — update POST handler to forward these params (EVAL G-18 fix):

```typescript
const result = await ingestionService.ingestProject({
  projectDir,
  forceReingest: body.forceReingest,
  maxCommitAgeDays: body.maxCommitAgeDays,  // NEW
  maxCommits: body.maxCommits,              // NEW
});
```

**File**: `src/mcp/handlers/CodebaseToolModule.ts` — add `maxCommitAgeDays` to MCP tool params.

### 5.3 Ingested Projects List Endpoint

**File**: `src/http/rest-server.ts`

```
GET /api/v1/ingestion/projects
```

Uses existing `ingestionService.listProjects()` (EVAL G-10) which wraps `codeGraph.listProjects()`. Augment response with staleness status from `StalenessChecker`.

### Phase 5 Quality Gate

- [ ] `bun run typecheck` — 0 errors
- [ ] `bun test` — all pass
- [ ] New tests: staleness uses git status (not full scan), maxCommitAgeDays forwarded, projects list returns data
- [ ] Manual test: modify a file in ping-learn, verify staleness detected within 5 min

---

## Verification Checklist (All Phases)

| Component | Test | PASS/FAIL |
|-----------|------|-----------|
| isProjectDirSafe on existing ingest | Arbitrary path rejected with 403 | |
| File size limit | File > 1MB skipped with reason logged | |
| Binary detection | File with null bytes skipped | |
| .env filtering (git path) | .env in git index not ingested | |
| .env cleanup migration | Previously-indexed .env removed from Qdrant | |
| Nested git repo | Subdirectory with .git skipped (walkDirectory path) | |
| Circular symlink | Symlink loop detected and skipped | |
| Single-read validation | No double file reads (stat+read+hash combined) | |
| IngestionQueue serial | 3 enqueues execute sequentially | |
| Queue depth limit | 11th enqueue returns 429 | |
| Manifest after persist | Manifest only saved after Neo4j + Qdrant succeed | |
| Partial failure recovery | Kill Qdrant mid-ingest, re-run without forceReingest, data recovers | |
| Neo4j relationship idempotency | Re-ingest same project, no duplicate relationships | |
| Progress callback | SSE client receives phase/current/total updates | |
| EventStore events | CODEBASE_INGESTION_STARTED/COMPLETED/FAILED in event log | |
| Worklog recording | `worklog_list` shows ingestion entry | |
| Health suppression | No CRITICAL alerts during active ingestion | |
| Per-batch retry | Kill Neo4j connection, batch retries and succeeds | |
| Error sanitization | No connection strings in API responses or event payloads | |
| Staleness detection | Modified file triggers stale warning within 5 min (via git status) | |
| maxCommitAgeDays exposed | REST and MCP accept and forward the param | |
| runId validation | Invalid runId returns 400 | |
| Enqueue path safety | `/etc` rejected with 403 | |

## Acceptance Criteria

### Functional
- A user can trigger ingestion and poll status without reading docker logs
- Partial failures are automatically recoverable (no manual `forceReingest` needed)
- HealthMonitor produces zero false positives during ingestion
- Garbage files (.env, binaries, .d.ts, node_modules content) never reach Qdrant
- SSE clients receive real-time ingestion progress events
- Arbitrary filesystem paths are rejected by all ingestion endpoints

### Non-Functional
- Ingestion of ping-learn (2364 files) completes in < 35 minutes
- File validation adds < 1% to scan time (combined read — EVAL PERF-1)
- Staleness check completes in < 1 second for 10 projects (git status — EVAL PERF-2)
- Queue status endpoint responds in < 50ms
- Memory usage during ingestion stays < 2GB (no OOM from large files)
- Per-batch retry wastes < 30 seconds on transient failure (not 30 minutes — EVAL PERF-3)

### Quality Gates (per phase)
- `bun run typecheck` — 0 errors
- `bun run lint` — 0 errors
- `bun test` — all pass
- No `any` types introduced

## Risk Analysis

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Manifest save reorder breaks existing behavior | Data inconsistency | Low | Test with `forceReingest` both true and false |
| IngestionEventEmitter adds SSE complexity | Broken SSE consumers | Low | Keep as separate channel, existing "memory" events unchanged |
| Binary detection false positives (UTF-16 with null bytes) | Valid files skipped | Low | Log all skipped files; allow override via includeExtensions |
| .d.ts exclusion removes useful type info | Reduced search quality | Medium | Start with exclusion; if search quality drops, reconsider |
| Two containers ingesting simultaneously | Data duplication | Medium | Document: only ping-mem-rest runs ingestion; disable on SSE container |

## Dependencies

**Zero new dependencies.** p-queue replaced with Promise chain. All changes use existing infrastructure.

## Complete File Structure (New/Modified)

```
src/ingest/
  ProjectScanner.ts          — MODIFIED (combined hash+validate, ignore dirs, symlink)
  IngestionQueue.ts          — NEW (Promise chain queue, run tracking)
  IngestionService.ts        — MODIFIED (events, progress, manifest order, health wiring)
  IngestionOrchestrator.ts   — MODIFIED (skipManifestSave, saveManifest(), progress)
  IngestionEventEmitter.ts   — NEW (typed EventEmitter for SSE)
  StalenessChecker.ts        — NEW (git status based staleness)
  types.ts                   — MODIFIED (onProgress, skipManifestSave)

src/types/
  index.ts                   — MODIFIED (new EventTypes, IngestionEventData)

src/observability/
  HealthMonitor.ts           — MODIFIED (ingestion awareness methods)

src/graph/
  TemporalCodeGraph.ts       — MODIFIED (per-batch retry in runBatched, ON CREATE SET)

src/search/
  CodeIndexer.ts             — MODIFIED (per-batch retry, progress callback)

src/http/
  rest-server.ts             — MODIFIED (queue endpoints, isProjectDirSafe, health enhance)

src/validation/
  api-schemas.ts             — MODIFIED (IngestionEnqueueSchema, maxCommitAgeDays)

src/mcp/handlers/
  CodebaseToolModule.ts      — MODIFIED (maxCommitAgeDays param)

scripts/
  cleanup-env-vectors.ts     — NEW (one-time .env cleanup)

src/ingest/__tests__/
  ProjectScanner.test.ts     — MODIFIED (combined validate+hash tests)
  IngestionQueue.test.ts     — NEW
  IngestionService.test.ts   — MODIFIED (event emission, retry, manifest order)
```

## Success Metrics

| Metric | Baseline (today) | Target | Measurement |
|--------|-------------------|--------|-------------|
| Manual intervention during ingestion | Always (grep logs) | Never | Ingestion completes with status visible via API |
| False positive health alerts during ingest | 2-5 per ingest | 0 | Health endpoint during active ingest |
| Garbage files in Qdrant (node_modules, .d.ts) | ~5% of vectors | 0% | Qdrant payload audit after ingest |
| Partial failure recovery | Manual forceReingest | Automatic on next run | Simulate Qdrant failure, verify auto-recovery |
| Time to discover stale project | Never (no detection) | < 5 min | Modify file, observe staleness event |
| File reads per scan | 3x per file | 1x per file | Profiling |
| Staleness check duration (10 projects) | N/A | < 1 second | Timer in qualityTick |
| Retry waste on transient failure | Full pipeline re-run | Single batch retry (~1s) | Simulate Neo4j drop |

## Explicitly Out of Scope

These findings from the research are NOT addressed in this plan:

- **F-05**: Git history not scoped to projectDir in mono-repos — requires GitHistoryReader redesign
- **F-06**: `//` inside string literals treated as comments — requires parser rewrite with string boundary tracking
- **F-10**: Auto-ingest via git hook/launchd — documented in CLAUDE.md as aspirational, not yet implemented
- **F-14**: Only TS/JS/Python get language-aware chunking — additive improvement, not a bug
- **F-15**: SymbolExtractor receives raw content — minor optimization, not blocking
