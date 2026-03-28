# Migrating from mem0 to ping-mem

> A guide for teams switching from [mem0](https://github.com/mem0ai/mem0) to ping-mem.

---

## Why Migrate?

| Feature | mem0 | ping-mem |
|---------|------|----------|
| **Transport** | REST API, Python SDK | MCP (stdio), REST, SSE |
| **AI Tool Integration** | Python SDK | Native MCP for Claude Code, Cursor |
| **Storage** | PostgreSQL, Qdrant, Redis | SQLite (zero-dep), Neo4j, Qdrant |
| **Determinism** | Non-deterministic embeddings | Content-addressable IDs (SHA-256) |
| **Session Isolation** | User/agent scoping | Session + project + channel isolation |
| **Code Intelligence** | Not available | Git-aware code ingestion, temporal queries |
| **Diagnostics** | Not available | SARIF ingestion, cross-tool comparison |
| **Event Sourcing** | Not available | Immutable append-only audit trail |
| **Checkpoints** | Not available | Named session checkpoints |
| **Runtime** | Python | Bun (TypeScript) |
| **Self-hosting** | Docker (requires PostgreSQL) | Docker (SQLite works standalone) |

---

## Concept Mapping

### Core Concepts

| mem0 Concept | ping-mem Equivalent | Notes |
|-------------|---------------------|-------|
| `memory.add()` | `context_save()` | ping-mem uses explicit keys |
| `memory.search()` | `context_search()` | Semantic search with category/channel filters |
| `memory.get_all()` | `context_get()` | Filter by key pattern, category, or channel |
| `memory.update()` | `context_save()` | Saving with an existing key updates it |
| `memory.delete()` | `context_delete()` | Delete by key |
| `memory.history()` | `worklog_list()` | Event-level history via worklog |
| User ID | Session ID | ping-mem uses sessions, not user IDs |
| Agent ID | Session name | The session name identifies the agent context |
| Categories | `category` param | `task`, `decision`, `progress`, `note`, `error`, `warning`, `fact`, `observation` |

### Memory Operations

**mem0:**

```python
from mem0 import Memory

m = Memory()

# Add memory
m.add("User prefers dark mode", user_id="user1", metadata={"app": "settings"})

# Search
results = m.search("theme preference", user_id="user1")

# Get all
all_memories = m.get_all(user_id="user1")

# Update
m.update(memory_id="mem-123", data="User prefers light mode")

# Delete
m.delete(memory_id="mem-123")
```

**ping-mem (MCP):**

```
// Start session (replaces user_id scoping)
context_session_start({ name: "user1-session", projectDir: "/app" })

// Save memory (explicit key instead of auto-generated ID)
context_save({
  key: "user-pref-theme",
  value: "User prefers dark mode",
  category: "note",
  metadata: { app: "settings" }
})

// Search
context_search({ query: "theme preference", limit: 10 })

// Get by key
context_get({ key: "user-pref-theme" })

// Get by pattern
context_get({ keyPattern: "user-pref-*" })

// Update (save with same key)
context_save({
  key: "user-pref-theme",
  value: "User prefers light mode",
  category: "note"
})

// Delete
context_delete({ key: "user-pref-theme" })
```

**ping-mem (REST):**

```bash
# Start session
curl -X POST http://localhost:3000/api/v1/session/start \
  -H "Content-Type: application/json" \
  -d '{"name": "user1-session"}'

# Save memory
curl -X POST http://localhost:3000/api/v1/context \
  -H "Content-Type: application/json" \
  -H "X-Session-ID: session-id" \
  -d '{
    "key": "user-pref-theme",
    "value": "User prefers dark mode",
    "category": "note"
  }'

# Search
curl "http://localhost:3000/api/v1/search?query=theme+preference&limit=10" \
  -H "X-Session-ID: session-id"

# Get by key
curl http://localhost:3000/api/v1/context/user-pref-theme \
  -H "X-Session-ID: session-id"

# Delete
curl -X DELETE http://localhost:3000/api/v1/context/user-pref-theme \
  -H "X-Session-ID: session-id"
```

---

## Migration Steps

### Step 1: Export mem0 Data

Export your existing memories from mem0:

```python
from mem0 import Memory

m = Memory()
all_memories = m.get_all(user_id="user1")

import json
with open("mem0-export.json", "w") as f:
    json.dump(all_memories, f, indent=2)
```

### Step 2: Install ping-mem

```bash
git clone https://github.com/ping-gadgets/ping-mem.git
cd ping-mem
bun install
bun run build
```

### Step 3: Import Data

Write a migration script to import mem0 data into ping-mem:

```typescript
import { readFileSync } from "fs";

const BASE_URL = "http://localhost:3000";

// Start session
const sessionRes = await fetch(`${BASE_URL}/api/v1/session/start`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "mem0-migration" })
});
const { data: session } = await sessionRes.json();

// Load exported data
const memories = JSON.parse(readFileSync("mem0-export.json", "utf-8"));

// Import each memory
for (const mem of memories) {
  await fetch(`${BASE_URL}/api/v1/context`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-ID": session.id
    },
    body: JSON.stringify({
      key: `mem0-${mem.id}`,
      value: mem.memory || mem.data,
      category: "note",
      metadata: {
        source: "mem0",
        originalId: mem.id,
        importedAt: new Date().toISOString(),
        ...mem.metadata
      }
    })
  });
}

console.log(`Imported ${memories.length} memories`);
```

### Step 4: Configure Your AI Tool

Replace mem0 with ping-mem in your MCP config. See:
- [Claude Code Guide](claude-code.md)
- [Cursor Guide](cursor.md)

### Step 5: Update Agent Prompts

Replace mem0 tool calls with ping-mem equivalents in your agent prompts or system instructions.

**Before (mem0):**
```
Use the memory tool to remember user preferences.
Call memory.add() to store and memory.search() to retrieve.
```

**After (ping-mem):**
```
Use ping-mem for persistent memory across sessions.
Call context_save() to store decisions and progress.
Call context_search() to find relevant past context.
```

---

## Key Differences

### 1. Explicit Keys vs Auto-Generated IDs

mem0 auto-generates memory IDs. ping-mem requires explicit keys, which makes memories easier to reference and update:

```
// ping-mem: explicit, predictable keys
context_save({ key: "db-choice", value: "PostgreSQL" })
context_get({ key: "db-choice" })

// vs mem0: auto-generated IDs you need to track
m.add("PostgreSQL")  // returns some UUID
```

### 2. Sessions vs User IDs

mem0 scopes memories by `user_id` and `agent_id`. ping-mem uses sessions:

- A **session** represents a unit of work (a conversation, a task, a sprint)
- Sessions have start/end lifecycle with audit trails
- Cross-session search finds context from previous sessions automatically

### 3. Categories and Channels

ping-mem provides structured organization:

- **Categories**: `task`, `decision`, `progress`, `note`, `error`, `warning`, `fact`, `observation`
- **Channels**: Custom groupings (e.g., `"auth"`, `"frontend"`, `"database"`)
- **Priority**: `high`, `normal`, `low`

### 4. No Automatic Embedding

mem0 automatically generates embeddings via OpenAI. ping-mem uses deterministic hash-based vectors by default (no API key needed). OpenAI embeddings are optional.

### 5. Event Sourcing

Every operation in ping-mem is recorded as an immutable event. This provides:
- Complete audit trail
- Ability to replay state
- Crash recovery via checkpoints

---

## Feature Comparison

### Available in Both

- Save/retrieve/search memories
- Metadata on memories
- REST API access

### Available Only in ping-mem

- MCP transport (native AI tool integration)
- Session management with checkpoints
- Code ingestion and semantic code search
- Git history timeline with "why" provenance
- Diagnostics tracking (SARIF)
- Knowledge graph with entity relationships
- Event sourcing and audit trail
- Deterministic, reproducible IDs
- Cross-session intelligence with relevance decay
- Memory consolidation (archiving stale memories)
- Admin panel with API key rotation

### Available Only in mem0

- Python SDK
- Automatic embedding generation (required)
- Graph memory (mem0's experimental feature)
- Managed cloud offering (mem0 Platform)
