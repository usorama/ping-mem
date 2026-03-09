# Knowledge Graph-Based Memory Encoding for Large Language Models

**Paper**: Knowledge Graph-Based Memory Encoding for Large Language Models
**Author**: Chris Royse, Kansas State University
**Published**: February 2025, ResearchGate
**DOI**: 10.13140/RG.2.2.27328.24323

---

## Core Thesis

LLMs excel at pattern recognition but suffer from limited built-in memory (fixed context windows). The paper proposes encoding conversational context into a knowledge graph as external long-term memory, transforming conversation transcripts into graph-structured knowledge in Neo4j for RAG with significantly reduced token overhead.

---

## Knowledge Graph Architecture

### Storage: Neo4j with Cypher queries

### Graph Schema
- **Entity Nodes**: Extracted from conversation turns (people, concepts, objects, locations)
- **Relationship Edges**: Typed connections representing semantic relationships
- **Associative Links**: Weighted connections reflecting association strength/frequency

### Pipeline Steps

1. **Entity & Relationship Extraction from Dialogue** -- LLM processes transcripts to identify entities and relationships
2. **Knowledge Graph Construction** -- Entities/relationships persisted to Neo4j as nodes and edges
3. **Embedding Generation** -- Entities/relationships receive vector embeddings for similarity search
4. **Associative Link Formation with Weighting** -- Weighted links encode strength (co-occurrence, recency, importance)
5. **Query Processing** -- Combines embedding similarity + graph traversal for retrieval

---

## Memory Mechanisms

### Storage
Conversations decomposed into structured knowledge (entities + relationships + links), not stored verbatim. Analogous to human memory encoding experiences into semantic/episodic components.

### Retrieval
- Embedding-based semantic search
- Graph traversal following edges
- Weight-based prioritization

### Update
Graph evolves with new conversations: new entities added, relationships updated/strengthened, weights adjusted. Provides memory consolidation over time.

---

## Key Contributions

| LLM Limitation | KG Solution |
|---|---|
| Fixed context window | Graph stores unlimited knowledge externally; only relevant subsets retrieved |
| No persistent memory | Graph persists between sessions |
| Token inefficiency | Structured retrieval returns compact context (90%+ reduction) |

---

## Evaluation Results

- Improved retrieval accuracy vs context-only memory
- Reduced token load via structured graph queries
- Increased response relevance with graph-retrieved context
- Note: Prototype evaluation, not standardized benchmarks (DMR, LongMemEval)

---

## Strengths

1. Clear, accessible framework for KG-based LLM memory
2. Practical implementation (Python + Neo4j + Cypher)
3. Token efficiency demonstrated
4. Weighted link mechanism for memory prioritization
5. Modular pipeline (each stage independently improvable)
6. Companion implementation: [CogniGraph](https://github.com/ChrisRoyse/Self-Conceptualizing-KG) with bio-inspired mechanisms

## Limitations

1. Prototype-level evaluation (no standardized benchmarks)
2. Simple temporal model (no bi-temporal like Zep/Graphiti)
3. Entity resolution not deeply addressed (deduplication, semantic drift)
4. Scalability concerns (LLM calls for extraction = computational overhead)
5. LLM dependency -- extraction quality bounded by LLM accuracy
6. No community detection (unlike Zep's three-tier approach)
7. No contradiction handling

---

## Related Work Landscape

| System | Date | Innovation |
|---|---|---|
| **This paper** | Feb 2025 | KG conversational memory + weighted associative links |
| **Zep/Graphiti** | Jan 2025 | Bi-temporal KG, episode/semantic/community tiers, 94.8% DMR |
| **Graph-based Agent Memory Survey** | Feb 2026 | Taxonomy: 6 memory types, 6 retrieval paradigms |
| **Microsoft GraphRAG** | 2024 | Hierarchical community detection + summarization |
| **Mem0** | Apr 2025 | Production-ready scalable long-term memory |

---

## Relevance to ping-mem

| Paper Architecture | ping-mem Equivalent |
|---|---|
| Neo4j graph storage | TemporalCodeGraph (Neo4j) |
| Entity/relationship extraction | EntityExtractor (regex-based) |
| Embedding generation | CodeIndexer + DeterministicVectorizer (Qdrant) |
| Cypher query retrieval | Neo4j client queries |
| Associative links | Relationship edges in temporal graph |

### Key Takeaways for Agent Memory

1. Graph > flat vector store for relational memory
2. Hybrid retrieval (embedding + graph) yields best results
3. Weighted associations enable prioritization
4. Token efficiency matters at scale (graph retrieval = 90%+ reduction)
5. Temporal modeling (when acquired vs when occurred) is a differentiator
