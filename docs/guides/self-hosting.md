# Self-Hosting Guide

> Deploy ping-mem with Docker Compose for persistent, production-ready operation.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  Docker Compose Stack               │
│                                                     │
│  ┌─────────────┐  ┌──────────┐  ┌───────────────┐  │
│  │  ping-mem   │  │  Neo4j   │  │    Qdrant     │  │
│  │  :3000      │  │  :7687   │  │    :6333      │  │
│  │  (App)      │  │  (Graph) │  │   (Vectors)   │  │
│  └──────┬──────┘  └────┬─────┘  └──────┬────────┘  │
│         │              │               │            │
│         └──────────────┼───────────────┘            │
│                        │                            │
│              ping-mem-network (bridge)              │
└─────────────────────────────────────────────────────┘
         │
    Volumes: neo4j-data, qdrant-data, ping-mem-data
```

## Quick Start

### 1. Clone and Build

```bash
git clone https://github.com/ping-gadgets/ping-mem.git
cd ping-mem
```

### 2. Configure Environment

Copy the example env file and customize:

```bash
cp .env.example .env
```

Edit `.env` with your settings:

```bash
# Required for production
PING_MEM_DB_PATH=/data/ping-mem.db
PING_MEM_API_KEY=your-api-key-here
PING_MEM_ADMIN_USER=admin
PING_MEM_ADMIN_PASS=your-admin-password
PING_MEM_SECRET_KEY=your-encryption-secret

# Neo4j
NEO4J_PASSWORD=your-neo4j-password

# Optional
PING_MEM_PORT=3000
QDRANT_COLLECTION_NAME=ping-mem-vectors
```

### 3. Start the Stack

**Development** (all ports exposed, SSE transport):

```bash
docker compose up -d
```

**Production** (localhost-only binding, streamable-http transport):

```bash
docker compose -f docker-compose.prod.yml up -d
```

### 4. Verify

```bash
# Health check
curl http://localhost:3000/health

# Check all services
docker compose ps
```

---

## Development Stack

The development `docker-compose.yml` starts four services:

| Service | Port | Description |
|---------|------|-------------|
| `ping-mem` | 3000 | Main server (SSE transport) |
| `ping-mem-rest` | 3003 | REST API server (optional profile) |
| `ping-mem-neo4j` | 7474, 7687 | Knowledge graph database |
| `ping-mem-qdrant` | 6333, 6334 | Vector search database |

```bash
# Start core stack
docker compose up -d

# Also start the REST server
docker compose --profile rest-api up -d
```

### Resource Allocation (Dev)

| Service | Heap | Pagecache |
|---------|------|-----------|
| Neo4j | 512MB initial, 2GB max | 1GB |

---

## Production Stack

The production `docker-compose.prod.yml` has key differences:

| Aspect | Development | Production |
|--------|-------------|------------|
| Port binding | `0.0.0.0:3000` | `127.0.0.1:3000` (localhost only) |
| Transport | SSE | streamable-http |
| Neo4j heap | 512MB–1GB | 1GB–2GB |
| Neo4j pagecache | 512MB | 1GB |
| REST server | Optional profile | Not included |
| Auth | Optional | Required |

### Resource Allocation (Production)

| Service | Heap | Pagecache |
|---------|------|-----------|
| Neo4j | 1GB initial, 2GB max | 1GB |

### Reverse Proxy

In production, the server binds to `127.0.0.1:3000`. Put it behind a reverse proxy (nginx, Caddy, Traefik) for external access:

**nginx example:**

```nginx
server {
    listen 443 ssl;
    server_name ping-mem.example.com;

    ssl_certificate /etc/ssl/certs/cert.pem;
    ssl_certificate_key /etc/ssl/private/key.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE support
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
    }
}
```

---

## Data Persistence

All data is stored in named Docker volumes:

| Volume | Contains | Service |
|--------|----------|---------|
| `ping-mem-data` | SQLite databases (memory, diagnostics, admin) | ping-mem |
| `ping-mem-neo4j-data` | Knowledge graph data | Neo4j |
| `ping-mem-neo4j-logs` | Neo4j log files | Neo4j |
| `ping-mem-qdrant-data` | Vector embeddings | Qdrant |

### Backup

Back up all volumes:

```bash
# Stop services
docker compose stop

# Backup volumes
docker run --rm -v ping-mem-data:/data -v $(pwd)/backups:/backup \
  alpine tar czf /backup/ping-mem-data-$(date +%Y%m%d).tar.gz -C /data .

