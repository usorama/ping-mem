# Agent Integration Guide

**Version**: 2.0.0
**Status**: Canonical Reference
**Last Updated**: 2026-02-13

> This is the **single source of truth** for integrating AI agents with ping-mem.
> It supersedes `AGENT_INSTRUCTIONS.md`, `docs/AGENT_WORKFLOW.md`, and `~/.claude/ping-mem-agent-workflow.md`.

---

## 1. Overview

**ping-mem** is a Universal Memory Layer for AI agents. It provides:

- **Persistent memory** across sessions (key-value with categories, priorities, channels)
- **Deterministic codebase ingestion** (code chunking, git history, Merkle-tree hashing)
- **Semantic code search** via Qdrant (deterministic hash-based vectors)
- **Temporal code graph** via Neo4j (bi-temporal model with commit DAG)
- **Diagnostics tracking** (SARIF 2.1.0 ingestion, multi-tool comparison, LLM summaries)
- **Worklog events** for full session provenance

Agents connect via **MCP (stdio)**, **REST API**, or **TypeScript Client SDK**.

---

## 2. Quick Start

### Step 1: Ensure infrastructure is running

```bash
docker compose -f ~/Projects/ping-mem/docker-compose.yml up -d
```

Verify:
```bash
curl http://localhost:3000/health        # SSE/MCP server
curl http://localhost:6333/collections   # Qdrant
docker exec ping-mem-neo4j cypher-shell -u neo4j -p neo4j_password "RETURN 1"  # Neo4j
```

### Step 2: Start a session

```json
{
  "tool": "context_session_start",
  "arguments": {
    "name": "my-agent-session",
    "projectDir": "/path/to/project",
    "autoIngest": true
  }
}
```

### Step 3: Search and save

```json
// Search code
{ "tool": "codebase_search", "arguments": { "query": "authentication middleware", "limit": 10 } }

// Save a decision
{ "tool": "context_save", "arguments": { "key": "auth-approach", "value": "Using JWT with RS256", "category": "decision" } }
```

---

## 3. Connection Methods

### 3.1 MCP (stdio) — Claude Code

Add to `~/.claude/mcp.json`:

```json
{
  "mcpServers": {
    "ping-mem": {
      "command": "bun",
      "args": ["run", "/Users/umasankr/Projects/ping-mem/dist/mcp/cli.js"],
      "env": {
        "PING_MEM_DB_PATH": "~/.claude/ping-mem.db",
        "NEO4J_URI": "bolt://localhost:7687",
        "NEO4J_USERNAME": "neo4j",
        "NEO4J_PASSWORD": "neo4j_password",
        "QDRANT_URL": "http://localhost:6333",
        "QDRANT_COLLECTION_NAME": "ping-mem-vectors",
        "QDRANT_VECTOR_DIMENSIONS": "768"
      }
    }
  }
}
```

Tools are available as `context_*`, `codebase_*`, `diagnostics_*`, `worklog_*`.

### 3.2 REST API

Base URLs:
- **SSE server**: `http://localhost:3000` (primary, supports SSE streaming)
- **REST server**: `http://localhost:3003` (Docker, REST-only clients)

Headers:
```
Content-Type: application/json
X-Session-ID: <session-id>       # For context operations
X-API-Key: <key>                 # If authentication is configured
```

### 3.3 TypeScript Client SDK

```typescript
import { createRESTClient } from "ping-mem/client";

const client = createRESTClient({ baseUrl: "http://localhost:3000" });
await client.startSession({ name: "sdk-session", projectDir: process.cwd() });
await client.save("key", "value", { category: "note" });
const results = await client.search({ query: "authentication", limit: 10 });
await client.close();
```

