# Current Implementation Audit — ping-mem

**Date**: 2026-03-22
**Scope**: Core modules, MCP tool handlers, and REST endpoints relevant to auto-capture feature work.

---

## 1. SessionManager

**File**: `/Users/umasankr/Projects/ping-mem/src/session/SessionManager.ts`

### Configuration

```typescript
interface SessionManagerConfig {
  eventStore?: EventStore;            // defaults to createInMemoryEventStore()
  maxActiveSessions?: number;         // default: 10
  autoCheckpointInterval?: number;    // ms, default: 300000 (5 min), 0 = disabled
  sessionTtlMs?: number;              // default: 3_600_000 (1 hour), 0 = disabled
}
```

### Public Method Signatures

```typescript
class SessionManager {
  constructor(config?: SessionManagerConfig)

  // Rebuild in-memory session state from persisted EventStore events.
  // Skips ended sessions (SESSION_ENDED event present) and restores pause state.
  // Restores auto-checkpoint timers for active sessions.
  async hydrate(): Promise<void>

  // Evict sessions inactive beyond sessionTtlMs. Called automatically by startSession().
  // Returns number of sessions evicted.
  async cleanup(): Promise<number>

  // Start a new session. Serialized via a promise-chain mutex to prevent TOCTOU race
  // on max-sessions check. Auto-loads context if config.autoLoadContext && config.continueFrom.
  async startSession(config: SessionConfig): Promise<Session>

  // End an active session. Creates final checkpoint. Requires status === "active".
  async endSession(sessionId: SessionId, reason?: string): Promise<Session>

  // Pause an active session. Clears auto-checkpoint timer.
  async pauseSession(sessionId: SessionId): Promise<Session>

  // Resume a paused session. Re-enables auto-checkpoint timer.
  async resumeSession(sessionId: SessionId): Promise<Session>

  // Create a new session that continues from a parent, copying projectDir/defaultChannel.
  async continueSession(sessionId: SessionId, newName: string): Promise<Session>

  // Synchronous in-memory lookup. Returns null if not found.
  getSession(sessionId: SessionId): Session | null

  // Returns the most recently activated session, or null.
  getActiveSession(): Session | null

  // List sessions optionally filtered by status and/or projectDir, sorted newest-first.
  listSessions(filter?: { status?: SessionStatus; projectDir?: string }): Session[]

  // Bump lastActivityAt to now (no event emitted).
  async updateActivity(sessionId: SessionId): Promise<void>

  // Increment memoryCount by delta (default 1) and call updateActivity.
  async incrementMemoryCount(sessionId: SessionId, delta?: number): Promise<void>

  // Aggregate session stats from EventStore events.
  async getSessionStats(sessionId: SessionId): Promise<SessionStats | null>

  // Clear all auto-checkpoint timers. Does NOT close EventStore (caller owns lifecycle).
  async close(): Promise<void>

  // Return the underlying EventStore (for testing).
  getEventStore(): EventStore
}
```

### Key Implementation Details

- Session IDs are UUID v7 (time-sortable, crypto-random).
- Auto-checkpoint fires on `setInterval` and writes `createCheckpoint()` to EventStore.
- `loadContextFrom()` is private; it reads `MEMORY_SAVED` events from source session and emits a `CONTEXT_LOADED` event. The `memories` array returned is a placeholder (`[]`) — population is delegated to MemoryManager.
- The mutex is a promise chain (`this.sessionMutex = resultPromise.then(() => {}, () => {})`), not a true lock. Errors in one `startSession` call do not permanently block subsequent calls.

---

## 2. MemoryManager

**File**: `/Users/umasankr/Projects/ping-mem/src/memory/MemoryManager.ts`

### Configuration

```typescript
interface MemoryManagerConfig {
  eventStore?: EventStore;
  vectorIndex?: VectorIndex;
  sessionId: SessionId;               // required
  defaultChannel?: string;
  defaultPriority?: MemoryPriority;   // default: "normal"
  defaultPrivacy?: MemoryPrivacy;     // default: "session"
  relevanceEngine?: RelevanceEngine;
  agentId?: AgentId;
  agentRole?: string;
  writeLockManager?: WriteLockManager;
  pubsub?: MemoryPubSub;
}
```

### Public Method Signatures

