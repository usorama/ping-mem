# ContextGraph Video: "I Built a 13-Model AI Memory System in Rust (Because RAG is Broken)"

**Source**: https://youtu.be/fdy8NpzhO_A
**Channel**: Leapable (Chris Royse)
**Published**: 2026-02-18
**GitHub**: https://github.com/ChrisRoyse/contextgraph

---

## The Core Problem: Vector Search Degradation at Scale

Single-model embedding-based retrieval degrades silently as corpus size grows ("The 4 Million Document Problem"):

1. **Similarity score compression**: Cosine similarity scores cluster toward the same narrow range
2. **Silent quality loss**: No errors logged, latency fine, but recall drops
3. **Single-vector bottleneck**: One query vector is mathematically insufficient to model multiple target distributions (proven by DeepMind)

Thesis: traditional RAG (single embedding + vector DB) is fundamentally broken at scale.

---

## The Solution: 13-Embedder "Context Graph" Architecture

An MCP server in Rust providing persistent, multi-dimensional semantic memory. Every memory is embedded across **13 specialized dimensions**:

| # | Name | Model | Dims | Purpose |
|---|------|-------|------|---------|
| E1 | Semantic | e5-large-v2 | 1024D | Primary similarity |
| E2 | Freshness | Custom temporal | 512D | Exponential recency decay |
| E3 | Periodic | Fourier-based | 512D | Time-of-day/week cyclical patterns |
| E4 | Sequence | Sinusoidal positional | 512D | Conversation ordering |
| E5 | Causal | nomic-embed-v1.5 + LoRA | 768D | Asymmetric cause-effect reasoning |
| E6 | Keyword | SPLADE cocondenser | ~30KD | BM25-style sparse matching |
| E7 | Code | Qodo-Embed-1.5B | 1536D | AST-aware source code |
| E8 | Graph | e5-large-v2 | 1024D | Directional graph connections |
| E9 | HDC | Hyperdimensional computing | 1024D | Character-level typo tolerance |
| E10 | Paraphrase | e5-base-v2 | 768D | Rephrase-invariant matching |
| E11 | Entity | KEPLER | 768D | Named entity + TransE knowledge linking |
| E12 | ColBERT | ColBERT | 128D/tok | Late interaction token-level precision |
| E13 | SPLADE | SPLADE v3 | ~30KD | Learned sparse expansion |

## Multi-Signal Fusion via Reciprocal Rank Fusion (RRF)

```
score = SUM(weight_i / (rank_i + 60))
```

14 predefined weight profiles for query types: `semantic_search`, `causal_reasoning`, `code_search`, `fact_checking`, `graph_reasoning`, `temporal_navigation`, etc.

### Three Search Strategies

1. **e1_only** (~1ms): Single HNSW search
2. **multi_space**: Weighted RRF across E1, E5, E7, E8, E10, E11
3. **pipeline**: E13 recall -> multi-space scoring -> E12 ColBERT reranking

---

## LoRA-Tuned Causal Embeddings (E5)

Fine-tuned `nomic-embed-v1.5` with LoRA for **asymmetric causal reasoning**. Dual directional vectors:
- **Cause-side embedding**: "What caused this?"
- **Effect-side embedding**: "What did this cause?"

Directional boost: cause->effect = 1.2x, effect->cause = 0.8x. High-confidence causal relationships get 1.10x boost; low-confidence demoted by 0.85x.

Uses llama-cpp-2 + Hermes 2 Pro + **GBNF grammar constraints** for 100% valid JSON output.

---

## Temporal Embeddings: Time as a Vector

- **E2 (Freshness)**: Exponential recency decay as **post-retrieval boost** (not search-time filter) -- prevents recent memories drowning older relevant ones
- **E3 (Periodic)**: Fourier-based cyclical patterns (time-of-day, day-of-week)
- **E4 (Sequence)**: Sinusoidal positional encoding for conversation ordering

---

## Tech Stack

- **Language**: Rust (468K LOC, 11 workspace crates)
- **Storage**: RocksDB with 51 column families (no external DB)
- **Vector Index**: usearch HNSW (embedded)
- **ML**: HuggingFace Candle (CUDA, RTX 5090)
- **LLM**: llama-cpp-2 (Hermes 2 Pro Mistral 7B, Q5_K_M)
- **MCP**: 55 tools across 11 categories

---

## Key Insights for Memory Systems

1. RAG is not memory -- true memory needs temporal awareness, causal understanding, entity linking, multi-perspective encoding
2. Multi-embedder approach fixes scale degradation by avoiding "crowded embedding space"
3. Asymmetric causal embeddings are novel -- "What caused X?" vs "What did X cause?" return different results
4. Temporal post-retrieval boosting prevents recency bias
5. GBNF grammar constraints guarantee valid LLM JSON output

---

## Relevance to ping-mem

| ContextGraph Concept | ping-mem Equivalent | Gap |
|---|---|---|
| 13 parallel embedders | Single DeterministicVectorizer + Qdrant | Multi-model embedding opportunity |
| Causal embeddings (E5) | Not present | Novel direction for "why" relationships |
| Temporal embeddings (E2-E4) | TemporalCodeGraph (Neo4j) | Graph structure vs embedding for temporal |
| RocksDB + 51 column families | SQLite + Neo4j + Qdrant | Different trade-offs |
| RRF across 13 embedders | HybridSearch (semantic + BM25 + graph) | ping-mem has fewer dimensions |
| 55 MCP tools | ~25 MCP tools | ContextGraph more feature-rich |
| GPU required (RTX 5090) | No GPU needed | ping-mem more accessible |