### 3.4 Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PING_MEM_DB_PATH` | No | `:memory:` | SQLite database path |
| `PING_MEM_PORT` | No | `3000` | HTTP server port |
| `PING_MEM_TRANSPORT` | No | `rest` | Transport mode (`rest`, `sse`, `streamable-http`) |
| `NEO4J_URI` | For ingestion | — | Neo4j Bolt URI (`bolt://localhost:7687`) |
| `NEO4J_USERNAME` | For ingestion | `neo4j` | Neo4j username |
| `NEO4J_PASSWORD` | For ingestion | — | Neo4j password |
| `QDRANT_URL` | For ingestion | — | Qdrant REST URL (`http://localhost:6333`) |
| `QDRANT_COLLECTION_NAME` | For ingestion | `ping-mem-vectors` | Qdrant collection name |
| `QDRANT_VECTOR_DIMENSIONS` | For ingestion | `768` | Vector dimensions |
| `OPENAI_API_KEY` | For LLM summaries | — | OpenAI API key |
| `PING_MEM_ENABLE_LLM_SUMMARIES` | No | `false` | Enable LLM-powered diagnostics summaries |
| `PING_MEM_API_KEY` | For auth | — | Seed API key for request authentication |
| `PING_MEM_ADMIN_USER` | For admin | — | Admin panel Basic Auth username |
| `PING_MEM_ADMIN_PASS` | For admin | — | Admin panel Basic Auth password |
| `PING_MEM_SECRET_KEY` | For encryption | — | Secret for AES-256-GCM key encryption |
| `PING_MEM_DIAGNOSTICS_DB_PATH` | No | `~/.ping-mem/diagnostics.db` | Diagnostics SQLite DB path |
| `PING_MEM_ADMIN_DB_PATH` | No | `~/.ping-mem/admin.db` | Admin SQLite DB path |

---

## 4. Core Workflow

### Session Lifecycle

```
Start Session → Search/Save → Checkpoint → End Session
     ↓              ↓              ↓
  auto-ingest   codebase_*     backup state
  project       context_*      before risky ops
```

### 4.1 Start Session

```json
{
  "tool": "context_session_start",
  "arguments": {
    "name": "implement-feature-x",
    "projectDir": "/Users/me/myproject",
    "autoIngest": true
  }
}
```

Response includes `sessionId` and ingestion result (if `autoIngest: true`).

### 4.2 Search Before Changing Code

Always search existing code before making changes:

```json
{
  "tool": "codebase_search",
  "arguments": {
    "query": "authentication middleware express",
    "projectId": "<from-ingestion>",
    "type": "code",
    "limit": 10
  }
}
```

For history/provenance questions:

```json
{
  "tool": "codebase_timeline",
  "arguments": {
    "projectId": "<project-id>",
    "filePath": "src/middleware/auth.ts",
    "limit": 50
  }
}
```

### 4.3 Save Decisions and Progress

```json
{
  "tool": "context_save",
  "arguments": {
    "key": "decision:oauth-provider",
    "value": "Using Auth0 for OAuth because of existing enterprise SSO integration",
    "category": "decision",
    "priority": "high",
    "extractEntities": true
  }
}
```

Categories: `task`, `decision`, `progress`, `note`, `error`, `warning`, `fact`, `observation`

Priorities: `high`, `normal`, `low`

### 4.4 Create Checkpoints Before Risky Operations

```json
{
  "tool": "context_checkpoint",
  "arguments": {
    "name": "pre-refactor",
    "description": "Before auth system refactor"
  }
}
```

### 4.5 End Session

```json
{
  "tool": "context_session_end",
  "arguments": {
    "reason": "Feature implementation complete"
  }
}
```

---

## 5. MCP Tool Reference

### Context Tools (14 tools)

| Tool | Description | Required Params |
|------|-------------|-----------------|
| `context_session_start` | Start session with optional auto-ingest | `name` |
| `context_session_end` | End the current session | — |
| `context_session_list` | List recent sessions | — |
| `context_save` | Save memory with key-value, category, priority | `key`, `value` |
| `context_get` | Retrieve memories by key, pattern, or filters | — |
| `context_search` | Semantic search for relevant memories | `query` |
| `context_delete` | Delete a memory by key | `key` |
| `context_checkpoint` | Create named checkpoint of session state | `name` |
| `context_status` | Get session status and statistics | — |
| `context_query_relationships` | Query knowledge graph relationships for an entity | `entityId` |
| `context_hybrid_search` | Combined semantic + keyword + graph search | `query` |
| `context_get_lineage` | Trace upstream/downstream entity lineage | `entityId` |
| `context_query_evolution` | Query temporal evolution of an entity | `entityId` |
| `context_health` | Check service health (Neo4j, Qdrant, SQLite) | — |

### Codebase Tools (5 tools)

| Tool | Description | Required Params |
|------|-------------|-----------------|
| `codebase_ingest` | Ingest project: scan, chunk, index git history | `projectDir` |
| `codebase_verify` | Verify manifest matches on-disk project state | `projectDir` |
| `codebase_search` | Semantic code search with provenance | `query` |
| `codebase_timeline` | Query commit timeline with explicit "why" | `projectId` |
| `codebase_list_projects` | List all ingested projects with metadata | — |

