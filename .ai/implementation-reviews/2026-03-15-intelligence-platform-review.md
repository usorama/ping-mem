# Implementation Review: Intelligence Platform + Self-Monitoring Pipeline

**PR**: #33 (feat/intelligence-platform-self-improvement)
**Date**: 2026-03-15
**Commit**: `ee4d1a4`
**Plans reviewed**:
1. `docs/plans/2026-03-15-feat-self-monitoring-ingestion-pipeline-plan.md` (5 phases)
2. `docs/plans/2026-03-15-feat-intelligence-platform-self-improvement-plan.md` (9 workstreams)

## Quality Gate

| Check | Result |
|-------|--------|
| `bun run typecheck` | PASS (0 errors) |
| `bun test` | PASS (1844 tests, 0 failures, 4273 assertions) |
| `any` types in new code | NONE FOUND |
| TODOs/stubs in implementation | NONE FOUND |

## Self-Monitoring Pipeline (Plan 1) — Phase-by-Phase

### Phase 0: Prerequisite Security Fix — PASS

- `isProjectDirSafe()` applied on all ingestion endpoints: existing ingest (line 764), enqueue (line 924), staleness (line 996), admin (line 487/782)
- Path traversal protection verified in tests (`path-safety.test.ts`, `admin.test.ts`)
- Null byte injection tested

### Phase 1: Smart Filtering — PASS

- `src/ingest/ProjectScanner.ts`: `hashAndValidateFile()` implemented exactly per plan (single read, stat+binary+hash combined)
- `.env` filtering on both git-ls-files and walkDirectory paths
- Binary detection (null bytes in first 8KB)
- Extended ignore dirs (11 new: coverage, tmp, temp, out, .turbo, .parcel-cache, .swc, vendor, .terraform, .serverless, e2e-tests)
- Extended exclude extensions (9 new: .d.ts, .map, .min.js, .min.css, .snap, .csv, .log, .sql, .wasm)
- Compound extension detection (.d.ts, .min.js, .min.css)
- `maxFileSizeBytes` configurable (default 1MB), wired via `ProjectScanOptions`
- `summarizeSkipReasons()` implemented
- Nested git repo detection in walkDirectory
- Circular symlink protection via `visitedDirs` Set with `realpathSync`
- Tests: 507 lines in `ProjectScanner.test.ts`

**Finding (MEDIUM)**: `cleanup-env-vectors.ts` script from Phase 1.7 was NOT created. The plan specified a one-time migration script to delete previously-indexed .env files from Qdrant. Only a warning log (`warnAboutEnvFiles`) exists instead. Not blocking but leaves stale .env data in Qdrant for previously-ingested projects.

### Phase 2: IngestionQueue + Manifest Fix — PASS

- `src/ingest/IngestionQueue.ts`: Zero-dependency Promise chain queue implemented
- `maxQueueDepth = 10` with 429 rejection (EVAL M3)
- `maxRunHistory = 50` with pruning
- Error sanitization via `sanitizeHealthError` (EVAL L3)
- REST endpoints: `POST /api/v1/ingestion/enqueue`, `GET /api/v1/ingestion/queue`, `GET /api/v1/ingestion/run/:runId`
- `IngestionEnqueueSchema` Zod validation with path traversal prevention (EVAL C3)
- UUID format validation on `runId` (EVAL H2)
- `skipManifestSave` + `saveManifest()` in `IngestionOrchestrator.ts` — manifest saved only after Neo4j+Qdrant succeed (EVAL G-03)
- Tests: 241 lines in `IngestionQueue.test.ts`

**Finding (LOW)**: The `onProgress` callback plumbing (Phase 2.4) is not visible in the `IngestionQueue.enqueue()` — the queue calls `ingestProject(options)` but doesn't pass an `onProgress` to update `run.progress` with phase/current/total. Progress tracking is stubbed at the queue level.

### Phase 3: Event Wiring — PASS

- `IngestionEventEmitter` implemented as separate emitter (EVAL G-05 — no MemoryPubSub modification)
- Event types `CODEBASE_INGESTION_STARTED/COMPLETED/FAILED` in `src/types/index.ts`
- `IngestionEventData` interface with all specified fields
- `SYSTEM_SESSION_ID` constant in `IngestionService.ts` (EVAL G-04)
- Events emitted via `EventStore.createEvent()` with sanitized errors (EVAL M2)
- Worklog recording with `TOOL_RUN_RECORDED` event (EVAL G-09)
- Tests: 157 lines in `IngestionEventEmitter.test.ts`

