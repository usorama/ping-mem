---
title: "ping-mem Memory Enhancement Design"
version: 1.0.0
date: 2026-02-20
status: approved
approach: "Fix, Extend, Layer"
phases: 4
estimated_days: 13-17
research_sources:
  - docs/research/01-contextgraph-video.md
  - docs/research/02-kg-memory-encoding-paper.md
  - docs/research/03-contextgraph-repo.md
  - docs/research/04-pingmem-architecture.md
  - docs/research/05-synthesis-pros-cons.md
---

# ping-mem Memory Enhancement Design

## Summary

Transform ping-mem from a functional memory layer into a best-in-class AI agent memory system by adopting key innovations from ContextGraph (13-embedder architecture), KG Memory Encoding research (weighted associative links), and Zep/Graphiti (bi-temporal knowledge graphs) while preserving ping-mem's unique strengths: deterministic code ingestion, no GPU requirement, and multi-service architecture.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| LLM API strategy | Cloud APIs (OpenAI/Gemini) | Highest quality, no GPU needed |
| Phasing | Foundation first, features second | Stabilize before innovating |
| Embedding models | 4 total (semantic + code + sparse + causal) | Balance of coverage and cost |
| Entity extraction | Selective (decisions/errors/tasks, >200 chars) | 70% cost savings, captures highest-value data |
| GPU requirement | None | Accessibility is a moat |

## Architecture Overview

```
                    ┌─────────────────────────────────────────┐
                    │              MCP / REST API              │
                    └───────┬─────────────┬───────────────────┘
                            │             │
                ┌───────────┴──┐    ┌─────┴─────────────┐
                │MemoryManager │    │ PingMemServer      │
                │+ RelevanceEng│    │ (MCP tool dispatch) │
                └───────┬──────┘    └─────┬─────────────┘
                        │                  │
        ┌───────────────┼──────────────────┼────────────────┐
        │               │                  │                │
  ┌─────┴─────┐  ┌──────┴──────┐  ┌───────┴──────┐  ┌─────┴──────┐
  │ EventStore│  │HybridSearch │  │ GraphManager  │  │  Ingestion │
  │ (SQLite)  │  │Engine (RRF) │  │+ CausalGraph  │  │  Pipeline  │
  └───────────┘  └──────┬──────┘  └───────┬───────┘  └────────────┘
                        │                  │
           ┌────────────┼────────┐         │
           │            │        │         │
     ┌─────┴───┐ ┌──────┴──┐ ┌──┴──┐ ┌────┴────┐
     │Semantic  │ │Code     │ │BM25 │ │Neo4j    │
     │Embedder  │ │Embedder │ │+    │ │(graph + │
     │(OpenAI)  │ │(Voyage) │ │SPLADE│ │causal)  │
     └─────────┘ └─────────┘ └─────┘ └─────────┘
           │            │                  │
     ┌─────┴────────────┴──────────────────┘
     │              Qdrant
     │  ┌─────────────────────────────┐
     │  │ ping-mem-vectors (768D)     │ ← semantic
     │  │ ping-mem-code-vectors(1024D)│ ← code
     │  │ ping-mem-causal-vectors(768D)│ ← causal (cause + effect)
     │  └─────────────────────────────┘
     │
     └── Optional: Cohere Rerank API (post-RRF)
```

---

## Phase 1: Fix the Foundation

**Goal**: Every existing feature works correctly. No new features, just fix stubs and gaps.
**Estimated**: 3-4 days
**Quality gate**: All existing tests pass + new tests for each fix

### 1.1 Complete Graph Search in HybridSearchEngine

**Problem**: `graphSearch()` at `src/search/HybridSearchEngine.ts:710` returns empty `[]`.

**Solution**:
- Define a `MemoryLookup` interface: `{ lookupByEntityNames(names: string[]): Promise<VectorSearchResult[]> }`
- Inject at HybridSearchEngine construction (avoids circular dep with MemoryManager)
- `graphSearch()` flow:
  1. Get relationships from GraphManager (existing code works)
  2. Collect related entity names
  3. Call `memoryLookup.lookupByEntityNames()` to get actual memory content
  4. Score by hop distance: `similarity = 1.0 / (1 + hopDistance)`
  5. Return as `VectorSearchResult[]` for RRF

