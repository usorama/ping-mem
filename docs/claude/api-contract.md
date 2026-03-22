# API Contract & Consumer Integration

## How Other Projects Consume ping-mem

```
Consumer Project → HTTP (REST) or MCP (stdio) → ping-mem Infrastructure
                                                  ├─ REST API :3003
                                                  ├─ MCP (stdio)
                                                  ├─ Neo4j :7687
                                                  └─ Qdrant :6333
```

## REST API Contract

All codebase endpoints require IngestionService (Neo4j + Qdrant). Returns **503** if not configured.

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/v1/codebase/ingest` | Ingest a project (`{projectDir, forceReingest?}`) |
| POST | `/api/v1/codebase/verify` | Verify project manifest integrity |
| GET | `/api/v1/codebase/search?query=...&projectId=...&type=...&limit=...` | Semantic code search |
| GET | `/api/v1/codebase/timeline?projectId=...&filePath=...&limit=...` | Temporal commit history |
| GET | `/health` | Health check (always 200, no auth required) |
| POST | `/api/v1/agents/register` | Register/update agent identity |
| GET | `/api/v1/agents/quotas` | Get quota status |
| DELETE | `/api/v1/agents/:agentId` | Deregister agent |
| POST | `/api/v1/knowledge/ingest` | Ingest knowledge entry |
| POST | `/api/v1/knowledge/search` | Full-text knowledge search |
| GET | `/api/v1/events/stream` | SSE stream of real-time events |

**Important**: Codebase search is **GET** with query params, NOT POST.

## Project Identity (Path-Independent)

```
projectId = SHA-256(remoteUrl + "::" + relativeToGitRoot)
```

Same project produces same projectId regardless of local path, Docker mount, or OS.

## Docker Volume Mapping

```yaml
volumes:
  - /Users/umasankr/Projects:/projects:rw
```

| Host Path | Container Path |
|-----------|---------------|
| `/Users/umasankr/Projects/openclaw` | `/projects/openclaw` |
| `/Users/umasankr/Projects/ping-mem` | `/projects/ping-mem` |

## Consumer Integration Checklist

1. Register: Add project path to `~/.ping-mem/registered-projects.txt`
2. Verify: `curl http://localhost:3003/api/v1/codebase/search?query=test&limit=1`
3. Health: `curl http://localhost:3003/health`
4. If 503: Ensure Docker containers running (`docker ps | grep ping-mem`)
5. Force reingest: `bun run scripts/force-ingest.ts /path/to/project`

## Failure Modes

| Symptom | Cause | Fix |
|---------|-------|-----|
| 503 on codebase endpoints | IngestionService not initialized | Restart container |
| Empty search results | Project not ingested | Run force-ingest |
| Wrong projectId | Path mismatch (Docker vs local) | Verify git remote URL |
| Connection refused :3003 | Container down | `docker-compose up -d ping-mem` |
| ECONNREFUSED :6333 | Qdrant down | `docker restart ping-mem-qdrant` |
