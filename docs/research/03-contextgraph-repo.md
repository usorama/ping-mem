# ContextGraph Repository Analysis

**URL**: https://github.com/ChrisRoyse/contextgraph
**Language**: Rust (468K LOC, 11 crates)
**License**: Apache-2.0 / MIT dual
**Stars**: 10 | **Forks**: 6 | **Author**: Chris Royse (single contributor)
**Created**: 2025-12-31 | **Tests**: ~6,577 functions across 684 files

---

## Purpose

MCP server providing persistent, multi-dimensional semantic memory for AI assistants. Core differentiator: **13-specialized-embedder pipeline** with Reciprocal Rank Fusion (RRF).

---

## Architecture

### 11 Workspace Crates

| Crate | Purpose |
|-------|---------|
| `context-graph-core` | Domain types, 14 weight profiles, fusion, clustering |
| `context-graph-mcp` | MCP server, 55 tool handlers, transport (stdio/TCP/SSE) |
| `context-graph-storage` | RocksDB, 51 column families, HNSW indexes |
| `context-graph-embeddings` | 13-model pipeline via HuggingFace Candle (GPU) |
| `context-graph-graph` | Knowledge graph, hyperbolic geometry, traversals |
| `context-graph-cuda` | GPU acceleration (CUDA / Candle) |
| `context-graph-cli` | CLI tools and Claude Code hooks |
| `context-graph-causal-agent` | LLM causal discovery (llama-cpp-2 + GBNF) |
| `context-graph-graph-agent` | LLM graph relationship discovery |
| `context-graph-benchmark` | Performance benchmarking |
| `context-graph-test-utils` | Shared test helpers |

### Data Flow

```
Store memory --> 13 embedders fire in parallel --> RocksDB + HNSW indexes
Search query --> 6 embedders retrieve candidates --> RRF fusion --> ranked results
```

---

## Storage: RocksDB Only (No External Services)

Everything in a single RocksDB instance with **51 column families**:

| Layer | CFs | Contents |
|-------|-----|----------|
| Core | 11 | Nodes, edges, embeddings, metadata, temporal, tags |
| Teleological | 19 | Fingerprints, topic profiles, causal relationships, audit log |
| Quantized Embedder | 13 | One CF per embedder (PQ-8 or Float8) |
| Code | 5 | AST chunks, language indexes, symbol tables |
| Causal | 2 | Causal metadata and indexes |

HNSW via `usearch` library. PID file guard with `flock()` prevents corruption.

---

## 13-Embedder Pipeline (Key Innovation)

All 13 run in parallel via `tokio::join!`. Target: <30ms per content piece.

| # | Name | Model | Dims | Purpose |
|---|------|-------|------|---------|
| E1 | Semantic | e5-large-v2 | 1024D | Primary similarity |
| E2 | Freshness | Custom temporal | 512D | Recency decay |
| E3 | Periodic | Fourier-based | 512D | Cyclical time patterns |
| E4 | Sequence | Sinusoidal positional | 512D | Conversation ordering |
| E5 | Causal | nomic-embed-v1.5 + LoRA | 768D | Cause-effect (asymmetric) |
| E6 | Keyword | SPLADE cocondenser | ~30KD | BM25-style sparse |
| E7 | Code | Qodo-Embed-1.5B | 1536D | AST-aware code |
| E8 | Graph | e5-large-v2 | 1024D | Directional graph |
| E9 | HDC | Hyperdimensional | 1024D | Typo tolerance |
| E10 | Paraphrase | e5-base-v2 | 768D | Rephrase-invariant |
| E11 | Entity | KEPLER | 768D | Named entity + TransE |
| E12 | ColBERT | ColBERT | 128D/tok | Late interaction precision |
| E13 | SPLADE | SPLADE v3 | ~30KD | Learned sparse expansion |

**GPU required**: Hard-coded for NVIDIA RTX 5090 + CUDA 13.1.

---

## Knowledge Graph

- Poincare ball model for hierarchical embedding (hyperbolic geometry)
- BFS, DFS, A* pathfinding with bidirectional search
- Contradiction detection
- NN-Descent for K-NN graph construction
- Multi-relation typed edges from cross-embedder agreement

---

## MCP Tools (55 total)

| Category | Count |
|----------|-------|
| Core Memory | 4 |
| Memory Curation | 3 |
| Causal Reasoning | 6 |
| Entity & Knowledge Graph | 6 |
| Session & Conversation | 4 |
| Topic Detection | 4 |
| Embedder-First Search | 7 |
| Specialized Search | 5 |
| Graph Navigation | 8 |
| File Watcher | 4 |
| Provenance & Audit | 3 |
| Maintenance | 1 |

Transport: stdio, TCP, SSE, stdio+tcp, daemon mode.

7 Claude Code hooks with timeout budgets (500ms - 30s).

---

## Memory Consolidation

- Three strategies: Similarity, Temporal, Semantic (LLM-assisted)
- Soft-delete with 30-day recovery
- Importance scoring (0.0-1.0)
- Background GC every 5 minutes
- HDBSCAN/BIRCH topic detection and clustering
- Topic stability metrics and divergence alerts

---

## Code Quality

### Strengths
- 6,577 test functions across 684 files
- Consistent `thiserror`/`anyhow` error handling
- Thread safety: `Arc<DB>`, `parking_lot::Mutex`, `RwLock`
- Production hardening: PID guard, signal handlers, daemon mode
- Extensive rustdoc with architecture diagrams

### Concerns
- Single contributor (bus factor = 1)
- Hard GPU coupling (RTX 5090 + CUDA 13.1)
- Squashed git history (1 visible commit)
- Minimal community (10 stars, 6 forks)
- ~600MB binary size
- No CI/CD, no Docker, no crates.io publication

---

## Comparison with ping-mem

| Dimension | ContextGraph | ping-mem |
|-----------|-------------|----------|
| Language | Rust | TypeScript + Bun |
| Storage | RocksDB (embedded) | SQLite + Neo4j + Qdrant |
| Vector Search | usearch HNSW (embedded) | Qdrant (external) |
| Graph | Embedded (hyperbolic) | Neo4j (external) |
| Embedding | 13 local GPU models | OpenAI/Gemini API + hash fallback |
| GPU Required | Yes (NVIDIA CUDA) | No |
| Interface | MCP (55 tools) | MCP + REST API |
| Deployment | Single binary | Docker Compose multi-container |
| Code Ingestion | Memory search only | Full code ingestion pipeline |
| External Deps | 0 services, 469 cargo | Neo4j + Qdrant containers |