docker run --rm -v ping-mem-neo4j-data:/data -v $(pwd)/backups:/backup \
  alpine tar czf /backup/neo4j-data-$(date +%Y%m%d).tar.gz -C /data .

docker run --rm -v ping-mem-qdrant-data:/data -v $(pwd)/backups:/backup \
  alpine tar czf /backup/qdrant-data-$(date +%Y%m%d).tar.gz -C /data .

# Restart services
docker compose start
```

### Restore

```bash
docker compose stop

docker run --rm -v ping-mem-data:/data -v $(pwd)/backups:/backup \
  alpine sh -c "rm -rf /data/* && tar xzf /backup/ping-mem-data-20260214.tar.gz -C /data"

docker compose start
```

---

## Project Ingestion

### Mount Your Projects

The development compose file mounts a host directory for project access:

```yaml
volumes:
  - /path/to/your/projects:/projects:rw
```

Edit `docker-compose.yml` to change the mount path, then reference projects using the container path:

```bash
curl -X POST http://localhost:3003/api/v1/codebase/ingest \
  -H "Content-Type: application/json" \
  -d '{"projectDir": "/projects/my-project"}'
```

### Auto-Ingestion

Register projects for automatic ingestion on git commits:

```bash
echo "/projects/my-project" >> ~/.ping-mem/registered-projects.txt
```

---

## Admin Panel

Access the admin panel at `http://localhost:3000/admin` (requires `PING_MEM_ADMIN_USER` and `PING_MEM_ADMIN_PASS`).

Features:
- **API Key Management**: Create, rotate, and deactivate API keys
- **Project Management**: List and delete ingested projects
- **LLM Configuration**: Configure OpenAI, Anthropic, or OpenRouter for diagnostics summaries

---

## MCP Client Access

To use ping-mem from Claude Code or Cursor while running in Docker, you have two options:

### Option 1: Direct MCP (stdio)

Run the MCP server locally, pointing at the Docker databases:

```json
{
  "mcpServers": {
    "ping-mem": {
      "command": "bun",
      "args": ["run", "/path/to/ping-mem/dist/mcp/cli.js"],
      "env": {
        "PING_MEM_DB_PATH": "~/.ping-mem/memory.db",
        "NEO4J_URI": "bolt://localhost:7687",
        "NEO4J_USERNAME": "neo4j",
        "NEO4J_PASSWORD": "your-password",
        "QDRANT_URL": "http://localhost:6333"
      }
    }
  }
}
```

### Option 2: SSE Transport

Connect to the Docker SSE server:

```json
{
  "mcpServers": {
    "ping-mem": {
      "url": "http://localhost:3000/sse"
    }
  }
}
```

---

## Monitoring

### Health Check

```bash
curl http://localhost:3000/health
# => {"status":"ok","timestamp":"2026-02-14T10:00:00.000Z"}
```

### Container Status

```bash
docker compose ps
docker compose logs -f ping-mem
```

### Neo4j Browser

Access Neo4j's web UI at `http://localhost:7474` (development only; not exposed in production).

### Qdrant Dashboard

Access Qdrant's dashboard at `http://localhost:6333/dashboard` (development only).

---

## Upgrading

```bash
cd /path/to/ping-mem

# Pull latest code
git pull origin main

# Rebuild
docker compose build

# Restart with new image
docker compose up -d
```

Data volumes are preserved across rebuilds.

---

## Troubleshooting

### Neo4j won't start

Check logs:

```bash
docker compose logs ping-mem-neo4j
```

Common causes:
- Insufficient memory — increase Docker's memory allocation
- Port conflict — another Neo4j instance on port 7687

### Qdrant port conflict

```bash
# Check what's using the port
lsof -i :6333
```

### ping-mem can't connect to Neo4j

The ping-mem container waits for Neo4j's healthcheck. If Neo4j takes too long:

```bash
# Check Neo4j health
docker compose exec ping-mem-neo4j cypher-shell -u neo4j -p neo4j_password "RETURN 1"

# Restart the stack
docker compose restart
```

### SQLite locked

Ensure only one ping-mem instance writes to the same SQLite file. The development compose file intentionally uses a single server instance to avoid this.

### Out of disk space

Check volume usage:

```bash
docker system df -v
```

Prune unused data:

```bash
docker system prune --volumes
```
