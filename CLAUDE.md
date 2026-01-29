# CLAUDE.md - ping-mem

**Version**: 1.1.0
**Status**: Standalone Project
**Last Updated**: 2026-01-29
**Project**: Universal Memory Layer for AI Agents + Deterministic Code Ingestion

---

## What is ping-mem?

**ping-mem** is a **Universal Memory Layer** for AI agents that provides persistent, intelligent, and contextually-aware memory across sessions, tools, and applications. It serves as reusable infrastructure that any AI application can leverage.

**Key Insight**: ping-mem is an application that's self-contained for use of AI Agents from other applications and use cases, serving deterministic, repeatable, reproducable memory with/without history, so Agents are always in the know.

---

## Code Ingestion System (v1.1.0)

**ping-mem now includes a deterministic, time-aware codebase understanding system** that ingests code + git history and provides:

### Core Capabilities

1. **Deterministic Project Scanning**
   - Merkle tree hashing for project-wide integrity
   - Content-addressable IDs (SHA-256 based)
   - Manifest-based change detection (`.ping-mem/manifest.json`)
   - Project ID derived from git identity

2. **Code Chunking**
   - Separates code vs comments vs docstrings
   - TypeScript/JavaScript: `//` and `/* */` comments
   - Python: `#` comments and `"""` / `'''` docstrings
   - Deterministic chunk IDs for reproducibility

3. **Git History Ingestion**
   - Full commit DAG extraction
   - File change tracking (A/M/D/R/C)
   - Unified diff parsing with hunk→chunk mapping
   - Commit messages for explicit "why" provenance

4. **Temporal Code Graph (Neo4j)**
   - Bi-temporal model for point-in-time queries
   - Nodes: Project, File, Chunk, Commit
   - Relationships: HAS_FILE, HAS_CHUNK, MODIFIES, CHANGES
   - Queries: files at time, file history, commit timeline

5. **Semantic Code Search (Qdrant)**
   - Deterministic vectorization (hash-based, no ML)
   - Full provenance metadata per chunk
   - Search by query with project/file/type filters

6. **Explicit-only "Why" Extraction**
   - Parses commit messages for reasons
   - Supports: `Why:`, `Reason:`, `Fixes #`, `Closes #`, ADR refs
   - **Never guesses or infers** – only explicit sources

### Usage Example

```bash
# Ingest a project (via MCP tool)
codebase_ingest({
  projectDir: "/path/to/project",
  forceReingest: false
})

# Search code
codebase_search({
  query: "authentication logic",
  projectId: "...",
  type: "code",
  limit: 10
})

# Query timeline
codebase_timeline({
  projectId: "...",
  filePath: "src/auth.ts",  # optional
  limit: 50
})
```

---

## Quick Start

### Installation

```bash
# Clone repository
git clone https://github.com/ping-gadgets/ping-mem.git
cd ping-mem

# Install dependencies
bun install

# Build TypeScript
bun run build
```

### Basic Usage (SQLite only)

```bash
# Run MCP server (for Claude Code integration)
bun run dist/mcp/cli.js

# Or start HTTP server (REST mode)
bun run start

# Or start HTTP server (SSE mode for real-time)
bun run start:sse
```

### Full Stack (with Neo4j and Qdrant) - Required for Code Ingestion

```bash
# Start dependencies with Docker
docker-compose up -d neo4j qdrant

# Set environment variables (REQUIRED for ingestion)
export NEO4J_URI="bolt://localhost:7687"
export NEO4J_USERNAME="neo4j"
export NEO4J_PASSWORD="your-password"
export QDRANT_URL="http://localhost:6333"
export QDRANT_COLLECTION_NAME="ping-mem-vectors"
export QDRANT_VECTOR_DIMENSIONS="768"

# Run with full ingestion capabilities
bun run dist/mcp/cli.js
```

**Note**: Neo4j and Qdrant are **required** for code ingestion features. Core memory operations work without them.

---

## Integration Examples

### 1. Claude Code Integration (stdio transport)

Add to your Claude Code MCP settings (`~/.claude/mcp.json`):

