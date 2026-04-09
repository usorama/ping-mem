# CLAUDE.md - ping-mem

**Version**: 3.0.0 | **Last Updated**: 2026-03-22

Universal Memory Layer for AI agents — persistent, intelligent, contextually-aware memory across sessions, tools, and applications. Consumed by openclaw, sn-assist, ro-new, understory, u-os.

## Agent Session Start

```json
{ "name": "context_session_start", "arguments": { "name": "agent-session", "projectDir": "/Users/umasankr/Projects/ping-mem", "autoIngest": true } }
```

## Dev Commands

```bash
bun install          # Install deps
bun run build        # Compile TypeScript
bun test             # Run tests (ALWAYS bun, never vitest/jest)
bun run typecheck    # Type check (0 errors required)
bun run lint         # Lint
bun run start        # REST server (:3003)
bun run start:sse    # SSE server
bun run dist/mcp/cli.js  # MCP stdio (deprecated — use proxy-cli.js)
PING_MEM_REST_URL=http://localhost:3003 bun run dist/mcp/proxy-cli.js  # MCP stdio (proxy mode, recommended)
```

**Quality gate**: `bun run typecheck && bun run lint && bun test`

## Key Rules

- **Port 3003** is mandatory for ping-mem — never use 3000 (except prod internal, Nginx handles it)
- **Codebase search** is GET `/api/v1/codebase/search?query=...` (NOT POST)
- **Health** is GET `/health` — always 200, no auth required
- **Neo4j + Qdrant** required for ingestion features; core memory works without them
- **ProjectId** = `SHA-256(remoteUrl + "::" + relativeToGitRoot)` — path-independent
- **Rate limit**: 60 requests/minute on `/api/v1/*` endpoints. Mining and dreaming endpoints are resource-intensive — use sparingly.

## MCP Tools

**Core** (`context_*`): `context_session_start`, `context_session_end`, `context_session_list`, `context_save`, `context_get`, `context_delete`, `context_search`, `context_auto_recall`, `context_checkpoint`, `context_status`, `context_hybrid_search`, `context_query_relationships`, `context_get_lineage`, `context_query_evolution`, `context_health`

**Codebase**: `codebase_ingest`, `codebase_verify`, `codebase_search`, `codebase_timeline`, `codebase_list_projects`, `codebase_impact`, `codebase_blast_radius`, `codebase_dependency_map`, `project_delete`

**Diagnostics**: `diagnostics_ingest`, `diagnostics_latest`, `diagnostics_list`, `diagnostics_diff`, `diagnostics_summary`, `diagnostics_summarize`, `diagnostics_compare_tools`, `diagnostics_by_symbol`

**Knowledge**: `knowledge_ingest`, `knowledge_search`

**Agents**: `agent_register`, `agent_quota_status`, `agent_deregister`

**Memory**: `memory_stats`, `memory_consolidate`, `memory_subscribe`, `memory_unsubscribe`, `memory_compress`, `memory_maintain`, `memory_conflicts`

**Worklog**: `worklog_record`, `worklog_list`

**Causal**: `search_causes`, `search_effects`, `get_causal_chain`, `trigger_causal_discovery`

**Mining**: `transcript_mine`, `dreaming_run`, `insights_list`

## Web UI & Admin

Routes: `/ui` `/ui/memories` `/ui/diagnostics` `/ui/ingestion` `/ui/agents` `/ui/knowledge` `/ui/sessions` `/ui/events` `/ui/worklog` `/ui/mining` `/ui/insights` `/ui/profile` `/admin`

## MCP Transport Modes

- **Proxy mode** (recommended): `PING_MEM_REST_URL=http://localhost:3003 bun run dist/mcp/proxy-cli.js` — all tools proxy through Docker, no DB opened in the MCP process
- **Direct mode** (deprecated): `bun run dist/mcp/cli.js` — opens DB directly, concurrent access issues with Docker

## Deployment

| Environment | Endpoint | Credentials |
|-------------|----------|-------------|
| Production | `https://ping-mem.ping-gadgets.com` | `~/Projects/.creds/ping-mem-prod-creds.md` |
| Local | `http://localhost:3003` | None |

## Detailed Reference (load on-demand)

| Topic | File |
|-------|------|
| REST API contract, consumer checklist, failure modes | `docs/claude/api-contract.md` |
| Architecture, components, project structure | `docs/claude/architecture.md` |
| Deployment, env vars, Docker, production | `docs/claude/deployment.md` |
| Integration examples (Claude Code, Node, Python, curl) | `docs/claude/integration-examples.md` |
| Ingestion pipeline, diagnostics, admin system | `docs/claude/ingestion-diagnostics.md` |
| Agent workflow reference | `~/.claude/ping-mem-agent-workflow.md` |

## Serena MCP

Re-index: `uvx --from git+https://github.com/oraios/serena serena project index .`
