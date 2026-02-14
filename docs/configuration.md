# Configuration Reference

> All environment variables, defaults, and configuration options for ping-mem.

---

## Environment Variables

### Server

| Variable | Default | Description |
|----------|---------|-------------|
| `PING_MEM_HOST` | `0.0.0.0` | HTTP server bind address |
| `PING_MEM_PORT` | `3000` | HTTP server port |
| `PING_MEM_TRANSPORT` | `streamable-http` | Transport mode: `sse`, `rest`, or `streamable-http` |
| `PING_MEM_DB_PATH` | `:memory:` | SQLite database path. Use a file path for persistence (e.g., `~/.ping-mem/memory.db`) |
| `NODE_ENV` | — | Node environment (`production`, `development`) |

### Authentication

| Variable | Default | Description |
|----------|---------|-------------|
| `PING_MEM_API_KEY` | — | Seed API key for request authentication. When set, all API requests require `X-API-Key` header |
| `PING_MEM_ADMIN_USER` | — | Admin panel Basic Auth username |
| `PING_MEM_ADMIN_PASS` | — | Admin panel Basic Auth password |
| `PING_MEM_SECRET_KEY` | — | Secret key for AES-256-GCM encryption of stored API keys |

### Storage

| Variable | Default | Description |
|----------|---------|-------------|
| `PING_MEM_DB_PATH` | `:memory:` | Core memory SQLite database |
| `PING_MEM_DIAGNOSTICS_DB_PATH` | Same as `PING_MEM_DB_PATH` | Diagnostics SQLite database |
| `PING_MEM_ADMIN_DB_PATH` | Same as `PING_MEM_DB_PATH` | Admin SQLite database (API keys, LLM config) |

### Neo4j (Knowledge Graph)

Required for: code ingestion, knowledge graph, temporal queries, entity relationships.

| Variable | Default | Description |
|----------|---------|-------------|
| `NEO4J_URI` | — | Neo4j Bolt URI (e.g., `bolt://localhost:7687`) |
| `NEO4J_USERNAME` | — | Neo4j username (fallback: `NEO4J_USER`) |
| `NEO4J_PASSWORD` | — | Neo4j password |
| `NEO4J_DATABASE` | — | Neo4j database name (uses driver default) |
| `NEO4J_MAX_POOL_SIZE` | — | Connection pool size (uses driver default) |

Neo4j is **optional**. If not configured, these features are disabled:
- Codebase ingestion (`codebase_ingest`)
- Knowledge graph queries (`context_query_relationships`, `context_get_lineage`)
- Temporal code graph (`codebase_timeline`)
- Entity extraction (`extractEntities` parameter on `context_save`)

### Qdrant (Vector Search)

Required for: semantic code search, hybrid search with vector component.

| Variable | Default | Description |
|----------|---------|-------------|
| `QDRANT_URL` | — | Qdrant REST URL (e.g., `http://localhost:6333`) |
| `QDRANT_COLLECTION_NAME` | `ping-mem-vectors` | Qdrant collection name |
| `QDRANT_API_KEY` | — | Qdrant API key (for cloud deployments) |
| `QDRANT_VECTOR_DIMENSIONS` | `768` | Vector embedding dimensions |

Qdrant is **optional**. If not configured, semantic code search is disabled.

