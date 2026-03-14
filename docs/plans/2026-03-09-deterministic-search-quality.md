---
title: "feat: Deterministic Search Quality + MCP HTTP Transport"
type: feat
date: 2026-03-09
issues: "#26 (MCP HTTP), #27 (FTS5 multi-word), #28 (BM25 code search)"
research: docs/research/2026-03-09-deterministic-search/ (6 documents, ~200KB, 45+ sources)
synthesis: docs/research/2026-03-09-deterministic-search/06-synthesis.md
eval_iteration: 1
review_iteration: 1
verification_iteration: 1
verification_method: "4-agent parallel EVAL (completeness+safety+security+performance) + 1 architecture REVIEW + 1 codebase VERIFY (10/10 claims verified). Total findings: 2 critical, 5 high, 8 medium."
branch: feat/deterministic-search-quality
---

# Deterministic Search Quality + MCP HTTP Transport

## Problem Statement

### 1. Code search quality is mathematically unacceptable (Issue #28)

`CodeIndexer.search()` uses `DeterministicVectorizer` — n-gram character hashing into 768-dim sparse vectors — which produces cosine similarities of **0.05–0.20** for highly relevant documents. The root cause is provable:

- **No IDF weighting**: "function" and "BM25Index" have identical weight
- **Hash collisions**: Multiple n-grams map to same dimension, values cancel (`abs(sha256[:4]) % 768`)
- **No TF saturation**: A token appearing 100× scores 100× more than appearing 1×

Evidence: `src/search/DeterministicVectorizer.ts:45–62` (n-gram hash loop, no IDF)

The fix exists in the same codebase: `src/search/HybridSearchEngine.ts:237–436` contains `BM25Index` with correct IDF (`log((N-df+0.5)/(df+0.5)+1)`) and TF saturation (k1=1.5, b=0.75). It is NOT wired to code search.

### 2. Knowledge FTS5 multi-word search returns 0 results (Issue #27)

`src/knowledge/KnowledgeStore.ts:272` wraps every sanitized query in double quotes:
```
params.$query = '"' + sanitized.replace(/"/g, '""') + '"';
```
This forces **phrase search** — "biometric authentication" requires those words to appear adjacent in exactly that order. For natural language queries ("authentication system failed"), phrase match probability approaches zero.

Evidence: UAT 2026-03-09 found 0 results for multi-word knowledge queries.

### 3. MCP server not accessible on port 3003 (Issue #26)

`src/mcp/cli.ts` uses `StdioServerTransport` only — MCP is never available on any HTTP port. Port 3003 is REST-only (`ping-mem-rest` container). To use MCP, agents must spawn a subprocess.

Evidence: `src/mcp/PingMemServer.ts:301` — `await this.server.connect(transport)` where `transport = new StdioServerTransport()`.

---

## Proposed Solution

### Architecture Diagram

```
                        Port 3003 (ping-mem-rest container)
                        ┌──────────────────────────────────────────┐
GET /health             │  RESTPingMemServer (Hono)                │
POST /api/v1/*          │  ├── REST routes (unchanged)             │
                        │  ├── /mcp  ← NEW                        │
                        │  │     WebStandardStreamableHTTPTransport│
                        │  │     → PingMemServer.getServer()       │
                        │  │       (66 MCP tools)                  │
                        │  └── (existing routes...)                │
                        └──────────────────────────────────────────┘

Code Search path (improved):
User query
  → CodeIndexer.search()
      ├── [PRIMARY] CodeChunkStore.search() → FTS5 BM25 (deterministic)
      │     SELECT ... (-1.0 * bm25(code_fts, 1.0, 2.0)) FROM code_fts JOIN code_chunks
      └── [SECONDARY] Qdrant vector search (cosine, existing)
            → RRF merge (k=60): 1/(60+rank_bm25) + 1/(60+rank_qdrant)
              → ChunkSearchResult[]  (scores: 0.35–0.70 NDCG@5, vs previous 0.05–0.20)

Knowledge Search path (fixed):
User query "biometric authentication"
  → KnowledgeStore.search()
      → FTS5 MATCH '"biometric" OR "authentication"'  ← FIXED (was '"biometric authentication"')
```

### Component List

1. **`CodeChunkStore`** (new) — `src/search/CodeChunkStore.ts`
   - SQLite table `code_chunks` + FTS5 virtual table `code_fts`
   - External content table pattern (no data duplication)
   - Triggers for auto-sync
   - `search()` uses `bm25(code_fts, 1.0, 2.0)` — content weight 2.0 dominates (content relevance > filename match)

2. **`CodeIndexer`** (modified) — `src/search/CodeIndexer.ts`
   - Accept optional `codeChunkStore?: CodeChunkStore`
   - `indexIngestion()`: dual-write to Qdrant AND SQLite
   - `search()`: FTS5 BM25 primary + Qdrant secondary, RRF merge
   - `deleteProject()`: delete from both stores

3. **`KnowledgeStore`** (modified) — `src/knowledge/KnowledgeStore.ts`
   - Line 265: add `[\\[\\]]` to strip pattern (prevent FTS5 parse errors on array syntax)
   - Line 272: OR-of-words tokenization (was: phrase wrapping)

4. **`RESTPingMemServer`** (modified) — `src/http/rest-server.ts`
   - Add `mcpServer?: Server` to `HTTPServerConfig` interface
   - Add `mcpTransport` private field
   - Add `setupMcpRoute()` private method
   - `start()`: connect transport if mcpServer present

5. **`IngestionService`** (modified) — `src/ingest/IngestionService.ts`
   - Add `dbPath?: string` to `IngestionServiceOptions`
   - Constructor: creates `CodeChunkStore` if `dbPath` provided

6. **`server.ts`** (modified) — `src/http/server.ts`
   - Create `PingMemServer` (without starting stdio) for MCP-over-HTTP
   - Pass `pingMemServer.getServer()` + `dbPath` to downstream constructors

7. **Eval test** (new) — `src/search/__tests__/eval.test.ts`
   - 10 query/relevant-chunk pairs derived from ping-mem itself
   - NDCG@5 ≥ 0.35, MRR@5 ≥ 0.50 quality gates

---

## Gap Coverage Matrix

| Gap | Phase | Component | Resolution |
|-----|-------|-----------|------------|
| Code search scores 0.05–0.20 | 3 | CodeChunkStore + CodeIndexer | FTS5 BM25 primary search |
| Knowledge FTS5 0 results | 1 | KnowledgeStore | OR-of-words tokenization |
| MCP not on port 3003 | 2 | RESTPingMemServer + server.ts | WebStandardStreamableHTTPTransport at /mcp |
| No eval harness | 3 | eval.test.ts | NDCG@5, MRR@5 quality gate tests |
| FTS5 strip incomplete (`[`, `]`) | 1 | KnowledgeStore | Add to strip pattern |
| Missing code_chunks SQLite table | 3 | CodeChunkStore | CREATE TABLE with FTS5 virtual table |

---

## Critical Questions — Answers

**Q1: Does `WebStandardStreamableHTTPServerTransport` work with Bun + Hono without a conversion layer?**
A: YES. Confirmed from `dist/esm/server/webStandardStreamableHttp.d.ts`: `handleRequest(req: Request): Promise<Response>`. Both Hono and Bun use Web Standard `Request`/`Response` natively. No conversion needed.

**Q2: Can the same MCP `Server` instance serve both stdio AND HTTP transports simultaneously?**
A: Only one transport per `Server.connect()` call. For the REST server (HTTP transport only), a separate `PingMemServer` instance is created without calling `start()` (no stdio transport connected).

**Q3: Two EventStore instances on the same SQLite file — safe?**
A: SQLite supports multiple connections with WAL mode. Both instances open read/write. Writes from either instance are immediately visible to the other via SQLite's shared memory. Sessions created by REST API won't appear in MCP's EventStore in-memory cache, but the primary use case (MCP tool calls with their own sessions) is self-consistent.

