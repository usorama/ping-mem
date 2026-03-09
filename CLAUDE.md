# CLAUDE.md - ping-mem

**Version**: 2.0.0 | **Last Updated**: 2026-03-09

## What is ping-mem?

Universal Memory Layer for AI agents — persistent, intelligent, contextually-aware memory across sessions, tools, and applications. Self-contained infrastructure consumed by other projects (openclaw, sn-assist, ro-new, etc.).

---

## Agent Workflow Reference

All agents: start session with auto-ingest.

```json
{
  "name": "context_session_start",
  "arguments": {
    "name": "agent-session",
    "projectDir": "/Users/umasankr/Projects/ping-mem",
    "autoIngest": true
  }
}
```

Full workflow: `~/.claude/ping-mem-agent-workflow.md`

---

## Key Ports & Endpoints

| Service | Port | Purpose |
|---------|------|---------|
| ping-mem (MCP/SSE) | 3000 | MCP stdio, SSE streaming |
| ping-mem-rest | 3003 | REST API |
| Neo4j | 7687 | Temporal code graph |
| Qdrant | 6333 | Semantic search |

### Critical REST API Endpoints

| Method | Endpoint | Notes |
|--------|----------|-------|
| GET | `/health` | Lightweight liveness (SQLite SELECT 1 only) |
| GET | `/api/v1/observability/status` | Full system health probe |
| POST | `/api/v1/codebase/ingest` | `{projectDir, forceReingest?}` |
| GET | `/api/v1/codebase/search` | Query params: `query`, `projectId`, `type`, `limit` — **GET not POST** |
| GET | `/api/v1/codebase/timeline` | `projectId`, `filePath`, `limit` |
| POST | `/api/v1/agents/register` | `{agentId, role, admin?, ttlMs?, quotaBytes?, quotaCount?}` |
| POST | `/api/v1/knowledge/ingest` | `{projectId, title, solution, symptoms?, rootCause?, tags?}` |
| POST | `/api/v1/knowledge/search` | `{query, projectId?, crossProject?, tags?, limit?}` |
| GET | `/api/v1/events/stream` | SSE real-time events |

---

## Development Commands

```bash
bun install          # Install deps
bun run build        # Compile TypeScript
bun test             # Run tests (ALWAYS bun, never vitest/jest)
bun run typecheck    # Type check (0 errors required)
bun run lint         # Lint

# Servers
bun run start        # REST mode (default)
bun run start:sse    # SSE mode
bun run start:rest   # REST explicit

# MCP
bun run dist/mcp/cli.js

# Diagnostics
bun run diagnostics:collect --projectDir . --sarifPaths "..."
bun run scripts/force-ingest.ts <projectDir>
```

**Quality gate** (must all pass before commit): `bun run typecheck && bun run lint && bun test`

---

## Project Structure (Key Files)

```
src/
  config/runtime.ts          # Centralized service initialization
  mcp/PingMemServer.ts       # MCP server
  http/rest-server.ts        # REST API (Hono)
  http/admin.ts              # Admin panel + API key mgmt
  http/server.ts             # HTTP entry point
  http/ui/                   # HTMX server-rendered UI
  ingest/IngestionService.ts # High-level ingestion API
  ingest/ProjectScanner.ts   # Merkle tree + manifest (path-independent projectId)
  observability/HealthMonitor.ts   # Self-healing health monitor
  observability/health-probes.ts   # SQLite/Neo4j/Qdrant probes
  util/auth-utils.ts         # timingSafeStringEqual, sha256, randomHex
  util/CircuitBreaker.ts     # Circuit breaker with handler isolation
  storage/EventStore.ts      # Immutable append-only SQLite log
  memory/                    # Core CRUD + SemanticCompressor
  session/SessionManager.ts  # Session lifecycle
  pubsub/                    # MemoryPubSub real-time events
  knowledge/                 # KnowledgeStore FTS5
  graph/TemporalCodeGraph.ts # Neo4j bi-temporal code graph
  search/CodeIndexer.ts      # Qdrant code search
.ping-mem/manifest.json      # Incremental ingestion state
```