```json
{
  "mcpServers": {
    "ping-mem": {
      "command": "bun",
      "args": [
        "run",
        "/Users/umasankr/Projects/ping-mem/dist/mcp/cli.js"
      ],
      "env": {
        "PING_MEM_DB_PATH": "~/.claude/ping-mem.db",
        "PING_MEM_VECTOR_SEARCH": "false"
      }
    }
  }
}
```

**Usage in Claude Code**:
- MCP tools available as `ping_mem_*` functions
- Automatic session management on startup
- Context persistence across conversations

### 2. Node.js Applications (REST)

```typescript
import { createRESTClient } from "ping-mem/client";

// Create client
const client = createRESTClient({
  baseUrl: "http://localhost:3000"
});

// Start session
await client.startSession({
  name: "my-app-session",
  projectDir: process.cwd()
});

// Save memory
await client.save("user-pref", "dark-mode", {
  category: "note",
  priority: "high"
});

// Search memories
const results = await client.search({
  query: "theme",
  limit: 10
});

// Close client
await client.close();
```

**Start HTTP server**:
```bash
# Terminal 1: Start ping-mem HTTP server
bun run start:rest

# Terminal 2: Run your Node.js app
node my-app.js
```

### 3. Python Scripts (REST API)

```python
import requests

BASE_URL = "http://localhost:3000"

# Start session
response = requests.post(f"{BASE_URL}/session/start", json={
    "name": "python-session"
})
session_id = response.json()["sessionId"]

# Save memory
requests.post(f"{BASE_URL}/context/save", json={
    "key": "decision",
    "value": "Use PostgreSQL for production",
    "category": "decision",
    "priority": "high"
}, headers={"X-Session-ID": session_id})

# Search memories
response = requests.get(f"{BASE_URL}/context/search", params={
    "query": "database",
    "limit": 5
}, headers={"X-Session-ID": session_id})

print(response.json())
```

**Start HTTP server**:
```bash
# Terminal 1: Start ping-mem
bun run start:rest

# Terminal 2: Run Python script
python script.py
```

### 4. curl Examples

```bash
# Set base URL
BASE="http://localhost:3000"

# Start session
SESSION=$(curl -s -X POST "$BASE/session/start" \
  -H "Content-Type: application/json" \
  -d '{"name":"curl-session"}' \
  | jq -r '.sessionId')

# Save memory
curl -X POST "$BASE/context/save" \
  -H "Content-Type: application/json" \
  -H "X-Session-ID: $SESSION" \
  -d '{
    "key": "auth-decision",
    "value": "JWT with RS256",
    "category": "decision",
    "priority": "high"
  }'

# Get memory by key
curl -X GET "$BASE/context/get/key:auth-decision" \
  -H "X-Session-ID: $SESSION"

# Search memories
curl -X GET "$BASE/context/search?query=auth&limit=5" \
  -H "X-Session-ID: $SESSION"

# Get status
curl -X GET "$BASE/status" \
  -H "X-Session-ID: $SESSION"

# Create checkpoint
curl -X POST "$BASE/context/checkpoint" \
  -H "Content-Type: application/json" \
  -H "X-Session-ID: $SESSION" \
  -d '{"name":"pre-deployment"}'
```

---

## Architecture Reference

### Core Components

