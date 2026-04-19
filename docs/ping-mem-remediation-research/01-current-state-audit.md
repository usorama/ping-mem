# ping-mem Current-State Audit (R1)

**Date**: 2026-04-18
**Scope**: Factual audit of ping-mem subsystems relevant to remediation plan
**Method**: Read-only code inspection, no speculation

---

## 1. MCP Proxy (`src/mcp/proxy-cli.ts`)

**File(s)**: `/Users/umasankr/Projects/ping-mem/src/mcp/proxy-cli.ts` (150+ lines)

**Current behavior**:
- Reads `PING_MEM_REST_URL` (default: `http://localhost:3003`) and `PING_MEM_ADMIN_USER`/`PING_MEM_ADMIN_PASS` from environment (lines 28–30)
- Creates Basic Auth header if creds present: `` Buffer.from(`${ADMIN_USER}:${ADMIN_PASS}`).toString("base64") `` (lines 46–49)
- `checkDockerHealth(baseUrl)` polls `/health` with 5s timeout (lines 56–65)
- `waitForServer(maxWaitMs, pollIntervalMs)` retries health check in 2s intervals up to 10s (lines 87–103)
- `proxyToolCall(name, args, baseUrl, authHeader)` POST to `/api/v1/tools/:name/invoke` with timeout-aware timeout based on tool name (lines 110–136)
- Long-running tools get 120s budget; interactive get 15s default via `MCP_TOOL_TIMEOUT_MS` env var (lines 36–44, 124)
- No cred-reading code beyond `process.env`

**Gaps for remediation**:
- Proxy reads creds from env BUT Claude Code's MCP config in `~/.claude.json` passes only `PING_MEM_REST_URL` — so creds are never set at runtime → 403 on every tool invoke
- Fire-and-forget `tryStartDocker()` (lines 68–81) needs await or startup probe before first tool call
- No startup readiness polling implemented yet

**Reusable hooks**: `checkDockerHealth()`, `waitForServer()` can be extended for warm-up readiness checks

---

## 2. REST Admin Auth (`src/http/rest-server.ts` + `src/http/admin.ts`)

**File(s)**: `src/http/rest-server.ts` (lines 3628–3650), `src/http/admin.ts` (lines 1–200+)

**Current behavior**:
- `POST /api/v1/tools/:name/invoke` reads `PING_MEM_ADMIN_USER` and `PING_MEM_ADMIN_PASS` from env (lines 3632–3634)
- Rejects all requests if creds NOT configured (lines 3634–3638) — default-deny
- Parses Basic Auth header, compares with timing-safe comparison (lines 3640–3646)
- Uses `timingSafeStringEqual()` from `auth-utils.ts` (line 3646)
- `GET /api/v1/tools` and `GET /api/v1/tools/:name` are unprotected (lines 3595–3625) — tool schema discovery only
- `checkAdminRateLimit()` and `isLockedOut()` for brute-force protection (lines 110–192)
- Auth lockout after 5 failures for 30 min (lines 47–48)
- Admin rate limit: 20 req/min per IP (line 39)
- IP extraction respects `PING_MEM_BEHIND_PROXY` for X-Forwarded-For trust (lines 64–94)

**Gaps for remediation**:
- No auto-auth-header generation in proxy during startup
- Rate limiter is in `admin.ts` but not wired to Hono middleware layer (only manual calls at lines 340, 361, 3418, 3632)
- Proxy currently hardcodes auth header per-request; no session reuse

**Reusable hooks**: `timingSafeStringEqual()` is portable; `getRemoteIp()` logic can be extracted for centralized IP handling

---

## 3. Ingestion (`src/ingest/IngestionService.ts`, `src/ingest/IngestionOrchestrator.ts`)

**File(s)**: `src/ingest/` (13 files)

**Current behavior**:
- `IngestionService.ingestProject()` (IngestionService.ts:119–150): scans, chunks, graphs, vectors, verifies
- `maxCommits?: 200` default (IngestionService.ts:46, GitHistoryReader.ts:61)
- `maxCommitAgeDays: 30` default — older commits excluded (IngestionService.ts:129)
- `forceReingest?: boolean` option (IngestionService.ts:45)
- No incremental per-file tracking yet; re-scans entire project each time (unless manifest hash matches)
- `ManifestStore` tracks project tree hash for change detection (ManifestStore.ts exists)
- Returns `IngestProjectResult` with counts: `filesIndexed`, `chunksIndexed`, `commitsIndexed` (IngestionService.ts:50–58)

**Gaps for remediation**:
- No file watcher or directory-ingest code path (would need new CLI command)
- ping-learn gap (133 ingested vs 653 actual commits) = `maxCommits=200` + 30-day filter. No automatic re-ingest on new commits
- No max-files truncation visible; chunks are generated per file
- Ingestion queue (`IngestionQueue`) exists but not auto-triggered on file changes