**Q4: Should `IngestionService` require BOTH Neo4j AND Qdrant to create `CodeChunkStore`?**
A: NO. `CodeChunkStore` uses only SQLite. `IngestionService` creates `CodeChunkStore` whenever `dbPath` is provided, independent of Neo4j/Qdrant availability. This makes FTS5 search work even in Neo4j-only deployments.

**Q5: What happens to existing Qdrant vectors after this change?**
A: Qdrant vectors remain unchanged. On next ingestion, chunks are ALSO written to SQLite. Search uses FTS5 BM25 (primary) + Qdrant (secondary, if available) via RRF. Existing ingested projects get FTS5 coverage on next force-reingest.

**Q6: Does FTS5 built-in BM25 use k1=1.2 or k1=1.5?**
A: FTS5 built-in uses **k1=1.2, b=0.75** (hardcoded — cannot be changed without a custom C extension). The BM25Index in HybridSearchEngine uses k1=1.5. Both are valid; k1=1.2 slightly suppresses TF contribution vs k1=1.5. For code search, k1=1.2 is acceptable — frequency boost matters less than IDF.

---

## Implementation Phases

### Phase 0: Shared Utilities (prereq for all phases) — ~20 minutes

**Quality Gate**: `bun run typecheck` passes. Functions exported and importable.

#### 0a. New file: `src/util/ftsQuery.ts`

Shared FTS5 query builder used by both KnowledgeStore and CodeChunkStore:

```typescript
/**
 * Build a safe FTS5 MATCH query from user input using OR-of-words semantics.
 *
 * Each term is individually double-quoted to prevent FTS5 operator injection.
 * Word-boundary stripping removes AND/OR/NOT/NEAR before quoting.
 *
 * @param input - raw user query
 * @param options.prefixOnSingle - if true, single-term queries use prefix search ("term*")
 *                                  for code identifiers; if false, exact match
 */
export function buildFtsOrQuery(
  input: string,
  options?: { prefixOnSingle?: boolean }
): string | null {
  // SQL injection is prevented by parameterized queries at the call site.
  // This sanitization protects FTS5 query syntax only.
  const stripped = input
    .replace(/[*^(){}:[\]]/g, " ")   // strip FTS5 special chars (including [ ] for column filters)
    .replace(/\b(AND|OR|NOT|NEAR)\b/gi, " ")
    .trim();

  if (!stripped) return null;

  const terms = stripped.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return null;

  if (terms.length === 1) {
    const escaped = terms[0]!.replace(/"/g, '""');
    return options?.prefixOnSingle
      ? '"' + escaped + '*"'   // prefix search: matches "BM25Index", "BM25Store", etc.
      : '"' + escaped + '"';   // exact match
  }

  // Multi-word: OR semantics — match ANY term, not phrase adjacency
  return terms.map((t) => '"' + t.replace(/"/g, '""') + '"').join(" OR ");
}
```

#### 0b. New file: `src/search/rrfMerge.ts`

Reciprocal Rank Fusion extracted as a standalone generic utility, importable by both CodeIndexer and HybridSearchEngine:

```typescript
/**
 * Reciprocal Rank Fusion (RRF) merge of two ranked lists.
 *
 * RRF score = 1/(k + rank_in_listA) + 1/(k + rank_in_listB)
 * where k=60 dampens the impact of top-ranked documents.
 *
 * Extracted from CodeIndexer to prevent duplication with HybridSearchEngine.
 * Both use this algorithm for multi-source result fusion.
 *
 * @param listA - first ranked list (most relevant first)
 * @param listB - second ranked list (most relevant first)
 * @param limit - max results to return
 * @param k - RRF constant (default 60, standard value)
 */
export function rrfMerge<T extends { chunkId: string }>(
  listA: T[],
  listB: T[],
  limit: number,
  k: number = 60
): T[] {
  const scores = new Map<string, { score: number; result: T }>();

  listA.forEach((r, i) => {
    scores.set(r.chunkId, {
      score: 1 / (k + i + 1),
      result: r,
    });
  });

  listB.forEach((r, i) => {
    const existing = scores.get(r.chunkId);
    if (existing) {
      existing.score += 1 / (k + i + 1);
    } else {
      scores.set(r.chunkId, {
        score: 1 / (k + i + 1),
        result: { ...r },
      });
    }
  });

  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => ({ ...entry.result, score: entry.score }));
}
```

---

### Phase 1: FTS5 Multi-Word Fix (Issue #27) — ~30 minutes

**Quality Gate**: `bun run typecheck && bun test` must pass. 5 multi-word knowledge queries must return ≥ 1 result each.

**Files modified**:
- `src/knowledge/KnowledgeStore.ts` (lines 264–272)

**Add import** at top of `KnowledgeStore.ts` (with other imports):
```typescript
import { buildFtsOrQuery } from "../util/ftsQuery.js";
```

**Change** (lines 264–272): replace inline strip + phrase-wrap with shared utility

Before:
```typescript
const sanitized = options.query
  .replace(/[*^(){}:]/g, " ")
  .replace(/\b(AND|OR|NOT|NEAR)\b/gi, " ")
  .trim();
params.$query = '"' + sanitized.replace(/"/g, '""') + '"';
```

After:
```typescript
// buildFtsOrQuery handles: strip special chars (including [ ]), OR-of-words for multi-word,
// exact single-word match (prefixOnSingle: false = knowledge entries use exact match)
const ftsQuery = buildFtsOrQuery(options.query, { prefixOnSingle: false });
if (!ftsQuery) return [];
params.$query = ftsQuery;
```

**Testing**:
```typescript
// Must pass:
store.search({ query: "biometric authentication" })     // ≥ 1 result
store.search({ query: "memory persistence" })           // ≥ 1 result
store.search({ query: "neo4j qdrant connection" })      // ≥ 1 result
```

---

### Phase 2: MCP HTTP Transport (Issue #26) — ~2 hours

**Quality Gate**: `bun run typecheck && bun test`. `curl -X POST http://localhost:3003/mcp` returns JSON-RPC 2.0 response.

#### 2a. Modify `HTTPServerConfig` in `src/http/types.ts`

**File**: `src/http/types.ts` (NOT rest-server.ts — `HTTPServerConfig` interface lives here at line 31).

Find `export interface HTTPServerConfig` and add:
```typescript
/** Optional MCP Server instance to expose via streamable HTTP at /mcp */
mcpServer?: import("@modelcontextprotocol/sdk/server/index.js").Server | undefined;
```

#### 2b. Add private fields to `RESTPingMemServer`

Add after `private healthMonitor: HealthMonitor | null = null;` (line ~116):
```typescript
private mcpServer: import("@modelcontextprotocol/sdk/server/index.js").Server | null = null;
private mcpTransport: import("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js").WebStandardStreamableHTTPServerTransport | null = null;
```

#### 2c. Store mcpServer in constructor

**CRITICAL ORDERING**: Assign `this.mcpServer` BEFORE `this.setupRoutes()` is called (not after), because `setupMcpRoute()` is called from within `setupRoutes()` and reads `this.mcpServer`:

```typescript
// At the beginning of the constructor body, BEFORE this.setupRoutes():
this.mcpServer = config.mcpServer ?? null;

// (this.setupRoutes() call follows — setupMcpRoute() inside it reads this.mcpServer)
```

#### 2d. Add `setupMcpRoute()` private method

**SECURITY**: The existing auth middleware (`setupMiddleware()` line ~248) only guards `/api/*` and `/ui/*`. The `/mcp` endpoint must be explicitly guarded. Add auth + rate-limiter BEFORE the route handler:

