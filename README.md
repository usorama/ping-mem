# ping-mem

**Universal Memory Layer for AI Agents**

[![Version](https://img.shields.io/badge/version-2.0.1-blue.svg)](package.json)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

ping-mem gives AI agents persistent memory, codebase intelligence, and cross-project awareness. It runs as a single server exposing 47 tools via REST API, MCP protocol, CLI, and TypeScript SDK — all on one port.

## How Agents Discover and Use ping-mem

Agents can discover every capability at runtime — no docs needed:

| Method | For | Discovery |
|--------|-----|-----------|
| **MCP `tools/list`** | Claude Code, Cursor, any MCP client | Automatic at session start — 47 tools with schemas |
| **`GET /api/v1/tools`** | REST agents, LangChain, CrewAI | One HTTP call returns all tools + input schemas |
| **`GET /openapi.json`** | SDK generators, Swagger UI | OpenAPI 3.1 spec for any HTTP client |
| **TypeScript SDK** | Node.js/Bun agents | `import { PingMemSDK }` — typed methods with autocomplete |
| **CLI** | Agents with shell access | `ping-mem tools list --json` or `ping-mem <module> --help` |

### Quick Examples

```bash
# REST — discover all tools
curl http://localhost:3000/api/v1/tools | jq '.data.count'
# → 47

# REST — save a memory
curl -X POST http://localhost:3000/api/v1/context \
  -H "Content-Type: application/json" \
  -d '{"key":"decision-1","value":"Use PostgreSQL","category":"decision"}'

# REST — search memories
curl "http://localhost:3000/api/v1/search?query=database&limit=5"

# CLI — same operations
ping-mem context save decision-1 "Use PostgreSQL" --category decision
ping-mem context search "database" --limit 5

# MCP — Claude Code gets tools automatically via ~/.claude/mcp.json
```

```typescript
// TypeScript SDK
import { PingMemSDK } from "@ping-gadgets/ping-mem-sdk";

const pm = new PingMemSDK({ baseUrl: "http://localhost:3000" });
await pm.contextSave("decision-1", "Use PostgreSQL", { category: "decision" });
const results = await pm.contextSearch("database", { limit: 5 });
```

## All 47 Capabilities

### Context Memory (9 tools)

| Tool | REST | CLI | Description |
|------|------|-----|-------------|
| `context_session_start` | `POST /api/v1/session/start` | `ping-mem session start <name>` | Start session with project tracking |
| `context_session_end` | `POST /api/v1/session/end` | `ping-mem session end <id>` | End session |
| `context_session_list` | `GET /api/v1/session/list` | `ping-mem session list` | List recent sessions |
| `context_save` | `POST /api/v1/context` | `ping-mem context save <key> <value>` | Save memory with category + priority |
| `context_get` | `GET /api/v1/context/:key` | `ping-mem context get <key>` | Retrieve by key |
| `context_search` | `GET /api/v1/search` | `ping-mem context search <query>` | Semantic + keyword search |
| `context_delete` | `DELETE /api/v1/context/:key` | `ping-mem context delete <key>` | Delete memory |
| `context_checkpoint` | `POST /api/v1/checkpoint` | `ping-mem context checkpoint <name>` | Named checkpoint |
| `context_status` | `GET /api/v1/status` | `ping-mem context status` | Session + server status |

### Knowledge Graph (5 tools)

| Tool | REST | CLI | Description |
|------|------|-----|-------------|
| `context_query_relationships` | `GET /api/v1/graph/relationships` | `ping-mem graph relationships <id>` | Entity relationships (Neo4j) |
| `context_hybrid_search` | `POST /api/v1/graph/hybrid-search` | `ping-mem graph search <query>` | Semantic + keyword + graph search |
| `context_get_lineage` | `GET /api/v1/graph/lineage/:entity` | `ping-mem graph lineage <entity>` | Upstream/downstream lineage |
| `context_query_evolution` | `GET /api/v1/graph/evolution` | `ping-mem graph evolution <id>` | Entity changes over time |
| `context_health` | `GET /api/v1/graph/health` | `ping-mem graph health` | Graph service health |

### Codebase Intelligence (8 tools)

| Tool | REST | CLI | Description |
|------|------|-----|-------------|
| `codebase_ingest` | `POST /api/v1/codebase/ingest` | `ping-mem codebase ingest <dir>` | Ingest project (code + git history) |
| `codebase_verify` | `POST /api/v1/codebase/verify` | `ping-mem codebase verify <dir>` | Verify manifest integrity |
| `codebase_search` | `GET /api/v1/codebase/search` | `ping-mem codebase search <query>` | Semantic code search |
| `codebase_timeline` | `GET /api/v1/codebase/timeline` | `ping-mem codebase timeline` | Git commit history with "why" extraction |
| `codebase_list_projects` | `GET /api/v1/codebase/projects` | `ping-mem codebase projects` | List ingested projects |
| `codebase_impact` | `GET /api/v1/codebase/impact` | `ping-mem codebase impact` | Transitive dependents of a file |
| `codebase_blast_radius` | `GET /api/v1/codebase/blast-radius` | `ping-mem codebase blast-radius` | Risk score (fan-in, git churn, centrality) |
| `codebase_dependency_map` | `GET /api/v1/codebase/dependency-map` | `ping-mem codebase dependency-map` | Module dependency graph |

### Diagnostics (8 tools)

| Tool | REST | CLI | Description |
|------|------|-----|-------------|
| `diagnostics_ingest` | `POST /api/v1/diagnostics/ingest` | `ping-mem diagnostics ingest` | Ingest SARIF (tsc/eslint/prettier) |
| `diagnostics_latest` | `GET /api/v1/diagnostics/latest` | `ping-mem diagnostics latest` | Latest run by project + tool |
| `diagnostics_list` | `GET /api/v1/diagnostics/findings/:id` | `ping-mem diagnostics list <id>` | List findings for analysis |
| `diagnostics_diff` | `POST /api/v1/diagnostics/diff` | `ping-mem diagnostics diff <a> <b>` | Compare two runs (introduced/resolved) |
| `diagnostics_summary` | `GET /api/v1/diagnostics/summary/:id` | `ping-mem diagnostics summary <id>` | Aggregate by severity |
| `diagnostics_compare_tools` | `GET /api/v1/diagnostics/compare` | `ping-mem diagnostics compare` | Cross-tool comparison |
| `diagnostics_by_symbol` | `GET /api/v1/diagnostics/by-symbol` | `ping-mem diagnostics by-symbol` | Group by function/class |
| `diagnostics_summarize` | `POST /api/v1/diagnostics/summarize/:id` | `ping-mem diagnostics summarize <id>` | LLM-powered summary |

### Memory Management (5 tools)

| Tool | REST | CLI | Description |
|------|------|-----|-------------|
| `memory_stats` | `GET /api/v1/memory/stats` | `ping-mem memory stats` | Memory usage statistics |
| `memory_consolidate` | `POST /api/v1/memory/consolidate` | `ping-mem memory consolidate` | Consolidate old memories |
| `memory_compress` | `POST /api/v1/memory/compress` | `ping-mem memory compress` | Compress to digest facts |
| `memory_subscribe` | `POST /api/v1/memory/subscribe` | `ping-mem memory subscribe` | Subscribe to change events |
| `memory_unsubscribe` | `POST /api/v1/memory/unsubscribe` | `ping-mem memory unsubscribe` | Unsubscribe |

### Causal Inference (4 tools)

| Tool | REST | CLI | Description |
|------|------|-----|-------------|
| `search_causes` | `GET /api/v1/causal/causes` | `ping-mem causal causes <entity>` | Find causes of an event |
| `search_effects` | `GET /api/v1/causal/effects` | `ping-mem causal effects <entity>` | Find effects of an event |
| `get_causal_chain` | `GET /api/v1/causal/chain` | `ping-mem causal chain <start> <end>` | Trace cause-effect chain |
| `trigger_causal_discovery` | `POST /api/v1/causal/discover` | `ping-mem causal discover` | Auto-discover causal relationships |

### Knowledge Base (2 tools)

| Tool | REST | CLI | Description |
|------|------|-----|-------------|
| `knowledge_ingest` | `POST /api/v1/knowledge/ingest` | `ping-mem knowledge ingest` | Store solutions with tags + symptoms |
| `knowledge_search` | `POST /api/v1/knowledge/search` | `ping-mem knowledge search <query>` | FTS5 multi-word search |

### Agent Management (3 tools)

| Tool | REST | CLI | Description |
|------|------|-----|-------------|
| `agent_register` | `POST /api/v1/agents/register` | `ping-mem agent register <id> <role>` | Register agent with quotas |
| `agent_quota_status` | `GET /api/v1/agents/quotas` | `ping-mem agent quotas` | Check quota usage |
| `agent_deregister` | `DELETE /api/v1/agents/:id` | `ping-mem agent deregister <id>` | Remove agent |

### Worklog (2 tools)

| Tool | REST | CLI | Description |
|------|------|-----|-------------|
| `worklog_record` | `POST /api/v1/worklog` | `ping-mem worklog record <kind> <title>` | Record tool/diagnostic/git event |
| `worklog_list` | `GET /api/v1/worklog` | `ping-mem worklog list` | List events |

### Project Management (1 tool)

| Tool | REST | CLI | Description |
|------|------|-----|-------------|
| `project_delete` | `DELETE /api/v1/codebase/projects/:id` | `ping-mem codebase delete <id>` | Delete all project data |

## Architecture

```
Port 3000 (single port)
├── /api/v1/*       REST API (47 endpoints)
├── /mcp            MCP streamable-http transport
├── /openapi.json   OpenAPI 3.1 spec
├── /health         Health check
├── /ui/*           Web dashboard (10 views)
├── /admin/*        Admin panel
└── /static/*       CSS/JS assets
```

```
┌─────────────────────────────────────────────────────┐
│  Interfaces                                          │
│  MCP (stdio + HTTP) · REST API · CLI · TypeScript SDK│
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│  Core: MemoryManager · SessionManager · EventStore   │
│  Knowledge: KnowledgeStore (FTS5)                    │
│  Agents: AgentRegistry · QuotaManager                │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│  Intelligence: Ingestion · BM25 · Structural Analysis│
│  Graph: Neo4j (temporal code graph + entity graph)   │
│  Search: Qdrant (vectors) + SQLite (BM25/FTS5)      │
│  Diagnostics: SARIF · Symbols · LLM Summaries       │
└─────────────────────────────────────────────────────┘
```

## Quick Start

### Docker (recommended)

```bash
git clone https://github.com/ping-gadgets/ping-mem.git
cd ping-mem
docker compose up -d

# Verify
curl http://localhost:3000/health
curl http://localhost:3000/api/v1/tools | jq '.data.count'
```

### From Source

```bash
bun install && bun run build
bun run start  # REST server on :3000
```

### CLI

```bash
# After bun run build
ping-mem --help
ping-mem server status
ping-mem session start "my-session"
ping-mem context save "key" "value"
ping-mem codebase search "authentication"
```

### Shell Integration

```bash
# Add to ~/.zshrc
eval "$(ping-mem shell-hook zsh)"

# Background daemon for zero-latency context tracking
ping-mem daemon start
```

### Claude Code Integration

Add to `~/.claude/mcp.json`:

```json
{
  "mcpServers": {
    "ping-mem": {
      "command": "bun",
      "args": ["run", "/path/to/ping-mem/dist/mcp/cli.js"],
      "env": {
        "PING_MEM_DB_PATH": "~/.ping-mem/ping-mem.db",
        "NEO4J_URI": "bolt://localhost:7687",
        "NEO4J_USERNAME": "neo4j",
        "NEO4J_PASSWORD": "neo4j_password",
        "QDRANT_URL": "http://localhost:6333"
      }
    }
  }
}
```

## Web UI

| Route | View |
|-------|------|
| `/ui` | Dashboard — stats, recent events |
| `/ui/memories` | Memory Explorer — search, filter |
| `/ui/diagnostics` | Diagnostics — SARIF runs, diff |
| `/ui/ingestion` | Ingestion Monitor — project status |
| `/ui/agents` | Agent Registry — quotas, TTL |
| `/ui/knowledge` | Knowledge Base — FTS search |
| `/ui/sessions` | Sessions — timeline, events |
| `/ui/events` | Event Log — paginated, filtered |
| `/ui/worklog` | Worklog — entries by kind |
| `/admin` | Admin — API keys, LLM config |

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PING_MEM_PORT` | `3000` | Server port |
| `PING_MEM_TRANSPORT` | `rest` | Transport (rest serves REST + MCP on same port) |
| `PING_MEM_DB_PATH` | `:memory:` | SQLite database path |
| `PING_MEM_API_KEY` | | API key for authentication |
| `NEO4J_URI` | | Neo4j Bolt URI (for graph features) |
| `NEO4J_PASSWORD` | | Neo4j password |
| `QDRANT_URL` | | Qdrant URL (for vector search) |
| `OPENAI_API_KEY` | | OpenAI key (for hybrid search + LLM summaries) |
| `PING_MEM_ADMIN_USER` | | Admin panel Basic Auth username |
| `PING_MEM_ADMIN_PASS` | | Admin panel Basic Auth password |

## Development

```bash
bun install          # Install deps
bun run build        # Compile TypeScript
bun test             # Run tests (2000+)
bun run typecheck    # Type check (0 errors required)
bun run start        # Start server
```

## License

MIT
