# Claude Code Integration Guide

> Step-by-step setup for using ping-mem as a persistent memory layer in Claude Code.

---

## Prerequisites

- [Bun](https://bun.sh/) v1.0+ installed
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed
- ping-mem repository cloned and built

## 1. Install ping-mem

```bash
git clone https://github.com/ping-gadgets/ping-mem.git
cd ping-mem
bun install
bun run build
```

Verify the build:

```bash
bun run dist/mcp/cli.js --help
```

## 2. Configure Claude Code

Add ping-mem to your Claude Code MCP settings. Edit `~/.claude/mcp.json`:

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

Replace `/path/to/ping-mem` with the actual path where you cloned ping-mem.

### Minimal Setup (SQLite only)

The above configuration gives you core memory operations (save, get, search, sessions, checkpoints) using SQLite. No additional services required.

### Full Setup (with code intelligence)

For codebase ingestion, semantic code search, and knowledge graph features, add Neo4j and Qdrant:

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

Start Neo4j and Qdrant with Docker:

```bash
cd /path/to/ping-mem
docker compose up -d ping-mem-neo4j ping-mem-qdrant
```

## 3. Restart Claude Code

After editing `mcp.json`, restart Claude Code to load the MCP server. You should see ping-mem tools available with the `ping_mem_` prefix.

Verify by asking Claude Code:

> "What MCP tools are available from ping-mem?"

## 4. Basic Usage

### Start a Session

At the beginning of each conversation, start a session to enable memory tracking:

```
context_session_start({
  name: "feature-auth",
  projectDir: "/path/to/your/project"
})
```

### Save Decisions

When you make architectural or implementation decisions:

```
context_save({
  key: "auth-approach",
  value: "Using JWT with RS256 for stateless API authentication",
  category: "decision",
  priority: "high"
})
```

### Search Past Context

Find relevant memories from previous sessions:

```
context_search({
  query: "authentication",
  limit: 5
})
```

### Create Checkpoints

Before risky operations (refactors, migrations):

```
context_checkpoint({
  name: "pre-refactor",
  description: "Before extracting auth into separate module"
})
```

### Ingest Your Codebase

With Neo4j and Qdrant running, ingest your project for code search:

```
codebase_ingest({
  projectDir: "/path/to/your/project"
})
```

Then search it:

```
codebase_search({
  query: "how does authentication work",
  type: "code",
  limit: 5
})
```

## 5. Session Hooks (Automation)

You can configure Claude Code hooks to automatically start sessions and ingest projects. Add to your project's `.claude/hooks.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "command": "echo 'Session starting'"
      }
    ]
  }
}
```

For automated session management, your `CLAUDE.md` can include instructions like:

```markdown
## Session Protocol
1. Start a ping-mem session at the beginning of each conversation
2. Save decisions with category: "decision"
3. Save progress with category: "progress"
4. Create checkpoints before risky operations
```

## 6. Multi-Project Setup

ping-mem supports multiple projects with isolated memory. Each project gets a unique `projectId` derived from its git remote URL, so the same project always has the same ID regardless of where it's cloned.

Register projects for auto-ingestion:

```bash
echo "/path/to/project-a" >> ~/.ping-mem/registered-projects.txt
echo "/path/to/project-b" >> ~/.ping-mem/registered-projects.txt
```

## 7. Troubleshooting

### Tools not appearing

1. Verify the path in `mcp.json` is correct (must point to `dist/mcp/cli.js`)
2. Verify the build completed: `ls /path/to/ping-mem/dist/mcp/cli.js`
3. Restart Claude Code after any config changes

### "Ingestion service not configured"

This means Neo4j or Qdrant is not running. Core memory features (save, get, search) still work. Start the services:

```bash
cd /path/to/ping-mem
docker compose up -d ping-mem-neo4j ping-mem-qdrant
```

### Database locked errors

If you see SQLite "database locked" errors, ensure only one instance of ping-mem is running. Check for stale processes:

```bash
ps aux | grep ping-mem
```

### Memory not persisting

Verify `PING_MEM_DB_PATH` is set to a file path (not `:memory:`):

```json
"env": {
  "PING_MEM_DB_PATH": "~/.ping-mem/memory.db"
}
```

## Available Tools Reference

Once configured, these tools are available in Claude Code (prefixed with your server name):

ping-mem exposes 44 MCP tools across 9 modules. Key tools include:

| Category | Tools |
|----------|-------|
| **Session** | `context_session_start`, `context_session_end`, `context_session_list`, `context_status` |
| **Memory** | `context_save`, `context_get`, `context_search`, `context_delete`, `context_checkpoint` |
| **Graph** | `context_query_relationships`, `context_hybrid_search`, `context_get_lineage`, `context_query_evolution`, `context_health` |
| **Codebase** | `codebase_ingest`, `codebase_verify`, `codebase_search`, `codebase_timeline`, `codebase_list_projects`, `project_delete` |
| **Diagnostics** | `diagnostics_ingest`, `diagnostics_latest`, `diagnostics_list`, `diagnostics_diff`, `diagnostics_summary`, `diagnostics_compare_tools`, `diagnostics_by_symbol`, `diagnostics_summarize` |
| **Worklog** | `worklog_record`, `worklog_list` |
| **Memory Intelligence** | `memory_stats`, `memory_consolidate`, `memory_subscribe`, `memory_unsubscribe`, `memory_compress` |
| **Causal** | `search_causes`, `search_effects`, `get_causal_chain`, `trigger_causal_discovery` |
| **Knowledge** | `knowledge_ingest`, `knowledge_search` |
| **Agents** | `agent_register`, `agent_quota_status`, `agent_deregister` |

See [API Reference](../api-reference.md) for full parameter details.