### Diagnostics Tools (7 tools)

| Tool | Description | Required Params |
|------|-------------|-----------------|
| `diagnostics_ingest` | Ingest SARIF 2.1.0 or normalized findings | `projectId`, `treeHash`, `configHash` |
| `diagnostics_latest` | Get latest diagnostics run for project/tool | `projectId` |
| `diagnostics_list` | List findings for an analysis | `analysisId` |
| `diagnostics_diff` | Diff two analyses (introduced/resolved/unchanged) | `analysisIdA`, `analysisIdB` |
| `diagnostics_summary` | Aggregate finding counts by severity | `analysisId` |
| `diagnostics_compare_tools` | Compare across tools for same project state | `projectId`, `treeHash` |
| `diagnostics_by_symbol` | Group findings by symbol or file | `analysisId` |
| `diagnostics_summarize` | LLM-powered summary with caching | `analysisId` |

### Worklog Tools (2 tools)

| Tool | Description | Required Params |
|------|-------------|-----------------|
| `worklog_record` | Record deterministic worklog event | `kind`, `title` |
| `worklog_list` | List worklog events for a session | — |

### Admin Tools (1 tool)

| Tool | Description | Required Params |
|------|-------------|-----------------|
| `project_delete` | Delete all data for a project directory | `projectDir` |

---

## 6. REST API Reference

### Health & Status

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check (200 if server running) |
| GET | `/api/v1/status` | Session + event store statistics |
| GET | `/api/v1/memory/stats` | Relevance engine statistics |

### Session Management

| Method | Endpoint | Body | Description |
|--------|----------|------|-------------|
| POST | `/api/v1/session/start` | `{name, projectDir?, continueFrom?, defaultChannel?}` | Start session |
| POST | `/api/v1/session/end` | — | End current session |
| GET | `/api/v1/session/list?limit=N` | — | List sessions |

### Context Operations

| Method | Endpoint | Body/Params | Description |
|--------|----------|-------------|-------------|
| POST | `/api/v1/context` | `{key, value, category?, priority?, channel?, metadata?}` | Save memory |
| GET | `/api/v1/context/:key` | — | Get memory by key |
| DELETE | `/api/v1/context/:key` | — | Delete memory |
| GET | `/api/v1/search?query=...&category=...&limit=N` | — | Search memories |
| POST | `/api/v1/checkpoint` | `{description?}` | Create checkpoint |
| POST | `/api/v1/memory/consolidate` | `{maxScore?, minDaysOld?}` | Consolidate stale memories |

### Codebase Operations

All codebase endpoints return **503** if IngestionService is not configured (Neo4j + Qdrant not running).

| Method | Endpoint | Body/Params | Description |
|--------|----------|-------------|-------------|
| POST | `/api/v1/codebase/ingest` | `{projectDir, forceReingest?}` | Ingest project |
| POST | `/api/v1/codebase/verify` | `{projectDir}` | Verify manifest integrity |
| **GET** | `/api/v1/codebase/search?query=...&projectId=...&type=...&limit=N` | — | **Semantic code search** |
| GET | `/api/v1/codebase/timeline?projectId=...&filePath=...&limit=N` | — | Commit timeline |

> **Important**: Codebase search is a **GET** endpoint with query params, NOT POST.

### Diagnostics Operations

| Method | Endpoint | Body/Params | Description |
|--------|----------|-------------|-------------|
| POST | `/api/v1/diagnostics/ingest` | `{projectId, treeHash, configHash, sarif/findings, ...}` | Ingest SARIF |
| GET | `/api/v1/diagnostics/latest?projectId=...&toolName=...` | — | Latest run |
| GET | `/api/v1/diagnostics/findings/:analysisId` | — | List findings |
| POST | `/api/v1/diagnostics/diff` | `{analysisIdA, analysisIdB}` | Diff two analyses |
| GET | `/api/v1/diagnostics/summary/:analysisId` | — | Severity counts |
| POST | `/api/v1/diagnostics/summarize/:analysisId` | `{useLLM?, forceRefresh?}` | LLM summary |

---

## 7. Codebase Ingestion

### How It Works

The ingestion pipeline runs in three phases:

```
Phase 1: IngestionOrchestrator.ingest()
  ├── ProjectScanner: Merkle tree hash, content-addressable file IDs
  ├── CodeChunker: Split code vs comments vs docstrings
  ├── GitHistoryReader: Commit DAG + unified diffs
  └── SymbolExtractor: AST-based symbols (TS/JS), regex (Python)

Phase 2: TemporalCodeGraph.persistIngestion()
  └── Neo4j: Project → File → Chunk → Commit nodes + relationships

Phase 3: CodeIndexer.indexIngestion()
  └── Qdrant: Deterministic hash-based vectors for all code chunks
```

### Ingestion Options

| Option | Default | Description |
|--------|---------|-------------|
| `projectDir` | — | Absolute path to project root (required) |
| `forceReingest` | `false` | Ignore cached manifest and re-ingest everything |
| `maxCommits` | `200` | Maximum git commits to ingest. Lower for cloned repos you don't own |

### Project Identity (Path-Independent)

**ProjectId is computed from git identity, NOT filesystem paths:**

```
projectId = SHA-256(gitRemoteUrl + "::" + relativeToGitRoot)
```

This ensures identical projectIds regardless of:
- Local clone path vs Docker mount path (`/Users/dev/project` vs `/projects/project`)
- CI runner paths vs developer machines
- Different OS path separators

The `ProjectScanner.scanProject()` also calls `fs.realpathSync()` to resolve symlinks (e.g., macOS `/var` → `/private/var`) before computing paths.

### Auto-Ingestion

Projects registered in `~/.ping-mem/registered-projects.txt` are auto-ingested via:
- **Git post-commit hook** (global hook, fires on every commit)
- **launchd periodic job** (every 10 minutes)

Register a project:
```bash
echo "/path/to/project" >> ~/.ping-mem/registered-projects.txt
```

### Manual Ingestion

```bash
# Via MCP tool
codebase_ingest({ projectDir: "/path/to/project", forceReingest: true, maxCommits: 500 })

# Via utility script
NEO4J_URI=bolt://localhost:7687 NEO4J_USERNAME=neo4j NEO4J_PASSWORD=neo4j_password \
QDRANT_URL=http://localhost:6333 QDRANT_COLLECTION_NAME=ping-mem-vectors \
bun run scripts/force-ingest.ts /path/to/project
```

---

## 8. Cross-Environment Integration

### Docker Volume Mapping

```yaml
# docker-compose.yml
volumes:
  - /Users/umasankr/Projects:/projects:rw
```

| Host Path | Container Path |
|-----------|---------------|
| `/Users/umasankr/Projects/openclaw` | `/projects/openclaw` |
| `/Users/umasankr/Projects/ping-mem` | `/projects/ping-mem` |

Because projectId uses `SHA-256(gitRemoteUrl + "::" + relativeToGitRoot)`, the same project produces the same projectId in both environments.

### Docker Service Ports

| Service | Container Name | Port | Protocol |
|---------|---------------|------|----------|
| Neo4j HTTP | `ping-mem-neo4j` | 7474 | HTTP |
| Neo4j Bolt | `ping-mem-neo4j` | 7687 | Bolt |
| Qdrant HTTP | `ping-mem-qdrant` | 6333 | HTTP |
| Qdrant gRPC | `ping-mem-qdrant` | 6334 | gRPC |
| ping-mem | `ping-mem` | 3000 | HTTP (transport via `PING_MEM_TRANSPORT`) |

### Symlink Handling (macOS)

macOS maps `/var` → `/private/var`. The `ProjectScanner` uses `fs.realpathSync()` to resolve this before computing `path.relative()`, preventing projectId mismatches between tools that resolve symlinks differently.

### CI/CD Integration

In CI environments, ensure:
1. Git remote URL matches local development (same origin)
2. The relative path within the repo is the same (usually the repo root)
3. Neo4j + Qdrant are accessible (use Docker service networking)

---

## 9. Performance & Scaling

### Neo4j UNWIND Batching

`TemporalCodeGraph.persistIngestion()` uses UNWIND batching for all Neo4j operations — files, chunks, commits, and relationships are processed in batches of 500 items per Cypher query. This provides ~10x speedup over individual queries.

### Qdrant Batch Upsert

`CodeIndexer.indexIngestion()` upserts vectors in batches of **500 points per request**. This prevents HTTP 400 errors from Qdrant when ingesting large repos (57K+ chunks).

### Commit Limit Tuning

