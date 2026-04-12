# ping-mem System-Zero Audit
**Date**: 2026-04-12
**Status**: VALIDATED (2 passes) — 4 verification agents + 3 second-opinion agents
**Pass 1**: 4 Sonnet agents verified dead code (17/17 confirmed), fetch timeouts (5 confirmed), test coverage (13 tools), missing caps (shell daemon, scripts, paro jobs)
**Pass 2**: 3 second-opinion agents (1 Haiku completeness, 1 Sonnet security, 1 Sonnet execution plan) found: 6 more dead files, 1 HIGH auth bypass, 1 MEDIUM timing oracle, execution plan improvements
**External**: Codex CLI failed (flag syntax), Gemini CLI failed (429 capacity exhausted)
**Corrections Applied**: 6 factual corrections, 2 new security findings, execution plan restructured

---

## The Three Personas

### Persona 1: AI AGENT (Primary — this is who we built it for)

The AI agent is a Claude Code instance, custom agent (understory, u-os-paro), or any
MCP-capable client that needs persistent, contextual memory across sessions.

**Capabilities (what the agent can do):**

| # | Capability | Entry Points | Status |
|---|-----------|-------------|--------|
| A1 | Start a memory session | `context_session_start` MCP / `POST /api/v1/session/start` | Active |
| A2 | End a session (triggers optional maintenance) | `context_session_end` MCP / `POST /api/v1/session/end` | Active |
| A3 | Save a memory (key-value with metadata) | `context_save` MCP / `POST /api/v1/context` | Active |
| A4 | Retrieve a memory by key | `context_get` MCP / `GET /api/v1/context/:key` | Active |
| A5 | Search memories (keyword + semantic) | `context_search` MCP / `GET /api/v1/search` | Active |
| A6 | Auto-recall relevant context (pre-prompt injection) | `context_auto_recall` MCP / `POST /api/v1/memory/auto-recall` | Active |
| A7 | Hybrid search (semantic + keyword + graph fusion) | `context_hybrid_search` MCP / `POST /api/v1/graph/hybrid-search` | Active |
| A8 | Delete a memory | `context_delete` MCP / `DELETE /api/v1/context/:key` | Active |
| A9 | Supersede a memory (archive old, save new) | `context_save` with existing key / `PUT /api/v1/context/:key` | Active |
| A10 | Create a session checkpoint | `context_checkpoint` MCP / `POST /api/v1/checkpoint` | Active |
| A11 | Get session status and stats | `context_status` MCP / `GET /api/v1/status` | Active |
| A12 | List recent sessions | `context_session_list` MCP / `GET /api/v1/session/list` | Active |
| A13 | Query entity relationships (graph) | `context_query_relationships` MCP / `GET /api/v1/graph/relationships` | Active (requires Neo4j) |
| A14 | Get entity lineage (ancestors/descendants) | `context_get_lineage` MCP / `GET /api/v1/graph/lineage/:entity` | Active (requires Neo4j) |
| A15 | Query entity evolution over time | `context_query_evolution` MCP / `GET /api/v1/graph/evolution` | Active (requires Neo4j) |
| A16 | Check service health | `context_health` MCP / `GET /health` | Active |
| A17 | Ingest a codebase (files + chunks + git history) | `codebase_ingest` MCP / `POST /api/v1/codebase/ingest` | Active (requires Neo4j + Qdrant) |
| A18 | Search code semantically | `codebase_search` MCP / `GET /api/v1/codebase/search` | Active (requires Neo4j + Qdrant) |
| A19 | Verify codebase ingestion status | `codebase_verify` MCP / `POST /api/v1/codebase/verify` | Active |
| A20 | Query commit timeline for a file/project | `codebase_timeline` MCP / `GET /api/v1/codebase/timeline` | Active (requires Neo4j) |
| A21 | Impact analysis (what depends on this file?) | `codebase_impact` MCP / `GET /api/v1/codebase/impact` | Active (requires Neo4j) |
| A22 | Blast radius (what does this file depend on?) | `codebase_blast_radius` MCP / `GET /api/v1/codebase/blast-radius` | Active (requires Neo4j) |
| A23 | Full dependency map for a project | `codebase_dependency_map` MCP / `GET /api/v1/codebase/dependency-map` | Active (requires Neo4j) |
| A24 | List ingested projects | `codebase_list_projects` MCP / `GET /api/v1/codebase/projects` | Active |
| A25 | Delete a project and all its data | `project_delete` MCP / `DELETE /api/v1/codebase/projects/:id` | Active |
| A26 | Ingest diagnostics (SARIF or findings array) | `diagnostics_ingest` MCP / `POST /api/v1/diagnostics/ingest` | Active |
| A27 | Get latest diagnostics run | `diagnostics_latest` MCP / `GET /api/v1/diagnostics/latest` | Active |
| A28 | List findings for an analysis | `diagnostics_list` MCP / `GET /api/v1/diagnostics/findings/:id` | Active |
| A29 | Diff two diagnostic analyses | `diagnostics_diff` MCP / `POST /api/v1/diagnostics/diff` | Active |
| A30 | Summary counts by severity | `diagnostics_summary` MCP / `GET /api/v1/diagnostics/summary/:id` | Active |
| A31 | Compare tools on same project state | `diagnostics_compare_tools` MCP / `GET /api/v1/diagnostics/compare` | Active |
| A32 | Group findings by symbol/file | `diagnostics_by_symbol` MCP / `GET /api/v1/diagnostics/by-symbol` | Active |
| A33 | Generate LLM narrative summary of diagnostics | `diagnostics_summarize` MCP / `POST /api/v1/diagnostics/summarize/:id` | Active (requires OpenAI) |
| A34 | Record a worklog entry | `worklog_record` MCP / `POST /api/v1/worklog` | Active |
| A35 | List worklog events | `worklog_list` MCP / `GET /api/v1/worklog` | Active |
| A36 | Search causal precursors | `search_causes` MCP / `GET /api/v1/causal/causes` | Active (requires Neo4j) |
| A37 | Search causal effects | `search_effects` MCP / `GET /api/v1/causal/effects` | Active (requires Neo4j) |
| A38 | Get causal chain between two entities | `get_causal_chain` MCP / `GET /api/v1/causal/chain` | Active (requires Neo4j) |
| A39 | Trigger causal discovery from text | `trigger_causal_discovery` MCP / `POST /api/v1/causal/discover` | Active (requires OpenAI) |
| A40 | Search knowledge base | `knowledge_search` MCP / `POST /api/v1/knowledge/search` | Active |
| A41 | Ingest knowledge entry | `knowledge_ingest` MCP / `POST /api/v1/knowledge/ingest` | Active |
| A42 | Register as a named agent with quota | `agent_register` MCP / `POST /api/v1/agents/register` | Active |
| A43 | Check quota status | `agent_quota_status` MCP / `GET /api/v1/agents/quotas` | Active |
| A44 | Deregister agent | `agent_deregister` MCP / `DELETE /api/v1/agents/:id` | Active |
| A45 | Subscribe to memory change events | `memory_subscribe` MCP (redirects to SSE) | **Partial** — MCP stub only |
| A46 | Unsubscribe from events | `memory_unsubscribe` MCP / `POST /api/v1/memory/unsubscribe` | Active |
| A47 | Get memory relevance stats | `memory_stats` MCP / `GET /api/v1/memory/stats` | Active |
| A48 | Consolidate stale memories | `memory_consolidate` MCP / `POST /api/v1/memory/consolidate` | Active |
| A49 | Compress memories into digest | `memory_compress` MCP / `POST /api/v1/memory/compress` | Active |
| A50 | Run full maintenance cycle | `memory_maintain` MCP | Active |
| A51 | Detect memory contradictions | `memory_conflicts` MCP | Active |
| A52 | Mine transcripts for facts | `transcript_mine` MCP / `POST /api/v1/mining/start` | Active (requires `claude` CLI) |
| A53 | Run dreaming cycle (derive insights) | `dreaming_run` MCP / `POST /api/v1/dreaming/run` | Active (requires `claude` CLI) |
| A54 | List derived insights | `insights_list` MCP / `GET /api/v1/insights` | Active |