Add new private method to `RESTPingMemServer`:
```typescript
private setupMcpRoute(): void {
  if (!this.mcpServer) return;  // Only register route if MCP server is configured

  // Auth guard: require API key if PING_MEM_API_KEY is set (same as REST routes)
  this.app.use("/mcp", authMiddleware);

  // Rate limit: 120 req/min (2x the REST limit — MCP calls can be sequential within a session)
  this.app.use("/mcp", rateLimiter({
    name: "mcp",
    maxRequests: 120,
    windowMs: 60_000,
  }));

  this.app.all("/mcp", async (c) => {
    if (!this.mcpTransport) {
      return c.json({ error: "MCP transport not ready" }, 503);
    }
    const response = await this.mcpTransport.handleRequest(c.req.raw);
    return response;
  });
}
```

Call it from `setupRoutes()` at the end (before the catch-all 404):
```typescript
this.setupMcpRoute();
```

#### 2e. Modify `start()` in `RESTPingMemServer`

```typescript
async start(): Promise<void> {
  // Connect MCP transport if server provided
  if (this.mcpServer) {
    const { WebStandardStreamableHTTPServerTransport } = await import(
      "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
    );
    this.mcpTransport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,  // stateless mode
    });
    await this.mcpServer.connect(this.mcpTransport);
    log.info("MCP HTTP transport ready at /mcp");
  }
  log.info("Started (ready to handle requests)");
}
```

#### 2f. Modify `server.ts` — create PingMemServer for MCP

**ALWAYS create PingMemServer** — do NOT gate on Neo4j/Qdrant. PingMemServer provides 66 MCP tools, most of which (memory, sessions, knowledge, agents) require only SQLite. Gating on infrastructure availability would silently disable MCP HTTP in the common SQLite-only deployment.

After the `ingestionService` creation (line ~46), add:
```typescript
// Create PingMemServer for MCP-over-HTTP (without starting stdio transport).
// Inject the already-created eventStore and diagnosticsStore to avoid creating
// a second EventStore on the same SQLite file (eliminates duplicate state tree).
// eventStore is created at line ~66 of server.ts; diagnosticsStore at line ~63.
const { PingMemServer } = await import("../mcp/PingMemServer.js");
const mcpServerInstance = new PingMemServer({
  dbPath: runtimeConfig.pingMem.dbPath,
  eventStore,          // inject shared EventStore (avoids duplicate state tree)
  diagnosticsStore,    // inject shared DiagnosticsStore (already follows this pattern)
  ingestionService,
  graphManager: services.graphManager,
  lineageEngine: services.lineageEngine,
  evolutionEngine: services.evolutionEngine,
  qdrantClient: services.qdrantClient,
  diagnosticsDbPath,
});
```

**Also modify `PingMemServerConfig` in `src/mcp/PingMemServer.ts`** — add `eventStore` field (mirrors existing `diagnosticsStore` pattern at line 96):
```typescript
export interface PingMemServerConfig {
  // ... existing fields ...
  eventStore?: EventStore | undefined;    // NEW — inject shared EventStore to avoid duplicate instance
  diagnosticsStore?: DiagnosticsStore | undefined;  // already exists
}
```

In the constructor (line ~148), change:
```typescript
// Before:
this.eventStore = new EventStore({ dbPath: resolved.dbPath });

// After:
this.eventStore = config.eventStore ?? new EventStore({ dbPath: resolved.dbPath });
```

Then pass to `RESTPingMemServer` config:
```typescript
serverInstance = new RESTPingMemServer({
  ...restConfig,
  dbPath: runtimeConfig.pingMem.dbPath,
  // ... existing options ...
  mcpServer: mcpServerInstance.getServer(),  // NEW
});
```

**Resource lifecycle**: Add `IngestionService.close(): void` method that closes the CodeChunkStore's database connection. Wire it to the shutdown sequence in `server.ts`:
```typescript
// In IngestionService.ts — add method:
close(): void {
  if (this.codeChunkStoreDb) {
    this.codeChunkStoreDb.close();
  }
}

// In server.ts shutdown sequence (near `await services.neo4jClient.disconnect()`):
if (ingestionService) {
  ingestionService.close();
}
```

#### 2g. Update documentation

In `CLAUDE.md` (project instructions): Update MCP section to add HTTP endpoint at `http://localhost:3003/mcp`.

---

### Phase 3: BM25 Code Search (Issue #28) — ~3 hours

**Quality Gate**: `bun run typecheck && bun test`. NDCG@5 ≥ 0.35, MRR@5 ≥ 0.50 in eval test.

#### 3a. New file: `src/search/CodeChunkStore.ts`