```
┌─────────────────────────────────────────────────────────────┐
│                     ping-mem Architecture                    │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              Interfaces                             │    │
│  │  • MCP Server (stdio) - Claude Code integration     │    │
│  │  • HTTP Server (REST/SSE) - Universal access        │    │
│  │  • Client SDK (TypeScript) - Application library    │    │
│  └─────────────────────────────────────────────────────┘    │
│                          │                                   │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              Core Layer                              │    │
│  │  • MemoryManager - CRUD operations                  │    │
│  │  • SessionManager - Session lifecycle               │    │
│  │  • EventStore - Immutable append-only log           │    │
│  └─────────────────────────────────────────────────────┘    │
│                          │                                   │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              Ingestion Layer (NEW)                  │    │
│  │  • ProjectScanner - Merkle tree + manifest          │    │
│  │  • CodeChunker - Code vs comment separation         │    │
│  │  • GitHistoryReader - Commit DAG + diffs            │    │
│  │  • IngestionService - Orchestrates pipeline         │    │
│  │  • DeterministicVectorizer - Hash-based vectors     │    │
│  │  • CodeIndexer - Qdrant code search                 │    │
│  └─────────────────────────────────────────────────────┘    │
│                          │                                   │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              Storage Layer                           │    │
│  │  • SQLite (bun:sqlite) - Core memory storage        │    │
│  │  • Neo4j - Temporal code graph (required for ingestion) │    │
│  │  • Qdrant - Semantic search (required for ingestion) │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

### Component Details

#### 0. Ingestion Layer (`src/ingest/`, `src/search/`)
**NEW in v1.1.0** - Deterministic code ingestion system

- **ProjectScanner** (`src/ingest/ProjectScanner.ts`)
  - Merkle tree hashing for project integrity
  - Content-addressable project/file IDs
  - Manifest storage (`.ping-mem/manifest.json`)
  - Change detection for incremental updates

- **CodeChunker** (`src/ingest/CodeChunker.ts`)
  - Separates code vs comments vs docstrings
  - Supports TypeScript, JavaScript, Python
  - Deterministic chunk IDs (SHA-256 based)
  - Line number tracking for provenance

- **GitHistoryReader** (`src/ingest/GitHistoryReader.ts`)
  - Full commit DAG extraction
  - File change tracking (A/M/D/R/C)
  - Unified diff parsing with hunk ranges
  - Commit message parsing for "why" provenance

- **IngestionService** (`src/ingest/IngestionService.ts`)
  - High-level API for agents
  - Methods: `ingestProject()`, `verifyProject()`, `searchCode()`, `queryTimeline()`
  - Explicit-only "why" extraction (never inferred)

- **TemporalCodeGraph** (`src/graph/TemporalCodeGraph.ts`)
  - Neo4j persistence for temporal queries
  - Nodes: Project, File, Chunk, Commit
  - Relationships: HAS_FILE, HAS_CHUNK, MODIFIES, CHANGES
  - Queries: files at time, file history, commit timeline

- **DeterministicVectorizer** (`src/search/DeterministicVectorizer.ts`)
  - Hash-based feature vectors (no ML)
  - Bit-for-bit reproducible
  - N-gram generation (1-3 grams)
  - L2 normalization

- **CodeIndexer** (`src/search/CodeIndexer.ts`)
  - Qdrant indexing for code chunks
  - Full provenance metadata per chunk
  - Semantic search with filters

#### 1. MemoryManager (`src/memory/`)
- **Purpose**: Core CRUD operations for memory items
- **Key Methods**:
  - `save(key, value, options)` - Store memory with metadata
  - `get(key)` - Retrieve by exact key
  - `search(query, filters)` - Semantic/fuzzy search
  - `update(key, value)` - Update existing memory
  - `delete(key)` - Remove memory

#### 2. SessionManager (`src/session/`)
- **Purpose**: Manage session lifecycle and isolation
- **Key Methods**:
  - `startSession(name, options)` - Create new session
  - `endSession(sessionId)` - Close session
  - `getSession(sessionId)` - Get session info
  - `listSessions(limit)` - List recent sessions

#### 3. EventStore (`src/storage/`)
- **Purpose**: Immutable event log for audit trail
- **Event Types**:
  - `SESSION_STARTED`
  - `CONTEXT_SAVED`
  - `CONTEXT_UPDATED`
  - `CHECKPOINT_CREATED`
  - `SESSION_ENDED`
- **Features**:
  - Append-only (no mutations)
  - Temporal ordering
  - Replay capability

#### 4. Graph Layer (Neo4j - Optional)
- **EntityExtractor** (`src/graph/EntityExtractor.ts`)
  - Extract entities from text (NER)
  - Extract relationships between entities

- **GraphManager** (`src/graph/GraphManager.ts`)
  - Store entities as nodes
  - Store relationships as edges
  - Query graph patterns

- **RelationshipManager** (`src/graph/RelationshipManager.ts`)
  - Track temporal relationships
  - Lineage tracking (upstream/downstream)

#### 5. Search Layer (Qdrant - Optional)
- **VectorIndex** (`src/search/VectorIndex.ts`)
  - Generate embeddings (OpenAI)
  - Store in Qdrant
  - Semantic similarity search

- **HybridSearchEngine** (`src/search/HybridSearchEngine.ts`)
  - Combine semantic + keyword + graph
  - Relevance scoring

- **LineageEngine** (`src/search/LineageEngine.ts`)
  - Trace entity relationships
  - Find upstream/downstream dependencies

- **EvolutionEngine** (`src/search/EvolutionEngine.ts`)
  - Track entity changes over time
  - Temporal queries

### MCP Tools

All tools are prefixed with `ping_mem_` when loaded in Claude Code:

#### Context Tools (Core)
| Tool | Purpose |
|------|---------|
| `context_session_start` | Start new session with project tracking |
| `context_save` | Save memory with auto-entity extraction |
| `context_get` | Retrieve memory by key or filters |
| `context_search` | Search by natural language query |
| `context_checkpoint` | Create named checkpoint |
| `context_restore` | Restore from checkpoint |
| `context_status` | Get session and server status |
| `context_link` | Link two entities with relationship |
| `context_query_relationships` | Query entity graph |
| `context_hybrid_search` | Combined semantic/graph search |
| `context_get_lineage` | Trace entity lineage |

#### Codebase Tools (NEW in v1.1.0)
| Tool | Purpose |
|------|---------|
| `codebase_ingest` | Ingest project with deterministic hashing |
| `codebase_verify` | Verify manifest integrity |
| `codebase_search` | Semantic code search with provenance |
| `codebase_timeline` | Query temporal history with explicit "why" |

---

## Deployment Instructions

### Local Development

```bash
# 1. Install dependencies
bun install