### Persona 2: DEVELOPER / OPERATOR (Manages the system)

The operator deploys, monitors, and administers ping-mem instances.

**Capabilities:**

| # | Capability | Entry Points | Status |
|---|-----------|-------------|--------|
| D1 | View dashboard (stats, recent events) | `GET /ui` | Active |
| D2 | Explore memories (search, filter, detail) | `GET /ui/memories` | Active |
| D3 | View diagnostics runs and findings | `GET /ui/diagnostics` | Active |
| D4 | Monitor ingestion status and trigger reingest | `GET /ui/ingestion` + `POST /ui/partials/ingestion/reingest` | Active |
| D5 | Manage agents (view, search) | `GET /ui/agents` | Active |
| D6 | Browse knowledge base | `GET /ui/knowledge` | Active |
| D7 | View sessions (active/ended, detail, events) | `GET /ui/sessions` | Active |
| D8 | Browse full event log | `GET /ui/events` | Active |
| D9 | View worklog (tool runs, git ops, tasks) | `GET /ui/worklog` | Active |
| D10 | View codebase architecture diagram | `GET /ui/codebase` | Active |
| D11 | View eval dashboard (search quality metrics) | `GET /ui/eval` | Active |
| D12 | View derived insights | `GET /ui/insights` | Active |
| D13 | View mining progress and trigger mining | `GET /ui/mining` | Active |
| D14 | View/edit user profile | `GET /ui/profile` | Active |
| D15 | Chat with LLM about memories (UI chat) | `POST /ui/api/chat` | Active (requires Ollama or Gemini) |
| D16 | Admin panel (manage projects, API keys, LLM config) | `GET /admin` | Active |
| D17 | Rotate/deactivate API keys | `POST /api/admin/keys/rotate`, `/deactivate` | Active |
| D18 | Configure LLM provider | `GET/POST /api/admin/llm-config` | Active |
| D19 | Delete projects from admin | `DELETE /api/admin/projects` | Active |
| D20 | Health check (liveness probe) | `GET /health` | Active |
| D21 | Deep readiness check | `GET /api/v1/internal/readiness` | Active |
| D22 | Warm-up after recovery | `POST /api/v1/internal/warm-up` | Active |
| D23 | View OpenAPI spec | `GET /openapi.json` | Active |
| D24 | Real-time SSE event stream | `GET /api/v1/events/stream` | Active |
| D25 | Invoke any MCP tool via REST (RPC gateway) | `POST /api/v1/tools/:name/invoke` | Active |
| D26 | Enqueue async ingestion jobs | `POST /api/v1/ingestion/enqueue` | Active |
| D27 | Poll ingestion job status | `GET /api/v1/ingestion/queue`, `/run/:runId` | Active |
| D28 | Check codebase staleness | `GET /api/v1/codebase/staleness` | Active (REST-only, no MCP) |
| D29 | Extract facts from raw text | `POST /api/v1/memory/extract` | Active (REST-only, no MCP) |
| D30 | Get mining status | `GET /api/v1/mining/status` | Active (REST-only, no MCP) |

