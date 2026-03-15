# OpenClaw Integration Guide

> Step-by-step setup for using ping-mem as the memory backend for OpenClaw agents.

---

## Overview

[OpenClaw](https://github.com/usorama/openclaw) is an AI agent orchestration framework. ping-mem provides persistent memory, codebase intelligence, and diagnostics tracking for OpenClaw agents across sessions.

```
┌──────────────────────────────────────┐
│           OpenClaw Agent             │
│  ┌──────────┐  ┌──────────────────┐  │
│  │ Planning  │  │ Task Execution   │  │
│  └────┬─────┘  └───────┬──────────┘  │
│       │                │             │
│       └────────┬───────┘             │
│                │                     │
│         MCP or REST API              │
└────────────────┼─────────────────────┘
                 │
┌────────────────▼─────────────────────┐
│            ping-mem                  │
│  ┌────────┐ ┌──────┐ ┌───────────┐  │
│  │ SQLite │ │Neo4j │ │  Qdrant   │  │
│  │ Memory │ │Graph │ │  Vectors  │  │
│  └────────┘ └──────┘ └───────────┘  │
└──────────────────────────────────────┘
```

## Prerequisites

- [Bun](https://bun.sh/) v1.0+ installed
- ping-mem repository cloned and built
- OpenClaw project set up

## 1. Install ping-mem

```bash
git clone https://github.com/ping-gadgets/ping-mem.git
cd ping-mem
bun install
bun run build
```

## 2. Choose Integration Method

### Option A: MCP Integration (Recommended)

Add ping-mem as an MCP server in your OpenClaw MCP configuration:

```json
{
  "mcpServers": {
    "ping-mem": {
      "command": "bun",
      "args": [
        "run",
        "/path/to/ping-mem/dist/mcp/cli.js"
      ],
      "env": {
        "PING_MEM_DB_PATH": "~/.ping-mem/memory.db",
        "NEO4J_URI": "bolt://localhost:7687",
        "NEO4J_USERNAME": "neo4j",
        "NEO4J_PASSWORD": "your-password",
        "QDRANT_URL": "http://localhost:6333",
        "QDRANT_COLLECTION_NAME": "ping-mem-vectors"
      }
    }
  }
}
```

### Option B: REST API Integration

Start the ping-mem HTTP server and call it from OpenClaw agents via REST:

```bash
# Start ping-mem REST server
cd /path/to/ping-mem
PING_MEM_DB_PATH=~/.ping-mem/memory.db \
PING_MEM_TRANSPORT=rest \
PING_MEM_PORT=3003 \
bun run start
```

Then call from OpenClaw agent code:

```typescript
// Start session
const response = await fetch("http://localhost:3003/api/v1/session/start", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    name: "openclaw-agent-session",
    projectDir: "/path/to/project"
  })
});
const { data } = await response.json();
const sessionId = data.id;

// Save memory
await fetch("http://localhost:3003/api/v1/context", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Session-ID": sessionId
  },
  body: JSON.stringify({
    key: "task-result",
    value: "Completed authentication module refactor",
    category: "progress"
  })
});

// Search past context
const searchRes = await fetch(
  `http://localhost:3003/api/v1/search?query=authentication&limit=5`,
  { headers: { "X-Session-ID": sessionId } }
);
const results = await searchRes.json();
```

### Option C: Docker Compose (Full Stack)

Run ping-mem alongside OpenClaw services using Docker:

```bash
cd /path/to/ping-mem
docker compose up -d
```

This starts:
- ping-mem SSE server on port `3000`
- Neo4j on ports `7474` (HTTP) and `7687` (Bolt)
- Qdrant on port `6333`

Optionally start the REST server:

```bash
docker compose --profile rest-api up -d
```

This adds a REST server on port `3003`.

## 3. Register Your OpenClaw Project

Register your OpenClaw project for automatic code ingestion:

```bash
echo "/path/to/openclaw-project" >> ~/.ping-mem/registered-projects.txt
```

Manually trigger the first ingestion:

```bash
# Via MCP tool
codebase_ingest({ projectDir: "/path/to/openclaw-project" })

# Or via REST
curl -X POST http://localhost:3003/api/v1/codebase/ingest \
  -H "Content-Type: application/json" \
  -d '{"projectDir": "/path/to/openclaw-project"}'
```

## 4. Agent Workflow

Recommended workflow for OpenClaw agents using ping-mem:

### Session Start

```
context_session_start({
  name: "openclaw-task-42",
  projectDir: "/path/to/project",
  autoIngest: true
})
```

### Before Making Changes

Search existing code and context:

```
codebase_search({
  query: "user authentication handler",
  type: "code",
  limit: 5
})

context_search({
  query: "auth decisions",
  category: "decision"
})
```

### Save Decisions

```
context_save({
  key: "task-42-approach",
  value: "Using middleware pattern for auth validation",
  category: "decision",
  priority: "high"
})
```

### Before Risky Operations

```
context_checkpoint({
  name: "pre-migration",
  description: "Before database schema migration"
})
```

### Track Progress

```
context_save({
  key: "task-42-progress",
  value: "Auth middleware implemented, tests passing",
  category: "progress"
})
```

### Record Worklog

```
worklog_record({
  kind: "task",
  title: "Implement auth middleware",
  status: "success",
  phase: "completed",
  durationMs: 45000
})
```

## 5. Cross-Session Intelligence

ping-mem automatically provides cross-session context. When saving a memory, related memories from previous sessions are returned:

```
context_save({
  key: "auth-token-format",
  value: "Using opaque tokens instead of JWT",
  category: "decision"
})
// Response includes relatedMemories from past sessions
```

This helps agents avoid repeating past mistakes and build on previous decisions.

## 6. Diagnostics Integration

Track code quality across OpenClaw agent runs:

```bash
# Generate SARIF
bun run diagnostics:tsc-sarif --output /tmp/tsc.sarif

# Ingest via MCP
diagnostics_ingest({
  projectId: "openclaw-project-id",
  treeHash: "current-tree-hash",
  configHash: "tsconfig-hash",
  sarif: sarifPayload
})

# Compare before and after
diagnostics_diff({
  analysisIdA: "before-analysis",
  analysisIdB: "after-analysis"
})
```

## 7. Troubleshooting

### 503 on codebase endpoints

Neo4j or Qdrant is not running. Start them:

```bash
docker compose up -d ping-mem-neo4j ping-mem-qdrant
```

### Empty search results

The project hasn't been ingested. Run:

```
codebase_ingest({ projectDir: "/path/to/project" })
```

### Wrong projectId

ping-mem computes `projectId` from git identity. Ensure the git remote URL is consistent:

```bash
cd /path/to/project
git remote get-url origin
```

### Connection refused on port 3003

The REST server runs on a separate profile. Start it with:

```bash
docker compose --profile rest-api up -d ping-mem-rest
```

## Further Reading

- [API Reference](../api-reference.md) — Full MCP tool and REST endpoint documentation
- [Self-Hosting Guide](self-hosting.md) — Production deployment with Docker Compose
- [Configuration Reference](../configuration.md) — All environment variables
