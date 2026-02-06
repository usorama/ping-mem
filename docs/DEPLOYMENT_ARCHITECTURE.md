# ping-mem Deployment Architecture

**Version**: 1.2.0
**Date**: 2026-01-29
**Status**: Production Ready

---

## Executive Summary

ping-mem is now deployable to local Docker/OrbStack with a **three-script installation**:

1. `./scripts/setup.sh` - Install infrastructure (once per machine)
2. `./scripts/install-client.sh` - Install client tools (per project or global)
3. `./scripts/ingest-project.sh` - Ingest codebase (per project)

All AI agents (Cursor, Claude Code, VS Code, Cline, etc.) can now use ping-mem
as their primary codebase understanding system, replacing grep/ripgrep/find.

---

## Deployment Topology

```
┌─────────────────────────────────────────────────────────────────┐
│ Host Machine (macOS)                                            │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Your Projects                                            │  │
│  │  /Users/you/Projects/                                    │  │
│  │    ├── project-a/.ping-mem/manifest.json                │  │
│  │    ├── project-b/.ping-mem/manifest.json                │  │
│  │    └── ping-mem/  (this repo)                           │  │
│  └──────────────────────────────────────────────────────────┘  │
│                          │ bind mount (rw)                      │
│  ┌───────────────────────▼──────────────────────────────────┐  │
│  │ Docker (OrbStack)                                        │  │
│  │                                                          │  │
│  │  ┌────────────┐  ┌────────────┐  ┌──────────────────┐  │  │
│  │  │  Neo4j     │  │  Qdrant    │  │  ping-mem        │  │  │
│  │  │  :7474     │  │  :6333     │  │  :3000           │  │  │
│  │  │  :7687     │  │  :6334     │  │                  │  │  │
│  │  │            │  │            │  │  Volumes:        │  │  │
│  │  │  Graph DB  │  │  Vector DB │  │  - /data         │  │  │
│  │  │            │  │            │  │  - /projects:rw  │  │  │
│  │  └────────────┘  └────────────┘  └──────────────────┘  │  │
│  │                                                          │  │
│  │  Volumes:                                                │  │
│  │  - ping-mem-neo4j-data (persistent graph)               │  │
│  │  - ping-mem-qdrant-data (persistent vectors)            │  │
│  │  - ping-mem-data (persistent SQLite)                    │  │
│  └──────────────────────────────────────────────────────────┘  │
│                          ▲ HTTP/Bolt                            │
│  ┌───────────────────────┴──────────────────────────────────┐  │
│  │ MCP Server (Local Process - NOT in Docker)              │  │
│  │                                                          │  │
│  │  Command: bun run dist/mcp/cli.js                       │  │
│  │  Transport: stdio (stdin/stdout)                        │  │
│  │  Connects to: Neo4j (bolt://localhost:7687)             │  │
│  │               Qdrant (http://localhost:6333)            │  │
│  └──────────────────────┬───────────────────────────────────┘  │
│                         │ stdio                                │
│  ┌──────────────────────▼───────────────────────────────────┐  │
│  │ IDE (Cursor, Claude Code, VS Code, etc.)                │  │
│  │                                                          │  │
│  │  Config: .cursor/mcp.json or ~/.claude/mcp.json         │  │
│  │  Rules: .cursorrules                                    │  │
│  │  Tools: 27 MCP tools available                          │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Component Responsibilities

### Docker Services

**Neo4j (Graph Database)**
- Stores temporal code graph
- Nodes: Project, File, Chunk, Commit
- Relationships: HAS_FILE, HAS_CHUNK, MODIFIES, CHANGES
- Bi-temporal queries (event time + ingestion time)

**Qdrant (Vector Database)**
- Stores deterministic code vectors
- Payload: projectId, filePath, chunkId, type, content, lineStart, lineEnd
- Semantic search with filters

**ping-mem HTTP Server**
- REST API on port 3000 (or 3001 for REST-only)
- SSE streaming for real-time updates
- Endpoints: `/api/v1/codebase/*`, `/api/v1/context/*`, `/api/v1/diagnostics/*`
- Persistent SQLite: `/data/ping-mem.db`

### Local Processes

**MCP Server**
- Runs via: `bun run dist/mcp/cli.js`
- Transport: stdio (stdin/stdout)
- Connects to: Docker services via HTTP/Bolt
- Tools: 27 MCP tools (context, codebase, diagnostics, worklog)

**IDE/Agent**
- Loads MCP configuration
- Reads `.cursorrules` for instructions
- Calls MCP tools via stdio
- Records decisions, searches code, queries history

---

## Storage Strategy

### Persistent Storage (Survives Restarts)

| Data | Location | Format |
|------|----------|--------|
| Graph data | Docker volume `ping-mem-neo4j-data` | Neo4j native |
| Vector data | Docker volume `ping-mem-qdrant-data` | Qdrant native |
| Memory data | Docker volume `ping-mem-data` → `/data/ping-mem.db` | SQLite |
| Diagnostics | Docker volume `ping-mem-data` → `/data/ping-mem-diagnostics.db` | SQLite |
| Manifests | Host filesystem `project/.ping-mem/manifest.json` | JSON |

### Bind Mount Strategy

**Host → Container mapping:**
```
/Users/umasankr/Projects → /projects (read-write)
```

**Why read-write:**
- Ingestion writes `.ping-mem/manifest.json` into each project
- Manifest is version controlled (NOT in .gitignore)
- Enables deterministic change detection

**Example:**
- Host: `/Users/you/Projects/myapp/.ping-mem/manifest.json`
- Container: `/projects/myapp/.ping-mem/manifest.json`
- Same file, accessible from both

---

## Installation Scenarios

### Scenario 1: Developer Workstation

**Goal**: Use ping-mem for all projects on your Mac

```bash
# One-time setup
cd /path/to/ping-mem
./scripts/setup.sh

# Install globally
./scripts/install-client.sh --global

# Per project
cd ~/Projects/project-a
/path/to/ping-mem/scripts/ingest-project.sh .
```

**Result**: All IDEs can use ping-mem via MCP

### Scenario 2: Team Shared Instance

**Goal**: Team shares one ping-mem deployment

```bash
# Server setup (once)
./scripts/setup.sh

# Each developer
./scripts/install-client.sh --global

# Each project (once)
./scripts/ingest-project.sh /path/to/project
```

**Result**: Shared knowledge base, consistent indexing

### Scenario 3: CI/CD Pipeline

**Goal**: Automated ingestion and diagnostics

```bash
# In CI pipeline
docker compose up -d
./scripts/ingest-project.sh $CI_PROJECT_DIR
bun run diagnostics:collect --projectDir $CI_PROJECT_DIR
```

**Result**: Automated codebase tracking, regression detection

---

## Network Ports

| Port | Service | Protocol | Purpose |
|------|---------|----------|---------|
| 3000 | ping-mem | HTTP/SSE | Primary API |
| 3001 | ping-mem-rest | HTTP | REST-only (optional) |
| 6333 | Qdrant | HTTP | Vector operations |
| 6334 | Qdrant | gRPC | Vector operations |
| 7474 | Neo4j | HTTP | Browser UI |
| 7687 | Neo4j | Bolt | Graph queries |

---

## Security Considerations

### Credentials

**Default passwords** (change in production):
- Neo4j: `neo4j` / `neo4j_password`
- Qdrant: No auth (localhost only)
- ping-mem: Optional API key via `PING_MEM_API_KEY`

**Where to change:**
1. Edit `.env` file
2. Update `docker-compose.yml` environment section
3. Update MCP configs (`.cursor/mcp.json`, `~/.claude/mcp.json`)

### Bind Mount Security

**Risk**: Container has read-write access to `/Users/.../Projects`

**Mitigation:**
- Container runs as non-root (Dockerfile uses `oven/bun:alpine`)
- Only writes to `.ping-mem/manifest.json` (deterministic, version controlled)
- No arbitrary file writes

**Alternative** (more restrictive):
```yaml
volumes:
  - /Users/you/Projects/project-a:/projects/project-a:ro  # read-only
```
Then manually create `.ping-mem/` on host.

---

## Performance Characteristics

### Ingestion Performance

| Project Size | Files | Chunks | Time | Memory |
|--------------|-------|--------|------|--------|
| Small | <1000 | <10K | 1-2 min | <500 MB |
| Medium | 1000-5000 | 10K-50K | 3-10 min | 500MB-2GB |
| Large | >5000 | >50K | 10-30 min | 2-4 GB |

### Search Performance

| Operation | Latency | Throughput |
|-----------|---------|------------|
| Semantic search | <100ms | >100 qps |
| Timeline query | <200ms | >50 qps |
| Context save | <50ms | >200 qps |

### Storage Requirements

| Component | Size per 1000 files |
|-----------|---------------------|
| Neo4j graph | ~50-100 MB |
| Qdrant vectors | ~100-200 MB |
| SQLite memory | ~10-50 MB |
| Manifests | ~1-5 MB |

---

## Troubleshooting

### Issue: "IngestionService not configured"

**Cause**: Neo4j or Qdrant not reachable

**Fix:**
```bash
docker compose ps  # Check all services healthy
docker compose logs ping-mem  # Check error logs
```

### Issue: MCP tools not appearing

**Cause**: MCP config not loaded or incorrect path

**Fix:**
```bash
# Verify config exists
cat .cursor/mcp.json

# Verify path is correct
ls /path/to/ping-mem/dist/mcp/cli.js

# Rebuild if needed
cd /path/to/ping-mem && bun run build

# Restart IDE
```

### Issue: Ingestion fails with "permission denied"

**Cause**: Container can't write to bind mount

**Fix:**
```bash
# Check bind mount in docker-compose.yml
docker compose config | grep -A 5 volumes

# Verify permissions
ls -la /Users/you/Projects/project/.ping-mem/
```

---

## See Also

- [INSTALLATION.md](INSTALLATION.md) - Complete installation guide
- [AGENT_INSTRUCTIONS.md](../AGENT_INSTRUCTIONS.md) - Agent workflow
- [AGENT_WORKFLOW.md](AGENT_WORKFLOW.md) - Detailed patterns
- [DOCKER.md](../DOCKER.md) - Docker deployment details
- [CLAUDE.md](../CLAUDE.md) - Full project documentation