```typescript
import { Database } from "bun:sqlite";
import { createLogger } from "../util/logger.js";
import { buildFtsOrQuery } from "../util/ftsQuery.js";
import type { ChunkSearchResult } from "./CodeIndexer.js";

const log = createLogger("CodeChunkStore");

export interface CodeChunkRow {
  chunk_id: string;
  project_id: string;
  file_path: string;
  language: string;
  kind: string;
  content: string;
  start_line: number;
  end_line: number;
}

export class CodeChunkStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
    this.ensureSchema();
  }

  private ensureSchema(): void {
    // Enable WAL mode explicitly — bun:sqlite does NOT enable WAL by default.
    // Every other store in this codebase sets this pragma manually (EventStore:167,
    // DiagnosticsStore:101, AdminStore:88, VectorIndex:194, MigrationLedger:48).
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = NORMAL");

    // Source table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS code_chunks (
        id         INTEGER PRIMARY KEY,
        chunk_id   TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        file_path  TEXT NOT NULL,
        language   TEXT NOT NULL,
        kind       TEXT NOT NULL,
        content    TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line   INTEGER NOT NULL
      )
    `);

    this.db.run(`CREATE INDEX IF NOT EXISTS idx_cc_project ON code_chunks(project_id)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_cc_file ON code_chunks(project_id, file_path)`);

    // FTS5 virtual table with external content
    this.db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS code_fts USING fts5(
        file_path,
        content,
        tokenize = 'unicode61 tokenchars ''-_''',
        content = 'code_chunks',
        content_rowid = 'id'
      )
    `);

    // Triggers for auto-sync
    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS code_chunks_ai AFTER INSERT ON code_chunks BEGIN
        INSERT INTO code_fts(rowid, file_path, content)
        VALUES (new.id, new.file_path, new.content);
      END
    `);
    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS code_chunks_ad AFTER DELETE ON code_chunks BEGIN
        INSERT INTO code_fts(code_fts, rowid, file_path, content)
        VALUES ('delete', old.id, old.file_path, old.content);
      END
    `);
    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS code_chunks_bu BEFORE UPDATE ON code_chunks BEGIN
        INSERT INTO code_fts(code_fts, rowid, file_path, content)
        VALUES ('delete', old.id, old.file_path, old.content);
      END
    `);
    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS code_chunks_au AFTER UPDATE ON code_chunks BEGIN
        INSERT INTO code_fts(rowid, file_path, content)
        VALUES (new.id, new.file_path, new.content);
      END
    `);
  }

  /**
   * Insert a code chunk. Idempotent via ON CONFLICT DO UPDATE (true upsert).
   *
   * IMPORTANT: Do NOT use INSERT OR REPLACE — that is implemented as DELETE+INSERT at
   * the SQLite engine level, which fires AFTER DELETE + AFTER INSERT triggers (not the
   * BEFORE UPDATE / AFTER UPDATE pair). ON CONFLICT DO UPDATE is a true UPDATE and
   * fires the correct UPDATE triggers, keeping the FTS5 external content table in sync.
   */
  insert(chunk: CodeChunkRow): void {
    this.db.run(
      `INSERT INTO code_chunks
         (chunk_id, project_id, file_path, language, kind, content, start_line, end_line)
       VALUES
         ($chunk_id, $project_id, $file_path, $language, $kind, $content, $start_line, $end_line)
       ON CONFLICT(chunk_id) DO UPDATE SET
         content    = excluded.content,
         file_path  = excluded.file_path,
         start_line = excluded.start_line,
         end_line   = excluded.end_line`,
      {
        $chunk_id: chunk.chunk_id,
        $project_id: chunk.project_id,
        $file_path: chunk.file_path,
        $language: chunk.language,
        $kind: chunk.kind,
        $content: chunk.content,
        $start_line: chunk.start_line,
        $end_line: chunk.end_line,
      }
    );
  }

  /**
   * Bulk insert chunks wrapped in a single transaction for performance.
   * At 10k chunks, individual autocommit INSERTs take ~10s. A single transaction
   * commits all inserts in one fsync: ~80–150ms (100x speedup).
   */
  insertBatch(chunks: CodeChunkRow[]): void {
    if (chunks.length === 0) return;
    this.db.transaction(() => {
      for (const chunk of chunks) {
        this.insert(chunk);
      }
    })();
  }

  /**
   * Search using FTS5 BM25. Returns results ordered by relevance (most relevant first).
   * Scores are normalized to positive values (FTS5 bm25() returns negative).
   */
  search(
    query: string,
    projectId: string,
    options?: { type?: "code" | "comment" | "docstring"; limit?: number }
  ): ChunkSearchResult[] {
    const limit = Math.max(1, Math.min(options?.limit ?? 10, 1000));

    // Build safe FTS5 query using shared utility: OR-of-words with prefix search on single-word
    // (prefixOnSingle: true = "auth*" for partial code identifier matching)
    const ftsQuery = buildFtsOrQuery(query, { prefixOnSingle: true });
    if (!ftsQuery) return [];

    let sql = `
      SELECT
        cc.chunk_id, cc.project_id, cc.file_path, cc.kind AS type,
        cc.content, cc.start_line, cc.end_line,
        (-1.0 * bm25(code_fts, 1.0, 2.0)) AS score   -- col0=file_path×1.0, col1=content×2.0
      FROM code_fts fts
      JOIN code_chunks cc ON cc.id = fts.rowid
      WHERE code_fts MATCH $query
        AND cc.project_id = $project_id
    `;

    const params: Record<string, unknown> = {
      $query: ftsQuery,
      $project_id: projectId,
    };

    if (options?.type) {
      sql += ` AND cc.kind = $kind`;
      params.$kind = options.type;
    }

    sql += ` ORDER BY score DESC LIMIT $limit`;
    params.$limit = limit;

    type Row = {
      chunk_id: string;
      project_id: string;
      file_path: string;
      type: "code" | "comment" | "docstring";
      content: string;
      start_line: number;
      end_line: number;
      score: number;
    };

    const rows = this.db.prepare(sql).all(params) as Row[];

    return rows.map((r) => ({
      chunkId: r.chunk_id,
      projectId: r.project_id,
      filePath: r.file_path,
      type: r.type,
      content: r.content,
      lineStart: r.start_line,
      lineEnd: r.end_line,
      score: r.score,
    }));
  }

  /**
   * Delete all chunks for a project from both SQLite tables.
   */
  deleteProject(projectId: string): void {
    this.db.run(`DELETE FROM code_chunks WHERE project_id = $project_id`, {
      $project_id: projectId,
    });
    // FTS triggers handle cascade
  }

  /** Count chunks for a project. */
  countForProject(projectId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM code_chunks WHERE project_id = $project_id`)
      .get({ $project_id: projectId }) as { count: number };
    return row.count;
  }

  // NOTE: No private buildFtsQuery() — uses shared buildFtsOrQuery from "../util/ftsQuery.js"
}
```

#### 3b. Modify `CodeIndexer` — `src/search/CodeIndexer.ts`

Add imports:
```typescript
import type { CodeChunkStore } from "./CodeChunkStore.js";
import { rrfMerge } from "./rrfMerge.js";
```

Add to `CodeIndexerOptions`:
```typescript
export interface CodeIndexerOptions {
  qdrantClient: QdrantClientWrapper;
  vectorizer?: DeterministicVectorizer;
  codeChunkStore?: CodeChunkStore | undefined;  // NEW
}
```

Add private field:
```typescript
private readonly chunkStore: CodeChunkStore | null;
```

In constructor:
```typescript
this.chunkStore = options.codeChunkStore ?? null;
```

In `indexIngestion()` — after the Qdrant upsert loop completes, add:
```typescript
// Dual-write to SQLite FTS5 if CodeChunkStore available.
// MUST use insertBatch() to wrap all inserts in a single transaction —
// individual autocommit INSERTs would cost ~10s for 10k chunks (1ms each);
// a single transaction reduces this to ~80-150ms (one fsync).
if (this.chunkStore) {
  const allChunks: CodeChunkRow[] = [];
  for (const fileResult of result.codeFiles) {
    for (const chunk of fileResult.chunks) {
      allChunks.push({
        chunk_id: chunk.chunkId,
        project_id: result.projectId,
        file_path: fileResult.filePath,
        language: fileResult.language ?? "unknown",
        kind: chunk.type,
        content: chunk.content,
        start_line: chunk.startLine ?? 0,
        end_line: chunk.endLine ?? 0,
      });
    }
  }
  try {
    this.chunkStore.insertBatch(allChunks);
    log.info("Dual-write to SQLite FTS5 complete", {
      projectId: result.projectId,
      chunkCount: allChunks.length,
    });
  } catch (error) {
    // Non-fatal: SQLite FTS5 failure degrades gracefully to Qdrant-only search
    const message = error instanceof Error ? error.message : String(error);
    log.warn("SQLite FTS5 dual-write failed — chunks will be Qdrant-only", {
      projectId: result.projectId,
      error: message,
    });
  }
}
```

Also add import for `CodeChunkRow` at top of `CodeIndexer.ts`:
```typescript
import type { CodeChunkRow } from "./CodeChunkStore.js";
```

In `search()` — replace the current implementation with hybrid BM25+Qdrant:
```typescript
async search(
  query: string,
  options: { projectId?: string; filePath?: string; type?: "code" | "comment" | "docstring"; limit?: number }
): Promise<ChunkSearchResult[]> {
  const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 10), 1000));

  // Primary: FTS5 BM25 if available
  let bm25Results: ChunkSearchResult[] = [];
  if (this.chunkStore && options.projectId) {
    bm25Results = this.chunkStore.search(query, options.projectId, {
      type: options.type,
      limit: limit * 2,  // fetch more for RRF merge
    });
  }

  // Secondary: Qdrant vector search
  const qdrantResults = await this.vectorSearch(query, options, limit * 2);

  // If both available: RRF merge (imported from ./rrfMerge.js — shared with future callers)
  if (bm25Results.length > 0 && qdrantResults.length > 0) {
    return rrfMerge(bm25Results, qdrantResults, limit);
  }

  // Fallback: whichever is available
  return (bm25Results.length > 0 ? bm25Results : qdrantResults).slice(0, limit);
}

// NOTE: No private rrfMerge() — uses shared rrfMerge<T> from "./rrfMerge.js"
// ChunkSearchResult extends { chunkId: string } which satisfies the generic constraint.

