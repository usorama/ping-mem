# ping-mem Architecture Deep Analysis

**Project**: /Users/umasankr/Projects/ping-mem
**Stack**: TypeScript + Bun + SQLite + Neo4j + Qdrant
**Tests**: 52 test files, ~19,100 lines test code vs ~30,800 source (0.62 ratio)

---

## 1. Core Memory System

**Files**: `src/memory/MemoryManager.ts` (995 lines), `src/memory/RelevanceEngine.ts` (750 lines)

### How It Works
- Event-sourced, in-memory key-value store with optional vector indexing
- Two Maps: `memories` (by key) and `memoriesById` (by UUID v7)
- Write: save to Maps -> emit `MEMORY_SAVED` event -> optional vector index
- Read: `get()` from Map (O(1)), `recall()` with filters, `semanticSearch()` via VectorIndex
- `hydrate()` replays events from EventStore to rebuild state
- Cross-session: `findRelatedAcrossSessions()` queries SQLite directly

### RelevanceEngine
- **Decay**: `relevance = base_score * 0.97^(days)` (~23-day half-life)
- **Priority weights**: high=1.5, normal=1.0, low=0.5
- **Category weights**: decision=1.3, error=1.2, task=1.0, note=0.7
- **Access bonus**: `min(1.0 + log2(access_count) * 0.1, 2.0)`
- **Consolidation**: Groups stale memories (score < 0.3, 30+ days) into digests

### Weaknesses
- No automatic hydration (must call explicitly)
- Race conditions on concurrent `save()` (no locking)
- All memories loaded into RAM
- EventStore grows unboundedly (no compaction)
- RelevanceEngine not auto-wired to MemoryManager

---

## 2. Event Store (Storage Layer)

**File**: `src/storage/EventStore.ts` (684 lines)

- Append-only SQLite event journal (WAL mode)
- Tables: events, checkpoints, checkpoint_items
- UUID v7 for time-sortable event IDs
- Causality tracking via `caused_by` FK
- Prepared statements for performance

### Weaknesses
- No event compaction/TTL/archival
- Payload as JSON strings (no payload field indexing)
- No event versioning (schema evolution risk)

---

## 3. Knowledge Graph (Neo4j)

**Files**: `src/graph/Neo4jClient.ts`, `TemporalCodeGraph.ts`, `GraphManager.ts`, `EntityExtractor.ts` (810 lines), `RelationshipInferencer.ts`, `TemporalStore.ts`, `LineageEngine.ts`, `EvolutionEngine.ts`

### Two Graph Models

**A) Temporal Code Graph**: Persists ingested code structure
- Nodes: Project, File, Chunk, Symbol, Commit
- Relationships: HAS_FILE, HAS_CHUNK, DEFINES_SYMBOL, HAS_COMMIT, MODIFIES, etc.
- Bi-temporal: `validFrom`/`validTo` (business) + `ingestedAt` (system)
- UNWIND batching (batch size 500) for 10x+ performance

**B) Memory Knowledge Graph**:
- EntityExtractor: **Regex patterns** for 9 types (PERSON, ORGANIZATION, CODE_FILE, CODE_FUNCTION, DECISION, TASK, ERROR, CONCEPT, CODE_CLASS)
- RelationshipInferencer: **Rule-based** for 10 types (DEPENDS_ON, RELATED_TO, CAUSES, IMPLEMENTS, etc.)
- TemporalStore: Bi-temporal storage with versioning
- LineageEngine: Upstream/downstream via DERIVED_FROM
- EvolutionEngine: Temporal evolution queries

### Weaknesses
- Entity extraction is regex-only (no LLM/NLP)
- Session leak risk (missing try-finally in batch methods)
- No graph pruning/TTL
- Shallow relationship inference

---

## 4. Semantic Search (Qdrant + Embeddings)

**Files**: `src/search/EmbeddingService.ts` (712 lines), `HybridSearchEngine.ts` (957 lines), `VectorIndex.ts`, `DeterministicVectorizer.ts`, `QdrantClient.ts`, `CodeIndexer.ts`

### Embedding Strategy
Three providers with fallback chain:
1. **OpenAI** `text-embedding-3-small` (768D) -- primary
2. **Gemini** `text-embedding-004` (768D) -- fallback
3. **DeterministicVectorizer** -- hash-based, no API needed

Content-addressable cache: SHA-256 hash, LRU, 1000 entries, 1-hour TTL.