### Persona 3: SYSTEM / AUTONOMOUS (Runs without human trigger)

Background processes, health checks, and self-maintenance that operate continuously.

| # | Capability | Trigger | Status |
|---|-----------|---------|--------|
| S1 | Health monitoring (fast tick every 60s) | `HealthMonitor.start()` at daemon boot | Active |
| S2 | Quality checks (every 300s — Neo4j nulls, Qdrant drift, SQLite integrity) | `HealthMonitor` quality tick | Active |
| S3 | WAL auto-checkpoint (on WAL > 2MB) | `HealthMonitor` fast tick | Active |
| S4 | Session hydration on restart | `restServer.hydrateSessionState()` at startup | Active |
| S5 | Auto-checkpoint active sessions (every 5 min) | `SessionManager` interval timer | Active |
| S6 | Session TTL cleanup (evict stale sessions) | `SessionManager.cleanup()` | Active |
| S7 | Graceful shutdown (drain connections, close DBs) | SIGINT/SIGTERM handlers | Active |
| S8 | PubSub circuit breaker (auto-unsub bad listeners) | `MemoryPubSub` — 5 consecutive errors | Active |
| S9 | Alert deduplication (15-min window) | `HealthMonitor` | Active |
| S10 | Ingestion drift suppression during writes | `HealthMonitor.suppressDuringIngestion()` | Active |
| S11 | Periodic codebase ingestion (every 10 min, local only) | `com.ping-mem.periodic-ingest` launchd agent | Active (dev only) |
| S12 | Mining stale-session auto-recovery | `TranscriptMiner` — stuck >1hr reset to pending | Active |
| S13 | Neo4j circuit breaker (5 failures → open, 30s heal) | `cockatiel` service policy | Active |
| S14 | Qdrant circuit breaker (same pattern) | `cockatiel` service policy | Active |
| S15 | MCP streamable-http transport on `/mcp` | `SSEPingMemServer` + HTTP router | Active |
| S16 | Relevance decay scoring (FSRS-based) | `RelevanceEngine` on every memory access | Active |
| S17 | Shell daemon (Unix socket listener) | `ping-mem daemon` CLI / `$XDG_RUNTIME_DIR/ping-mem-<uid>.sock` | Active (dev only) |
| S18 | Ingestion queue serializer | `IngestionQueue` Promise chain — at most 1 ingest at a time | Active |

### Persona 4: PARO / SCHEDULED (External automation)

Jobs scheduled via `paro-jobs.yaml` and operator scripts.

| # | Capability | Trigger | Status |
|---|-----------|---------|--------|
| P1 | Autoresearch dreaming baseline | Weekly Paro job via `bin/aos-autoresearch dreaming` | Active |
| P2 | Autoresearch transcript miner | Weekly Paro job, up to 5 experiments | Active |
| P3 | Autoresearch entity extractor | Biweekly Paro job, up to 3 experiments | Active |
| P4 | Nightly improvement run | `scripts/nightly-improvement.sh` | Active |
| P5 | SQLite backup + R2 upload | `scripts/backup.sh` / `scripts/backup-r2.sh` | Active |
| P6 | Restore from backup | `scripts/restore.sh` | Active |
| P7 | API key rotation | `scripts/rotate-api-key.sh` | Active |
| P8 | Full Qdrant re-index | `scripts/reindex-qdrant.ts` | Active |
| P9 | Smoke test all capabilities | `scripts/test-all-capabilities.sh` | Active |
| P10 | Direct/force ingest (bypass queue) | `scripts/direct-ingest.ts` / `scripts/force-ingest.ts` | Active |
| P11 | Agent path safety audit | `scripts/agent-path-audit.sh` | Active |
| P12 | Knowledge graph seeding | `scripts/seed-knowledge.ts` | Active |
| P13 | Persistence verification | `scripts/verify-persistence.ts` | Active |