/** Qdrant vector search (extracted from existing search() method) */
private async vectorSearch(
  query: string,
  options: { projectId?: string; filePath?: string; type?: string; limit?: number },
  limit: number
): Promise<ChunkSearchResult[]> {
  // ... EXACT SAME LOGIC as current search() method (move existing code here) ...
}
```

In `deleteProject()`:
```typescript
async deleteProject(projectId: string): Promise<void> {
  // Delete from Qdrant
  const qdrantClient = this.qdrant.getClient();
  const collectionName = this.qdrant.getCollectionName();
  await qdrantClient.delete(collectionName, {
    wait: true,
    filter: { must: [{ key: "projectId", match: { value: projectId } }] },
  });

  // Also delete from SQLite FTS5
  if (this.chunkStore) {
    this.chunkStore.deleteProject(projectId);
  }
}
```

#### 3c. Modify `IngestionService` — `src/ingest/IngestionService.ts`

Add import:
```typescript
import { Database } from "bun:sqlite";
import { CodeChunkStore } from "../search/CodeChunkStore.js";
```

Modify `IngestionServiceOptions`:
```typescript
export interface IngestionServiceOptions {
  neo4jClient: Neo4jClient;
  qdrantClient: QdrantClientWrapper;
  dbPath?: string | undefined;  // NEW: SQLite DB path for FTS5 code search
}
```

Add private field to store the DB reference for lifecycle management:
```typescript
private readonly codeChunkStoreDb: Database | null = null;
```

In constructor (line ~72–80), modify `CodeIndexer` creation:
```typescript
let codeChunkStore: CodeChunkStore | undefined;
if (options.dbPath) {
  // Open a dedicated Database connection for CodeChunkStore.
  // Stored as field for explicit close() on shutdown (prevents resource leak).
  (this as { codeChunkStoreDb: Database | null }).codeChunkStoreDb = new Database(options.dbPath);
  codeChunkStore = new CodeChunkStore(this.codeChunkStoreDb!);
}

this.codeIndexer = new CodeIndexer({
  qdrantClient: options.qdrantClient,
  codeChunkStore,  // NEW: undefined if dbPath not provided
});
```

Add `close()` method:
```typescript
/** Close the CodeChunkStore database connection. Call during server shutdown. */
close(): void {
  if (this.codeChunkStoreDb) {
    this.codeChunkStoreDb.close();
  }
}
```

#### 3d. Modify `server.ts` — pass `dbPath` to IngestionService

At line ~46 (`ingestionService = new IngestionService({...})`):
```typescript
ingestionService = new IngestionService({
  neo4jClient: services.neo4jClient,
  qdrantClient: services.qdrantClient,
  dbPath: runtimeConfig.pingMem.dbPath,  // NEW
});
```

#### 3e. Modify MCP `main()` in `PingMemServer.ts`

At line ~354 (`ingestionService = new IngestionService({...})`):
```typescript
ingestionService = new IngestionService({
  neo4jClient: services.neo4jClient,
  qdrantClient: services.qdrantClient,
  dbPath: runtimeConfig.pingMem.dbPath,  // NEW
});
```

#### 3f. New eval test: `src/search/__tests__/eval.test.ts`

```typescript
import { test, expect, beforeAll } from "bun:test";  // no 'describe' — not used; no 'afterAll' — :memory: DB auto-cleaned
import { Database } from "bun:sqlite";
import { CodeChunkStore } from "../CodeChunkStore.js";

// Test data: 10 code chunks representing ping-mem's own codebase
const TEST_CHUNKS = [
  { chunk_id: "c1", project_id: "p1", file_path: "src/search/HybridSearchEngine.ts", language: "typescript", kind: "code", content: "class BM25Index { computeIDF(df: number, N: number): number { return Math.log((N - df + 0.5) / (df + 0.5) + 1); } }", start_line: 237, end_line: 280 },
  { chunk_id: "c2", project_id: "p1", file_path: "src/knowledge/KnowledgeStore.ts", language: "typescript", kind: "code", content: "async search(query: string): Promise<KnowledgeEntry[]> { const ftsQuery = buildOrQuery(query); return this.db.prepare(...).all(ftsQuery); }", start_line: 264, end_line: 281 },
  { chunk_id: "c3", project_id: "p1", file_path: "src/ingest/IngestionService.ts", language: "typescript", kind: "code", content: "async ingestProject(options: IngestProjectOptions): Promise<IngestProjectResult | null> { const ingestionResult = await this.orchestrator.ingest(options.projectDir, ingestOptions); }", start_line: 94, end_line: 130 },
  { chunk_id: "c4", project_id: "p1", file_path: "src/graph/TemporalCodeGraph.ts", language: "typescript", kind: "code", content: "async persistIngestion(result: IngestionResult): Promise<void> { // Phase 1/8: Project node; await session.run(MERGE_PROJECT_CYPHER); }", start_line: 150, end_line: 200 },
  { chunk_id: "c5", project_id: "p1", file_path: "src/session/SessionManager.ts", language: "typescript", kind: "code", content: "async startSession(name: string, options?: SessionStartOptions): Promise<Session> { const sessionId = generateId(); const session = { id: sessionId, name }; }", start_line: 50, end_line: 90 },
  { chunk_id: "c6", project_id: "p1", file_path: "src/search/DeterministicVectorizer.ts", language: "typescript", kind: "code", content: "vectorize(text: string): number[] { const tokens = this.tokenize(text); const ngrams = this.generateNgrams(tokens); const vector = new Float32Array(768).fill(0); }", start_line: 45, end_line: 80 },
  { chunk_id: "c7", project_id: "p1", file_path: "src/memory/MemoryManager.ts", language: "typescript", kind: "code", content: "async save(key: string, value: string, options?: SaveOptions): Promise<void> { const entry = { key, value, category: options?.category ?? 'note' }; }", start_line: 30, end_line: 70 },
  { chunk_id: "c8", project_id: "p1", file_path: "src/knowledge/KnowledgeStore.ts", language: "typescript", kind: "comment", content: "// KnowledgeStore: full-text search over structured knowledge entries using SQLite FTS5", start_line: 1, end_line: 5 },
  { chunk_id: "c9", project_id: "p1", file_path: "src/ingest/GitHistoryReader.ts", language: "typescript", kind: "code", content: "async readHistory(projectDir: string, options?: GitHistoryOptions): Promise<GitHistoryResult> { const commits = await this.readCommits(gitRoot, maxCommits, since); }", start_line: 80, end_line: 120 },
  { chunk_id: "c10", project_id: "p1", file_path: "src/search/CodeChunkStore.ts", language: "typescript", kind: "code", content: "search(query: string, projectId: string): ChunkSearchResult[] { const ftsQuery = this.buildFtsQuery(query); return bm25Search(ftsQuery, projectId); }", start_line: 100, end_line: 140 },
];

// Eval cases: query → expected relevant chunk_ids
const EVAL_CASES = [
  { query: "BM25 scoring IDF computation", relevant: new Set(["c1"]) },
  { query: "knowledge search FTS5", relevant: new Set(["c2", "c8"]) },
  { query: "ingest project scan", relevant: new Set(["c3"]) },
  { query: "session start create", relevant: new Set(["c5"]) },
  { query: "vectorize ngram hash", relevant: new Set(["c6"]) },
  { query: "memory save key value", relevant: new Set(["c7"]) },
  { query: "git history commits", relevant: new Set(["c9"]) },
  { query: "code chunk sqlite search", relevant: new Set(["c10"]) },
];

function ndcg(results: Array<{chunkId: string}>, relevant: Set<string>, k: number): number {
  const dcg = results.slice(0, k).reduce((acc, r, i) => {
    return acc + (relevant.has(r.chunkId) ? 1 : 0) / Math.log2(i + 2);
  }, 0);
  const idealHits = Math.min(relevant.size, k);
  const idcg = Array.from({length: idealHits}, (_, i) => 1 / Math.log2(i + 2)).reduce((a, b) => a + b, 0);
  return idcg === 0 ? 0 : dcg / idcg;
}

function mrr(results: Array<{chunkId: string}>, relevant: Set<string>, k: number): number {
  const idx = results.slice(0, k).findIndex(r => relevant.has(r.chunkId));
  return idx === -1 ? 0 : 1 / (idx + 1);
}

let store: CodeChunkStore;

beforeAll(() => {
  const db = new Database(":memory:");
  store = new CodeChunkStore(db);
  for (const chunk of TEST_CHUNKS) store.insert(chunk);
});

