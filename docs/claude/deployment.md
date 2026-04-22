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
| `PING_MEM_TRANSPORT` | No | `streamable-http` | Compatibility transport label; runtime still exposes REST and `/mcp` on the same listener |
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
bun run start               # unified HTTP server on :3003
bun run dist/mcp/proxy-cli.js # recommended local MCP path against the running server
bun run dist/mcp/cli.js     # direct stdio fallback for isolated development
```

## Full Stack (Neo4j + Qdrant required for ingestion)

```bash
docker-compose up -d neo4j qdrant
export NEO4J_URI="bolt://localhost:7687" NEO4J_USERNAME="neo4j" NEO4J_PASSWORD="your-pw"
export QDRANT_URL="http://localhost:6333"
bun run start
```

## Docker Deployment

```bash
docker build -t ping-mem:latest .
docker run -d -v ping-mem-data:/data -p 3003:3003 -e PING_MEM_DB_PATH=/data/ping-mem.db ping-mem:latest
```

## Docker Compose Configs

- **Dev**: `docker-compose.yml` — unified server on :3003
- **Prod**: `docker-compose.prod.yml` — unified server on :3003
- **Improvement**: `docker-compose.improvement.yml` — Blue-green overlay, Green on :3001

## Production Notes

- **Nginx**: Shared config at `/opt/sn-assist/nginx.prod.conf` (both `assist` + `ping-mem` server blocks)
- **Network bridge**: `docker network connect thriveassist-app ping-mem` + systemd service
- **DNS**: Cloudflare A record → 72.62.117.123 (proxied, SSL Full mode)
- **Qdrant healthcheck**: `bash -c 'echo > /dev/tcp/localhost/6333'` (no curl in v1.12.6)
