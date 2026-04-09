# Architecture Reference

## Core Components

```
┌─────────────────────────────────────────────────────────┐
│  Interfaces                                             │
│  MCP Server (stdio) · HTTP Server (REST/SSE) · Client SDK │
├─────────────────────────────────────────────────────────┤
│  Core Layer                                             │
│  MemoryManager · SessionManager · EventStore            │
├─────────────────────────────────────────────────────────┤
│  Ingestion Layer                                        │
│  ProjectScanner · CodeChunker · GitHistoryReader         │
│  IngestionService · DeterministicVectorizer · CodeIndexer │
├─────────────────────────────────────────────────────────┤
│  Storage Layer                                          │
│  SQLite (bun:sqlite) · Neo4j (temporal graph) · Qdrant   │
└─────────────────────────────────────────────────────────┘
```

## Component Details

### Ingestion Layer (`src/ingest/`, `src/search/`)
- **ProjectScanner** — Merkle tree hashing, content-addressable IDs, manifest-based change detection
- **CodeChunker** — Separates code/comments/docstrings (TS, JS, Python)
- **GitHistoryReader** — Commit DAG, file change tracking, unified diff parsing
- **IngestionService** — High-level API: `ingestProject()`, `verifyProject()`, `searchCode()`, `queryTimeline()`
- **SemanticChunker** — Function/class/file-level semantic chunks
- **TemporalCodeGraph** — Neo4j bi-temporal model (Project, File, Chunk, Commit nodes)
- **DeterministicVectorizer** — Hash-based vectors (no ML), N-gram, L2 normalized
- **CodeIndexer** — Qdrant indexing + BM25/FTS5 hybrid search (CodeChunkStore)

### Core Layer
- **MemoryManager** — CRUD + `supersede()` semantics, JunkFilter on write
- **SessionManager** — Session lifecycle and isolation
- **EventStore** — Immutable append-only log (SESSION_STARTED, CONTEXT_SAVED, etc.)
- **AgentIntelligence** — Agent history and pattern analysis
- **CcMemoryBridge** — Write-through enrichment between native files and ping-mem
- **MaintenanceRunner** — Automated quality gates and self-maintenance
- **SemanticCompressor** — Memory compression (heuristic or LLM)

### Graph Layer (Neo4j)
- **EntityExtractor** — NER from text
- **GraphManager** — Nodes + edges storage
- **RelationshipManager** — Temporal lineage tracking

### Search Layer (Qdrant)
- **VectorIndex** — Embeddings + semantic similarity
- **HybridSearchEngine** — Semantic + keyword + graph combined
- **LineageEngine** — Upstream/downstream dependency tracing
- **EvolutionEngine** — Temporal entity change tracking

## Project Structure

```
src/
├── config/            # Runtime configuration (runtime.ts)
├── mcp/               # MCP server (PingMemServer.ts, cli.ts)
├── http/              # HTTP server (rest-server.ts, sse-server.ts)
├── client/            # Client SDK (rest-client.ts, sse-client.ts)
├── ingest/            # Code ingestion pipeline
├── graph/             # Neo4j graph layer
├── search/            # Qdrant + hybrid search
├── knowledge/         # KnowledgeStore (FTS5)
├── memory/            # MemoryManager + SemanticCompressor
├── pubsub/            # MemoryPubSub (real-time events)
├── session/           # Session management
├── storage/           # SQLite EventStore + WriteLockManager
├── eval/              # Eval suite (LLM-as-judge)
├── integration/       # CcMemoryBridge
├── admin/             # AdminStore, ApiKeyManager, crypto
├── types/             # TypeScript definitions
└── validation/        # Input validation (Zod)
```

## DreamingEngine LLM Dependency

DreamingEngine calls `callClaude()` directly (bypassing the Ollama/Gemini fallback chain). Claude API access is required for dreaming. In environments without Claude API access, dreaming will silently fail. Future work: route through LLMProxy.

## Key Design Decisions

- **SQLite**: Core storage (always available, no deps)
- **Neo4j + Qdrant**: Required for ingestion; optional for core memory
- **Event sourcing**: Immutable EventStore, all state derived from events
- **Pipeline**: ProjectScanner -> SemanticChunker -> GitHistoryReader -> Neo4j -> Qdrant
- **Explicit "why" only**: Commit message `Why:`, `Reason:`, `Fixes #` — never inferred
- **Security**: AES-256-GCM API keys, timingSafeEqual auth, CSRF protection, rate limiting