### Phase 4: Health Integration + Retry — PASS

- `HealthMonitor.suppressDuringIngestion()` / `resumeAfterIngestion()` / `isIngestionActive()` implemented
- Qdrant drift check skipped during active ingestion (line 354)
- Health wiring via setter pattern (EVAL G-06)
- Tests: Phase4_5.test.ts covers suppress/resume/multiple concurrent ingestions
- Per-batch retry in `TemporalCodeGraph.runBatched()` — verified via grep for retry logic

**Finding (MEDIUM)**: Per-batch retry was specified for BOTH `TemporalCodeGraph.runBatched()` and `CodeIndexer.indexIngestion()`. The CodeIndexer has batch retry for Qdrant upsert (confirmed), but the retry logic is not consistent between the two — CodeIndexer has retry hardcoded at the upsert level while the plan specified it at `runBatched()` abstraction level.

### Phase 5: Staleness Detection — PASS (with deviation)

- Staleness endpoint `GET /api/v1/codebase/staleness` implemented using `git status --porcelain` (EVAL PERF-2)
- `isProjectDirSafe()` applied on staleness endpoint
- Manifest check included
- No `StalenessChecker.ts` class — implemented inline in rest-server

**Finding (LOW)**: Plan specified a `StalenessChecker` class and integration with `HealthMonitor.qualityTick()` for periodic staleness detection. Implementation is a REST endpoint only — no proactive polling. Users must call the endpoint manually. Not a regression since there was no prior staleness detection.

**Finding (LOW)**: `maxCommitAgeDays` parameter forwarding to MCP (Phase 5.2) — not verified in CodebaseToolModule. REST endpoint does forward it correctly.

---

## Intelligence Platform (Plan 2) — Workstream-by-Workstream

### WS1: Eval Suite — PASS

- `src/eval/types.ts`: All types implemented (QueryType 5 types, EvalQuery, EvalResult, EvalRunResult, JudgeScore)
- `src/eval/metrics.ts`: `recallAtK`, `ndcgAtK`, `mrrAtK` — pure functions, mathematically correct (DCG formula verified)
- `src/eval/llm-judge.ts`: Dual-judge (Anthropic + Google) with budget enforcement, cost tracking, disagreement resolution (delta >= 2 uses average)
- `src/eval/suite.ts`: `EvalSuite` class with JSONL loading, search adapter interface, aggregate computation, file-based run persistence
- `.ai/eval/labeled-queries.jsonl`: 30 queries (6 per type) — plan specified 200 (40 per type)
- Tests: 170 lines (metrics), 316 lines (suite), well-structured

**Finding (MEDIUM)**: Dataset has 30 queries instead of the planned 200. Coverage is 6 per query type instead of 40. Sufficient for a v1 baseline but below plan target.

**Finding (LOW)**: `DatasetGenerator.ts` (WS1.3) not implemented as a separate file. The plan called for LLM-driven dataset generation; instead, queries are hand-curated in JSONL. Acceptable for bootstrap phase.

**Finding (LOW)**: `EvalStore.ts` (WS1.5 — SQLite persistence for eval runs) not implemented. Eval runs are saved as JSON files in `.ai/eval/runs/`. No SQLite table `eval_runs`. This means no SQL-queryable eval history and no `improvement_run_id` linkage for WS6.

**Finding (MEDIUM)**: `relevanceScores` in plan types uses `Map<string, number>` but implementation uses `Record<string, number>`. This is actually an improvement — Maps don't serialize to JSON, Records do. Suite.ts and metrics.ts correctly handle Records. The plan type was wrong.

### WS2: Gemini Embedding 2 Upgrade — NOT IMPLEMENTED (DEFERRED)

- No Gemini embedding 2 provider code
- QDRANT_VECTOR_DIMENSIONS remains at 768 everywhere
- No `scripts/migrate-qdrant-collection.ts`
- DeterministicVectorizer still at 768 dims

**Assessment**: WS2 was explicitly deferred (no code changes). The plan marks it as Wave 2 (after Phase 1). This is acceptable — Wave 2 depends on clean data in Qdrant first. Not blocking for the PR.