---

## Cross-Project Integration Contract

**ProjectId**: `SHA-256(remoteUrl + "::" + relativeToGitRoot)` — path-independent, same across Docker/local.

**Docker volume**: Host `/Users/umasankr/Projects` → Container `/projects`

**Registered projects**: `~/.ping-mem/registered-projects.txt`

### Failure Modes

| Symptom | Cause | Fix |
|---------|-------|-----|
| 503 on codebase endpoints | IngestionService not initialized | Restart `ping-mem-rest` container |
| Empty search results | Project not ingested | Run force-ingest script |
| Connection refused :3003 | REST container down | `docker-compose up -d ping-mem-rest` |
| ECONNREFUSED :6333 | Qdrant down | `docker restart ping-mem-qdrant` |

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PING_MEM_DB_PATH` | No | `:memory:` | SQLite database path |
| `NEO4J_URI` | For ingestion | | `bolt://localhost:7687` |
| `NEO4J_USERNAME` / `NEO4J_PASSWORD` | For ingestion | | Neo4j credentials |
| `QDRANT_URL` | For ingestion | | `http://localhost:6333` |
| `QDRANT_COLLECTION_NAME` | No | `ping-mem-vectors` | |
| `OPENAI_API_KEY` | Optional | | ML embeddings + LLM summaries |
| `PING_MEM_API_KEY` | For auth | | Seed API key |
| `PING_MEM_ADMIN_USER` / `PING_MEM_ADMIN_PASS` | For admin | | Basic Auth |
| `PING_MEM_SECRET_KEY` | For encryption | | AES-256-GCM key encryption |
| `PING_MEM_PORT` | No | 3000 | HTTP port |

---

## MCP Tools Reference

**Core**: `context_session_start`, `context_save`, `context_get`, `context_search`, `context_checkpoint`, `context_restore`, `context_status`, `context_link`

**Codebase**: `codebase_ingest`, `codebase_verify`, `codebase_search`, `codebase_timeline`

**Diagnostics**: `diagnostics_ingest`, `diagnostics_latest`, `diagnostics_diff`, `diagnostics_by_symbol`, `diagnostics_summarize`

**Agents**: `agent_register`, `agent_quota_status`, `agent_deregister`

**Knowledge**: `knowledge_ingest`, `knowledge_search`, `knowledge_get`

**Worklog**: `worklog_record`, `worklog_list`

**PubSub**: `memory_subscribe`, `memory_unsubscribe`, `memory_compress`

---

## Web UI Routes

`/ui` dashboard · `/ui/memories` · `/ui/diagnostics` · `/ui/ingestion` · `/ui/agents` · `/ui/knowledge` · `/ui/sessions` · `/ui/events` · `/ui/worklog` · `/admin`

---

## Key Design Decisions

- **SQLite**: Core storage (always available, no deps)
- **Neo4j + Qdrant**: Required for ingestion features; optional for core memory
- **Event sourcing**: Immutable append-only EventStore, all state derived from events
- **Ingestion pipeline**: ProjectScanner → CodeChunker → GitHistoryReader → Neo4j → Qdrant
- **Explicit "why" only**: Commit message `Why:`, `Reason:`, `Fixes #` — never inferred
- **Security**: AES-256-GCM API keys, timingSafeEqual auth, CSRF protection, rate limiting

## Deployment

| Environment | Endpoint | Credentials |
|-------------|----------|-------------|
| Production | `https://ping-mem.ping-gadgets.com` | `~/Projects/.creds/cloudflare.json` |
| Local | `http://localhost:3000` | None |

---

## Serena MCP

Enabled for semantic code navigation. Always verify Serena results with Grep/Glob.

Re-index: `uvx --from git+https://github.com/oraios/serena serena project index .`

---

## Codebase Audit Status

All 66 audit findings resolved in v2.0.0. Current branch `feat/self-healing-health-monitor` (PR #24) under active PR Zero review.