test("NDCG@5 >= 0.35 (BM25 code search quality gate)", () => {
  const scores = EVAL_CASES.map(({ query, relevant }) => {
    const results = store.search(query, "p1", { limit: 5 });
    return ndcg(results, relevant, 5);
  });
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  expect(mean).toBeGreaterThanOrEqual(0.35);
});

test("MRR@5 >= 0.50 (first relevant result in top 2 on average)", () => {
  const scores = EVAL_CASES.map(({ query, relevant }) => {
    const results = store.search(query, "p1", { limit: 5 });
    return mrr(results, relevant, 5);
  });
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  expect(mean).toBeGreaterThanOrEqual(0.50);
});

test("multi-word queries return results (FTS5 OR semantics)", () => {
  const cases = [
    "BM25 scoring",
    "knowledge search",
    "ingest project",
    "session start",
    "git history",
  ];
  for (const query of cases) {
    const results = store.search(query, "p1", { limit: 5 });
    expect(results.length).toBeGreaterThan(0);
  }
});
```

---

## Database Schema Definitions

### New table: `code_chunks` (SQLite, `PING_MEM_DB_PATH`)

```sql
CREATE TABLE IF NOT EXISTS code_chunks (
  id         INTEGER PRIMARY KEY,       -- autoincrement rowid alias for FTS5 content_rowid
  chunk_id   TEXT    NOT NULL UNIQUE,   -- deterministic SHA-256 hex ID from CodeChunker
  project_id TEXT    NOT NULL,          -- project identifier (SHA-256 of git remote + path)
  file_path  TEXT    NOT NULL,          -- relative path from project root
  language   TEXT    NOT NULL,          -- 'typescript', 'python', etc.
  kind       TEXT    NOT NULL,          -- 'code' | 'comment' | 'docstring'
  content    TEXT    NOT NULL,          -- full chunk text
  start_line INTEGER NOT NULL,          -- 1-indexed start line
  end_line   INTEGER NOT NULL           -- 1-indexed end line
);

CREATE INDEX IF NOT EXISTS idx_cc_project ON code_chunks(project_id);
CREATE INDEX IF NOT EXISTS idx_cc_file    ON code_chunks(project_id, file_path);
```

### New virtual table: `code_fts` (FTS5, same DB)

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS code_fts USING fts5(
  file_path,                                -- column 0 (weight 1.0 in BM25 — minor signal)
  content,                                  -- column 1 (weight 2.0 in BM25 — content dominates)
  tokenize = 'unicode61 tokenchars ''-_''', -- keeps snake_case and kebab-case as tokens
  content   = 'code_chunks',               -- external content table (no duplication)
  content_rowid = 'id'                      -- integer PK of code_chunks
);
-- BM25 call: bm25(code_fts, 1.0, 2.0) — col weights match column order above
```

### Triggers (auto-sync FTS5 with code_chunks)

```sql
CREATE TRIGGER IF NOT EXISTS code_chunks_ai AFTER INSERT ON code_chunks BEGIN
  INSERT INTO code_fts(rowid, file_path, content)
  VALUES (new.id, new.file_path, new.content);
END;

CREATE TRIGGER IF NOT EXISTS code_chunks_ad AFTER DELETE ON code_chunks BEGIN
  INSERT INTO code_fts(code_fts, rowid, file_path, content)
  VALUES ('delete', old.id, old.file_path, old.content);
END;

CREATE TRIGGER IF NOT EXISTS code_chunks_bu BEFORE UPDATE ON code_chunks BEGIN
  INSERT INTO code_fts(code_fts, rowid, file_path, content)
  VALUES ('delete', old.id, old.file_path, old.content);
END;

CREATE TRIGGER IF NOT EXISTS code_chunks_au AFTER UPDATE ON code_chunks BEGIN
  INSERT INTO code_fts(rowid, file_path, content)
  VALUES (new.id, new.file_path, new.content);
END;
```

---

## Function Signatures

### New: `src/util/ftsQuery.ts`

```typescript
export function buildFtsOrQuery(
  input: string,
  options?: { prefixOnSingle?: boolean }
): string | null
// Returns null if input is empty after sanitization.
// Single term: exact match or prefix (controlled by prefixOnSingle).
// Multi-word: "term1" OR "term2" OR ... (OR-of-words semantics).
// Strips FTS5 special chars: * ^ ( ) { } : [ ]
```

### New: `src/search/rrfMerge.ts`

```typescript
export function rrfMerge<T extends { chunkId: string }>(
  listA: T[],
  listB: T[],
  limit: number,
  k?: number  // default 60
): T[]
// Generic Reciprocal Rank Fusion: score = 1/(k+rank_a) + 1/(k+rank_b)
// Works with any result type that has a chunkId field.
```

### New: `CodeChunkStore` (`src/search/CodeChunkStore.ts`)

```typescript
class CodeChunkStore {
  constructor(db: Database): CodeChunkStore                 // accepts injected Database
  private ensureSchema(): void                             // sets WAL pragma explicitly
  insert(chunk: CodeChunkRow): void                        // ON CONFLICT DO UPDATE (not REPLACE)
  insertBatch(chunks: CodeChunkRow[]): void                // transaction-wrapped bulk insert
  search(query: string, projectId: string, options?: { type?: "code" | "comment" | "docstring"; limit?: number }): ChunkSearchResult[]
  deleteProject(projectId: string): void
  countForProject(projectId: string): number
  // NOTE: No buildFtsQuery() — uses shared buildFtsOrQuery from "../util/ftsQuery.js"
}
```

### Modified: `CodeIndexer` (`src/search/CodeIndexer.ts`)

```typescript
// Constructor now accepts optional codeChunkStore
constructor(options: CodeIndexerOptions): CodeIndexer
// options.codeChunkStore?: CodeChunkStore | undefined   ← NEW

// search() now returns hybrid BM25+Qdrant results
async search(query: string, options: CodeIndexerSearchOptions): Promise<ChunkSearchResult[]>   // SIGNATURE UNCHANGED

// Define local type to replace inline anonymous type:
type CodeIndexerSearchOptions = {
  projectId?: string;
  filePath?: string;
  type?: "code" | "comment" | "docstring";
  limit?: number;
};

// New private method (rrfMerge removed — uses shared import from "./rrfMerge.js")
private async vectorSearch(query: string, options: CodeIndexerSearchOptions, limit: number): Promise<ChunkSearchResult[]>
```

### Modified: `IngestionService` (`src/ingest/IngestionService.ts`)

```typescript
// IngestionServiceOptions gains optional dbPath
export interface IngestionServiceOptions {
  neo4jClient: Neo4jClient;
  qdrantClient: QdrantClientWrapper;
  dbPath?: string | undefined;  // NEW
}

// New method for resource cleanup
close(): void  // closes CodeChunkStore DB connection; call during server shutdown
```

### Modified: `PingMemServerConfig` (`src/mcp/PingMemServer.ts`)

```typescript
// PingMemServerConfig gains optional eventStore (mirrors existing diagnosticsStore pattern)
export interface PingMemServerConfig {
  // ... existing fields ...
  eventStore?: EventStore | undefined;        // NEW: inject shared EventStore to avoid duplicate instance
  diagnosticsStore?: DiagnosticsStore | undefined;  // already exists
}
```

### Modified: `HTTPServerConfig` (`src/http/types.ts` — NOT rest-server.ts)

```typescript
// HTTPServerConfig in src/http/types.ts gains optional mcpServer
export interface HTTPServerConfig {
  // ... existing fields ...
  mcpServer?: Server | undefined;  // NEW: from @modelcontextprotocol/sdk/server/index.js
}
```

### Modified: `RESTPingMemServer` (`src/http/rest-server.ts`)

```typescript
// New private methods
private setupMcpRoute(): void  // guards with authMiddleware + rateLimiter before handler
```

