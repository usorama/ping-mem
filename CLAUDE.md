# CLAUDE.md - ping-mem

**Version**: 3.1.0 | **Last Updated**: 2026-04-13

Universal Memory Layer for AI agents — persistent, intelligent, contextually-aware memory across sessions, tools, and applications. Consumed by openclaw, sn-assist, ro-new, understory, u-os.

## Agent Session Start

ping-mem is currently under the 2026-04-29 local trust rebuild. Do not use MCP
tools, direct DB mode, or codebase grounding tools as proof until the local
S001-S015 gate package says they are re-adopted.

Approved local proof starts through the REST-only CLI trust spine:

```bash
bun run src/cli/index.ts agent status --json
bun run src/cli/index.ts agent proof memory-lifecycle --agent claude-code-local --project /Users/umasankr/Projects/ping-mem --json
```

## Dev Commands

```bash
bun install          # Install deps
bun run build        # Compile TypeScript
bun test             # Run tests (ALWAYS bun, never vitest/jest)
bun run typecheck    # Type check (0 errors required)
bun run lint         # Lint
bun run start        # unified server (:3003)
bun run start:sse    # legacy label; unified HTTP server still exposes /mcp on :3003
scripts/pre-push.sh  # pre-push gate — install: ln -sf ../../scripts/pre-push.sh .git/hooks/pre-push
```

**Quality gate**: `bun run typecheck && bun test`

## Key Rules

- **Port 3003** is the supported local/public listener for the unified server
- **Agent re-adoption is blocked until S015**. Do not add ping-mem back to Claude Code or Codex config from this file.
- **Ollama is primary LLM**: Entity extraction, contradiction detection, causal discovery all use Ollama `llama3.2` via OpenAI-compatible API. OpenAI is fallback only.
- **Codebase search** is GET `/api/v1/codebase/search?query=...` (NOT POST)
- **Health** is GET `/health` — always 200, no auth required
- **Neo4j + Qdrant** required for ingestion features; core memory works without them
- **ProjectId** = `SHA-256(remoteUrl + "::" + relativeToGitRoot)` — path-independent
- **Rate limit**: 60 requests/minute on `/api/v1/*` endpoints. Mining and dreaming endpoints are resource-intensive — use sparingly.
- **HTTP contract**: `/mcp` is MCP streamable HTTP, `/api/v1/events/stream` is app SSE, and the same `:3003` server also serves REST, UI, and admin routes.
- **SQLite data lives in a named Docker volume** (`ping-mem-data`) — NOT a bind mount. This prevents host-side file access from corrupting WAL. Use REST API or `docker exec` to interact with the DB.

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

- **Current approved proof path**: `bun run src/cli/index.ts agent ... --json` against the REST runtime.
- **Proxy mode**: quarantined until S015/S016 re-adoption proof.
- **Direct mode**: offline development only; it cannot prove local trust or agent readiness.

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

## graphify

This project has a graphify knowledge graph at graphify-out/.

Rules:
- Before answering architecture or codebase questions, read graphify-out/GRAPH_REPORT.md for god nodes and community structure
- If graphify-out/wiki/index.md exists, navigate it instead of reading raw files
- After modifying code files in this session, run `graphify update .` to keep the graph current (AST-only, no API cost)
