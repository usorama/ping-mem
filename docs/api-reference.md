# ping-mem API Reference

> Complete reference for all 32 MCP tools and REST API endpoints.

**Version**: 1.4.0
**Transport**: MCP (stdio), REST (HTTP), SSE (streaming)

---

## Table of Contents

- [Overview](#overview)
- [MCP Tools](#mcp-tools)
  - [Session Management](#session-management)
  - [Memory Operations](#memory-operations)
  - [Search](#search)
  - [Checkpoints](#checkpoints)
  - [Knowledge Graph](#knowledge-graph)
  - [Codebase Intelligence](#codebase-intelligence)
  - [Diagnostics](#diagnostics)
  - [Worklog](#worklog)
  - [Memory Intelligence](#memory-intelligence)
  - [Project Management](#project-management)
  - [Health](#health)
- [REST API](#rest-api)
  - [Authentication](#authentication)
  - [Session Endpoints](#session-endpoints)
  - [Context Endpoints](#context-endpoints)
  - [Codebase Endpoints](#codebase-endpoints)
  - [Diagnostics Endpoints](#diagnostics-endpoints)
  - [Admin Endpoints](#admin-endpoints)

---

## Overview

ping-mem exposes its functionality through two interfaces:

| Interface | Transport | Use Case |
|-----------|-----------|----------|
| **MCP Server** | stdio | Claude Code, Cursor, and other MCP-compatible AI tools |
| **HTTP Server** | REST / SSE | Web apps, scripts, CI/CD, any HTTP client |

All MCP tools are prefixed with the server name when loaded (e.g., `context_save` becomes `ping_mem_context_save` in Claude Code).

---

## MCP Tools

### Session Management

#### `context_session_start`

Start a new memory session. Sessions isolate memory and provide audit trails.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `name` | string | Yes | Session name (descriptive label) |
| `projectDir` | string | No | Project directory for context isolation |
| `continueFrom` | string | No | Session ID to continue from (loads previous context) |
| `defaultChannel` | string | No | Default channel for memories saved in this session |
| `autoIngest` | boolean | No | Auto-ingest project codebase when `projectDir` is set (default: `false`) |

**Returns:**

```json
{
  "success": true,
  "sessionId": "01924a3b-...",
  "name": "my-session",
  "status": "active",
  "startedAt": "2026-02-14T10:00:00.000Z",
  "ingestResult": { "filesIndexed": 150 }
}
```

**Example:**

```
context_session_start({
  name: "feature-auth",
  projectDir: "/home/user/myproject",
  autoIngest: true
})
```

**Edge Cases:**
- If `continueFrom` references a non-existent session, a new session is created without continuation.
- `autoIngest` requires Neo4j and Qdrant to be running. If unavailable, session starts without ingestion and logs a warning.
- Maximum active sessions is enforced (default: 10). Starting a new session when at the limit returns an error.

---

#### `context_session_end`

End the current active session.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `reason` | string | No | Reason for ending the session |

**Returns:**

```json
{
  "success": true,
  "sessionId": "01924a3b-...",
  "status": "ended",
  "endedAt": "2026-02-14T12:00:00.000Z"
}
```

**Edge Cases:**
- Returns an error if no active session exists.
- Ending a session is idempotent — ending an already-ended session is a no-op.

---

#### `context_session_list`

List recent sessions.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `limit` | number | No | Maximum sessions to return (default: `10`) |

**Returns:**

```json
{
  "count": 3,
  "sessions": [
    {
      "id": "01924a3b-...",
      "name": "feature-auth",
      "status": "active",
      "startedAt": "2026-02-14T10:00:00.000Z",
      "memoryCount": 42,
      "eventCount": 87
    }
  ]
}
```

---

#### `context_status`

Get current session status and server statistics.

**Parameters:** None

**Returns:**

```json
{
  "hasActiveSession": true,
  "session": {
    "id": "01924a3b-...",
    "name": "feature-auth",
    "status": "active",
    "memoryCount": 42,
    "eventCount": 87,
    "lastActivityAt": "2026-02-14T11:30:00.000Z"
  },
  "stats": {
    "totalSessions": 15,
    "totalEvents": 1200
  }
}
```

---

### Memory Operations

#### `context_save`

Save a memory item with automatic entity extraction and proactive recall.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `key` | string | Yes | Unique key for the memory |
| `value` | string | Yes | Memory content (text) |
| `category` | enum | No | `task`, `decision`, `progress`, `note`, `error`, `warning`, `fact`, `observation` |
| `priority` | enum | No | `high`, `normal`, `low` |
| `channel` | string | No | Channel for organization (e.g., `"auth"`, `"frontend"`) |
| `metadata` | object | No | Custom key-value metadata |
| `extractEntities` | boolean | No | Extract entities and store in knowledge graph |
| `skipProactiveRecall` | boolean | No | Skip proactive recall of related memories (default: `false`) |

**Returns:**

```json
{
  "success": true,
  "memoryId": "mem-01924a3b-...",
  "key": "auth-decision",
  "entityIds": ["entity-1", "entity-2"],
  "relatedMemories": [
    {
      "key": "auth-research",
      "value": "JWT vs session tokens comparison...",
      "relevance": 0.87
    }
  ]
}
```

**Example:**

```
context_save({
  key: "auth-decision",
  value: "Using JWT with RS256 for API authentication",
  category: "decision",
  priority: "high",
  extractEntities: true
})
```

**Edge Cases:**
- Saving with a duplicate `key` in the same session updates the existing memory.
- `extractEntities` requires the knowledge graph (Neo4j). If unavailable, the save succeeds but `entityIds` is empty.
- Proactive recall searches across all sessions for the same project, not just the current one.

---

#### `context_get`

Retrieve memories by key or query parameters.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `key` | string | No | Exact key to retrieve |
| `keyPattern` | string | No | Wildcard pattern (e.g., `"auth-*"`) |
| `category` | string | No | Filter by category |
| `channel` | string | No | Filter by channel |
| `limit` | number | No | Maximum results |
| `offset` | number | No | Pagination offset |

**Returns (single key):**

```json
{
  "found": true,
  "memory": {
    "id": "mem-01924a3b-...",
    "key": "auth-decision",
    "value": "Using JWT with RS256...",
    "category": "decision",
    "priority": "high",
    "createdAt": "2026-02-14T10:30:00.000Z"
  }
}
```

**Returns (pattern/filter):**

```json
{
  "count": 5,
  "memories": [...]
}
```

**Edge Cases:**
- At least one of `key`, `keyPattern`, `category`, or `channel` must be provided.
- `keyPattern` supports `*` wildcards (e.g., `"auth-*"` matches `"auth-decision"`, `"auth-config"`).
- Returns `{ "found": false }` when a specific key is not found.

---

#### `context_delete`

Delete a memory by key.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `key` | string | Yes | Key of the memory to delete |

**Returns:**

```json
{
  "success": true,
  "key": "auth-decision"
}
```

---

### Search

#### `context_search`

Semantic search across memories in the current session.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `query` | string | Yes | Natural language search query |
| `minSimilarity` | number | No | Minimum similarity score, 0–1 |
| `category` | string | No | Filter by category |
| `channel` | string | No | Filter by channel |
| `limit` | number | No | Maximum results |

**Returns:**

```json
{
  "count": 3,
  "results": [
    {
      "key": "auth-decision",
      "value": "Using JWT with RS256...",
      "score": 0.92,
      "category": "decision"
    }
  ]
}
```

---

#### `context_hybrid_search`

Hybrid search combining semantic, keyword, and graph-based search with configurable weights.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `query` | string | Yes | Search query |
| `limit` | number | No | Maximum results |
| `weights` | object | No | Search mode weights |
| `weights.semantic` | number | No | Semantic search weight (0–1) |
| `weights.keyword` | number | No | Keyword search weight (0–1) |
| `weights.graph` | number | No | Graph search weight (0–1) |
| `sessionId` | string | No | Filter by session |

**Returns:**

```json
{
  "query": "authentication",
  "count": 5,
  "results": [
    {
      "key": "auth-decision",
      "value": "Using JWT...",
      "score": 0.95,
      "source": "semantic"
    }
  ]
}
```

**Edge Cases:**
- Weights default to equal distribution across available search backends.
- Graph search requires Neo4j. If unavailable, only semantic and keyword results are returned.

---

### Checkpoints

#### `context_checkpoint`

Create a named checkpoint of the current session state. Useful before risky operations.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `name` | string | Yes | Checkpoint name |
| `description` | string | No | Checkpoint description |

**Returns:**

```json
{
  "success": true,
  "checkpointId": "cp-01924a3b-...",
  "name": "pre-refactor",
  "timestamp": "2026-02-14T11:00:00.000Z"
}
```

---

### Knowledge Graph

#### `context_query_relationships`

Query entity relationships in the knowledge graph.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `entityId` | string | Yes | Entity ID or name to query |
| `depth` | number | No | Max traversal depth (default: `1`) |
| `relationshipTypes` | string[] | No | Filter by relationship types |
| `direction` | enum | No | `incoming`, `outgoing`, `both` |

**Returns:**

```json
{
  "entities": [
    { "id": "e1", "type": "CONCEPT", "name": "JWT" }
  ],
  "relationships": [
    { "type": "USES", "sourceId": "e1", "targetId": "e2", "weight": 0.9 }
  ],
  "paths": [...]
}
```

**Edge Cases:**
- Requires Neo4j. Returns an error if the graph backend is not configured.
- `entityId` can be the entity name (case-insensitive) or the entity UUID.

---

#### `context_get_lineage`

Trace upstream/downstream dependency lineage for an entity.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `entityId` | string | Yes | Entity ID to trace |
| `direction` | enum | No | `upstream`, `downstream`, `both` |
| `maxDepth` | number | No | Maximum traversal depth |

**Returns:**

```json
{
  "entityId": "e1",
  "direction": "both",
  "upstream": [...],
  "downstream": [...],
  "upstreamCount": 3,
  "downstreamCount": 5
}
```

---

#### `context_query_evolution`

Query temporal evolution of an entity — how it changed over time.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `entityId` | string | Yes | Entity ID |
| `startTime` | string | No | ISO 8601 start date |
| `endTime` | string | No | ISO 8601 end date |

**Returns:**

```json
{
  "entityId": "e1",
  "entityName": "AuthService",
  "totalChanges": 7,
  "changes": [
    {
      "timestamp": "2026-02-10T...",
      "changeType": "update",
      "details": "..."
    }
  ]
}
```

---

### Codebase Intelligence

These tools require Neo4j and Qdrant to be running.

#### `codebase_ingest`

Ingest a project codebase with deterministic hashing, code chunking, and git history extraction.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `projectDir` | string | Yes | Absolute path to project root |
| `forceReingest` | boolean | No | Force re-ingestion even if no changes detected |

**Returns:**

```json
{
  "success": true,
  "hadChanges": true,
  "projectId": "sha256-...",
  "treeHash": "abc123...",
  "filesIndexed": 250,
  "chunksIndexed": 1500,
  "commitsIndexed": 150,
  "ingestedAt": "2026-02-14T10:00:00.000Z"
}
```

**Edge Cases:**
- Returns `{ "hadChanges": false }` if the project hasn't changed since last ingestion (manifest comparison).
- `projectId` is path-independent: computed from `SHA-256(gitRemoteUrl + "::" + relativePath)`. The same project produces the same ID regardless of clone location.
- Returns 503 if Neo4j or Qdrant is not configured.

---

#### `codebase_verify`

Verify that the ingested manifest matches the current on-disk state.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `projectDir` | string | Yes | Absolute path to project root |

**Returns:**

```json
{
  "projectId": "sha256-...",
  "valid": true,
  "manifestTreeHash": "abc123...",
  "currentTreeHash": "abc123...",
  "message": "Manifest is valid and up-to-date"
}
```

---

#### `codebase_search`

Search code chunks semantically. Returns relevant code snippets with full provenance (file, line numbers, chunk type).

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `query` | string | Yes | Natural language query |
| `projectId` | string | No | Filter by project ID |
| `filePath` | string | No | Filter by file path |
| `type` | enum | No | `code`, `comment`, `docstring` |
| `limit` | number | No | Maximum results (default: `10`) |

**Returns:**

```json
{
  "query": "authentication logic",
  "resultCount": 3,
  "results": [
    {
      "filePath": "src/auth/handler.ts",
      "lineStart": 42,
      "lineEnd": 78,
      "type": "code",
      "content": "export async function authenticate...",
      "score": 0.91,
      "projectId": "sha256-..."
    }
  ]
}
```

---

#### `codebase_timeline`

Query temporal commit history for a project or specific file. Returns commits with explicit "why" provenance.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `projectId` | string | Yes | Project ID |
| `filePath` | string | No | Filter by specific file |
| `limit` | number | No | Max commits (default: `100`) |

**Returns:**

```json
{
  "projectId": "sha256-...",
  "eventCount": 25,
  "events": [
    {
      "commitHash": "abc123",
      "timestamp": "2026-02-10T...",
      "author": "dev@example.com",
      "message": "Fix auth token refresh",
      "why": "Fixes #42: Token refresh loop",
      "filesChanged": ["src/auth/refresh.ts"]
    }
  ]
}
```

**Edge Cases:**
- The `why` field is extracted only from explicit sources: `Why:`, `Reason:`, `Fixes #`, `Closes #`, and ADR references in commit messages. It is never inferred or guessed.
- If no explicit reason is found, `why` is `null`.

---

#### `codebase_list_projects`

List all ingested projects with metadata.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `projectId` | string | No | Filter by specific project ID |
| `limit` | number | No | Max projects, 1–1000 (default: `100`) |
| `sortBy` | enum | No | `lastIngestedAt`, `filesCount`, `rootPath` |

**Returns:**

```json
{
  "count": 3,
  "sortBy": "lastIngestedAt",
  "projects": [
    {
      "projectId": "sha256-...",
      "rootPath": "/home/user/myproject",
      "treeHash": "abc123...",
      "filesCount": 250,
      "chunksCount": 1500,
      "commitsCount": 150,
      "lastIngestedAt": "2026-02-14T10:00:00.000Z"
    }
  ]
}
```

---

### Diagnostics

Tools for tracking code quality across TypeScript, ESLint, and Prettier.

#### `diagnostics_ingest`

Ingest diagnostics results from SARIF 2.1.0 payloads or normalized findings.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `projectId` | string | Yes | Project ID |
| `treeHash` | string | Yes | Git tree hash |
| `configHash` | string | Yes | Deterministic config hash |
| `commitHash` | string | No | Git commit hash |
| `toolName` | string | No | Tool name (optional if SARIF provides it) |
| `toolVersion` | string | No | Tool version |
| `environmentHash` | string | No | Environment hash |
| `status` | enum | No | `passed`, `failed`, `partial` |
| `durationMs` | number | No | Duration in milliseconds |
| `sarif` | object/string | No | SARIF 2.1.0 payload |
| `findings` | object[] | No | Normalized findings (alternative to SARIF) |
| `metadata` | object | No | Additional metadata |

**Returns:**

```json
{
  "success": true,
  "runId": "run-uuid",
  "analysisId": "sha256-...",
  "findingsCount": 42,
  "toolName": "tsc",
  "toolVersion": "5.3.3",
  "treeHash": "abc123..."
}
```

**Edge Cases:**
- `analysisId` is content-addressable: `SHA-256(projectId + treeHash + tool + config + findings)`. The same inputs always produce the same ID.
- Provide either `sarif` or `findings`, not both. If both are provided, `sarif` takes precedence.

---

#### `diagnostics_latest`

Get the latest diagnostics run for a project/tool combination.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `projectId` | string | Yes | Project ID |
| `toolName` | string | No | Filter by tool name |
| `toolVersion` | string | No | Filter by tool version |
| `treeHash` | string | No | Filter by tree hash |

**Returns:**

```json
{
  "found": true,
  "run": {
    "runId": "run-uuid",
    "analysisId": "sha256-...",
    "toolName": "tsc",
    "findingsCount": 0,
    "status": "passed"
  }
}
```

---

#### `diagnostics_list`

List all findings for a specific analysis.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `analysisId` | string | Yes | Analysis ID |

**Returns:**

```json
{
  "analysisId": "sha256-...",
  "count": 42,
  "findings": [
    {
      "findingId": "sha256-...",
      "ruleId": "TS2322",
      "message": "Type 'string' is not assignable to type 'number'",
      "severity": "error",
      "filePath": "src/auth.ts",
      "line": 42,
      "column": 10
    }
  ]
}
```

---

#### `diagnostics_diff`

Compare two analyses to find introduced, resolved, and unchanged findings.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `analysisIdA` | string | Yes | Base analysis ID |
| `analysisIdB` | string | Yes | Compare analysis ID |

**Returns:**

```json
{
  "analysisIdA": "sha256-a...",
  "analysisIdB": "sha256-b...",
  "introduced": [...],
  "resolved": [...],
  "unchanged": [...]
}
```

---

#### `diagnostics_summary`

Aggregate finding counts by severity.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `analysisId` | string | Yes | Analysis ID |

**Returns:**

```json
{
  "analysisId": "sha256-...",
  "total": 42,
  "bySeverity": {
    "error": 5,
    "warning": 15,
    "note": 22
  }
}
```

---

#### `diagnostics_compare_tools`

Compare diagnostics across multiple tools for the same project state.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `projectId` | string | Yes | Project ID |
| `treeHash` | string | Yes | Tree hash |
| `toolNames` | string[] | No | Filter by tool names (default: `["tsc", "eslint", "prettier"]`) |

**Returns:**

```json
{
  "projectId": "sha256-...",
  "treeHash": "abc123...",
  "toolSummaries": [
    { "toolName": "tsc", "total": 0 },
    { "toolName": "eslint", "total": 3 },
    { "toolName": "prettier", "total": 12 }
  ],
  "overlappingFiles": [...],
  "aggregateSeverity": { "error": 0, "warning": 3, "note": 12 }
}
```

---

#### `diagnostics_by_symbol`

Group diagnostic findings by code symbol (function, class, method) or by file.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `analysisId` | string | Yes | Analysis ID |
| `groupBy` | enum | No | `symbol` or `file` (default: `symbol`) |

**Returns:**

```json
{
  "analysisId": "sha256-...",
  "groupBy": "symbol",
  "symbolCount": 5,
  "symbols": [
    {
      "name": "authenticate",
      "kind": "function",
      "filePath": "src/auth.ts",
      "findingsCount": 3
    }
  ],
  "totalAttributed": 12,
  "totalUnattributed": 2
}
```

---

#### `diagnostics_summarize`

Generate an LLM-powered summary of diagnostic findings with caching.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `analysisId` | string | Yes | Analysis ID |
| `useLLM` | boolean | No | Use LLM for summary (default: `false`) |
| `forceRefresh` | boolean | No | Bypass cache (default: `false`) |

**Returns (without LLM):**

```json
{
  "analysisId": "sha256-...",
  "useLLM": false,
  "findings": [...]
}
```

**Returns (with LLM):**

```json
{
  "analysisId": "sha256-...",
  "useLLM": true,
  "summary": {
    "text": "The analysis found 42 issues...",
    "model": "gpt-4",
    "generatedAt": "2026-02-14T...",
    "isFromCache": false,
    "costUsd": 0.05
  }
}
```

**Edge Cases:**
- `useLLM: true` requires `OPENAI_API_KEY` to be set. If missing, returns a fallback with raw findings and `suggestion: "Set OPENAI_API_KEY"`.
- Summaries are cached by `analysisId`. Subsequent calls return the cached version unless `forceRefresh: true`.

---

### Worklog

#### `worklog_record`

Record a deterministic worklog event for auditing and provenance tracking.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `kind` | enum | Yes | `tool`, `diagnostics`, `git`, `task` |
| `title` | string | Yes | Short event title |
| `status` | enum | No | `success`, `failed`, `partial` |
| `phase` | enum | No | `started`, `summary`, `completed` (only for `kind: task`) |
| `toolName` | string | No | Tool name |
| `toolVersion` | string | No | Tool version |
| `configHash` | string | No | Deterministic config hash |
| `environmentHash` | string | No | Environment hash |
| `projectId` | string | No | Project ID |
| `treeHash` | string | No | Tree hash |
| `commitHash` | string | No | Commit hash |
| `runId` | string | No | Diagnostics run ID |
| `command` | string | No | Command executed |
| `durationMs` | number | No | Duration in milliseconds |
| `summary` | string | No | Summary of outcome |
| `metadata` | object | No | Additional metadata |
| `sessionId` | string | No | Explicit session ID |

**Returns:**

```json
{
  "success": true,
  "eventId": "evt-01924a3b-...",
  "eventType": "WORKLOG_TOOL",
  "timestamp": "2026-02-14T10:00:00.000Z"
}
```

---

#### `worklog_list`

List worklog events for a session.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `sessionId` | string | No | Session ID (uses current session if omitted) |
| `limit` | number | No | Max events (default: `100`) |
| `eventTypes` | string[] | No | Filter by event types |

**Returns:**

```json
{
  "sessionId": "01924a3b-...",
  "count": 15,
  "events": [...]
}
```

---

### Memory Intelligence

#### `memory_stats`

Get relevance decay distribution and memory tracking statistics.

**Parameters:** None

**Returns:**

```json
{
  "stats": {
    "totalTracked": 150,
    "averageRelevance": 0.72,
    "staleCount": 12,
    "distribution": {
      "high": 45,
      "medium": 80,
      "low": 25
    }
  }
}
```

---

#### `memory_consolidate`

Archive stale memories into digest entries. Groups by channel/category, creates summaries, and moves originals to an archive table.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `maxScore` | number | No | Max relevance score for consolidation (default: `0.3`) |
| `minDaysOld` | number | No | Min days since last access (default: `30`) |

**Returns:**

```json
{
  "result": {
    "consolidated": 12,
    "digestsCreated": 3,
    "memoriesArchived": 12
  }
}
```

---

### Project Management

#### `project_delete`

Delete all data (memory, diagnostics, graph, vectors) for a project.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `projectDir` | string | Yes | Absolute path to project root |

**Returns:**

```json
{
  "success": true,
  "projectId": "sha256-...",
  "projectDir": "/home/user/myproject",
  "sessionsDeleted": 5
}
```

---

### Health

#### `context_health`

Check ping-mem service health and connectivity to all backends.

**Parameters:** None

**Returns:**

```json
{
  "status": "healthy",
  "timestamp": "2026-02-14T10:00:00.000Z",
  "version": "1.0.0",
  "components": {
    "sqlite": "ok",
    "neo4j": "ok",
    "qdrant": "ok"
  },
  "session": {
    "active": true,
    "id": "01924a3b-..."
  }
}
```

---

## REST API

### Authentication

API key authentication via the `X-API-Key` header. Enabled when `PING_MEM_API_KEY` is set.

```bash
curl -H "X-API-Key: your-api-key" http://localhost:3000/api/v1/status
```

Session context is passed via the `X-Session-ID` header:

```bash
curl -H "X-API-Key: your-api-key" \
     -H "X-Session-ID: 01924a3b-..." \
     http://localhost:3000/api/v1/search?query=auth
```

Admin endpoints require Basic Auth in addition to the API key:

```bash
curl -u admin:password \
     -H "X-API-Key: your-api-key" \
     http://localhost:3000/api/admin/projects
```

---

### Session Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/session/start` | Start session |
| POST | `/api/v1/session/end` | End session |
| GET | `/api/v1/session/list?limit=10` | List sessions |
| GET | `/api/v1/status` | Get system status |

---

### Context Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/context` | Save memory |
| GET | `/api/v1/context/:key` | Get memory by key |
| DELETE | `/api/v1/context/:key` | Delete memory |
| GET | `/api/v1/search?query=...&limit=10` | Search memories |
| POST | `/api/v1/checkpoint` | Create checkpoint |
| GET | `/api/v1/memory/stats` | Memory statistics |
| POST | `/api/v1/memory/consolidate` | Consolidate stale memories |

---

### Codebase Endpoints

All codebase endpoints return **503** if Neo4j/Qdrant is not configured.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/codebase/ingest` | Ingest project |
| POST | `/api/v1/codebase/verify` | Verify manifest |
| GET | `/api/v1/codebase/search?query=...&projectId=...&type=...&limit=10` | Search code |
| GET | `/api/v1/codebase/timeline?projectId=...&filePath=...&limit=100` | Code history |

---

### Diagnostics Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/diagnostics/ingest` | Ingest diagnostics |
| GET | `/api/v1/diagnostics/latest?projectId=...&toolName=...` | Latest run |
| GET | `/api/v1/diagnostics/findings/:analysisId` | List findings |
| GET | `/api/v1/diagnostics/summary/:analysisId` | Summary by severity |
| POST | `/api/v1/diagnostics/diff` | Compare analyses |
| POST | `/api/v1/diagnostics/summarize/:analysisId` | LLM summary |

---

### Admin Endpoints

Require both Basic Auth (`PING_MEM_ADMIN_USER`/`PING_MEM_ADMIN_PASS`) and API key.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin` | Admin web UI |
| GET | `/api/admin/projects` | List projects |
| DELETE | `/api/admin/projects` | Delete project |
| GET | `/api/admin/keys` | List API keys |
| POST | `/api/admin/keys/rotate` | Rotate API key |
| POST | `/api/admin/keys/deactivate` | Deactivate key |
| GET | `/api/admin/llm-config` | Get LLM config |
| POST | `/api/admin/llm-config` | Set LLM config |

---

### Health Endpoint

```bash
curl http://localhost:3000/health
# => { "status": "ok", "timestamp": "2026-02-14T10:00:00.000Z" }
```

No authentication required for the health endpoint (unless `PING_MEM_API_KEY` is set, in which case it requires the key).

---

### Error Response Format

All error responses follow a consistent format:

```json
{
  "error": "ErrorName",
  "message": "Human-readable description",
  "details": {}
}
```

| Status Code | Meaning |
|-------------|---------|
| 400 | Bad request (missing required params, validation error) |
| 401 | Unauthorized (missing or invalid API key) |
| 403 | Forbidden |
| 404 | Resource not found |
| 500 | Internal server error |
| 503 | Service unavailable (Neo4j/Qdrant not configured) |
