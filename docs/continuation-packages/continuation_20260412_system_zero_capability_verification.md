# Continuation Package: ping-mem Capability Verification & Ingestion Pipeline Fixes
**Date**: 2026-04-12
**From**: Haiku 4.5 + Opus 4.6 (orchestrator session)
**To**: Opus 4.6 agent working on audit cleanup
**Context**: `.ai/system-zero-audit-20260412.md` is the source audit. This package adds deployment-time findings that the static audit couldn't surface.

---

## What happened in this session

We ran `/system-zero` (full code + plan + runtime verification), deployed to local OrbStack, then discovered that passing code review and passing tests means nothing if the running system doesn't work. The gap between "tests pass" and "capabilities work" was enormous.

## Critical findings the audit agent should integrate

### 1. The ingestion pipeline was fundamentally broken

The audit found dead code and missing tests. What it couldn't find: **codebase ingestion crashed every time** on ping-mem's own codebase. Three distinct root causes, all fixed:

| Root Cause | Symptom | Fix Applied |
|-----------|---------|-------------|
| BM25 index shared the same SQLite file as EventStore | `SQLITE_IOERR_SHORT_READ` during Qdrant indexing phase after 8min Neo4j persist | Separated into `ping-mem-bm25.db` (`src/http/server.ts:46`) |
| BM25 `indexDocumentsBatch` wrote 18K docs in one transaction | I/O pressure on Docker virtio-fs layer | Batched into 500-doc transactions (`src/search/BM25Scorer.ts:145`) |
| `git ls-files` returned committed node_modules/junk | 60K symbols, 160K Qdrant vectors, search returned playwright types | Added `.gitignore` + `.pingmemignore` parsing in `ProjectScanner.ts:224-240` |
| `/api/v1/codebase/ingest` bypassed IngestionQueue | Concurrent ingests deadlocked Neo4j (ForsetiClient lock contention) | Routed through `IngestionQueue.enqueueAndWait()` (`rest-server.ts:1085`) |
| `listProjects` Cypher did cartesian OPTIONAL MATCH across 160K relationships | 120s timeout on every call | Denormalized counts onto Project node (`TemporalCodeGraph.ts:84-101`) |

**Advice to the cleanup agent**: The audit's Wave 2 (dead code cleanup) is safe to execute. But if you touch anything in `src/ingest/`, `src/search/BM25Scorer.ts`, `src/graph/TemporalCodeGraph.ts`, or `src/http/rest-server.ts` — you're in the blast radius of these fixes. Read the diff before refactoring.

### 2. The health probe had a property-name bug masking real issues