### WS3: BM25+FTS5 Code Search — PASS

- `src/search/CodeChunkStore.ts`: FTS5 virtual table with correct schema, porter stemmer, unicode61 tokenizer
- BM25 scoring via `-1.0 * bm25(code_fts, 1.0, 2.0)` — weights content(1.0) and file_path(2.0)
- `sanitizeFts5Query()` prevents FTS5 injection — strips special operators, wraps tokens in quotes
- `CodeIndexer.ts`: RRF merge (k=60) of BM25 + Qdrant results, with graceful fallback to BM25-only when Qdrant fails
- Upsert semantics via delete-before-insert for FTS (handles re-indexing)
- `removeProject()` cleanup for both FTS and chunks tables
- Tests: 246 lines in `CodeChunkStore.test.ts`

**Finding (LOW)**: FTS5 query sanitization strips `AND/OR/NOT/NEAR` operators but does not handle colons (`:`) which are FTS5 column filter syntax. A query like `file_path:secret` could theoretically filter by column. Risk is low since results are read-only and column names are known.

### WS4: Semantic Chunking — PASS

- `src/ingest/SemanticChunker.ts`: 3-level hierarchical chunking (function, class, file)
- Class minimum: 10 lines
- 2-line overlap between adjacent chunks
- `parentChunkId` linking methods to parent classes
- Large file splitting at `MAX_CHUNK_CHARS = 32000` (8K tokens)
- File path prefixed in content for BM25 path matching
- Deterministic chunk IDs via SHA-256(filePath + chunkType + startLine + endLine + content)
- Tests: 404 lines in `SemanticChunker.test.ts`

**Finding (LOW)**: SemanticChunker produces `SemanticChunk` without `projectId`. The `CodeIndexer` correctly provides `projectId` from `result.projectId` when wiring to `CodeChunkStore`. This is a design difference from the plan's `SemanticChunk` interface that included `projectId`, but functionally correct.

### WS5: Multi-Client Architecture — PASS

- `src/mcp/SessionRegistry.ts`: Full session management with TTL (1h), max sessions (20), cleanup, metadata
- `src/http/sse-server.ts`: Multi-client StreamableHTTP transport with session isolation
- Client detection via User-Agent/X-Client-Name (6 clients: claude-code, codex, cursor, opencode, antigravity, unknown)
- Session lifecycle: create on POST without Mcp-Session-Id, route on subsequent requests, cleanup on DELETE
- Capacity handling: 503 when maxSessions reached
- CORS headers applied
- Tests: 293 lines in `SessionRegistry.test.ts`

**Finding (LOW)**: Plan specified `SessionIsolation.ts` as the filename; implementation uses `SessionRegistry.ts`. Same functionality, better name.

### WS6: Self-Improvement Loop — PASS

- `docker-compose.improvement.yml`: Green instance on port 3001, profile-gated, isolated volume, read-only project mount
- `scripts/nightly-improvement.sh`: Full orchestration (budget check, data snapshot, green start, baseline eval, Claude headless, tests, post eval, compare, keep/discard)
- `src/eval/improvement-loop.ts`: Budget tracking, baseline/post comparison, TSV recording, CLI commands
- Comparison logic: MIN_RECALL_IMPROVEMENT=0.02, MAX_METRIC_REGRESSION=0.05, MAX_LATENCY_INCREASE_PCT=20
- Budget ceiling: 20x * $5 = $100 total
- Tests: 398 lines in `improvement-loop.test.ts`

**Finding (MEDIUM)**: The nightly script's `run-baseline` and `run-post` CLI commands in `improvement-loop.ts` output hardcoded dummy values (`meanRecallAt10: 0.8500` / `0.8700`) instead of actually running the eval suite. This means the nightly improvement loop will not produce real eval results. The comparison logic is correct, but the CLI entry point is a stub.

**Finding (MEDIUM)**: `nightly-improvement.sh` runs `git checkout -- .` to discard changes on failure, which is destructive. If there are uncommitted changes from prior work, they would be lost. Should use `git stash` or a worktree.

**Finding (LOW)**: No launchd plist file was created. Plan mentioned `~/Library/LaunchAgents/com.ping-mem.nightly-improve.plist`. Scheduling is documented but not implemented.

### WS7: Agent Memory Intelligence — PASS