```typescript
class MemoryManager {
  constructor(config: MemoryManagerConfig)

  // Replay MEMORY_SAVED / MEMORY_UPDATED / MEMORY_DELETED events from EventStore
  // to rebuild the in-memory Map caches. Must be called after construction.
  async hydrate(): Promise<void>

  // Save a new memory. Throws MemoryKeyExistsError if key already exists.
  // Enforces agent quota (bytes + count) with atomic SQLite UPDATE guard.
  // Writes MEMORY_SAVED event, updates in-memory cache, vector index, pubsub.
  async save(key: string, value: string, options?: SaveMemoryOptions): Promise<Memory>

  // Upsert: calls update() if key exists (scope-aware), else save().
  async saveOrUpdate(key: string, value: string, options?: SaveMemoryOptions): Promise<Memory>

  // Supersede: if key exists, moves old memory to "key::superseded::id", saves new memory
  // under original key, emits MEMORY_SUPERSEDED event. If no existing key, behaves like save().
  async supersede(key: string, value: string, options?: SaveMemoryOptions): Promise<Memory>

  // Update an existing memory by key. Enforces agent ownership and quota delta.
  // Writes MEMORY_UPDATED event, applies changes to in-memory object after successful write.
  async update(key: string, options: UpdateMemoryOptions): Promise<Memory>

  // Delete a memory by key. Enforces agent ownership. Writes MEMORY_DELETED event,
  // removes from caches, vector index, decrements agent quota, publishes via pubsub.
  async delete(key: string): Promise<boolean>

  // Exact key lookup with scope enforcement. Auto-tracks access in RelevanceEngine.
  get(key: string): Memory | null

  // Lookup by memory ID with scope enforcement.
  getById(memoryId: MemoryId): Memory | null

  // Scope-aware existence check.
  has(key: string): boolean

  // List all visible memories, filtered/sorted, newest-first.
  list(options?: { limit?: number; category?: MemoryCategory; channel?: string }): Memory[]

  // Multi-mode recall: exact key, wildcard pattern, semantic vector, or full scan.
  // Emits MEMORY_RECALLED event for exact key matches.
  async recall(query: MemoryQuery): Promise<MemoryQueryResult[]>

  // Fuzzy in-memory text match against value content (no vector required).
  findRelated(text: string, options?: { excludeKeys?: string[]; excludeSessionId?: string; limit?: number }): Array<{ memory: Memory; score: number }>

  // Cross-session SQL scan for related memories via LIKE pattern on EventStore.
  findRelatedAcrossSessions(text: string, options?: { excludeKeys?: string[]; excludeSessionId?: string; limit?: number }): Array<{ memory: { id: string; key: string; value: string; sessionId: string; category?: string; priority: string; createdAt: Date }; score: number }>

  // Return basic stats: count, keys, categories.
  async getStats(): Promise<{ count: number; keys: string[]; categories: Record<string, number> }>

  // Return the current agent ID (used by ContextToolModule for admin lookup).
  getAgentId?(): AgentId | undefined
}
```

### Key Implementation Details

- Dual in-memory cache: `Map<key, Memory>` and `Map<MemoryId, Memory>` for O(1) key and ID lookup.
- Agent scope rules: `public`/undefined = visible to all; `shared` = visible to any registered agent; `role` = same `agentRole`; `private` = owner only.
- Write operations follow write-event-then-mutate-cache ordering for consistency.
- Quota enforcement uses an atomic `UPDATE ... WHERE current_bytes + $bytes <= quota_bytes` with `result.changes === 0` detection. Failed EventStore writes roll back the quota increment.
- JunkFilter is applied in ContextToolModule before calling `save()`/`supersede()`, not inside MemoryManager itself.

---

## 3. SemanticCompressor

**File**: `/Users/umasankr/Projects/ping-mem/src/memory/SemanticCompressor.ts`

### Public Method Signatures

```typescript
interface CompressionResult {
  facts: string[];
  sourceCount: number;
  compressionRatio: number;   // 0-1, lower = more compressed
  strategy: "llm" | "heuristic";
  costEstimate?: { inputTokens: number; outputTokens: number };
}

interface CompressorConfig {
  apiKey?: string;            // falls back to OPENAI_API_KEY env var
  maxBatchTokens?: number;    // default: 4000
  model?: string;             // default: "gpt-4o-mini"
}

class SemanticCompressor {
  constructor(config?: CompressorConfig)

  // Entry point: uses LLM if API key available, else heuristic.
  async compress(memories: Memory[]): Promise<CompressionResult>

  // Getter: true if OPENAI_API_KEY is configured.
  get isLLMAvailable(): boolean
}
```