### Hybrid Search (RRF Fusion)
- **Semantic** (weight 0.5): Vector similarity via Qdrant/sqlite-vec
- **Keyword** (weight 0.3): Built-in BM25 (k1=1.5, b=0.75)
- **Graph** (weight 0.2): Entity relationship traversal
- RRF: `score = sum(weight * 1/(60 + rank))`

### Weaknesses
- **Graph search is a stub** (returns empty results) -- hybrid is effectively semantic + keyword only
- No re-ranking (cross-encoder or LLM)
- BM25 index in-memory only (rebuilt on restart)
- Single embedding model (no multi-perspective)

---

## 5. Ingestion Pipeline

**Files**: `src/ingest/IngestionOrchestrator.ts`, `IngestionService.ts`, `ProjectScanner.ts`, `CodeChunker.ts`, `GitHistoryReader.ts`, `SymbolExtractor.ts`, `ManifestStore.ts`, `SafeGit.ts`

### Pipeline Flow
```
IngestionService.ingestProject()
  -> IngestionOrchestrator.ingest()
     -> ProjectScanner.scanProject()      (Merkle tree hash)
     -> CodeChunker.chunkFile()           (code/comment/docstring chunks)
     -> GitHistoryReader.readHistory()    (commits, diffs)
     -> SymbolExtractor.extractFromFile() (functions, classes)
     -> ManifestStore.save()              (persist manifest)
  -> TemporalCodeGraph.persistIngestion() (Neo4j)
  -> CodeIndexer.indexIngestion()          (Qdrant vectors)
```

### Project Identity
`projectId = SHA-256(remoteUrl + "::" + relativeToGitRoot)` -- path-independent

### Strengths
- Deterministic and reproducible (same state = same IDs)
- Merkle tree change detection avoids unnecessary re-ingestion
- SafeGit provides command injection protection

### Weaknesses
- No incremental file-level ingestion (any change = full re-chunk)
- Sequential file processing
- Large repos slow (1000 commits = slow Neo4j persist)
- No file size limits

---

## 6. Session Management

**File**: `src/session/SessionManager.ts` (535 lines)

- Lifecycle: active -> paused -> active -> ended
- Session continuation via `parentSessionId`
- Auto-checkpointing (default: 5 minutes)
- Max active sessions limit (default: 10)

### Weaknesses
- In-memory only (requires explicit `hydrate()`)
- No session timeout
- `loadContextFrom()` returns empty memories (placeholder)

---

## 7. MCP Interface

**File**: `src/mcp/PingMemServer.ts` (~1500+ lines)

20+ tools: Context (12), Worklog (2), Diagnostics (7), Codebase (6)

### Strengths
- Proactive recall on save surfaces related memories
- Entity extraction opt-in per save
- Supports SARIF and normalized findings

### Weaknesses
- Monolithic (1500+ lines single file)
- Inconsistent input validation
- No rate limiting

---

## 8. Diagnostics

**Files**: `src/diagnostics/DiagnosticsStore.ts`, sarif.ts, normalizer.ts, SummaryGenerator.ts, SymbolAttributor.ts, eslint-sarif.ts, prettier-sarif.ts, tsc-sarif.ts

- SARIF 2.1.0 ingestion (TypeScript, ESLint, Prettier, generic)
- Deterministic analysis IDs: `SHA-256(projectId + toolName + configHash + treeHash)`
- Diff between runs
- Symbol attribution (link findings to code symbols)
- LLM summary generation with caching

---

## 9. What ping-mem Has That Others Lack

1. **Deterministic code ingestion** with Merkle tree verification
2. **Bi-temporal modeling** for memory and code graphs
3. **Diagnostic result tracking** with SARIF
4. **Worklog events** for tool usage tracking
5. **Path-independent project identity** for multi-env deployment
6. **No GPU requirement** -- accessible on any machine

## 10. What State-of-the-Art Has That ping-mem Lacks

| Feature | State-of-the-Art | ping-mem |
|---------|-----------------|----------|
| LLM-based entity extraction | Graphiti, Mem0 | Regex-only |
| LLM memory consolidation | MemGPT | Staleness-based only |
| LLM importance scoring | Mem0 | Manual priority weights |
| Contradiction detection | Graphiti | Not implemented |
| Memory deduplication | Mem0 | Key uniqueness only |
| Episodic vs semantic memory | MemGPT | Single memory type |
| Context overflow summarization | MemGPT | None |
| User feedback for relevance | Mem0 | Not implemented |
| LLM relationship inference | Graphiti | Regex patterns |
| Re-ranking (cross-encoder) | Modern RAG | RRF only |
| Multi-model embeddings | ContextGraph (13) | Single model |
| Streaming/incremental ingestion | Various | Full re-scan |