# 2. Build TypeScript
bun run build

# 3. Run tests
bun test

# 4. Type check
bun run typecheck

# 5. Start server
bun run start           # REST mode
bun run start:sse       # SSE mode
```

### Docker Deployment

```bash
# Build image
docker build -t ping-mem:latest .

# Run container
docker run -d \
  -v ping-mem-data:/data \
  -p 3000:3000 \
  -e PING_MEM_DB_PATH=/data/ping-mem.db \
  ping-mem:latest
```

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PING_MEM_DB_PATH` | No | `:memory:` | SQLite database path |
| `NEO4J_URI` | **For ingestion** | | Neo4j Bolt URI (e.g., `bolt://localhost:7687`) |
| `NEO4J_USERNAME` | **For ingestion** | `neo4j` | Neo4j username |
| `NEO4J_PASSWORD` | **For ingestion** | | Neo4j password |
| `QDRANT_URL` | **For ingestion** | | Qdrant REST URL (e.g., `http://localhost:6333`) |
| `QDRANT_COLLECTION_NAME` | **For ingestion** | `ping-mem-vectors` | Qdrant collection name |
| `QDRANT_VECTOR_DIMENSIONS` | **For ingestion** | `768` | Vector dimensions |
| `OPENAI_API_KEY` | Optional | | OpenAI API key (only for ML-based embeddings) |
| `PING_MEM_PORT` | No | `3000` | HTTP server port |
| `PING_MEM_TRANSPORT` | No | `rest` | HTTP transport mode (`rest` or `sse`) |

**Note**: Neo4j and Qdrant are **required for code ingestion** (v1.1.0+), but core memory operations work with SQLite only.

### Configuration Priority

1. Environment variables
2. CLI arguments
3. Default values

---

## Development Commands

```bash
# Install dependencies
bun install

# Build TypeScript
bun run build

# Run tests (249 tests in rad-engineer, ping-mem tests TBD)
bun test

# Type check (MUST pass with 0 errors)
bun run typecheck

# Watch mode for development
bun run dev

# Start HTTP servers
bun run start           # REST mode (default)
bun run start:sse       # SSE mode (real-time)
bun run start:rest      # REST mode (explicit)

# Run MCP server directly
bun run dist/mcp/cli.js
```

### Project Structure