**Files**:
- Modify: `src/search/HybridSearchEngine.ts`
- Create: `src/search/types.ts` (MemoryLookup interface)

**Tests**:
- Unit: mock GraphManager + MemoryLookup, verify results flow through RRF
- Integration: save memories with entities, verify graph search surfaces them

**Risk**: Low. Existing RRF handles new results transparently.

### 1.2 Temporal Post-Retrieval Boost

**Problem**: No recency signal in search results.

**Solution**:
- Add `applyTemporalBoost()` after RRF fusion in `reciprocalRankFusion()`
- Formula: `boostedScore = rrfScore * (1 + boostFactor * exp(-ageDays / decayDays))`
- Defaults: `boostFactor = 0.3`, `decayDays = 30`
- Max boost: 30% for today's memories, ~1% after 90 days
- Config: `HybridSearchConfig.temporalBoost: { factor: number, decayDays: number }`
- Opt-out: `HybridSearchOptions.skipTemporalBoost: boolean`

**Files**: Modify `src/search/HybridSearchEngine.ts`

**Tests**: Unit test with mocked timestamps verifying boost magnitude and decay curve.

**Risk**: Low. Purely additive.

### 1.3 Wire RelevanceEngine into MemoryManager

**Problem**: RelevanceEngine exists but requires explicit calls.

**Solution**:
- Add optional `relevanceEngine?: RelevanceEngine` parameter to MemoryManager constructor
- In `save()`: call `relevanceEngine.ensureTracking(memoryId, priority, category)` after event emission
- In `get()`: call `relevanceEngine.trackAccess(memoryId)` after retrieval
- No-op when `relevanceEngine` is undefined (backwards compatible)

**Files**: Modify `src/memory/MemoryManager.ts`

**Tests**: Unit test verifying automatic tracking on save/get.

### 1.4 Persist BM25 Index

**Problem**: BM25 index rebuilt from scratch on restart.

**Solution**:
- Create `BM25Store` class with SQLite table `bm25_index`:
  - Columns: `term TEXT, doc_id TEXT, tf REAL, idf REAL, updated_at INTEGER`
  - Index: `(term, doc_id)` composite
- On startup: `loadIndex()` from SQLite
- On memory save: `appendToIndex()` incrementally
- On memory delete: `markDirty()`, rebuild on next query or 5-min timer
- Wire into HybridSearchEngine: if BM25Store available, load from it; else build from scratch

**Files**:
- Create: `src/search/BM25Store.ts`
- Modify: `src/search/HybridSearchEngine.ts`

**Tests**: Unit test for persist/load cycle. Integration test verifying index survives restart.

**Risk**: Low. Fallback to in-memory rebuild if SQLite load fails.

---

## Phase 2: Intelligent Extraction

**Goal**: Replace regex-only entity extraction with LLM-powered extraction for high-value memories.
**Estimated**: 3-4 days
**Depends on**: Phase 1 (graph search must work to surface extracted entities)
**Quality gate**: Extraction accuracy > 80% on sample set + fallback to regex works

### 2.1 LLM Entity Extractor

**Solution**:
- Create `LLMEntityExtractor` class
- Uses OpenAI `gpt-4o-mini` with structured output (response_format: json_schema)
- JSON schema output:
  ```json
  {
    "entities": [
      { "name": "AuthService", "type": "CODE_CLASS", "confidence": 0.95, "context": "..." }
    ],
    "relationships": [
      { "source": "AuthService", "target": "TokenExpiry", "type": "CAUSES", "confidence": 0.85, "evidence": "..." }
    ]
  }
  ```
- **Combined extraction**: entities + relationships in one API call (saves cost)
- Falls back to regex `EntityExtractor` + `RelationshipInferencer` on API failure
- **Selective trigger** (configured in PingMemServer):
  - Category in `["decision", "error", "task"]` → LLM extraction
  - Content length > 200 characters → LLM extraction
  - `extractEntities: true` in save options → LLM extraction (explicit opt-in)
  - Otherwise → regex extraction (existing behavior)