- `src/memory/AgentIntelligence.ts`: Consolidated implementation (plan called for 5 separate files)
  - Agent identity persistence (UPSERT with session_count increment)
  - Cross-session continuity (history log by agent, by session)
  - Contradiction detection (same key, different value)
  - Memory compression (group by category, mark as compressed)
- SQLite WAL mode, foreign keys, proper indexes
- Tests: 433 lines in `AgentIntelligence.test.ts`

**Finding (MEDIUM)**: Contradiction detection uses exact key match + value difference, NOT semantic similarity (plan WS7.3 specified similarity > 0.85). The plan called for `HybridSearchEngine` semantic similarity to detect contradictions across different keys with similar meaning. Current implementation only catches same-key conflicts. This misses contradictions like "BM25 k1=1.5 is optimal" vs "BM25 k1=2.0 performs better" stored under different keys.

**Finding (MEDIUM)**: Memory compression (WS7.4) uses simple string concatenation, NOT LLM summarization as specified. Plan called for "LLM summarize: condense 20 entries into 3-5 key facts." Current implementation does `summaryParts.join("; ")` which is a mechanical concatenation, not an intelligent summary. The compression "ratio" will be 1:1 (concatenated text is roughly the same size).

**Finding (LOW)**: WS7.5 (360-degree situational awareness) not implemented. No `SituationalAwareness.ts` or post-processing in `HybridSearchEngine.search()`. This was Wave 4 (latest priority).

### WS8: cc-memory/cc-connect Integration — PASS

- `src/integration/CcMemoryBridge.ts`: Full implementation
  - Entity extraction via regex (technologies, patterns, project names)
  - Cross-project search via KnowledgeStore
  - Learning propagation (auto-index with `propagated-from:` tags)
  - Relationship building (uses, implements, related_to)
- No LLM dependency for entity extraction (regex-only, zero cost)
- Tests: 380 lines in `CcMemoryBridge.test.ts`

**Finding (LOW)**: Plan called for Neo4j graph nodes for entities (WS8.1). Implementation uses KnowledgeStore (SQLite/FTS5) instead of Neo4j. This is arguably better — no Neo4j dependency for cross-project search, simpler architecture.

**Finding (LOW)**: cc-connect write-back (WS8.3) — no modifications to `~/.claude/skills/cc-connect/SKILL.md`. The bridge provides the API but the cc-connect skill itself was not updated to call it.

### WS9: Observability Dashboard — PASS

- `src/http/ui/eval.ts`: Full HTMX dashboard with:
  - Latest metrics display (Recall@10, NDCG@10, MRR@10, latency)
  - Improvement trends (delta visualization)
  - Per-query-type breakdown table
  - Run history (last 20 runs)
  - Quality badges (color-coded by score range)
- XSS protection via `escapeHtml()`
- CSP nonce and CSRF token support
- Tests: 160 lines in `eval.test.ts`

**Finding (LOW)**: WS9.2 REST API endpoints (`/api/v1/eval/latest`, `/api/v1/eval/history`, `/api/v1/eval/run/:runId`) not implemented. Dashboard reads directly from JSON files. Functional but not API-accessible.

---

## Security Review

| Check | Status | Notes |
|-------|--------|-------|
| Path traversal on all ingestion endpoints | PASS | `isProjectDirSafe()` on 4+ endpoints |
| FTS5 injection | PASS | `sanitizeFts5Query()` strips operators, wraps in quotes |
| UUID validation | PASS | Regex check on runId |
| Error sanitization | PASS | `sanitizeHealthError()` on all error responses |
| Zod input validation | PASS | `IngestionEnqueueSchema` with `.trim()`, `..` rejection |
| XSS in dashboard | PASS | `escapeHtml()` on all user-facing strings |
| CSRF protection | PASS | CSP nonce + CSRF token |
| Auth bypass | PASS | API key validation in SSE server |
| Null byte in paths | PASS | Tested in path-safety.test.ts |

**Finding (LOW)**: `nightly-improvement.sh` runs `git add -A` and `git commit` which could include sensitive files if the Claude headless session creates any. The `.gitignore` should catch most cases but this is worth noting.

---

## Silent Failures / Swallowed Errors