---

## Dead Code Findings *(all 17 claims independently verified)*

### Dead Modules — 18 files (Unified Ingestion + Migration + Eval execution + SARIF builders + Metrics)

**Unified Ingestion cluster (never wired, replacement-in-progress abandoned):**
- `src/ingest/UnifiedIngestionService.ts` — zero production importers
- `src/ingest/UnifiedIngestionOrchestrator.ts` — only imported by UnifiedIngestionService
- `src/ingest/DocumentParser.ts` — only imported by dead chain
- `src/graph/DocumentGraph.ts` — only imported by UnifiedIngestionService

**Migration cluster (one-time migration, now complete):**
- `src/migration/MigrationVerifier.ts` — zero production importers
- `src/migration/MigrationLedger.ts` — zero production importers
- `src/migration/MemoryKeeperReader.ts` — only imported by MigrationVerifier

**Eval execution (types used, runners dead):**
- `src/eval/suite.ts` — zero production importers
- `src/eval/llm-judge.ts` — only imported by suite.ts
- `src/eval/metrics.ts` — zero production importers
- `src/eval/improvement-loop.ts` — zero production importers

**SARIF builders (zero importers):** *(found by second-opinion review)*
- `src/diagnostics/eslint-sarif.ts` — zero importers anywhere in src/
- `src/diagnostics/prettier-sarif.ts` — zero importers anywhere in src/
- `src/diagnostics/tsc-sarif.ts` — zero importers anywhere in src/

**Metrics subsystem (zero production importers):** *(found by second-opinion review)*
- `src/metrics/MetricsCollector.ts` — only imported by its own test and index.ts
- `src/metrics/types.ts` — only imported within src/metrics/
- `src/metrics/index.ts` — barrel with zero external importers

### Dead Route Files — 7 (duplicated inline in rest-server.ts)

Every route in these files already exists **inline** in `rest-server.ts`. The files are never imported:
- `src/http/routes/graph.ts`
- `src/http/routes/causal.ts`
- `src/http/routes/worklog.ts`
- `src/http/routes/codebase-extra.ts`
- `src/http/routes/diagnostics-extra.ts`
- `src/http/routes/memory-extra.ts`
- `src/http/routes/tool-discovery.ts`

(`routes/openapi.ts` and `routes/shell.ts` are LIVE — imported by rest-server.ts)

### Dead Exports — 13 functions/classes

- `registerCodebaseExtraRoutes`, `registerDiagnosticsExtraRoutes`, `registerMemoryExtraRoutes`, `registerToolDiscoveryRoutes`, `registerGraphRoutes`, `registerCausalRoutes`, `registerWorklogRoutes` — all in dead route files
- `MigrationVerifier`, `MigrationLedger` classes
- `EvalSuite`, `EvalMetrics`, `ImprovementLoop` classes
- `UnifiedIngestionService`, `DocumentGraph`, `DocumentParser` classes

---

## MCP Tool Test Coverage Gap

**53 total MCP tools. Only 13 have handler-execution test coverage.** *(validated by independent agent)*

Tools with actual `callTool()`/`handle()` execution tests (13):
`context_session_start`, `context_save`, `context_session_end`, `context_auto_recall`,
`context_query_relationships`, `context_hybrid_search`, `context_get_lineage`,
`context_query_evolution`, `memory_conflicts`, `agent_register`, `agent_quota_status`,
`agent_deregister`, `codebase_impact`

**6 tools have schema-only tests** (checked TOOLS.find() shape, never dispatched):
`search_causes`, `search_effects`, `get_causal_chain`, `trigger_causal_discovery`,
`codebase_blast_radius`, `codebase_dependency_map`

**35 tools have ZERO test coverage of any kind** — including all of:
- Diagnostics (8 tools)
- Codebase except `codebase_impact` (5 tools)
- Memory (7 tools)
- Knowledge (2 tools)
- Mining/Dreaming (3 tools)
- Worklog (2 tools)
- Core context: `context_health`, `context_delete`, `context_checkpoint`, `context_status`, `context_session_list`, `context_get`, `context_search`

---

## REST-Only Endpoints (no MCP tool equivalent)

These are accessible only via HTTP, invisible to MCP agents:

| Endpoint | Purpose | Should it have an MCP tool? |
|----------|---------|-----------------------------|
| `GET /api/v1/codebase/staleness` | Check if project has uncommitted changes vs manifest | Maybe (useful for agents deciding when to reingest) |
| `POST /api/v1/ingestion/enqueue` | Async ingestion job queue | Maybe (agents could benefit from fire-and-forget) |
| `GET /api/v1/ingestion/queue` | Poll queue status | Yes, if enqueue gets a tool |
| `GET /api/v1/ingestion/run/:runId` | Poll specific job | Yes, if enqueue gets a tool |
| `POST /api/v1/memory/extract` | Heuristic fact extraction from raw text | Maybe (alternative to transcript_mine) |
| `POST /api/v1/observations/capture` | Capture tool-use observations from hooks | No (hook-specific, not agent-facing) |
| `GET /api/v1/mining/status` | Mining progress stats | Maybe (agents might want to check before running) |
| `POST /api/v1/shell/event` | Shell daemon event ingestion | No (daemon integration, not agent-facing) |
| `GET /api/v1/events/stream` | SSE push stream | No (transport-specific) |
| `GET/POST /api/v1/internal/*` | Readiness + warm-up | No (infrastructure-only) |

---

## External Dependency Degradation Map

| Dependency | Missing/Down at Startup | Fails at Runtime | Verdict |
|-----------|------------------------|-------------------|---------|
| **Neo4j** | 5 retries, then SQLite-only mode. Graph features disabled. | Circuit breaker (5 failures → open, 30s heal). MCP tools return structured errors. | GRACEFUL |
| **Qdrant** | 5 retries, then disabled. Search degrades to keyword-only. | HybridSearchEngine falls back to BM25-only on Qdrant failure. | GRACEFUL |
| **OpenAI API** | LLMEntityExtractor skipped (regex fallback). CausalDiscovery disabled. EmbeddingService chains Ollama → Gemini → OpenAI. | ContradictionDetector returns safe default. SemanticCompressor uses heuristic. | GRACEFUL |
| **`claude` CLI** | Not checked at startup. | DreamingEngine catches per-phase, continues. TranscriptMiner catches per-session, continues. | GRACEFUL (but no pre-flight check) |
| **Ollama** | Falls through to Gemini/OpenAI for embeddings. | **UNBOUNDED WAIT** — `fetch()` to localhost:11434 has no timeout. | **RISK** |
| **Gemini API** | Falls through to OpenAI for embeddings. | **UNBOUNDED WAIT** — `fetch()` to googleapis.com has no timeout. | **RISK** |
| **Cohere API** | Reranker not used if unavailable. | **UNBOUNDED WAIT** — `fetch()` to api.cohere.com has no timeout. | **RISK** |

---

## Security Findings

| Severity | Issue | Capability Impact | Validated |
|----------|-------|-------------------|-----------|
| **HIGH** | `POST /api/v1/tools/:name/invoke` RPC gateway has NO auth when `PING_MEM_ADMIN_USER`/`PING_MEM_ADMIN_PASS` are unset — exposes all 53 MCP tools to unauthenticated callers. Same pattern on `DELETE /api/v1/codebase/projects/:id` (rest-server.ts lines 3368, 3573) | ALL capabilities (A1-A54) | NEW — found by second-opinion security review |
| MEDIUM | Timing oracle on Basic Auth in tool-invoke and project-delete endpoints — uses `!==` instead of `timingSafeStringEqual` (rest-server.ts lines 3371, 3576). The `/ui/*` auth correctly uses constant-time comparison. | D25, A25 | NEW — found by second-opinion security review |
| MEDIUM | 5 `fetch()` calls without timeout — can hang indefinitely (EmbeddingService x2, Reranker, SummaryGenerator, CodeEmbeddingProvider, SemanticCompressor) | A5-A7 (search), A17 (ingest), A49 (compress) | CONFIRMED by independent agent |
| MEDIUM | OpenAI SDK `embeddings.create()` in EmbeddingService (line 305) also lacks timeout | A5-A7 (search) | NEW — found during validation |
| MEDIUM | `diagnostics_summarize` throws Error instead of returning structured error when summaryGenerator is null | A33 | CONFIRMED |
| LOW | `maxDepth` query param on `/api/v1/graph/lineage/:entity` allows up to 50 but `LineageEngine` clamps to 10 — API advertises capability it can't honor | A14 | NEW — found by second-opinion security review |
| LOW | No pre-flight check for `claude` CLI binary — produces non-obvious error messages | A52, A53 | CONFIRMED |
| LOW | `memory_subscribe` MCP tool is a stub (redirects to SSE) — agents can't get real-time events via MCP. Should return `NOT_IMPLEMENTED` structured error. | A45 | CONFIRMED + enhanced by execution plan review |

**Note**: LLMProxy.ts was originally listed as having unprotected fetch calls. Validation confirmed it IS properly protected (AbortController + setTimeout on all 3 fetch calls). Removed from findings.

---

## Naming Ambiguity

| MCP Tool | What It Does | Confusion Risk |
|----------|-------------|----------------|
| `diagnostics_summary` | Returns severity count breakdown (deterministic) | Easily confused with `diagnostics_summarize` |
| `diagnostics_summarize` | Generates LLM narrative summary | Easily confused with `diagnostics_summary` |

---

## Duplicate Surface Area (REST mirrors MCP)