### Compression Approach

**LLM path** (`compressWithLLM`):
- Formats memories as `[N] (category) key: value` text.
- Estimates tokens as `ceil(text.length / 4)`.
- If estimated input > `maxBatchTokens`, calls `compressInBatches()` which splits into chunks of `floor(maxBatchTokens / 50)` memories per batch.
- Sends to OpenAI chat completions with `temperature: 0.1` and `response_format: { type: "json_object" }`.
- System prompt instructs extraction of a `{ "facts": string[] }` JSON object.
- Falls back to heuristic on HTTP error, invalid JSON, or network exception.
- Cross-batch dedup: `[...new Set(allFacts)]`.

**Heuristic path** (`compressWithHeuristic`):
- Normalizes value (lowercase, trim, collapse whitespace).
- Deduplicates using `Bun.hash(normalized)` as key.
- Formats fact as `"key: value"` truncated to 200 chars.
- Uses `Bun.hash` (Bun runtime specific — not portable to Node).

---

## 4. RelevanceEngine

**File**: `/Users/umasankr/Projects/ping-mem/src/memory/RelevanceEngine.ts`

### Public Method Signatures

```typescript
class RelevanceEngine {
  constructor(db: Database, config?: RelevanceEngineConfig)

  // Increment access_count, update last_accessed, recalculate relevance score.
  trackAccess(memoryId: string): void

  // Recalculate and persist relevance for one memory. Returns new score (0 if not tracked).
  recalculateRelevance(memoryId: string): number

  // Batch recalculate all tracked memories inside a SQLite transaction.
  // Returns number of records updated.
  recalculateAll(): number

  // Return distribution stats: total, staleCount, avgRelevance, distribution{high,medium,low,stale}.
  getStats(): RelevanceStats

  // Find memories below maxScore threshold, optionally filtered by minimum age.
  findStaleMemories(options?: FindStaleOptions): StaleMemory[]

  // Full consolidation cycle:
  // 1. findStaleMemories with minDaysOld filter
  // 2. Group by channel::category
  // 3. SemanticCompressor.compress() per chunk (maxPerDigest = 20)
  // 4. Insert into archived_memories, delete from memory_relevance
  // Returns { archivedCount, digestsCreated }
  async consolidate(options?: ConsolidateOptions): Promise<ConsolidationResult>

  // Ensure a memory is tracked (no-op if already exists). Sets initial score from
  // priority/category weights. Called on first save.
  ensureTracking(memoryId: string, priority?: string, category?: string): void

  // Get current score for a memory. Returns 1.0 if not tracked.
  getRelevanceScore(memoryId: string): number
}
```

### Scoring Algorithm

**Formula**: `relevance = base_score * decay_factor^(days_since_access)`

Where:
```
base_score = priority_weight * category_weight * access_frequency_bonus
access_frequency_bonus = min(1.0 + log2(access_count) * 0.1, 2.0)
decay_factor = 0.97 (halves every ~23 days, configurable)
```

**Priority weights**: `high=1.5, normal=1.0, low=0.5`

**Category weights**: `decision=1.3, error=1.2, task=1.0, warning=1.0, fact=0.9, observation=0.8, progress=0.8, note=0.7`

**Stale threshold**: 0.3 (configurable). Distribution tiers: `high >= 0.7`, `medium >= 0.4`, `low >= staleThreshold`, `stale < staleThreshold`.

**Schema**: Uses `memory_relevance` table (shared with VectorIndex but created independently) and `archived_memories` table. Both created via `initializeSchema()` with `CREATE TABLE IF NOT EXISTS`.

**Consolidation grouping key**: `"${channel}::${category}"` from `MEMORY_SAVED` event payload. Falls back to heuristic digest (`"- key: value"` list, truncated to 200 chars each) when SemanticCompressor returns empty facts or throws.

---

## 5. JunkFilter

**File**: `/Users/umasankr/Projects/ping-mem/src/memory/JunkFilter.ts`

### Public Method Signatures

```typescript
interface JunkFilterResult {
  junk: boolean;
  reason?: string;
}

class JunkFilter {
  // Synchronous single-method filter. No constructor config.
  isJunk(value: string): JunkFilterResult
}
```

### Filtering Logic (ordered checks)