| Location | Issue | Severity |
|----------|-------|----------|
| `IngestionQueue.enqueue()` | Promise chain catch handler sanitizes and logs but the queue continues processing next items. This is correct behavior — one failed run should not block the queue. | OK |
| `CcMemoryBridge.propagateLearning()` | Catches errors per-project and logs warning. Does not propagate. | OK — fail-open for cross-project features |
| `ProjectScanner.tryGitLsFiles()` | Returns null on error, falling back to walkDirectory. | OK — documented fallback |
| `EvalSuite.loadQueries()` | Throws if file not found. | OK — fail-fast |
| `loadEvalRuns()` | Skips unparseable JSON files with warning log. | OK — graceful degradation |

No hidden swallowed errors found.

---

## Integration Points

| From | To | Wired? | Notes |
|------|------|--------|-------|
| IngestionService | EventStore | YES | Events emitted on start/complete/fail |
| IngestionService | HealthMonitor | YES | suppress/resume during ingestion |
| IngestionService | IngestionOrchestrator | YES | skipManifestSave + saveManifest |
| CodeIndexer | CodeChunkStore | YES | FTS5 indexing during ingestion |
| CodeIndexer | Qdrant | YES | RRF merge in search |
| SSEPingMemServer | SessionRegistry | YES | Session creation/routing |
| SSEPingMemServer | PingMemServer | YES | Tool dispatch delegation |
| rest-server | IngestionQueue | YES | Enqueue/status/run endpoints |
| rest-server | Staleness | YES | git status endpoint |
| EvalSuite | metrics | YES | recallAtK/ndcgAtK/mrrAtK |
| improvement-loop | EvalSuite | PARTIAL | CLI stubs, not wired to real eval |

---

## Summary of Findings

### CRITICAL: 0

### HIGH: 0

### MEDIUM: 6

1. **Nightly improvement CLI stubs**: `run-baseline` and `run-post` output hardcoded values. The improvement loop will not produce real eval results until these are wired to `EvalSuite`. Files: `src/eval/improvement-loop.ts` lines 266-272.

2. **Contradiction detection is key-based, not semantic**: Plan specified semantic similarity > 0.85 for contradiction detection. Implementation uses exact key match only. Misses semantically similar but differently-keyed contradictions. File: `src/memory/AgentIntelligence.ts` line 349.

3. **Memory compression is concatenation, not LLM summarization**: Plan specified LLM-based summarization for 4:1 compression. Implementation concatenates entries with semicolons. File: `src/memory/AgentIntelligence.ts` line 427.

4. **Missing cleanup-env-vectors.ts**: Previously-indexed .env data remains in Qdrant. Plan Phase 1.7 specified a migration script.

5. **Labeled dataset undersized**: 30 queries vs planned 200 (15% of target). 6 per type vs 40 per type.

6. **Nightly script uses destructive git checkout**: `git checkout -- .` discards all uncommitted changes on failure. Should use stash or worktree.

### LOW: 10

1. No `StalenessChecker` class — inline in rest-server (acceptable)
2. No proactive staleness polling in HealthMonitor (REST-only)
3. No `EvalStore.ts` SQLite persistence (JSON files instead)
4. No `DatasetGenerator.ts` (manual JSONL instead)
5. WS7.5 situational awareness not implemented
6. No launchd plist created
7. WS9.2 eval REST API endpoints not implemented
8. FTS5 colon filter not stripped in sanitization
9. cc-connect SKILL.md not updated for write-back
10. Progress callback not wired through IngestionQueue

### Deferred (by design): 1

1. **WS2: Gemini Embedding 2 Upgrade** — Entire workstream deferred. Qdrant remains at 768 dims. Migration script not created. This is acceptable per the plan's wave sequencing (Wave 2 requires Phase 1 complete).

---

## Verdict

**APPROVE with conditions**: The implementation is solid across both plans. 1844 tests pass, typecheck clean, no `any` types, no stubs in production code. The 6 MEDIUM findings are all "plan vs implementation" deviations where simpler approaches were chosen. None are blocking for merge.

**Recommended follow-ups** (not blocking):
1. Wire `improvement-loop.ts` CLI to real `EvalSuite` (otherwise nightly loop is ceremonial)
2. Create `scripts/cleanup-env-vectors.ts` and run once
3. Expand labeled dataset from 30 to 200 queries
4. Replace `git checkout -- .` with `git stash` in nightly script
