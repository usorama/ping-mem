# Cursor Integration Guide

> Step-by-step setup for using ping-mem as a persistent memory layer in Cursor.

---

## Prerequisites

- [Bun](https://bun.sh/) v1.0+ installed
- [Cursor](https://cursor.com/) installed
- ping-mem repository cloned and built

## 1. Install ping-mem

```bash
git clone https://github.com/ping-gadgets/ping-mem.git
cd ping-mem
bun install
bun run build
```

## 2. Configure Cursor MCP

Cursor supports MCP servers through its settings. Open Cursor settings and navigate to the MCP configuration.

### Option A: Project-level config (`.cursor/mcp.json`)

Create `.cursor/mcp.json` in your project root:

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
        "PING_MEM_DB_PATH": "~/.ping-mem/memory.db"
      }
    }
  }
}
```

### Option B: Global config (`~/.cursor/mcp.json`)

For ping-mem to be available across all projects:

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
        "PING_MEM_DB_PATH": "~/.ping-mem/memory.db"
      }
    }
  }
}
```

Replace `/path/to/ping-mem` with the actual path where you cloned the repo.

### Full Setup (with code intelligence)

To enable codebase ingestion and semantic search, add Neo4j and Qdrant environment variables:

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

Start the databases:

```bash
cd /path/to/ping-mem
docker compose up -d ping-mem-neo4j ping-mem-qdrant
```

## 3. Restart Cursor

Restart Cursor after editing the MCP config. The ping-mem tools will appear as available MCP tools.

## 4. Usage in Cursor

### Start a Session

In Cursor's AI chat, instruct the agent to start a session:

> "Start a ping-mem session for this project"

The agent will call:

```
context_session_start({
  name: "cursor-session",
  projectDir: "/path/to/your/project"
})
```

### Save Context

As you work, save important decisions and findings:

```
context_save({
  key: "db-choice",
  value: "Using PostgreSQL with Drizzle ORM for type-safe queries",
  category: "decision"
})
```

### Search Previous Work

Find context from past sessions:

```
context_search({
  query: "database schema design",
  limit: 5
})
```

### Code Intelligence

With Neo4j and Qdrant running, ingest and search your codebase:

```
codebase_ingest({
  projectDir: "/path/to/your/project"
})

codebase_search({
  query: "database connection pool",
  type: "code"
})
```

## 5. Cursor Rules Integration

Add ping-mem instructions to your `.cursorrules` file so the AI agent uses memory automatically:

```
## Memory Protocol

Use ping-mem MCP tools for persistent memory:

1. At session start: call context_session_start with the project directory
2. When making decisions: save with context_save (category: "decision")
3. When completing tasks: save with context_save (category: "progress")
4. Before risky changes: create a checkpoint with context_checkpoint
5. When searching for context: use context_search with natural language queries
```

## 6. Troubleshooting

### MCP tools not appearing

1. Verify the MCP config file is in the correct location
2. Check that `dist/mcp/cli.js` exists (run `bun run build` if not)
3. Restart Cursor after config changes

### Connection issues

Test the MCP server directly:

```bash
echo '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{}},"id":1}' | \
  bun run /path/to/ping-mem/dist/mcp/cli.js
```

### Memory not persisting between sessions

Ensure `PING_MEM_DB_PATH` points to a file on disk, not `:memory:`:

```json
"PING_MEM_DB_PATH": "~/.ping-mem/memory.db"
```

## Available Tools

See [API Reference](../api-reference.md) for the complete list of 32 MCP tools with parameters and examples.
