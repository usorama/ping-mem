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
bun run dist/mcp/cli.js  # MCP stdio
```

**Quality gate**: `bun run typecheck && bun run lint && bun test`

## Key Rules

- **Port 3003** is mandatory for ping-mem — never use 3000 (except prod internal, Nginx handles it)
- **Codebase search** is GET `/api/v1/codebase/search?query=...` (NOT POST)
- **Health** is GET `/health` — always 200, no auth required
- **Neo4j + Qdrant** required for ingestion features; core memory works without them
- **ProjectId** = `SHA-256(remoteUrl + "::" + relativeToGitRoot)` — path-independent

## MCP Tools

**Core**: `context_session_start`, `context_save`, `context_get`, `context_search`, `context_checkpoint`, `context_restore`, `context_status`, `context_link`, `context_auto_recall`, `context_hybrid_search`, `context_query_relationships`, `context_get_lineage`

**Codebase**: `codebase_ingest`, `codebase_verify`, `codebase_search`, `codebase_timeline`

**Diagnostics**: `diagnostics_ingest`, `diagnostics_latest`, `diagnostics_diff`, `diagnostics_by_symbol`, `diagnostics_summarize`

**Agents**: `agent_register`, `agent_quota_status`, `agent_deregister`

**Knowledge**: `knowledge_ingest`, `knowledge_search`, `knowledge_get`

**Maintenance**: `memory_maintain`, `memory_conflicts`, `memory_subscribe`, `memory_unsubscribe`, `memory_compress`

**Worklog**: `worklog_record`, `worklog_list`

**Mining**: `transcript_mine`, `dreaming_run`, `insights_list`

## Web UI & Admin

Routes: `/ui` `/ui/memories` `/ui/diagnostics` `/ui/ingestion` `/ui/agents` `/ui/knowledge` `/ui/sessions` `/ui/events` `/ui/worklog` `/ui/mining` `/ui/insights` `/ui/profile` `/admin`

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