**Reusable hooks**: `IngestionOrchestrator.ingest()` is the central orchestrator; hooks at phases (scan → chunk → graph → vector → verify)

---

## 4. LLM Integration (`src/llm/LLMProxy.ts`)

**File(s)**: `src/llm/LLMProxy.ts` (lines 1–250+)

**Current behavior**:
- Primary: Ollama at `http://localhost:11434` (default), model `llama3.2` (lines 18–19)
- Fallback 1: Gemini Flash (`gemini-2.0-flash`) via `GEMINI_API_KEY` (lines 21, 34)
- Fallback 2: OpenAI (presumed, not in LLMProxy; see `diagnostics` modules)
- Timeout: 8s for Ollama (line 20), configurable via `ollamaTimeoutMs` (line 33)
- `chat()` tries Ollama first, then Gemini (lines 41–59)
- `chatStream()` tries Ollama streaming, fallback to Gemini non-streaming (lines 65–101)
- Config inputs: `ollamaUrl`, `ollamaModel`, `ollamaTimeoutMs`, `geminiApiKey`

**Gaps for remediation**:
- No code path for Ollama embed model selection (docker-compose has `OLLAMA_EMBED_MODEL=nomic-embed-text` but not wired to LLMProxy)
- DreamingEngine uses `callClaude()` directly, bypasses LLM fallback chain
- No explicit error tracking for provider selection

**Reusable hooks**: `LLMProxy.chat()` and `chatStream()` are the entry points; fallback pattern is extensible

---

## 5. Memory Subsystem (`src/memory/MemoryManager.ts`, `src/search/`)

**File(s)**: `src/memory/MemoryManager.ts`, `src/search/` (VectorIndex, HybridSearchEngine, etc.)

**Current behavior**:
- SQLite schema: `memories` table (EventStore) with columns `key`, `value`, `category`, `priority`, `privacy`, `channel`, `sessionId`, `metadata`
- Neo4j: Entity extraction → nodes + relationships (graph/GraphManager.ts)
- Qdrant: Vector embeddings indexed by memory key (search/QdrantClient.ts)
- `MemoryManager.save(key, value, options)` inserts memory + emits event
- No file-watcher code path today
- Directory-ingest: NOT in `MemoryManager`; handled by `transcript_mine` tool (MiningToolModule.ts)
- `/api/v1/search` → hybrid search (BM25 + semantic) via `HybridSearchEngine`
- `/api/v1/codebase/search` → code search via `CodeIndexer` (rest-server.ts, line 1218)

**Gaps for remediation**:
- No observable signal when Qdrant is unavailable (fallback to BM25 silent)
- No `/api/v1/internal/readiness` deep probe endpoint yet

**Reusable hooks**: `MemoryManager.save()`, `search()`; `HybridSearchEngine` is the query router

---

## 6. CLI (`src/cli/cli.ts`, `src/cli/commands/`)

**File(s)**: `src/cli/cli.ts`, `src/cli/commands/` (16 subcommands)

**Current behavior**:
- Subcommands: `agent`, `auth`, `causal`, `codebase`, `config`, `context`, `daemon`, `diagnostics`, `graph`, `knowledge`, `memory`, `server`, `session`, `shell-hook`, `tools`, `worklog`
- `daemon` command exists (daemon.ts) — shell daemon for .zshrc hooks
- `codebase` command contains ingest logic
- No `ingest-dir` subcommand visible; ingest is via `POST /api/v1/ingestion/enqueue`
- `shell-hook` command — integration with Claude Code hooks
- No `doctor` or `health` subcommand visible

**Gaps for remediation**:
- No CLI health check command (would need new subcommand)

**Reusable hooks**: Modular command structure (`commands/` directory); `daemon.ts` is the shell daemon entry point

---

## 7. Observability (`src/observability/`, `src/http/ui/`)

**File(s)**: `src/observability/health-probes.ts`, `src/http/ui/` (dashboard, diagnostics, health partials)

**Current behavior**:
- `/health` endpoint (rest-server.ts:363–401) — returns JSON with component status (sqlite, neo4j, qdrant)
- Neo4j/Qdrant status based on driver object existence, NOT actual connectivity (passive object check)
- UI pages: `/ui/dashboard`, `/ui/diagnostics`, `/ui/health`, `/ui/sessions`, `/ui/memories`, `/ui/agents`, `/ui/knowledge`, `/ui/worklog`, `/ui/codebase`, `/ui/mining`, `/ui/ingestion`
- Health partials: `src/http/ui/partials/health.ts` renders health data
- No `/api/v1/internal/readiness` endpoint yet
- `HealthMonitor` class exists (observability/HealthMonitor.ts) but not fully integrated into `/health` response