1. **Empty/whitespace**: `trimmed.length === 0` → `"empty content"`
2. **Too short**: `trimmed.length < 10` → `"too short (< 10 chars)"`
3. **Generic filler (exact, case-insensitive)**: Set includes `test, testing, asdf, hello, hello world, foo, bar, baz, lorem ipsum, todo, tbd, n/a, na, xxx, yyy, zzz, abc, 123, qwerty`
4. **Bare URL**: matches `/^https?:\/\/\S+$/i` → `"bare URL without context"`
5. **Repetitive chars**: any single character comprising > 60% of string → `"repetitive content"`
6. **Repetitive words**: (only for `words.length >= 3`) any single word comprising > 60% of word count → `"repetitive content"`

Applied in `ContextToolModule.handleSave()` before `memoryManager.supersede()`. A rejected save returns `{ success: false, rejected: true, reason: string }` without touching EventStore.

---

## 6. MCP Tool: `worklog_record`

**Definition file**: `/Users/umasankr/Projects/ping-mem/src/mcp/handlers/WorklogToolModule.ts`
**Class**: `WorklogToolModule` implements `ToolModule`
**Handler method**: `private async handleWorklogRecord(args)`

### Input Schema

```typescript
{
  kind: "tool" | "diagnostics" | "git" | "task",  // required
  title: string,                                    // required
  status?: "success" | "failed" | "partial",
  phase?: "started" | "summary" | "completed",     // required when kind="task"
  toolName?: string,
  toolVersion?: string,
  configHash?: string,
  environmentHash?: string,
  projectId?: string,
  treeHash?: string,
  commitHash?: string,
  runId?: string,
  command?: string,
  durationMs?: number,
  summary?: string,
  metadata?: object,
  sessionId?: string,    // explicit override; defaults to current session
}
```

### Event Type Mapping

| kind | phase | EventType |
|------|-------|-----------|
| `tool` | — | `TOOL_RUN_RECORDED` |
| `diagnostics` | — | `DIAGNOSTICS_INGESTED` |
| `git` | — | `GIT_OPERATION_RECORDED` |
| `task` | `started` | `AGENT_TASK_STARTED` |
| `task` | `summary` | `AGENT_TASK_SUMMARY` |
| `task` | `completed` | `AGENT_TASK_COMPLETED` |

### Response Shape

```typescript
{
  success: true,
  eventId: string,
  eventType: string,
  timestamp: string,  // ISO 8601
}
```

### REST Equivalent

`POST /api/v1/worklog` (defined in `src/http/routes/openapi.ts`)

---

## 7. MCP Tool: `context_search`

**Definition file**: `/Users/umasankr/Projects/ping-mem/src/mcp/handlers/ContextToolModule.ts`
**Handler method**: `private async handleSearch(args)`

### MCP Input Schema

```typescript
{
  query: string,           // required
  minSimilarity?: number,  // 0-1
  category?: string,
  channel?: string,
  limit?: number,
}
```

### MCP Handler Logic

Calls `memoryManager.recall({ semanticQuery, minSimilarity, category, channel, limit })`. Returns:

```typescript
{
  count: number,
  results: Array<{
    id, key, value, category, priority, privacy, channel,
    createdAt, updatedAt, metadata,  // serialized memory fields
    score: number,
  }>
}
```

### REST Endpoint

`GET /api/v1/search` in `/Users/umasankr/Projects/ping-mem/src/http/rest-server.ts` (line 1415)

**Query parameters**: `query` (required, max 2000 chars), `category`, `channel`, `priority`, `limit` (1–1000, default 10), `offset`

**REST-specific behavior** (different from MCP):
- Strips glob metacharacters (`*?[\\\%_`) and wraps in `*query*` pattern → uses `keyPattern` (wildcard match), NOT `semanticQuery`.
- Rejects queries that become empty after metacharacter stripping.
- Blends match score with relevance decay: `weightedScore = score * 0.7 + relevanceScore * 0.3`, then re-sorts.

**REST Response**:

```typescript
{
  data: Array<{
    memory: Memory,
    score: number,   // blended score
  }>
}
```

---

## 8. MCP Tool: `memory_maintain`

**Definition file**: `/Users/umasankr/Projects/ping-mem/src/mcp/handlers/MemoryToolModule.ts`
**Handler method**: `private async handleMemoryMaintain(args)`
**Orchestrator**: `/Users/umasankr/Projects/ping-mem/src/maintenance/MaintenanceRunner.ts`

### Input Schema