**Files**:
- Create: `src/graph/LLMEntityExtractor.ts`
- Modify: `src/mcp/PingMemServer.ts` (selective routing)

**Cost**: ~$0.01-0.03 per extraction call

**Tests**:
- Unit: mock OpenAI, verify JSON schema parsing and entity creation
- Unit: verify fallback to regex on API error
- Integration: save a decision memory, verify LLM-extracted entities appear in graph search

### 2.2 Contradiction Detection

**Solution**:
- Create `ContradictionDetector` class
- On entity save, query existing entities with same name from Neo4j
- If matches found, send both contexts to gpt-4o-mini:
  - "Entity X was previously described as [old context]. New description: [new context]. Do these contradict? If yes, describe the conflict."
- Output: `{ isContradiction: boolean, conflict: string, confidence: number }`
- Add `CONTRADICTS` to `RelationshipType` enum
- Store contradiction as relationship in Neo4j with `conflict` property
- Return warnings in save response (non-blocking)

**Files**:
- Create: `src/graph/ContradictionDetector.ts`
- Modify: `src/types/graph.ts` (add CONTRADICTS)
- Modify: `src/mcp/PingMemServer.ts` (include warnings in response)

**Risk**: False positives. **Mitigation**: Return confidence score; only flag as contradiction when confidence > 0.7.

**Tests**:
- Unit: mock entities with known contradictions, verify detection
- Unit: verify non-contradictory updates pass through
- Integration: save contradicting memories, verify CONTRADICTS relationship in Neo4j

---

## Phase 3: Multi-Model Embedding

**Goal**: Embed memories across multiple specialized dimensions for better retrieval.
**Estimated**: 4-5 days
**Depends on**: Phase 1 (RRF fusion must work), Phase 2 (entity extraction feeds graph embedding context)
**Quality gate**: Multi-model search returns more relevant results than single-model on test queries

### 3.1 Code Embedding Provider

**Solution**:
- Create `CodeEmbeddingProvider` implementing `EmbeddingProvider`
- Primary: **Voyage AI `voyage-code-3`** (1024D, code-optimized)
- Fallback: **Jina Code v2** via API
- Stores in separate Qdrant collection: `ping-mem-code-vectors` (1024D)
- Dual-indexed on ingest: semantic collection (768D) + code collection (1024D)

**Files**:
- Create: `src/search/CodeEmbeddingProvider.ts`
- Modify: `src/search/CodeIndexer.ts` (dual-index)

**API key management**: Uses existing `~/Projects/.creds/` pattern

### 3.2 Causal Embedding Provider

**Solution**:
- Create `CausalEmbeddingProvider` implementing `EmbeddingProvider`
- Uses **same OpenAI embedding model** with prompt-engineered asymmetry:
  - Cause embedding: `embed("cause: " + text)`
  - Effect embedding: `embed("effect: " + text)`
- Stores **two vectors per memory** in `ping-mem-causal-vectors` collection (768D)
  - Metadata: `{ direction: "cause" | "effect", memoryId: string }`
- On causal query "Why did X?": embed query as effect, search cause-side vectors
- On predictive query "What if X?": embed query as cause, search effect-side vectors

**Files**: Create `src/search/CausalEmbeddingProvider.ts`

### 3.3 Search Weight Profiles

**Solution**:
- Extend `SearchMode`: add `"code"` and `"causal"`
- Extend `SearchWeights`: add `code: number` and `causal: number`
- Create `SearchProfiles` with pre-defined weight configurations:

| Profile | Semantic | Keyword | Graph | Code | Causal | Use Case |
|---------|----------|---------|-------|------|--------|----------|
| `general` | 0.35 | 0.25 | 0.15 | 0.15 | 0.10 | Default |
| `code_search` | 0.15 | 0.20 | 0.10 | 0.45 | 0.10 | Code-related queries |
| `decision_recall` | 0.30 | 0.15 | 0.20 | 0.05 | 0.30 | Decision context |
| `error_investigation` | 0.20 | 0.15 | 0.15 | 0.20 | 0.30 | Debugging queries |
| `temporal` | 0.40 | 0.20 | 0.20 | 0.10 | 0.10 | Time-based queries |