Nearly every MCP tool has a corresponding REST endpoint with identical logic. This is **by design** — REST serves the UI and external HTTP consumers, MCP serves AI agents. However, the two surfaces are maintained separately in `rest-server.ts` (inline route handlers) and `src/mcp/handlers/*.ts` (tool modules), meaning:

- Bug fixes must be applied in two places
- Parameter validation may drift between REST and MCP
- 7 dead route files in `src/http/routes/` are remnants of an incomplete refactor to extract REST routes into modules (the extraction happened inline in rest-server.ts instead)

---

## Architecture Strengths

1. **EventStore as single source of truth** — append-only, replay-friendly, clean hydration
2. **Graceful degradation by design** — Neo4j/Qdrant/OpenAI all degrade to SQLite-only operation
3. **Circuit breakers on critical paths** — Neo4j and Qdrant wrapped with cockatiel policies
4. **BM25 determinism** — same corpus + same query = same scores, no embedding drift
5. **Agent isolation primitives** — write locks, quotas, scope-based visibility, PubSub filtering
6. **Bi-temporal code graph** — both codebase-time and ingestion-time tracked in Neo4j
7. **Serial ingestion queue** — prevents concurrent writes that would corrupt graph state
8. **UUID v7 for events** — monotonic, time-sortable, no ordering ambiguity within milliseconds
9. **Health monitor with alert dedup** — prevents alert storms, has severity escalation/de-escalation
10. **Dreaming engine with contradiction cleanup** — self-correcting insight generation

---

## Questions for System-Zero Validation

1. Are the 7 dead route files safe to delete, or is anything in the routes/index.ts barrel used by tests?
2. Is the UnifiedIngestionService an abandoned experiment or planned future work? (No GH issue found)
3. Is the migration/ cluster still needed, or was it a one-time MemoryKeeper → ping-mem migration?
4. Do any external consumers call `POST /api/v1/memory/extract` (REST-only)?
5. Is the eval execution code (`suite.ts`, `improvement-loop.ts`) dead or run via a separate script?
6. Should `memory_subscribe` be properly implemented for MCP, or is SSE-only acceptable?
7. Are the 6 unbounded `fetch()` calls causing actual hangs in production, or is this theoretical?

---

## Execution Plan (Revised after second-opinion review)

### Wave 0: Auth Fix (CRITICAL — before any other work)
0. **Default-deny on tool-invoke and project-delete**: Return 403 when admin credentials are unconfigured (rest-server.ts lines 3368, 3573). Replace `!==` with `timingSafeStringEqual` at both sites.

### Wave 1: Safety (no behavior change)
1. Create `src/util/fetchWithTimeout.ts` — shared `fetchWithTimeout(url, opts, ms)` utility using AbortController pattern from LLMProxy.ts. Apply to all 5 unprotected `fetch()` calls + 1 OpenAI SDK call.
2. Fix `diagnostics_summarize` to return structured error instead of throwing when summaryGenerator is null
3. Fix `memory_subscribe` MCP tool to return `NOT_IMPLEMENTED` structured error instead of a redirect message
4. Add `claude` CLI pre-flight check in ClaudeCli.ts

### Wave 2: Dead Code Cleanup
5. Delete 7 dead route files in `src/http/routes/` (keep openapi.ts and shell.ts)
6. Delete UnifiedIngestion cluster (4 files) — confirmed dead by 2 independent reviewers
7. Delete Migration cluster (3 files) — one-time migration, confirmed dead
8. Delete dead eval runners (3 files, keep types.ts)
9. Delete 3 SARIF builder files (`eslint-sarif.ts`, `prettier-sarif.ts`, `tsc-sarif.ts`) — zero importers
10. Delete `src/metrics/` subsystem (3 files + test) — zero production importers

### Wave 3: Test Coverage
11. Add handler-execution tests for untested MCP tools. Priority order (by call frequency + data-loss risk):
    - **Tier 1**: `context_get`, `context_search` (highest daily usage)
    - **Tier 2**: `context_checkpoint`, `context_delete`, `memory_consolidate`, `memory_maintain` (data-loss risk if silently broken)
    - **Tier 3**: All 8 diagnostics tools (completely untested)
    - **Tier 4**: `knowledge_search`, `knowledge_ingest`, `transcript_mine`, `dreaming_run`
    - **Tier 5**: Codebase tools except `codebase_impact` (need Neo4j/Qdrant fixtures)

### Wave 4: Polish
12. Add descriptions to `diagnostics_summary` and `diagnostics_summarize` in `tool-schemas.ts` to clarify the difference (NOT a rename — rename would break `mcp-smoke-test.sh`, external consumers)
13. Align `maxDepth` clamp: either raise `LineageEngine.DEFAULT_MAX_DEPTH` to 50 or lower the REST handler's clamp to 10
14. Consider extracting REST route handlers from rest-server.ts into proper route modules (the 7 dead files were an attempt at this)

---

