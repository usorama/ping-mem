---
name: local-deploy
description: Deploy ping-mem to local OrbStack Docker without data loss. Rebuilds images, restarts containers, verifies health. Use after any code changes that need to be deployed locally.
---

# Local Deploy — ping-mem on OrbStack

Deploy ping-mem to local Docker (OrbStack) without losing existing data (Neo4j graph, Qdrant vectors, SQLite DBs).

## Pre-Deploy Checks

1. Verify code compiles: `bun run typecheck`
2. Verify tests pass: `bun test`
3. **Build dist/ FIRST** (MCP stdio uses host dist/): `bun run build`
4. Check existing data volumes: `docker volume ls | grep ping-mem`
5. Note current container state: `docker ps --format "table {{.Names}}\t{{.Status}}" | grep ping`

## Deploy Steps

### Step 1: Build dist/ (BEFORE Docker — MCP stdio depends on this)
```bash
bun run build
```
**WHY FIRST**: MCP stdio (configured in ~/.claude/mcp.json) runs from the HOST filesystem's `dist/mcp/cli.js`, not from inside the Docker container. If dist/ isn't rebuilt before deploy, all Claude Code sessions get stale tools — new tools won't appear, code fixes won't take effect for MCP callers.

### Step 2: Build new Docker image (no cache to pick up all changes)
```bash
docker compose build --no-cache ping-mem
```
This rebuilds only the ping-mem app image. Neo4j and Qdrant use upstream images.

### Step 3: Rolling restart (data-safe)
```bash
# Stop only the app container (NOT neo4j/qdrant — preserves data)
docker compose stop ping-mem
docker compose rm -f ping-mem

# Start with new image
docker compose up -d ping-mem
```

**CRITICAL**: Never run `docker compose down` — it removes volumes and loses data.

### Step 4: Run Agent-Path Audit (MANDATORY)
```bash
sleep 5
bash scripts/agent-path-audit.sh
```
This tests every path a real agent uses:
- MCP stdio tool discovery (53 tools expected)
- dist/ freshness (must be newer than last commit)
- Write-then-search round-trip (save memory, find it by value content)
- Cross-session search (session A saves, session B finds)
- New feature endpoints (mining, insights, profile UI)
- Health check

**If any path fails, the deploy is NOT complete.** Fix the failure before moving on.

### Step 5: Verify Data Intact
```bash
# Check Neo4j has data
curl -sf http://localhost:7474 && echo "Neo4j UI OK"

# Check Qdrant collections
curl -sf http://localhost:6333/collections | jq '.result.collections[].name'

# Container logs (check for errors)
docker logs ping-mem --tail 20
```

## Docker Compose Config Notes

- **Transport**: `PING_MEM_TRANSPORT=rest` — REST server handles all paths including `/mcp`
- **Port**: 3003 (single port for REST + MCP + UI + admin + health). Never use 3000 for dev.
- **Volumes**: `ping-mem-data:/data` (SQLite DBs), `neo4j-data:/data` (graph), `qdrant-data:/qdrant/storage` (vectors)
- **Project mounts**: `/Users/umasankr/Projects:/projects:rw` (for code ingestion)

## Rollback

If the new image fails:
```bash
docker compose stop ping-mem
docker compose rm -f ping-mem
docker compose up -d ping-mem  # Will use cached previous layer if available
```

## Common Issues

| Issue | Fix |
|-------|-----|
| MCP tools missing/stale | Run `bun run build` — dist/ was not rebuilt |
| Port 3003 already in use | Stop the old container: `docker compose stop ping-mem` |
| Health check fails | Check logs: `docker logs ping-mem --tail 50` |
| Search returns wrong results | Check `recall()` uses keyword scoring — issue #67 |
| Empty search results | Data volumes OK? `docker volume inspect ping-mem-data` |
| Build fails | Run `bun run typecheck` and `bun test` first |