```
ping-mem/
├── src/
│   ├── config/            # Runtime configuration
│   │   └── runtime.ts          # Centralized service initialization
│   ├── mcp/               # MCP server implementation
│   │   ├── PingMemServer.ts    # Main MCP server
│   │   └── cli.ts              # CLI entry point
│   ├── http/              # HTTP server (REST/SSE)
│   │   ├── rest-server.ts      # REST API
│   │   ├── sse-server.ts       # SSE streaming
│   │   └── types.ts            # HTTP types
│   ├── client/            # Client SDK
│   │   ├── rest-client.ts      # REST client
│   │   ├── sse-client.ts       # SSE client
│   │   └── types.ts            # Client types
│   ├── ingest/            # Code ingestion system (NEW)
│   │   ├── ProjectScanner.ts   # Merkle tree + manifest
│   │   ├── ManifestStore.ts    # Manifest persistence
│   │   ├── CodeChunker.ts      # Code vs comment separation
│   │   ├── GitHistoryReader.ts # Git commit + diff parsing
│   │   ├── IngestionOrchestrator.ts # Pipeline coordinator
│   │   ├── IngestionService.ts # High-level agent API
│   │   ├── types.ts            # Type definitions
│   │   └── index.ts            # Exports
│   ├── graph/             # Knowledge graph layer
│   │   ├── Neo4jClient.ts      # Neo4j connection
│   │   ├── TemporalCodeGraph.ts # Bi-temporal code graph (NEW)
│   │   ├── EntityExtractor.ts  # NER
│   │   ├── GraphManager.ts     # Graph operations
│   │   └── RelationshipManager.ts
│   ├── search/            # Search engines
│   │   ├── QdrantClient.ts     # Qdrant connection
│   │   ├── CodeIndexer.ts      # Code search (NEW)
│   │   ├── DeterministicVectorizer.ts # Hash-based vectors (NEW)
│   │   ├── VectorIndex.ts      # Vector search
│   │   ├── HybridSearchEngine.ts
│   │   ├── LineageEngine.ts
│   │   └── EvolutionEngine.ts
│   ├── memory/            # Memory operations
│   ├── session/           # Session management
│   ├── storage/           # SQLite event store
│   ├── types/             # TypeScript definitions
│   └── validation/        # Input validation
├── examples/              # Usage examples (NEW)
│   └── resume-tracking/   # Resume tracking demo
├── dist/                  # Compiled JavaScript
├── package.json
├── tsconfig.json
├── IMPLEMENTATION_SUMMARY.md # v1.1.0 implementation details
└── README.md
```

---

## Related Projects

### rad-engineer-v3

**Location**: `/Users/umasankr/Projects/rad-engineer-v3`

**Relationship**: ping-mem is infrastructure that rad-engineer consumes

```
┌────────────────────────────────────────────────┐
│              rad-engineer (Application)         │
│  • 17 Specialized Agents                       │
│  • Verification Harness                        │
│  • Orchestration Engine                        │
│  • Deterministic Execution                     │
└─────────────────────────┬──────────────────────┘
                          │ uses
┌─────────────────────────▼──────────────────────┐
│              ping-mem (Infrastructure)          │
│  • Event Store (audit trail)                   │
│  • Episodic Memory (session history)           │
│  • Knowledge Graph (entity relations)          │
│  • Checkpoint/Restore (crash recovery)         │
└────────────────────────────────────────────────┘
```

**How rad-engineer uses ping-mem**:
1. **Event Sourcing**: Every agent action logged to event store
2. **Checkpoint/Restore**: Save state before risky operations
3. **Agent Context**: Each agent has isolated memory context
4. **Verification Results**: Store contract validation outcomes
5. **Session Replay**: Reconstruct agent workflows from events

### Other Consumers

ping-mem is designed as **universal infrastructure**. Potential consumers:
- AI coding assistants (session continuity)
- Research tools (knowledge accumulation)
- Autonomous agents (long-running state)
- Any MCP-compatible tool

---

## Key Design Principles

### 1. Interface Agnostic
- Works with any LLM (Claude, GPT-4, local models)
- No assumptions about AI interface
- Pure memory infrastructure

### 2. Transport Agnostic
- MCP (stdio) for Claude Code
- REST API for HTTP clients
- SSE for real-time streaming
- Future: WebSocket, gRPC

### 3. Storage Flexibility
- **Core Memory**: SQLite (zero dependencies, always available)
- **Ingestion System** (v1.1.0): Neo4j + Qdrant **required at startup**
  - Neo4j: Temporal code graph (mandatory for ingestion)
  - Qdrant: Semantic code search (mandatory for ingestion)