## Phase 0 Mechanical Scan Results (2026-04-12)

**Scan performed**: Fresh Phase 0 scan cross-referenced against existing audit.
**Delta**: Audit claimed 5+1 unbounded fetch calls → Phase 0 found 6+1 (SummaryGenerator and SemanticCompressor were in wrong directory paths in audit).
**Dead code**: All 24 files confirmed dead by independent grep — zero live importers.
**MCP tools**: 52 registered (vs 53 in CLAUDE.md — delta of 1). 9 tested (17.3%).

### Already Fixed in Working Tree (uncommitted)
- SEC-4 (path traversal): `isProjectDirSafe` guards added to CodebaseToolModule.ts and ContextToolModule.ts
- SEC-5 (claude CLI): `--dangerously-skip-permissions` replaced with `--allowedTools ""`
- SEC-6 (timing-safe main auth): Main middleware at rest-server.ts:348 uses `timingSafeStringEqual`
- PERF-1 (BM25 batch): 500-doc transaction batches in BM25Scorer.ts
- PERF-2 (fire-and-forget LLM extraction): ContextToolModule.ts no longer blocks on entity extraction
- PERF-3 (blast radius LIMIT): TemporalCodeGraph.ts queryBlastRadius has LIMIT + timeout
- PERF-4 (listProjects denormalized): Count aggregation on Project node
- OBS-1 (health alerts surfaced): /health endpoint now surfaces critical alerts
- OBS-2 (structured logging): console.warn/error replaced with structured logger
- OBS-3 (error.name): constructor.name replaced with error.name
- INFRA-1 (CausalGraphManager): Wired in runtime.ts (was returning 503)
- INFRA-2 (MaintenanceRunner await): createEvent now awaited
- INFRA-3 (timer unref): SessionManager timer .unref() added
- INFRA-4 (ingestion queue routing): REST ingest routed through IngestionQueue
- INFRA-5 (HealthMonitor property): n.sha → n.hash fix
- INFRA-6 (.gitignore/.pingmemignore parsing): ProjectScanner filter updates

---

## Findings Index

### Security (still present)

- id: SEC-1
  type: auth-bypass
  path: src/http/rest-server.ts:3573
  claim: tool-invoke endpoint has no auth when PING_MEM_ADMIN_USER/PING_MEM_ADMIN_PASS are unset — exposes all MCP tools
  severity: HIGH
  status: OPEN

- id: SEC-2
  type: timing-oracle
  path: src/http/rest-server.ts:3575-3576
  claim: tool-invoke Basic Auth uses !== instead of timingSafeStringEqual
  severity: MEDIUM
  status: OPEN

### Unbounded Fetch (still present)

- id: TO-1
  type: missing-timeout
  path: src/search/EmbeddingService.ts:373
  claim: Gemini embedContent fetch() with no AbortSignal
  severity: MEDIUM
  status: OPEN

- id: TO-2
  type: missing-timeout
  path: src/search/EmbeddingService.ts:448
  claim: Ollama /api/embed fetch() with no AbortSignal
  severity: MEDIUM
  status: OPEN

- id: TO-3
  type: missing-timeout
  path: src/search/EmbeddingService.ts:305
  claim: OpenAI SDK embeddings.create() with no timeout option
  severity: MEDIUM
  status: OPEN

- id: TO-4
  type: missing-timeout
  path: src/search/Reranker.ts:98
  claim: Cohere rerank fetch() with no AbortSignal
  severity: MEDIUM
  status: OPEN

- id: TO-5
  type: missing-timeout
  path: src/search/CodeEmbeddingProvider.ts:84
  claim: Voyage AI embeddings fetch() with no AbortSignal
  severity: MEDIUM
  status: OPEN

- id: TO-6
  type: missing-timeout
  path: src/diagnostics/SummaryGenerator.ts:124
  claim: OpenAI chat completions fetch() with no AbortSignal
  severity: MEDIUM
  status: OPEN

- id: TO-7
  type: missing-timeout
  path: src/memory/SemanticCompressor.ts:108
  claim: OpenAI chat completions fetch() with no AbortSignal
  severity: MEDIUM
  status: OPEN

### Dead Code — Modules (confirmed by Phase 0 grep)

- id: DC-1
  type: dead-file
  path: src/ingest/UnifiedIngestionService.ts
  claim: zero production importers (abandoned experiment)

- id: DC-2
  type: dead-file
  path: src/ingest/UnifiedIngestionOrchestrator.ts
  claim: only imported by DC-1 (dead chain)

- id: DC-3
  type: dead-file
  path: src/ingest/DocumentParser.ts
  claim: only imported by dead chain

- id: DC-4
  type: dead-file
  path: src/graph/DocumentGraph.ts
  claim: only imported by DC-1 (dead chain)

- id: DC-5
  type: dead-file
  path: src/migration/MigrationVerifier.ts
  claim: zero production importers (one-time migration, complete)

- id: DC-6
  type: dead-file
  path: src/migration/MigrationLedger.ts
  claim: zero production importers

