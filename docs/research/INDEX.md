# Research Index

**Created**: 2026-02-20
**Purpose**: Quick-lookup index for research documents. Read this file first to find what you need without loading all documents.

---

## Documents

| # | File | Topic | Key Question It Answers |
|---|------|-------|------------------------|
| 01 | `01-contextgraph-video.md` | ContextGraph YouTube video analysis | What is the 13-embedder architecture and why does single-model RAG break at scale? |
| 02 | `02-kg-memory-encoding-paper.md` | Academic paper on KG memory encoding | How do knowledge graphs serve as external LLM memory with weighted associative links? |
| 03 | `03-contextgraph-repo.md` | ContextGraph GitHub repo deep dive | How is ContextGraph implemented? (Rust, RocksDB, 51 CFs, 55 MCP tools) |
| 04 | `04-pingmem-architecture.md` | ping-mem architecture analysis | How does each ping-mem subsystem work? What are the gaps? |
| 05 | `05-synthesis-pros-cons.md` | Synthesis and recommendations | What should ping-mem adopt? Prioritized action items. |

---

## Quick Topic Lookup

### Embedding & Retrieval
- **Multi-model embedding**: `01` (13 embedders), `03` (implementation details), `05` (adoption plan)
- **RRF fusion**: `01` (formula + weight profiles), `04` (ping-mem's existing implementation)
- **BM25/SPLADE**: `01` (E6/E13), `04` (ping-mem's BM25 implementation)
- **Re-ranking**: `05` (recommendation to add)
- **Embedding degradation at scale**: `01` (4M document problem)

### Knowledge Graphs
- **KG architecture for LLM memory**: `02` (full paper analysis)
- **Neo4j patterns**: `02` (Cypher queries), `04` (ping-mem's TemporalCodeGraph)
- **Entity extraction**: `02` (LLM-based), `03` (ContextGraph's KEPLER), `04` (ping-mem's regex)
- **Bi-temporal modeling**: `04` (ping-mem's implementation), `02` (Zep/Graphiti comparison)

### Causal Reasoning
- **Asymmetric causal embeddings**: `01` (LoRA fine-tuning), `03` (E5 implementation)
- **Causal discovery agents**: `03` (llama-cpp-2 + GBNF grammar)
- **Adoption plan for ping-mem**: `05` (Tier 2.1)

### Temporal Memory
- **Temporal embeddings (time as vector)**: `01` (E2/E3/E4)
- **Post-retrieval temporal boost**: `01` (key insight), `05` (P0 recommendation)
- **Bi-temporal graph**: `04` (ping-mem's validFrom/validTo + ingestedAt)

### Memory Consolidation & Decay
- **Time-based decay**: `04` (RelevanceEngine, 0.97^days)
- **LLM-based consolidation**: `05` (Tier 2.2 recommendation)
- **ContextGraph consolidation**: `03` (similarity/temporal/semantic strategies)
- **Weighted associative links**: `02` (paper's core mechanism)

### Architecture Comparisons
- **ping-mem vs ContextGraph**: `03` (table), `05` (what to adopt vs skip)
- **ping-mem vs state-of-the-art**: `04` (Section 10 gap table)
- **Research landscape**: `02` (Zep, GraphRAG, Mem0, MemGPT)

### Code Ingestion (ping-mem unique)
- **Pipeline flow**: `04` (Section 5)
- **Merkle tree change detection**: `04` (ProjectScanner)
- **Path-independent projectId**: `04` (SHA-256 formula)

### Priorities & Roadmap
- **Full prioritized matrix**: `05` (Adoption Priority Matrix)
- **What NOT to adopt**: `05` (bottom section)
- **P0 items**: Complete graph search stub, temporal post-retrieval boost
- **P1 items**: LLM entity extraction, multi-model embedding, causal reasoning

---

## Key Numbers

| Metric | ContextGraph | ping-mem |
|--------|-------------|----------|
| Embedding models | 13 (GPU) | 1 (API) |
| MCP tools | 55 | ~25 |
| Storage backends | 1 (RocksDB) | 3 (SQLite + Neo4j + Qdrant) |
| Language | Rust (468K LOC) | TypeScript |
| GPU required | Yes (RTX 5090) | No |
| Entity extraction | KEPLER + LLM | Regex |
| Causal reasoning | Yes (LoRA) | No |
| Code ingestion | No | Yes (deterministic) |
| Diagnostics tracking | No | Yes (SARIF) |
