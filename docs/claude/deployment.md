# Deployment & Environment

## Environments

| Environment | Endpoint | Credentials |
|-------------|----------|-------------|
| Production | `https://ping-mem.ping-gadgets.com` | `~/Projects/.creds/ping-mem-prod-creds.md` |
| Local | `http://localhost:3003` | None |

Production VPS: 72.62.117.123, install path: `/opt/ping-mem/`, shared with SN-Assist.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PING_MEM_DB_PATH` | No | `:memory:` | SQLite database path |
| `PING_MEM_PORT` | No | `3003` | HTTP server port |
| `PING_MEM_TRANSPORT` | No | `rest` | Transport mode (`rest`, `sse`, `streamable-http`) |
| `NEO4J_URI` | For ingestion | | `bolt://localhost:7687` |
| `NEO4J_USERNAME` / `NEO4J_PASSWORD` | For ingestion | | Neo4j credentials |
| `QDRANT_URL` | For ingestion | | `http://localhost:6333` |
| `QDRANT_COLLECTION_NAME` | No | `ping-mem-vectors` | Collection name |
| `QDRANT_VECTOR_DIMENSIONS` | No | `768` | Vector dimensions |
| `OPENAI_API_KEY` | Optional | | ML embeddings + LLM summaries |
| `PING_MEM_API_KEY` | For auth | | Seed API key |
| `PING_MEM_ADMIN_USER` / `PING_MEM_ADMIN_PASS` | For admin | | Basic Auth |
| `PING_MEM_SECRET_KEY` | For encryption | | AES-256-GCM key encryption |
| `PING_MEM_ADMIN_DB_PATH` | No | `~/.ping-mem/admin.db` | Admin SQLite DB |
| `PING_MEM_DIAGNOSTICS_DB_PATH` | No | `~/.ping-mem/diagnostics.db` | Diagnostics DB |
| `PING_MEM_MAX_AGENTS` | No | `100` | Max registered agents |

## Local Development

```bash
bun install && bun run build
bun run start           # REST mode
bun run start:sse       # SSE mode
bun run dist/mcp/cli.js # MCP stdio
```

## Full Stack (Neo4j + Qdrant required for ingestion)

```bash
docker-compose up -d neo4j qdrant
export NEO4J_URI="bolt://localhost:7687" NEO4J_USERNAME="neo4j" NEO4J_PASSWORD="your-pw"
export QDRANT_URL="http://localhost:6333"
bun run dist/mcp/cli.js
```

## Docker Deployment

```bash
docker build -t ping-mem:latest .
docker run -d -v ping-mem-data:/data -p 3003:3003 -e PING_MEM_DB_PATH=/data/ping-mem.db ping-mem:latest
```

## Docker Compose Configs

- **Dev**: `docker-compose.yml` — REST on :3003
- **Prod**: `docker-compose.prod.yml` — REST on :3000 (Nginx proxies to it)
- **Improvement**: `docker-compose.improvement.yml` — Blue-green overlay, Green on :3001

## Production Notes

- **Nginx**: Shared config at `/opt/sn-assist/nginx.prod.conf` (both `assist` + `ping-mem` server blocks)
- **Network bridge**: `docker network connect thriveassist-app ping-mem` + systemd service
- **DNS**: Cloudflare A record → 72.62.117.123 (proxied, SSL Full mode)
- **Qdrant healthcheck**: `bash -c 'echo > /dev/tcp/localhost/6333'` (no curl in v1.12.6)