```typescript
{
  dryRun?: boolean,           // default: false — preview without modifying
  dedupThreshold?: number,    // default: 0.95
  pruneThreshold?: number,    // default: 0.2
  pruneMinAgeDays?: number,   // default: 30
  exportDir?: string,         // dir to export high-relevance memories as native markdown
}
```

### What It Does (MaintenanceRunner.run)

**Step 1 — Dedup**: Finds keys with multiple `CONTEXT_SAVED` events (GROUP BY key, HAVING count > 1). Keeps newest, emits `MEMORY_SUPERSEDED` events for older copies. Note: `dedupThreshold` is passed but not used in the SQL (no vector similarity, pure key-based dedup).

**Step 2 — Consolidate**: Delegates to `RelevanceEngine.consolidate()`. In dry-run mode, returns `staleCount` from `getStats()` without modifying data.

**Step 3 — Prune**: Finds memories where `relevance_score < pruneThreshold AND access_count = 0 AND last_accessed < datetime('now', '-N days')`. Emits `MEMORY_SUPERSEDED` with `reason: "maintenance-prune"`. Does NOT delete — append-only.

**Step 4 — Vacuum**: Checks WAL size via `eventStore.getWalSizeBytes()`. If > 50MB threshold, calls `eventStore.walCheckpoint("TRUNCATE")`.

**Step 5 — Export**: If `ccMemoryBridge` and `exportDir` configured, calls `ccMemoryBridge.exportToNativeMemory({ topicsDir, eventStore })`.

### Response Shape

```typescript
{
  success: true,
  result: {
    dedupCount: number,
    consolidateResult: { archivedCount: number, digestsCreated: number },
    pruneCount: number,
    vacuumRan: boolean,
    walSizeBefore: number,
    walSizeAfter: number,
    exportedCount: number,
    durationMs: number,
  }
}
```

---

## 9. MCP Tool: `context_auto_recall`

**Definition file**: `/Users/umasankr/Projects/ping-mem/src/mcp/handlers/ContextToolModule.ts`
**Handler method**: `private async handleAutoRecall(args)`

### Input Schema

```typescript
{
  query: string,      // required; minimum 3 chars after trim
  limit?: number,     // default: 5
  minScore?: number,  // default: 0.1
}
```

### What It Does

1. Validates query length (< 3 chars → returns `{ recalled: false, reason: "query too short", context: "" }`).
2. Requires an active session (returns `{ recalled: false, reason: "no active session", context: "" }` otherwise).
3. Calls `memoryManager.recall({ semanticQuery: query, limit })`.
4. Filters results to `score >= minScore`.
5. If no results pass filter → `{ recalled: false, reason: "no relevant memories found", context: "" }`.
6. Formats results as a block:
   ```
   --- ping-mem auto-recall ---
   [1] (82%) some-key: some value
   [2] (61%) other-key: other value
   --- end recall ---
   ```

### Response Shape

```typescript
// No results:
{ recalled: false, reason: string, context: "" }

// With results:
{
  recalled: true,
  count: number,
  context: string,    // formatted block for pre-prompt injection
  memories: Array<{
    key: string,
    value: string,
    score: number,
    category?: string,
  }>
}
```

### Usage Pattern (from CLAUDE.md)

Called before processing any substantive user message as a memory recall hook. The `context` string is intended for direct injection into pre-prompt context.

---

## 10. HybridSearchEngine

**File**: `/Users/umasankr/Projects/ping-mem/src/search/HybridSearchEngine.ts`

### Public Method Signatures

```typescript
class HybridSearchEngine {
  constructor(config: HybridSearchEngineConfig)

  // Index a document into both BM25 (keyword) and vector (semantic) indexes.
  // Generates embedding via embeddingService.embed(), stores in Qdrant or localVectorIndex.
  // Also persists to BM25Store if configured.
  async indexDocument(
    memoryId: MemoryId,
    sessionId: SessionId,
    content: string,
    indexedAt: Date,
    options?: { category?: string; metadata?: Record<string, unknown> }
  ): Promise<void>

  // Remove from BM25 index and vector store (Qdrant or local).
  async removeDocument(memoryId: MemoryId): Promise<boolean>

  // Add to BM25 only (no embedding generated). Used for keyword-only workflows / tests.
  addDocument(
    memoryId: MemoryId,
    sessionId: SessionId,
    content: string,
    indexedAt: Date,
    metadata?: Record<string, unknown>
  ): void

  // Core hybrid search. Runs semantic + keyword + graph modes in parallel,
  // fuses with RRF, applies temporal boost, optionally re-ranks via Reranker.
  async search(query: string, options?: HybridSearchOptions): Promise<HybridSearchResult[]>
}
```