- id: DC-7
  type: dead-file
  path: src/migration/MemoryKeeperReader.ts
  claim: only imported by DC-5 (dead chain)

- id: DC-8
  type: dead-file
  path: src/eval/suite.ts
  claim: zero production importers (dead runner)

- id: DC-9
  type: dead-file
  path: src/eval/llm-judge.ts
  claim: only imported by DC-8 (dead chain)

- id: DC-10
  type: dead-file
  path: src/eval/metrics.ts
  claim: zero production importers

- id: DC-11
  type: dead-file
  path: src/eval/improvement-loop.ts
  claim: zero production importers (dead runner)

- id: DC-12
  type: dead-file
  path: src/diagnostics/eslint-sarif.ts
  claim: zero importers in src/

- id: DC-13
  type: dead-file
  path: src/diagnostics/prettier-sarif.ts
  claim: zero importers in src/

- id: DC-14
  type: dead-file
  path: src/diagnostics/tsc-sarif.ts
  claim: zero importers in src/

- id: DC-15
  type: dead-file
  path: src/metrics/MetricsCollector.ts
  claim: only imported within src/metrics/ (dead cluster)

- id: DC-16
  type: dead-file
  path: src/metrics/types.ts
  claim: only imported within src/metrics/ (dead cluster)

- id: DC-17
  type: dead-file
  path: src/metrics/index.ts
  claim: barrel with zero external importers

### Dead Code — Route Files (confirmed by Phase 0 grep)

- id: DR-1
  type: dead-route
  path: src/http/routes/graph.ts
  claim: zero importers, routes duplicated inline in rest-server.ts

- id: DR-2
  type: dead-route
  path: src/http/routes/causal.ts
  claim: zero importers, routes duplicated inline in rest-server.ts

- id: DR-3
  type: dead-route
  path: src/http/routes/worklog.ts
  claim: zero importers, routes duplicated inline in rest-server.ts

- id: DR-4
  type: dead-route
  path: src/http/routes/codebase-extra.ts
  claim: zero importers, routes duplicated inline in rest-server.ts

- id: DR-5
  type: dead-route
  path: src/http/routes/diagnostics-extra.ts
  claim: zero importers, routes duplicated inline in rest-server.ts

- id: DR-6
  type: dead-route
  path: src/http/routes/memory-extra.ts
  claim: zero importers, routes duplicated inline in rest-server.ts

- id: DR-7
  type: dead-route
  path: src/http/routes/tool-discovery.ts
  claim: zero importers, routes duplicated inline in rest-server.ts

### Behavioral / Error Handling

- id: BH-1
  type: error-handling
  path: src/mcp/handlers/ContextToolModule.ts (diagnostics_summarize handler)
  claim: throws Error instead of returning structured MCP error when summaryGenerator is null
  severity: MEDIUM
  status: OPEN

- id: BH-2
  type: stub-tool
  path: src/mcp/handlers/ContextToolModule.ts (memory_subscribe handler)
  claim: MCP tool is a stub that redirects to SSE — should return NOT_IMPLEMENTED structured error
  severity: LOW
  status: OPEN

### API Contract Mismatch

- id: AC-1
  type: api-mismatch
  path: src/graph/LineageEngine.ts + src/http/rest-server.ts
  claim: REST handler advertises maxDepth=50 but LineageEngine clamps to 10
  severity: LOW
  status: OPEN (LineageEngine depth clamping is FIXED in working tree but REST handler may still advertise 50)

### Naming Ambiguity

- id: NA-1
  type: naming-ambiguity
  path: src/mcp/handlers/ (diagnostics_summary vs diagnostics_summarize)
  claim: two tools with nearly identical names, very different behavior (deterministic counts vs LLM narrative)
  severity: LOW
  status: OPEN

### Test Coverage Gap

- id: TC-1
  type: untested-tools
  claim: 43/52 MCP tools have zero handler-execution tests
  severity: MEDIUM
  status: OPEN
  details: Only 9 tools tested — context_auto_recall, context_get_lineage, context_hybrid_search, context_query_evolution, context_query_relationships, context_save, context_session_end, context_session_start, memory_conflicts

---

## Finding Totals

| Category | Count | Severity Breakdown |
|----------|-------|-------------------|
| Security | 2 | 1 HIGH, 1 MEDIUM |
| Unbounded fetch | 7 | 7 MEDIUM |
| Dead code (modules) | 17 | — |
| Dead code (routes) | 7 | — |
| Behavioral/error | 2 | 1 MEDIUM, 1 LOW |
| API mismatch | 1 | 1 LOW |
| Naming ambiguity | 1 | 1 LOW |
| Test coverage | 1 (43 tools) | 1 MEDIUM |
| **Total findings** | **38** | **1 HIGH, 10 MEDIUM, 3 LOW, 24 dead code** |

*Already fixed in working tree (not counted above): 16 items across security, performance, observability, and infrastructure.*