**Gaps for remediation**:
- `/health` lies post-wake (reads stale driver state, doesn't probe backends)
- `/readiness` endpoint missing
- `HealthMonitor.lastSnapshot` not exposed in REST response

**Reusable hooks**: `HealthMonitor.probe()` and `snapshot()` methods can drive readiness endpoint

---

## 8. Admin Endpoints & Session Management

**File(s)**: `src/session/SessionManager.ts`, `src/admin/`

**Current behavior**:
- `maxActiveSessions: 10` default (SessionManager.ts:54)
- Enforced via mutex at `startSession()` (SessionManager.ts:256–261)
- No explicit session reaper; TTL-based auto-end at 1 hour idle (SessionManager.ts:56)
- No zombie session cleanup visible
- Admin endpoints for API key rotation, LLM config, project deletion (admin.ts)

**Gaps for remediation**:
- No active-session monitoring endpoint
- No reaper daemon for expired sessions (TTL-based auto-end exists but no background thread to evict)
- Session creation has no timeout (curl defaults to ~2min)

**Reusable hooks**: `SessionManager.startSession()`, `endSession()` methods; mutex pattern for concurrency

---

## 9. Docker Compose Files

**File(s)**: `docker-compose.yml`, `docker-compose.prod.yml`

**Current behavior**:
- `docker-compose.yml`: Neo4j, Qdrant, ping-mem service on `:3003` (local dev)
  - Volumes: `/projects` (host) → `/projects` (container rw) for ingestion
  - Health check: `nc -z 127.0.0.1 3003` (TCP port check only)
  - Env: `PING_MEM_TRANSPORT=rest`, `OLLAMA_URL=http://host.docker.internal:11434` (OrbStack-specific)
  - `NEO4J_PASSWORD=neo4j_password` hardcoded

- `docker-compose.prod.yml`: Same services, production-grade
  - Port: `127.0.0.1:3003:3003` (localhost-only binding)
  - Health check: `curl http://localhost:3003/health` (HTTP)
  - Env vars pulled from shell `.env` file
  - Memory limits: Neo4j 512m, Qdrant 512m, ping-mem 512m
  - Embedding env vars: `OLLAMA_URL`, `GEMINI_API_KEY`, `OPENAI_API_KEY` all present

**Gaps for remediation**:
- Dev compose health check is TCP-only (not HTTP); should probe `/health`
- Prod compose port 3003 may conflict with Nginx reverse proxy (port 3000 expectation)

---

## 10. Recent Plans Status

**Files**: `docs/plans/2026-03-22-*.md`, `2026-04-08-*.md`, `2026-04-09-*.md`

**Plan Summary**:

1. **2026-03-22-arch-single-owner-mcp-proxy-plan.md** (status: DONE — `src/mcp/proxy-cli.ts` functional)

2. **2026-04-08-feat-capability-closure-plan.md** (partially DONE — Gap-C1 done; Gap-C2 plist needs ThrottleInterval; Gap-H1-H3 done)

3. **2026-04-08-feat-client-reachability-reliability-plan.md** (partial — Phase 0 done; Phase 1 `/health` fix + `/readiness` NOT DONE; Phase 2 proxy startup poll NOT DONE; Phase 4 client config migration NOT DONE)

4. **2026-04-09-feat-full-capability-activation-plan.md** (65% done per VERIFY amendments — Phase 0 pop stash + regressions PENDING; Phase 3A plist PARTIAL; Phase 4D consumer migration unknown)

---

## Top 10 Concrete Integration Points for Remediation

1. **src/mcp/proxy-cli.ts:87–103** — `waitForServer()` must be called before first tool invocation (startup probe)
2. **src/http/rest-server.ts:363–401** — `/health` reads stale driver state; must call `HealthMonitor.probe()` before returning
3. **src/http/rest-server.ts:3628–3650** — `POST /api/v1/tools/:name/invoke` auth check; add `checkAdminRateLimit()` call
4. **src/http/rest-server.ts** — Add new `POST /api/v1/internal/warm-up` endpoint (MUST require admin auth via existing admin middleware, or bind loopback-only with token check — never expose unauthenticated)
5. **src/http/rest-server.ts** — Add new `GET /api/v1/internal/readiness` deep probe (Neo4j + Qdrant connectivity) (same auth requirement as warm-up; reject requests without valid admin credentials before calling `HealthMonitor.lastSnapshot()`)
6. **src/observability/HealthMonitor.ts** — Expose `lastSnapshot()` method to REST layer for `/health`
7. **src/config/runtime.ts:213–226** — `llmEntityExtractor` instantiation (DONE but verify threading)
8. **src/ingest/IngestionService.ts:119–150** — Add instrumentation for per-file change detection if file-watching is added
9. **src/session/SessionManager.ts:256–261** — Add timeout guard (30s max) to session creation mutex
10. **~/Library/LaunchAgents/com.ping-mem.daemon.plist** — Add `<key>ThrottleInterval</key><integer>10</integer>` and update log path to `~/Library/Logs/ping-mem-daemon.log`

---

**Provenance**: Agent R1 (Explore), 2026-04-18. Findings are factual from code inspection; no speculation.
