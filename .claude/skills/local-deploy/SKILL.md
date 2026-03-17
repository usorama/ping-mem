---
name: local-deploy
description: Deploy ping-mem to local OrbStack Docker without data loss. Rebuilds images, restarts containers, verifies health. Use after any code changes that need to be deployed locally.
---

# Local Deploy — ping-mem on OrbStack

Deploy ping-mem to local Docker (OrbStack) without losing existing data (Neo4j graph, Qdrant vectors, SQLite DBs).

## Pre-Deploy Checks

1. Verify code compiles: `bun run typecheck`
2. Verify tests pass: `bun test`
3. Check existing data volumes: `docker volume ls | grep ping-mem`
4. Note current container state: `docker ps --format "table {{.Names}}\t{{.Status}}" | grep ping`

## Deploy Steps

### Step 1: Build new image (no cache to pick up all changes)
```bash
docker compose build --no-cache ping-mem
```
This rebuilds only the ping-mem app image. Neo4j and Qdrant use upstream images.

### Step 2: Rolling restart (data-safe)
```bash
# Stop only the app container (NOT neo4j/qdrant — preserves data)
docker compose stop ping-mem
docker compose rm -f ping-mem

# Also stop the REST-only container if running (legacy separate instance)
docker compose stop ping-mem-rest 2>/dev/null
docker compose rm -f ping-mem-rest 2>/dev/null

# Start with new image
docker compose up -d ping-mem
```

**CRITICAL**: Never run `docker compose down` — it removes volumes and loses data.

### Step 3: Verify Health
```bash
# Wait for startup
sleep 5

# Health check
curl -sf http://localhost:3000/health | jq .

# Verify MCP endpoint exists
curl -sf -X POST http://localhost:3000/mcp -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' | head -100

# OpenAPI spec
curl -sf http://localhost:3000/openapi.json | jq '.openapi, .info.title'

# Tool discovery
curl -sf http://localhost:3000/api/v1/tools | jq '.count'

# Container logs (check for errors)
docker logs ping-mem --tail 20
```

### Step 4: Verify Data Intact
```bash
# Check Neo4j has data
curl -sf http://localhost:7474 && echo "Neo4j UI OK"

# Check Qdrant collections
curl -sf http://localhost:6333/collections | jq '.result.collections[].name'

# Search existing data
curl -sf "http://localhost:3000/api/v1/codebase/search?query=test&limit=1" | jq '.data'
```

### Step 5: CLI Verification
```bash
# Build CLI
bun run build

# Test CLI against local server
bun run dist/cli/index.js server status
bun run dist/cli/index.js tools list --json | jq '.count'
bun run dist/cli/index.js codebase projects --json
```

## Docker Compose Config Notes

- **Transport**: `PING_MEM_TRANSPORT=rest` — REST server handles all paths including `/mcp`
- **Port**: 3000 (single port for REST + MCP + UI + admin + health)
- **Volumes**: `ping-mem-data:/data` (SQLite DBs), `neo4j-data:/data` (graph), `qdrant-data:/qdrant/storage` (vectors)
- **Project mounts**: `/Users/umasankr/Projects:/projects:rw` (for code ingestion)

## Rollback

If the new image fails:
```bash
# Check previous image
docker images ping-mem --format "{{.ID}} {{.CreatedAt}}" | head -5

# Rollback to previous
docker compose stop ping-mem
docker compose rm -f ping-mem
docker compose up -d ping-mem  # Will use cached previous layer if available
```

## Common Issues

| Issue | Fix |
|-------|-----|
| Port 3000 already in use | Stop the old SSE container: `docker compose stop ping-mem` |
| Health check fails | Check logs: `docker logs ping-mem --tail 50` |
| Missing /mcp endpoint | Verify `PING_MEM_TRANSPORT=rest` in docker-compose.yml |
| Empty search results | Data volumes OK? `docker volume inspect ping-mem-data` |
| Build fails | Run `bun run typecheck` and `bun test` first |