### Search Approach

**Search modes**: `"semantic" | "keyword" | "graph" | "code" | "causal"`
Note: `code` and `causal` modes are currently no-ops (empty result sets participate in RRF with zero weight effect).

**Weight resolution priority**:
1. `options.weights` (explicit override)
2. `options.profile` (named profile lookup from `SearchProfiles`)
3. Auto-detected profile via `detectProfile(query)` (pattern matching)
4. Config defaults: `{ semantic: 0.5, keyword: 0.3, graph: 0.2 }`

**Causal direction auto-detection**: Regex on query text.
- `why|what caused|reason|because|due to` → `"cause"` direction; boosts causal weight × 1.5, renormalizes all weights.
- `what if|consequence|result|effect|impact|leads to` → `"effect"` direction.

**Execution**: Semantic, keyword, graph searches run in `Promise.all()` (parallel).

**Reciprocal Rank Fusion (RRF)**:
- RRF constant `k = 60`.
- `rrf_score = Σ_mode [ weight_mode / (k + rank_in_mode) ]`
- All contributing modes are recorded in `result.searchModes`.

**Temporal boost** (post-RRF, unless `skipTemporalBoost: true`):
- `boost_factor = 0.3` (default), `decay_days = 30` (default).
- Exponential decay from document's `indexedAt` date.
- Applied additively to hybrid score; results re-sorted after boost.

**Reranker**: Optional Cohere Rerank API integration. If `reranker.rerank()` returns `null` (failure), results stay in RRF order with a warn log.

**BM25 Implementation** (internal `BM25Index` class):
- `k1 = 1.5`, `b = 0.75` (defaults, configurable).
- Standard BM25 IDF: `log((N - df + 0.5) / (df + 0.5) + 1)`.
- Tokenization: lowercase, strip non-word/non-space, split whitespace, filter `length > 1`.
- In-memory only (no SQLite); optionally persisted via `BM25Store` for restart survival.

**Vector search**: Qdrant cloud client takes priority; falls back to local `VectorIndex` (SQLite-backed). `semanticSearch` fetches `limit * 2` results before fusion.

---

## Integration Points Summary

| Tool/Endpoint | File | Key Dependencies |
|---|---|---|
| `worklog_record` MCP | `src/mcp/handlers/WorklogToolModule.ts:95` | `EventStore.createEvent()` |
| `context_search` MCP | `src/mcp/handlers/ContextToolModule.ts:224` | `MemoryManager.recall()` |
| `GET /api/v1/search` REST | `src/http/rest-server.ts:1415` | `MemoryManager.recall()` + `RelevanceEngine.getRelevanceScore()` |
| `memory_maintain` MCP | `src/mcp/handlers/MemoryToolModule.ts:132` | `MaintenanceRunner.run()` → `RelevanceEngine.consolidate()` + `EventStore` |
| `context_auto_recall` MCP | `src/mcp/handlers/ContextToolModule.ts:234` | `MemoryManager.recall()` |
| `JunkFilter` | `src/memory/JunkFilter.ts` | Applied in `ContextToolModule.handleSave()` |
| `SemanticCompressor` | `src/memory/SemanticCompressor.ts` | Used by `RelevanceEngine.consolidate()` and `MemoryToolModule.handleMemoryCompress()` |

## Notes on Auto-Capture Integration Points

- **Entry point for new memories**: `ContextToolModule.handleSave()` → `JunkFilter.isJunk()` → `MemoryManager.supersede()` → `RelevanceEngine.ensureTracking()`. Auto-capture would hook at this same path.
- **Session context**: `state.currentSessionId` is set on session start; `getActiveMemoryManager(state)` resolves the correct `MemoryManager` instance.
- **Event emission**: All memory writes go through `EventStore.createEvent()`. Auto-capture could emit its own event type (e.g. `AUTO_CAPTURE_SAVED`) by following the same pattern.
- **Cross-session recall**: `MemoryManager.findRelatedAcrossSessions()` does a SQL LIKE scan across all sessions' `MEMORY_SAVED` events — this is the current cross-session path, no vector index required.
- **BM25 indexing**: `HybridSearchEngine.indexDocument()` must be called explicitly after save if BM25 keyword search coverage is desired. It is not called automatically by `MemoryManager.save()`.