| Scenario | Recommended `maxCommits` |
|----------|--------------------------|
| Your own actively developed repo | `200` (default) |
| Large monorepo | `100` |
| Cloned OSS repo you don't own | `50` |
| Full history analysis needed | `1000`+ |

### Ingestion Time Estimates

| Repo Size | Files | Approx. Time |
|-----------|-------|---------------|
| Small (< 100 files) | ~50 | 5-15 seconds |
| Medium (100-500 files) | ~300 | 30-90 seconds |
| Large (500-2000 files) | ~1000 | 2-5 minutes |

The bottleneck is typically Neo4j persist (Phase 2), especially for repos with many commits.

---

## 10. Troubleshooting

### Qdrant 400 on Large Repos

**Symptom**: Ingestion fails during Phase 3 with HTTP 400 from Qdrant.

**Cause**: Batch size too large for Qdrant's request limit.

**Fix**: This was fixed in commit `a01c092` (batch upserts capped at 500 points). Ensure you're running the latest code:
```bash
cd ~/Projects/ping-mem && docker compose build && docker compose up -d
```

### Stale Neo4j Nodes After ProjectId Changes

**Symptom**: Duplicate project nodes in Neo4j from old path-dependent IDs.

**Fix**: Clean up stale nodes:
```cypher
// List all projects
MATCH (p:Project) RETURN p.projectId, p.rootPath

// Delete stale project and all its data
MATCH (p:Project {projectId: "stale-id"})
OPTIONAL MATCH (p)-[*]->(n)
DETACH DELETE p, n
```

### 503 on Codebase Endpoints

**Symptom**: REST API returns `503 "Ingestion service not configured"`.

**Cause**: IngestionService not initialized (Neo4j or Qdrant not available at startup).

**Fix**:
```bash
docker compose up -d        # Ensure all containers running
docker restart ping-mem      # Restart to re-initialize
```

### Search Returns No Results

**Cause 1**: Project not ingested yet.
```bash
curl "http://localhost:3003/api/v1/codebase/search?query=test&limit=1"
# If empty, ingest first
```

**Cause 2**: Stale `.ping-mem/manifest.json` blocking re-ingestion.
```bash
rm /path/to/project/.ping-mem/manifest.json
# Then re-ingest
```

**Cause 3**: Wrong projectId filter.
```json
// Use codebase_list_projects to find the correct projectId
{ "tool": "codebase_list_projects", "arguments": {} }
```

### Ingestion Crashes Mid-Way

If ingestion completes Phase 1-2 (Neo4j) but fails during Phase 3 (Qdrant), use the Qdrant-only reindex script:

```bash
NEO4J_URI=bolt://localhost:7687 NEO4J_USERNAME=neo4j NEO4J_PASSWORD=neo4j_password \
QDRANT_URL=http://localhost:6333 QDRANT_COLLECTION_NAME=ping-mem-vectors \
bun run scripts/reindex-qdrant.ts /path/to/project
```

### Docker Containers Unhealthy

```bash
docker ps                           # Check status
docker logs ping-mem-neo4j          # Neo4j logs
docker logs ping-mem                # ping-mem logs
docker restart ping-mem-neo4j       # Restart Neo4j
docker restart ping-mem-qdrant      # Restart Qdrant
docker compose up -d                # Ensure all services up
```

### Connection Refused Errors

| Error | Service | Fix |
|-------|---------|-----|
| `ECONNREFUSED :7687` | Neo4j | `docker restart ping-mem-neo4j` |
| `ECONNREFUSED :6333` | Qdrant | `docker restart ping-mem-qdrant` |
| `ECONNREFUSED :3000` | ping-mem SSE | `docker compose up -d` |
| `ECONNREFUSED :3003` | ping-mem REST | `docker compose --profile rest-api up -d` |

---

## 11. Utility Scripts

### `scripts/force-ingest.ts`

Force re-ingest a project, bypassing manifest cache:

```bash
NEO4J_URI=bolt://localhost:7687 NEO4J_USERNAME=neo4j NEO4J_PASSWORD=neo4j_password \
QDRANT_URL=http://localhost:6333 QDRANT_COLLECTION_NAME=ping-mem-vectors \
bun run scripts/force-ingest.ts /path/to/project
```

### `scripts/reindex-qdrant.ts`

Re-scan and re-index only Qdrant vectors (skips Neo4j). Use when Neo4j data is intact but Qdrant indexing failed:

```bash
QDRANT_URL=http://localhost:6333 QDRANT_COLLECTION_NAME=ping-mem-vectors \
bun run scripts/reindex-qdrant.ts /path/to/project
```

### `scripts/direct-ingest.ts`

Direct ingestion for testing/debugging.

### `scripts/verify-persistence.ts`

Verify data persistence across restarts.

---

## 12. Anti-Patterns

### DO NOT use grep/ripgrep for code search

```
# Wrong
rg "function authenticate" src/

# Right
codebase_search({ query: "authentication function", type: "code" })
```

### DO NOT use git log for history

```
# Wrong
git log --oneline src/auth.ts

# Right
codebase_timeline({ projectId: "...", filePath: "src/auth.ts" })
```

### DO NOT skip project scoping in multi-project environments

```typescript
// Wrong — searches ALL projects
codebase_search({ query: "auth" })

// Right — scoped to one project
const { projectId } = await codebase_ingest({ projectDir: "/path/to/project" })
codebase_search({ query: "auth", projectId })
```

### DO NOT forget to save decisions

```typescript
// Wrong — architectural decision lost after session
// "Let's use JWT with RS256"

// Right — persisted for future sessions
context_save({
  key: "decision:auth-method",
  value: "Using JWT with RS256 for API authentication",
  category: "decision",
  priority: "high"
})
```

### DO NOT skip verification

```typescript
// Wrong — start working without checking project state
codebase_search({ query: "..." })

// Right — verify manifest is current first
const verify = await codebase_verify({ projectDir: "/path/to/project" })
if (!verify.valid) {
  await codebase_ingest({ projectDir: "/path/to/project" })
}
```

### DO NOT hardcode high maxCommits for repos you don't own

```typescript
// Wrong — wastes time on 1000 commits of someone else's repo
codebase_ingest({ projectDir: "/path/to/oss-lib", maxCommits: 1000 })

// Right — limit for external repos
codebase_ingest({ projectDir: "/path/to/oss-lib", maxCommits: 50 })
```

---

## 13. Complete Example Session

```typescript
// 1. Start session with auto-ingest
const session = await context_session_start({
  name: "implement-oauth",
  projectDir: "/Users/me/myproject",
  autoIngest: true
});
// session.projectId is now available

// 2. Search for existing auth code
const authCode = await codebase_search({
  query: "authentication middleware express",
  projectId: session.projectId,
  type: "code",
  limit: 10
});

// 3. Check history for context
const authHistory = await codebase_timeline({
  projectId: session.projectId,
  filePath: "src/middleware/auth.ts"
});

// 4. Record architectural decision
await context_save({
  key: "oauth-provider-choice",
  value: "Using Auth0 for OAuth because of existing enterprise SSO integration",
  category: "decision",
  priority: "high",
  extractEntities: true
});

// 5. Checkpoint before risky changes
await context_checkpoint({
  name: "pre-oauth-refactor",
  description: "Before replacing session-based auth with OAuth"
});

// 6. ... make code changes ...

// 7. Re-ingest to update vectors
await codebase_ingest({
  projectDir: "/Users/me/myproject",
  forceReingest: true
});

// 8. Run diagnostics and record
await diagnostics_ingest({
  projectId: session.projectId,
  treeHash: newTreeHash,
  toolName: "tsc",
  toolVersion: "5.3.3",
  configHash: configHash,
  sarif: tscSarifOutput
});

// 9. Record worklog event
await worklog_record({
  kind: "task",
  title: "Implement OAuth with Auth0",
  status: "success",
  phase: "completed",
  summary: "Replaced session auth with Auth0 OAuth, 0 type errors"
});

// 10. End session
await context_session_end({ reason: "OAuth implementation complete" });
```

---

## 14. Version History

| Version | Date | Changes |
|---------|------|---------|
| 2.0.0 | 2026-02-13 | Consolidated guide from 3 docs. Added: path-independent projectId, symlink resolution, Qdrant batch upserts, Neo4j UNWIND batching, configurable maxCommits (default 200), utility scripts, complete REST API reference, all 30 MCP tools, performance tuning, Docker integration details |
| — | 2026-02-12 | Session fixes: path-independent projectId, macOS symlink handling, Qdrant 400 fix, Neo4j UNWIND batching, maxCommits option |
| 1.0.0 | 2026-02-01 | Initial agent workflow documentation (split across 3 files) |