### OpenAI

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENAI_API_KEY` | — | OpenAI API key for LLM-powered diagnostics summaries |

Optional. Only needed for `diagnostics_summarize` with `useLLM: true`.

### LLM Summaries

| Variable | Default | Description |
|----------|---------|-------------|
| `PING_MEM_ENABLE_LLM_SUMMARIES` | — | Set to `true` to enable LLM-powered diagnostics summaries |

---

## Configuration Priority

Environment variables take the highest priority:

1. **Environment variables** (highest)
2. **Docker Compose defaults**
3. **Hardcoded defaults in source** (lowest)

---

## Service Tiers

ping-mem operates in three tiers based on which services are configured:

### Tier 1: SQLite Only (Minimal)

No additional services needed. Provides:
- Memory CRUD (save, get, search, delete)
- Session management
- Event store (audit trail)
- Checkpoints
- Keyword-based search
- Diagnostics storage
- Worklog events

**Required config:**
```bash
PING_MEM_DB_PATH=~/.ping-mem/memory.db
```

### Tier 2: + Neo4j (Knowledge Graph)

Adds:
- Entity extraction and knowledge graph
- Relationship queries and lineage tracing
- Temporal code graph
- Codebase ingestion (files and git history)
- Evolution queries

**Additional config:**
```bash
NEO4J_URI=bolt://localhost:7687
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=your-password
```

### Tier 3: + Qdrant (Full Stack)

Adds:
- Semantic code search with vector similarity
- Hybrid search (semantic + keyword + graph)
- Code chunk indexing with full provenance

**Additional config:**
```bash
QDRANT_URL=http://localhost:6333
QDRANT_COLLECTION_NAME=ping-mem-vectors
```

---

## Transport Modes

| Mode | Value | Use Case |
|------|-------|----------|
| **Streamable HTTP** | `streamable-http` | Default. Standard HTTP with streaming support |
| **SSE** | `sse` | Server-Sent Events for real-time streaming |
| **REST** | `rest` | Standard REST API for HTTP clients |

Set via `PING_MEM_TRANSPORT` environment variable.

For MCP (stdio) transport, use the CLI entry point directly:

```bash
bun run dist/mcp/cli.js
```

---

## Docker Compose Ports

### Development

| Service | Port | Protocol | Description |
|---------|------|----------|-------------|
| ping-mem | 3000 | HTTP | Main server |
| ping-mem-rest | 3003 | HTTP | REST API (optional profile) |
| Neo4j | 7474 | HTTP | Browser UI |
| Neo4j | 7687 | Bolt | Driver protocol |
| Qdrant | 6333 | HTTP | REST API |
| Qdrant | 6334 | gRPC | Streaming protocol |

### Production

| Service | Port | Binding | Description |
|---------|------|---------|-------------|
| ping-mem | 3000 | `127.0.0.1` only | Main server (behind reverse proxy) |

---

## Database Paths

When running in Docker, databases are stored in the `/data` volume:

| Database | Path | Contains |
|----------|------|----------|
| Core memory | `/data/ping-mem.db` | Sessions, memories, events |
| Diagnostics | `/data/ping-mem-diagnostics.db` | SARIF findings, analyses |
| Admin | `/data/ping-mem-admin.db` | API keys, LLM config |

When running locally, use `~/.ping-mem/` as the base directory:

```bash
PING_MEM_DB_PATH=~/.ping-mem/memory.db
PING_MEM_DIAGNOSTICS_DB_PATH=~/.ping-mem/diagnostics.db
PING_MEM_ADMIN_DB_PATH=~/.ping-mem/admin.db
```

---

## NPM Scripts

| Script | Command | Description |
|--------|---------|-------------|
| `build` | `tsc` | Compile TypeScript |
| `test` | `bun test` | Run tests |
| `test:watch` | `bun test --watch` | Run tests in watch mode |
| `typecheck` | `tsc --noEmit` | Type check (0 errors required) |
| `dev` | `tsc --watch` | Watch mode compilation |
| `start` | `bun run dist/http/server.js` | Start HTTP server |
| `start:sse` | `PING_MEM_TRANSPORT=sse bun run dist/http/index.js` | Start SSE server |
| `start:rest` | `PING_MEM_TRANSPORT=rest bun run dist/http/index.js` | Start REST server |
| `start:mcp` | `bun run dist/mcp/cli.js` | Start MCP server (stdio) |
| `setup` | `bash scripts/setup.sh` | Full local setup |
| `setup:docker` | `docker compose up -d` | Start Docker services |
| `diagnostics:tsc-sarif` | `bun run src/diagnostics/tsc-sarif.ts` | Generate TypeScript SARIF |
| `diagnostics:eslint-sarif` | `bun run src/diagnostics/eslint-sarif.ts` | Generate ESLint SARIF |
| `diagnostics:prettier-sarif` | `bun run src/diagnostics/prettier-sarif.ts` | Generate Prettier SARIF |
| `diagnostics:collect` | `bun run src/cli.ts collect` | Collect all diagnostics |
| `smoke-test` | `bash scripts/smoke-test.sh` | Run deployment smoke tests |
| `health` | curl checks | Verify all services |

---

## Example `.env` File

```bash
# Server
PING_MEM_HOST=0.0.0.0
PING_MEM_PORT=3000
PING_MEM_TRANSPORT=sse
PING_MEM_DB_PATH=/data/ping-mem.db
PING_MEM_DIAGNOSTICS_DB_PATH=/data/ping-mem-diagnostics.db
PING_MEM_ADMIN_DB_PATH=/data/ping-mem-admin.db

# Authentication
PING_MEM_API_KEY=
PING_MEM_ADMIN_USER=
PING_MEM_ADMIN_PASS=
PING_MEM_SECRET_KEY=

# Neo4j
NEO4J_URI=bolt://localhost:7687
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=your_secure_password

# Qdrant
QDRANT_URL=http://localhost:6333
QDRANT_COLLECTION_NAME=ping-mem-vectors

# Node
NODE_ENV=production
```