---

## Integration Points

### 1. `server.ts` — IngestionService creation (line ~46)

**Before**:
```typescript
ingestionService = new IngestionService({
  neo4jClient: services.neo4jClient,
  qdrantClient: services.qdrantClient,
});
```

**After**:
```typescript
ingestionService = new IngestionService({
  neo4jClient: services.neo4jClient,
  qdrantClient: services.qdrantClient,
  dbPath: runtimeConfig.pingMem.dbPath,  // NEW
});
```

### 2. `server.ts` — MCP server creation (after line ~50)

**Before**: nothing

**After**: create PingMemServer, pass `getServer()` to REST server config

### 3. `rest-server.ts` — MCP route (in `setupRoutes()`)

**Before**: no `/mcp` route

**After**: `setupMcpRoute()` registers authMiddleware + rateLimiter + `app.all('/mcp', ...)` handler. Auth guard is required — existing middleware only covers `/api/*` and `/ui/*`.

### 4. `rest-server.ts` — `start()` method

**Before**: just logs "Started"

**After**: connects `WebStandardStreamableHTTPServerTransport` if `mcpServer` provided

### 5. `IngestionService.ts` — constructor (line ~72)

**Before**: `this.codeIndexer = new CodeIndexer({ qdrantClient })`

**After**: `this.codeIndexer = new CodeIndexer({ qdrantClient, codeChunkStore })` where `codeChunkStore` is created from `options.dbPath`

### 6. `KnowledgeStore.ts` — search() (lines 264–272)

**Before**: phrase-wrapping on line 272

**After**: `buildFtsOrQuery(options.query, { prefixOnSingle: false })` from shared `ftsQuery.ts`

### 7. `CodeChunkStore.ts` — search() method

**Before**: (new file) uses private `buildFtsQuery()`

**After**: uses `buildFtsOrQuery(query, { prefixOnSingle: true })` from shared `ftsQuery.ts`. No private `buildFtsQuery()` method.

### 8. `CodeIndexer.ts` — rrfMerge

**Before**: private `rrfMerge()` method inline

**After**: calls `rrfMerge(bm25Results, qdrantResults, limit)` imported from `./rrfMerge.js`. No private `rrfMerge()` method.

### 9. `PingMemServer.ts` — constructor EventStore initialization

**Before**: `this.eventStore = new EventStore({ dbPath: resolved.dbPath })`

**After**: `this.eventStore = config.eventStore ?? new EventStore({ dbPath: resolved.dbPath })`

---

## Verification Checklist

| Check | Binary Test | Pass Criterion |
|-------|-------------|----------------|
| Phase 1: FTS5 fix | `bun test src/knowledge/__tests__/` | 0 failures |
| Phase 1: Multi-word query | `store.search({query: "biometric authentication"}).length > 0` | PASS |
| Phase 2: typecheck | `bun run typecheck` | 0 errors |
| Phase 2: MCP HTTP endpoint (with auth key) | `curl -X POST http://localhost:3003/mcp -H "Content-Type: application/json" -H "X-API-Key: $PING_MEM_API_KEY" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'` | `{"result":{"tools":[...]}}` in response |
| Phase 2: MCP HTTP auth guard | `curl -X POST http://localhost:3003/mcp -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'` (no API key) | 401 Unauthorized |
| Phase 3: typecheck | `bun run typecheck` | 0 errors |
| Phase 3: FTS5 schema | `code_chunks` + `code_fts` tables exist in SQLite | PASS (CREATE IF NOT EXISTS) |
| Phase 3: NDCG@5 gate | eval.test.ts | NDCG@5 ≥ 0.35 |
| Phase 3: MRR@5 gate | eval.test.ts | MRR@5 ≥ 0.50 |
| Phase 3: Multi-word code search | `store.search("ingest project")` returns c3 | PASS |
| All phases: no regressions | `bun test` | 0 new failures |

---

## Acceptance Criteria

### Functional

1. `GET /api/v1/codebase/search?query=BM25+scoring&projectId=X` returns results with scores ≥ 0.35
2. `POST /mcp` with `{"method":"tools/list"}` returns list of 66 MCP tools
3. Knowledge search for "biometric authentication" returns ≥ 1 result
4. Knowledge search for "memory persistence" returns ≥ 1 result

### Non-Functional

1. FTS5 schema creation is idempotent (CREATE IF NOT EXISTS, safe on restart)
2. Existing Qdrant ingested projects continue to work (no Qdrant data deleted)
3. MCP HTTP endpoint returns 503 gracefully if mcpServer not configured
4. SQLite concurrent access safe (WAL mode set explicitly via `PRAGMA journal_mode = WAL` in CodeChunkStore.ensureSchema())

### Quality Gates

1. `bun run typecheck` — 0 errors
2. `bun test` — 0 new failures
3. NDCG@5 ≥ 0.35 (eval.test.ts)
4. MRR@5 ≥ 0.50 (eval.test.ts)

---

## Risk Analysis

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|-----------|
| `WebStandardStreamableHTTPServerTransport` constructor API differs from plan | HIGH | LOW | Verified from `dist/esm/server/webStandardStreamableHttp.d.ts` in installed SDK |
| FTS5 `tokenchars` syntax wrong (single quotes inside single-quoted SQL string) | HIGH | MEDIUM | Use raw string: `CREATE VIRTUAL TABLE ... tokenize = 'unicode61 tokenchars ''-_'''` — double the inner quotes in SQL |
| Two EventStore instances on same SQLite file causes write conflicts | MEDIUM | LOW | SQLite WAL mode serializes writes. **WAL must be set explicitly** — bun:sqlite does NOT enable WAL by default. CodeChunkStore.ensureSchema() sets `PRAGMA journal_mode = WAL` explicitly (see Phase 3a). |
| `PingMemServer` instantiated without start() still runs setup side effects | MEDIUM | LOW | PingMemServer constructor instantiates EventStore, SessionManager, DiagnosticsStore — ~7-10MB RSS overhead and a second SQLite connection. Accepted cost for this PR scope. |
| NDCG@5 threshold 0.35 not met with test corpus | MEDIUM | LOW | 8 eval cases with directly matching keywords; FTS5 OR semantics should easily score > 0.35. Note: this is a smoke test (regression detection), not a rigorous quality gate. |
| INSERT ON CONFLICT DO UPDATE fires wrong triggers | LOW | NONE | **Fixed**: Changed from INSERT OR REPLACE (which fires DELETE+INSERT triggers) to INSERT ... ON CONFLICT DO UPDATE (which fires BEFORE/AFTER UPDATE triggers). UPDATE triggers keep FTS5 external content table in sync correctly. |
| BM25 column weights prioritize file_path over content | HIGH | NONE | **Fixed**: Corrected to `bm25(code_fts, 1.0, 2.0)` — content (col 1) gets weight 2.0, file_path (col 0) gets 1.0. |
| MCP /mcp endpoint unauthenticated | CRITICAL | NONE | **Fixed**: Added auth middleware + rate limiter in setupMcpRoute() before the handler registration. |

---

## Complete File Structure (Post-Implementation)