- **Future**: PostgreSQL, Redis

### 4. Event Sourcing
- Immutable append-only log
- Complete audit trail
- State replay capability
- Crash recovery

### 5. Session Isolation
- Each session has isolated memory
- Optional cross-session queries
- Multi-project support (4-tier: org/project/user/session)

---

## Quality Gates

| Gate | Command | Requirement |
|------|---------|-------------|
| TypeScript | `bun run typecheck` | 0 errors |
| Tests | `bun test` | 100% pass |
| Build | `bun run build` | No errors |

---

## Documentation

- **README.md**: Quick start and basic usage
- **IMPLEMENTATION_SUMMARY.md**: v1.1.0 ingestion system implementation details
- **src/client/README.md**: Client SDK documentation
- **rad-engineer docs**: `/Users/umasankr/Projects/rad-engineer-v3/docs/ping-mem/`
  - BRIEF.md: Executive summary
  - ARCHITECTURE.md: Full technical architecture
  - PRD.md: Product requirements
  - SPECIFICATION.md: Detailed specifications

---

## Roadmap & Pending Work

### Completed (v1.1.0)
- ✅ Deterministic project scanning with Merkle tree hashing
- ✅ Code chunking (code vs comments vs docstrings)
- ✅ Git history ingestion (commit DAG + diffs)
- ✅ Neo4j temporal code graph with bi-temporal queries
- ✅ Deterministic vectorization (hash-based, no ML)
- ✅ Qdrant code indexing with full provenance
- ✅ MCP/REST APIs for ingest, search, timeline
- ✅ Explicit-only "why" extraction from commit messages

### In Progress
- 🔄 **Project folder generalization** - Extend ingestion model to non-code projects (resumes, job tracking, etc.)
  - Work files: `src/ingest/UnifiedIngestionOrchestrator.ts`, `src/ingest/UnifiedIngestionService.ts`
  - Status: WIP, untracked files in working directory

### Pending (Future Work)
- ⏳ **Symbol extraction** - AST-based parsing for functions, classes, variables
  - Will enable finer-grained queries at symbol level
  - Planned for v1.2.0

- ⏳ **Differential queries** - "What changed between commit A and B?"
  - Temporal diff between arbitrary points in time

- ⏳ **LLM-powered summarization** (optional layer)
  - Human-friendly explanations
  - Always backed by explicit provenance

---

## Deployment Endpoints

| Environment | Endpoint | Credentials |
|-------------|----------|-------------|
| **Production** | `https://ping-mem.ping-gadgets.com` | `~/Projects/.creds/cloudflare.json` |
| **Local** | `http://localhost:3000` | None |

---

## Troubleshooting

### Issue: "bun:sqlite not found"

```bash
# Ensure you're using Bun runtime
bun --version
# If not installed, install Bun:
curl -fsSL https://bun.sh/install | bash
```

### Issue: "Module not found"

```bash
# Rebuild TypeScript
bun run build

# Clear cache and reinstall
rm -rf node_modules bun.lockb
bun install
```

### Issue: Neo4j connection failed

```bash
# Check Neo4j is running
docker ps | grep neo4j

# Check connection
bolt://localhost:7687

# Verify credentials in .env
cat .env | grep NEO4J
```

### Issue: Vector search not working

```bash
# Check Qdrant is running
curl http://localhost:6333/collections

# Verify OpenAI API key
echo $OPENAI_API_KEY

# Test embedding generation
curl https://api.openai.com/v1/embeddings \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"input":"test","model":"text-embedding-3-small"}'
```

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.1.0 | 2026-01-29 | **Deterministic Temporal Code Ingestion** - ProjectScanner, CodeChunker, GitHistoryReader, TemporalCodeGraph, DeterministicVectorizer, CodeIndexer, IngestionService, MCP codebase tools |
| 1.0.0 | 2026-01-27 | Initial standalone release |

---

**License**: MIT
**Repository**: https://github.com/ping-gadgets/ping-mem
**Issues**: https://github.com/ping-gadgets/ping-mem/issues

## Memories:
current vision and plan: `/Users/umasankr/.cursor/plans/deterministic_temporal_ingestion_06e320ca.plan.md`