The audit found the health monitoring architecture is sound (Architecture Strength #9). What it missed: `HealthMonitor.ts:68` checked `n.sha IS NULL` on Commit nodes, but the actual property is `n.hash`. Every Commit node registered as a "null orphan" — the 955-node alert was a false positive. **Fixed**: changed to `n.hash IS NULL`.

The audit also found `SQLITE_IOERR` integrity failures — those were real, caused by disk space exhaustion (568MB free on 460GB). The DB was recovered via dump/restore + REINDEX.

### 3. The smoke test (`scripts/mcp-smoke-test.sh`) now tests all 53 MCP tools

The audit identified that 39/53 MCP tools have zero handler-execution tests. The smoke test doesn't replace unit tests, but it does verify every tool is wired and responding against the live container. Results from the last clean run: **40 PASS, 0 FAIL, 14 SKIP** (rate limited).

The rate limiting (60 req/min) is shared across ping-guard + periodic-ingest + any manual calls. The smoke test consumes the entire budget. **Recommendation**: exempt localhost from rate limiting (one `if` in `src/http/middleware/rate-limit.ts`).

### 4. What ping-mem's own search can and cannot find

We tested ping-mem's codebase search against the audit findings. Honest results:

**Can find (~20% of audit findings):**
- Code patterns matching keywords (vitest imports, console.warn usage, error handling patterns)
- File content matching semantic queries ("HealthMonitor sqlite integrity" → correct file at 0.755 score)

**Cannot find (the other 80%):**
- Dead code (12 dead modules, 7 dead route files) — requires import graph analysis, not keyword search
- Missing test coverage (39 untested tools) — requires test inventory comparison
- Architectural issues (REST/MCP surface duplication, naming ambiguity)
- Security patterns ("this flag shouldn't be here") — requires policy knowledge
- Unbounded fetch() calls — requires timeout analysis, not text matching

**`codebase_impact` timed out** when asked about `runtime.ts` — the Neo4j graph query infrastructure works for small queries but chokes on whole-project analysis. This is a known limitation that the audit's "Graceful degradation" strength (Architecture Strength #2) doesn't cover — it degrades gracefully for *external* dependencies but not for its own graph queries being too expensive.

### 5. `.pingmemignore` is now a thing

Per-project ignore files were created for ping-learn, ping-learn-mobile, sn-assist, and thrivetree. The implementation is in `ProjectScanner.ts:224-240`. It supports directory names and path prefixes (e.g., `curriculum/reviews/`). No glob support yet.

GH issue [#114](https://github.com/usorama/ping-mem/issues/114) tracks the full ingestion filter audit with per-project findings and numbers.

### 6. Fixes from /system-zero that are deployed but not committed

All these changes are in the working tree (not yet committed). The cleanup agent should be aware they exist:

**Security fixes:**
- `CodebaseToolModule.ts` + `ContextToolModule.ts`: Added `isProjectDirSafe()` guard on MCP handlers
- `rest-server.ts:348`: Basic Auth switched to `timingSafeStringEqual`
- `ClaudeCli.ts:53`: `--dangerously-skip-permissions` replaced with `--allowedTools ""`
- `LineageEngine.ts`: Depth clamped to prevent DoS via unclamped Cypher traversal

**Performance fixes:**
- `ContextToolModule.ts:449-472`: LLM entity extraction made fire-and-forget (was blocking context_save for 300-800ms)
- `TemporalCodeGraph.ts:815`: `queryBlastRadius` now has LIMIT + timeout
- `ContextToolModule.ts:962`: RECALL_MISS emission has 60s cooldown

**Observability fixes:**
- `rest-server.ts:400-406`: `/health` now surfaces critical alerts from HealthMonitor (was returning "ok" during active CRITICAL alert)
- `MemoryManager.ts:608`, `MemoryPubSub.ts:106`: `console.warn`/`console.error` replaced with structured logger
- `rest-server.ts:3981`: `constructor.name` replaced with `error.name` (survives minification)

**Infrastructure fixes:**
- `runtime.ts:143`: CausalGraphManager now wired (was returning 503 on all 4 causal endpoints)
- `MaintenanceRunner.ts:293`: `createEvent` now awaited (was fire-and-forget with silent failures)
- `SessionManager.ts:604`: Timer `.unref()` added (was preventing process exit)
- `IngestionService.ts:481`: INGESTION_FAILED event write at `error` level (was `warn`)
- `insights.ts:77`: Bare catch replaced with `log.error` + user-facing error message

**LLM prompt extraction (for autoresearch):**
- DreamingEngine, LLMEntityExtractor, CausalDiscoveryAgent, TranscriptMiner prompts extracted to `.md` files in `src/*/prompts/`
- Loaded at runtime via `fs.readFileSync` with inline fallback
- Autoresearch configs created in `config/autoresearch/`
- `paro-jobs.yaml` updated with weekly autoresearch schedules

---

## Advice for the cleanup agent

1. **Don't separate the work.** The audit's Wave 2 (dead code cleanup) and these deployment fixes should be committed together. They're all uncommitted changes on the same branch. A single PR with a clear commit message is better than two PRs that could conflict.

2. **The audit's 7 dead route files ARE safe to delete.** `routes/index.ts` barrel exports them, but nothing imports from the barrel. Grep for the function names — zero callers outside the files themselves. Keep `routes/openapi.ts` and `routes/shell.ts` (those are live).

3. **The UnifiedIngestion cluster is dead.** No GH issue, no references in any plan. It was an abandoned experiment. Delete it. Same for the Migration cluster — the MemoryKeeper migration was a one-time event in March 2026, complete and verified.

4. **The eval execution code is partially dead.** `suite.ts` and `improvement-loop.ts` are dead runners. But `metrics.ts` exports types used by `src/eval/__tests__/metrics.test.ts` and `src/http/ui/__tests__/eval.test.ts`. Check before deleting `metrics.ts` — the types may need to survive.

5. **The 6 unbounded fetch() calls are real.** The audit flagged them as MEDIUM severity. They're in: `EmbeddingService.ts` (Ollama + Gemini), `Reranker.ts` (Cohere), `SummaryGenerator.ts` (OpenAI), `CodeEmbeddingProvider.ts`, `SemanticCompressor.ts`. Add `signal: AbortSignal.timeout(30_000)` to each. This is Wave 1 in the audit's execution plan and should be done first — it's the only safety-critical fix.

6. **Run `bash scripts/mcp-smoke-test.sh` after every change.** It's the only thing that proves the deployed system works. Unit tests pass with mocks that don't reflect reality. The smoke test hits the live container.

7. **Commit all changes, then rebuild the Docker image.** The current deployed container has the fixes but not the dead code cleanup. After cleanup: `bun run build && docker compose build --no-cache ping-mem && docker compose stop ping-mem && docker compose rm -f ping-mem && docker compose up -d ping-mem`.

---

## Files modified (uncommitted)

```
M  src/config/runtime.ts                    (CausalGraphManager wiring, import)
M  src/dreaming/DreamingEngine.ts           (prompt loading from .md files)
M  src/graph/CausalDiscoveryAgent.ts        (prompt loading from .md files)
M  src/graph/LLMEntityExtractor.ts          (prompt loading from .md files)
M  src/graph/LineageEngine.ts               (depth clamping)
M  src/graph/TemporalCodeGraph.ts           (queryBlastRadius LIMIT, listProjects denormalized, Project node counts)
M  src/http/rest-server.ts                  (timing-safe auth, health alerts, ingestion queue routing, error.name)
M  src/http/server.ts                       (CausalGraphManager wiring, BM25 separate DB)
M  src/http/ui/partials/insights.ts         (bare catch → log.error)
M  src/ingest/IngestionQueue.ts             (enqueueAndWait method)
M  src/ingest/IngestionService.ts           (INGESTION_FAILED log level)
M  src/ingest/ProjectScanner.ts             (.gitignore + .pingmemignore parsing, filter updates)
M  src/llm/ClaudeCli.ts                     (--allowedTools replaces --dangerously-skip-permissions)
M  src/maintenance/MaintenanceRunner.ts     (await createEvent)
M  src/mcp/__tests__/auto-recall.test.ts    (cooldown reset import)
M  src/mcp/handlers/CodebaseToolModule.ts   (isProjectDirSafe guard)
M  src/mcp/handlers/ContextToolModule.ts    (isProjectDirSafe, fire-and-forget LLM, RECALL_MISS cooldown)
M  src/memory/MemoryManager.ts              (console.warn → log.warn)
M  src/mining/TranscriptMiner.ts            (prompt loading from .md files)
M  src/observability/HealthMonitor.ts       (n.sha → n.hash)
M  src/pubsub/MemoryPubSub.ts              (console.error → log.error)
M  src/search/BM25Scorer.ts                 (batch transactions)
M  src/session/SessionManager.ts            (timer.unref)
A  config/autoresearch/*.yaml               (3 files)
A  paro-jobs.yaml                           (autoresearch schedules)
A  scripts/mcp-smoke-test.sh                (53-tool verification)
A  src/dreaming/prompts/*.md                (2 files)
A  src/graph/prompts/*.md                   (2 files)
A  src/mining/prompts/*.md                  (1 file)
```