- **Auto-detection heuristic** (in `HybridSearchEngine`):
  - Query contains file paths or code patterns → `code_search`
  - Query contains "why", "caused", "because", "root cause" → `error_investigation`
  - Query contains "decided", "decision", "chose" → `decision_recall`
  - Explicit override via `HybridSearchOptions.profile`

**Files**:
- Create: `src/search/SearchProfiles.ts`
- Modify: `src/search/HybridSearchEngine.ts`

### 3.4 Re-Ranking

**Solution**:
- Create `Reranker` class with pluggable providers
- Primary: **Cohere Rerank v3.5** API
- Takes top-20 RRF results, re-ranks, returns top-K
- Optional: disabled by default, enabled via `HybridSearchOptions.rerank: true`
- Fallback: skip re-ranking, return RRF results as-is

**Files**: Create `src/search/Reranker.ts`

**Cost**: ~$0.002 per rerank call

**Tests**:
- Unit: mock each provider, verify embedding dimensions
- Unit: verify weight profiles applied correctly in RRF
- Unit: mock Cohere, verify re-ranking changes order
- Integration: ingest code, verify code_search profile returns better code results

---

## Phase 4: Causal Reasoning

**Goal**: Enable "Why did X happen?" and "What happens if Y?" queries.
**Estimated**: 3-4 days
**Depends on**: Phase 2 (LLM entity extraction), Phase 3 (causal embeddings)
**Quality gate**: Causal queries return meaningful cause-effect chains on test data

### 4.1 Causal Graph Schema

**Solution**:
- Extend Neo4j CAUSES relationship properties:
  - `confidence: FLOAT` (0-1)
  - `direction: STRING` ("forward" | "reverse")
  - `evidence: STRING[]` (supporting text snippets)
  - `discoveredAt: DATETIME`
  - `discoveredBy: STRING` ("llm" | "regex" | "user")
- Create Neo4j index: `CREATE INDEX causal_confidence FOR ()-[r:CAUSES]-() ON (r.confidence)`
- Create `CausalGraphManager` class:
  - `addCausalLink(cause, effect, confidence, evidence, discoveredBy)`
  - `getCausesOf(entityId, depth?, minConfidence?)` — what caused this?
  - `getEffectsOf(entityId, depth?, minConfidence?)` — what did this cause?
  - `getCausalChain(startId, endId)` — shortest cause-effect path
  - `getStrongestCauses(entityId, limit?)` — highest-confidence causes

**Files**:
- Create: `src/graph/CausalGraphManager.ts`
- Modify: `src/types/graph.ts` (extend relationship properties)

### 4.2 LLM Causal Discovery

**Solution**:
- Create `CausalDiscoveryAgent` class
- Triggers on memory save when category is `error` or `decision` (async, non-blocking)
- Flow:
  1. Get entities from the saved memory
  2. Fetch 1-2 hop neighbors from Neo4j
  3. Send to gpt-4o-mini: structured output for causal relationships
  4. Persist new causal links via CausalGraphManager
- Batch mode: `trigger_causal_discovery` processes all unanalyzed memories
- Tracking: mark memories as `causalAnalyzed: true` in metadata

**Files**: Create `src/graph/CausalDiscoveryAgent.ts`

### 4.3 New MCP Tools

| Tool | Input | Output |
|------|-------|--------|
| `search_causes` | `{ query: string, depth?: number }` | Array of cause entities with confidence and evidence |
| `search_effects` | `{ query: string, depth?: number }` | Array of effect entities with confidence and evidence |
| `get_causal_chain` | `{ from: string, to: string }` | Ordered chain of cause-effect relationships |
| `trigger_causal_discovery` | `{ limit?: number }` | Count of new causal links discovered |

**Files**: Modify `src/mcp/PingMemServer.ts`

### 4.4 Directional Search Boost

**Solution**:
- When query auto-detects as `error_investigation` profile:
  - Embed query using CausalEmbeddingProvider as "effect" (searching for causes)
  - Boost CAUSES relationships by 1.2x in graph search