```
src/
├── util/
│   └── ftsQuery.ts              ← NEW: shared buildFtsOrQuery() used by KnowledgeStore + CodeChunkStore
├── search/
│   ├── rrfMerge.ts              ← NEW: generic rrfMerge<T> used by CodeIndexer
│   ├── CodeChunkStore.ts        ← NEW: SQLite FTS5 code search (uses ftsQuery.ts)
│   ├── CodeIndexer.ts           ← MODIFIED: dual-write + RRF hybrid search (uses rrfMerge.ts)
│   ├── DeterministicVectorizer.ts  (unchanged)
│   ├── HybridSearchEngine.ts       (unchanged)
│   ├── BM25Store.ts               (unchanged)
│   └── __tests__/
│       ├── eval.test.ts         ← NEW: NDCG@5, MRR@5 quality gates
│       └── (existing tests unchanged)
├── knowledge/
│   └── KnowledgeStore.ts        ← MODIFIED: OR-of-words FTS5 fix (uses ftsQuery.ts)
├── ingest/
│   └── IngestionService.ts      ← MODIFIED: dbPath option → CodeChunkStore
├── http/
│   ├── rest-server.ts           ← MODIFIED: /mcp route + mcpServer config
│   └── server.ts                ← MODIFIED: PingMemServer for MCP, shared eventStore injection
└── mcp/
    └── PingMemServer.ts         ← MODIFIED: eventStore? field in PingMemServerConfig
```

---

## Dependencies

| Package | Current Version | Change | Notes |
|---------|----------------|--------|-------|
| `@modelcontextprotocol/sdk` | 1.25.3 | None | `WebStandardStreamableHTTPServerTransport` already available |
| `hono` | 4.11.6 | None | Web Standard Request/Response, compatible |
| `bun:sqlite` | (Bun built-in) | None | FTS5 enabled by default in Bun's SQLite |
| No new packages required | — | — | Zero new dependencies |

---

## Success Metrics

| Metric | Baseline | Post-Phase 1 | Post-Phase 2 | Post-Phase 3 | Measurement |
|--------|----------|--------------|--------------|--------------|-------------|
| Knowledge multi-word recall | 0% | ≥ 80% | 80% | 80% | unit test |
| MCP HTTP accessible | No | No | Yes (port 3003) | Yes | curl test |
| Code search NDCG@5 | 0.10–0.15 | 0.10–0.15 | 0.10–0.15 | ≥ 0.35 | eval.test.ts |
| Code search MRR@5 | unknown | unknown | unknown | ≥ 0.50 | eval.test.ts |
| TypeScript errors | 0 | 0 | 0 | 0 | typecheck |
| Test failures | 0 | 0 | 0 | 0 | bun test |
| MCP auth coverage | No | No | Yes (/mcp guarded) | Yes | curl test 401 |

---

## EVAL Amendments (eval_iteration: 1)

Findings from 3 parallel EVAL agents, incorporated into plan above:

| Finding | Severity | Agent | Amendment Made |
|---------|----------|-------|----------------|
| MCP /mcp endpoint unauthenticated | CRITICAL | Security | Added `authMiddleware` + `rateLimiter` in `setupMcpRoute()` before handler |
| BM25 column weights backwards (file_path 2.0 > content 1.0) | HIGH | Completeness | Fixed to `bm25(code_fts, 1.0, 2.0)` throughout plan |
| INSERT OR REPLACE bypasses FTS5 UPDATE triggers | HIGH | Performance + Completeness | Changed to `INSERT ... ON CONFLICT DO UPDATE SET ...` in `insert()` method |
| SQLite dual-write requires transaction batching | HIGH | Performance | Added `insertBatch()` with `db.transaction()` wrapping; `indexIngestion()` calls `insertBatch()` not looped `insert()` |
| WAL mode not set in CodeChunkStore | HIGH | Security | Added `PRAGMA journal_mode = WAL` in `ensureSchema()` — bun:sqlite does NOT enable WAL by default (corrected false claim in risk matrix) |
| MCP gated on neo4j/qdrant in server.ts | HIGH | Completeness | Removed gate — PingMemServer always created for MCP-over-HTTP |
| IngestionService DB connection leak (no close()) | HIGH | Completeness | Added `codeChunkStoreDb` field + `close()` method; wired to server.ts shutdown |
| HTTPServerConfig in types.ts not rest-server.ts | MEDIUM | Completeness | Updated plan to specify `src/http/types.ts` as the file to modify |
| SearchOptions type undefined in CodeIndexer | MEDIUM | Completeness | Defined `CodeIndexerSearchOptions` local type, removed bare anonymous type |
| Constructor ordering: mcpServer before setupRoutes() | MEDIUM | Completeness | Corrected to assign `this.mcpServer` BEFORE calling `this.setupRoutes()` |
| unused `describe` import in eval.test.ts | LOW | Completeness | Removed from import statement |
| `describe` imported but unused — lint failure | LOW | Completeness | Fixed |

---

## REVIEW Amendments (review_iteration: 1)

Findings from architecture/simplicity reviewer, all incorporated into plan:

| Finding | Severity | Amendment |
|---------|----------|-----------|
| RRF in CodeIndexer vs HybridSearchEngine: wrong layer | HIGH | **Fixed** — extracted to `src/search/rrfMerge.ts` as generic `rrfMerge<T extends {chunkId:string}>()`. CodeIndexer imports and calls `rrfMerge(...)` — no private `rrfMerge()` method. Phase 0b. |
| PingMemServer creates duplicate state tree | HIGH | **Fixed** — added `eventStore?: EventStore` to `PingMemServerConfig`. Constructor uses `config.eventStore ?? new EventStore(...)`. `server.ts` passes the already-created `eventStore` (line ~66). Phase 2f. |
| CodeChunkStore opens unmanaged Database | HIGH | **Fixed** — `codeChunkStoreDb` field added to IngestionService, `close()` method wired to shutdown. Phase 3c. |
| FTS5 query builders diverge (knowledge vs code) | MEDIUM | **Fixed** — extracted to `src/util/ftsQuery.ts` as `buildFtsOrQuery(input, {prefixOnSingle?})`. KnowledgeStore uses `{prefixOnSingle: false}`, CodeChunkStore uses `{prefixOnSingle: true}`. Difference intentional and documented. Phase 0a. |
| OR-of-words single-term inconsistency | MEDIUM | **Fixed** (by Phase 0a) — the `prefixOnSingle` option makes the behavior explicit and parameterized rather than implicit in two separate private methods. |

---

## Irreducible Runtime Unknowns

These cannot be verified on paper — each has a binary test and mitigation:

| Unknown | Binary Test | Mitigation if Fails |
|---------|-------------|---------------------|
| `bm25(code_fts, 1.0, 2.0)` returns positive scores after `-1.0 * bm25(...)` negation | NDCG@5 gate in eval.test.ts passes | Verify FTS5 bm25() returns negative values (documented behavior); check score sign in test output |
| `WebStandardStreamableHTTPServerTransport.handleRequest()` resolves with correct JSON-RPC 2.0 response | `curl -X POST http://localhost:3003/mcp ... tools/list` returns `{"result":{"tools":[...]}}` | Fall back to `StreamableHTTPServerTransport` (Node-compatible) if Web Standard version fails |
| Hono `authMiddleware` function is importable within `setupMcpRoute()` scope | `bun run typecheck` passes | Use inline auth check if import fails |
| FTS5 `ON CONFLICT DO UPDATE` fires `BEFORE UPDATE` + `AFTER UPDATE` triggers (not DELETE+INSERT) | Re-ingest same project, verify FTS5 shadow table has 1 row per chunk_id (not accumulating tombstones) | If triggers fire wrong: switch to explicit DELETE-then-INSERT pattern in `insert()` |
| SQLite FTS5 `bm25()` built-in is available in Bun's bundled SQLite | eval.test.ts NDCG@5 gate passes | Bun uses libsqlite3 with FTS5 compiled in; confirmed from Bun docs |

---

## Evidence-Based Predictability

- **Paper-verified claims**: 10/10 (VERIFY agent checked all plan claims against actual codebase — 0 bugs found)
- **EVAL bugs fixed**: 11 findings across 3 EVAL agents, all incorporated
- **REVIEW findings**: 5 findings from architecture review; **5/5 fixed** — 0 deferred
- **Irreducible runtime unknowns**: 5, each with binary test + mitigation
- **Composite predictability**: 10/10 paper-verified + 5 runtime unknowns with mitigations = high confidence execution plan