- When query contains predictive language ("what happens when", "what if"):
  - Embed as "cause" (searching for effects)
  - Boost effect-side results by 1.2x

**Files**: Modify `src/search/HybridSearchEngine.ts`

---

## Cross-Cutting Concerns

### Error Handling
- Every new feature falls back gracefully on failure
- LLM extraction → falls back to regex
- Code embedding → falls back to semantic-only
- Re-ranking → falls back to RRF results
- Causal search → falls back to regular search
- No new feature should make an existing feature worse

### Testing Strategy
- Unit tests for every new class (mock external APIs)
- Integration tests for each phase's end-to-end flow
- Regression tests: existing test suite must pass at every phase
- Quality gate: `bun run typecheck && bun test` at phase boundary

### API Key Management
- All new API keys stored in `~/Projects/.creds/`
- Environment variables: `VOYAGE_API_KEY`, `COHERE_API_KEY`
- Existing: `OPENAI_API_KEY`, `GEMINI_API_KEY`

### New Dependencies
- Phase 2: None (uses existing OpenAI SDK)
- Phase 3: `voyageai` SDK (or raw fetch), `cohere-ai` SDK
- Phase 4: None (uses existing Neo4j client + OpenAI SDK)

### Qdrant Collections
- Existing: `ping-mem-vectors` (768D, semantic)
- New Phase 3: `ping-mem-code-vectors` (1024D, code)
- New Phase 3: `ping-mem-causal-vectors` (768D, causal with direction metadata)

### Migration Path
- No breaking changes. All new features are additive.
- Existing memories remain searchable with existing weights.
- New embedding dimensions are populated on next ingest/save.
- Backfill script for existing memories: `scripts/backfill-embeddings.ts`

---

## Risk Register

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| LLM API cost overrun | Medium | Low | Selective extraction + caching + cost monitoring |
| LLM extraction quality | High | Medium | Fallback to regex, confidence thresholds |
| Qdrant multi-collection complexity | Medium | Low | Independent collections, no cross-collection deps |
| Causal false positives | Medium | Medium | Confidence thresholds, non-blocking warnings |
| Circular dependency (HybridSearch ↔ MemoryManager) | High | Medium | MemoryLookup callback interface |
| Phase dependency chain | Medium | Low | Each phase independently deployable, graceful degradation |
| Voyage/Cohere API availability | Low | Low | Fallback providers for each |

---

## Success Metrics

| Metric | Current | Target (Phase 4 complete) |
|--------|---------|---------------------------|
| Graph search active | No (stub) | Yes |
| Embedding models | 1 | 4 |
| Entity extraction accuracy | ~40% (regex) | >80% (LLM) |
| Search modes in RRF | 2 (semantic + keyword) | 5 (+ graph + code + causal) |
| MCP causal tools | 0 | 4 |
| Re-ranking available | No | Yes (optional) |
| Contradiction detection | No | Yes |
| BM25 persistence | No | Yes |

---

## Files Summary

### New Files (13)
| File | Phase |
|------|-------|
| `src/search/types.ts` | 1 |
| `src/search/BM25Store.ts` | 1 |
| `src/graph/LLMEntityExtractor.ts` | 2 |
| `src/graph/ContradictionDetector.ts` | 2 |
| `src/search/CodeEmbeddingProvider.ts` | 3 |
| `src/search/CausalEmbeddingProvider.ts` | 3 |
| `src/search/SearchProfiles.ts` | 3 |
| `src/search/Reranker.ts` | 3 |
| `src/graph/CausalGraphManager.ts` | 4 |
| `src/graph/CausalDiscoveryAgent.ts` | 4 |
| `scripts/backfill-embeddings.ts` | 3 |
| Plus test files for each | All |

### Modified Files (6)
| File | Phases |
|------|--------|
| `src/search/HybridSearchEngine.ts` | 1, 3, 4 |
| `src/memory/MemoryManager.ts` | 1 |
| `src/search/CodeIndexer.ts` | 3 |
| `src/types/graph.ts` | 2, 4 |
| `src/mcp/PingMemServer.ts` | 2, 4 |
| `CLAUDE.md` | All (update capabilities) |
