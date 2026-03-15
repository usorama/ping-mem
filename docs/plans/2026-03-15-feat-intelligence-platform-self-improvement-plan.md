---
title: "feat: Intelligence Platform Self-Improvement"
type: feat
date: 2026-03-15
prerequisite_plan: docs/plans/2026-03-15-feat-self-monitoring-ingestion-pipeline-plan.md
related_plan: understory (AGENTS.md — Epic 1-5, all implemented)
issues: "#28 (BM25 code search), #26 (MCP HTTP streamable transport)"
research: autoresearch/ (LLM-as-judge patterns), docs/research/2026-03-09-deterministic-search/
eval_iteration: 0
review_iteration: 0
verification_iteration: 0
verification_method: "pending"
budget_ceiling: "20x plan cost across ALL models (Claude, Gemini, OpenAI, Codex)"
---

# Intelligence Platform Self-Improvement

## Problem Statement

ping-mem has the infrastructure (SQLite, Neo4j, Qdrant, BM25, FTS5, 62 MCP tools, HTMX dashboard) but lacks the closed-loop intelligence to measure and improve its own search quality, adapt embeddings to real usage, serve multiple AI coding tools concurrently, and learn from agent behavior across projects.

**Five loops are currently open:**

1. **SEARCH QUALITY** — No eval suite. No way to know if Recall@10 is 0.3 or 0.9. DeterministicVectorizer produces cosine similarities of 0.05-0.20 for relevant documents. No measurement, no improvement signal.

2. **MEMORY INTELLIGENCE** — Agents write observations, but ping-mem stores them as flat key-value pairs. No contradiction detection, no compression, no cross-session continuity, no situational awareness.

3. **CROSS-PROJECT** — cc-memory writes per-project memories. cc-connect reads them. But ping-mem does not enrich, correlate, or propagate learnings between projects automatically.

4. **SELF-IMPROVEMENT** — No mechanism to test changes to search quality before deploying them. No blue-green for safe experimentation. No nightly improvement cycle.

5. **CLIENT ADOPTION** — ping-mem serves Claude Code via SSE transport. Codex, Cursor, OpenCode, and Antigravity IDE cannot connect concurrently. StreamableHTTP session isolation is missing.

### Evidence

- `src/search/DeterministicVectorizer.ts` — n-gram hash with no IDF, hash collisions at `abs(sha256[:4]) % 768`
- `src/search/EmbeddingService.ts` — OpenAI text-embedding-3-small at 768 dims. Gemini text-embedding-004 exists as fallback but limited to same 768 dims
- `docker-compose.yml` — Single ping-mem instance on port 3000 (SSE), optional ping-mem-rest on port 3003. No blue-green. `QDRANT_VECTOR_DIMENSIONS=768`
- `src/search/HybridSearchEngine.ts` — BM25Index exists with correct IDF/TF-saturation but only wired to memory search, not code search
- cc-memory SKILL.md — Writes Tier 1/2/3 per-project. No cross-project enrichment loop
- cc-connect SKILL.md — Reads cc-memory data, produces summaries. No write-back to ping-mem

---

## Proposed Solution

Nine workstreams across four waves. Each wave is independently shippable. Waves 2-4 require self-monitoring plan Phase 1 (smart filtering) complete.

```
Wave 1: Measurement Foundation (parallel with self-monitoring Phase 3+)
  WS1: Eval Suite with LLM-as-Judge
  WS9: Observability Dashboard (eval metrics)

Wave 2: Search Quality Upgrade (requires self-monitoring Phase 1)
  WS2: Gemini Embedding 2 Upgrade
  WS3: BM25+FTS5 Integration (Issue #28)
  WS4: Semantic Chunking Overhaul

Wave 3: Platform Architecture
  WS5: Multi-Client Architecture (StreamableHTTP)
  WS6: Self-Improvement Loop (Blue-Green)

Wave 4: Intelligence Layer
  WS7: Agent Memory Intelligence
  WS8: cc-memory/cc-connect Integration
```

---

## Cross-Plan Dependency Map

```
Self-Monitoring Plan          This Plan                    Understory Plan
===================          =========                    ===============
Phase 0: Security Fix
Phase 1: Smart Filtering ──┐
Phase 2: IngestionQueue    │  Wave 1 (parallel start)
Phase 3: Event Wiring     │    WS1: Eval Suite ◄──────── Epic 5: Knowledge
Phase 4: Health Integration│    WS9: Dashboard             (autoresearch patterns)
Phase 5: Staleness         │
                           │  Wave 2 (after Phase 1)
                           ├─► WS2: Gemini Embed 2
                           ├─► WS3: BM25+FTS5
                           ├─► WS4: Semantic Chunking
                           │
                           │  Wave 3
                           ├─► WS5: Multi-Client ◄────── Epic 3: PR-Zero
                           ├─► WS6: Blue-Green             (review swarm needs
                           │                                concurrent MCP access)
                           │  Wave 4
                           ├─► WS7: Agent Intelligence
                           └─► WS8: cc-memory/connect ◄─ Epic 2: LLM Routing
                                                           (model selection for
                                                            enrichment queries)
```

### Task-Level Sequencing (All 3 Plans)

```
WEEK 1-2:
  [self-mon] Phase 0: isProjectDirSafe fix
  [self-mon] Phase 1: Smart Filtering (hashAndValidateFile, ignore dirs, extensions)
  [this]     WS1.1: Define eval schema + 5 query types                    ║ PARALLEL
  [this]     WS1.2: Build LLM-as-judge harness (Opus 1M + Gemini 3.1)    ║ PARALLEL
  [this]     WS9.1: Add /ui/eval route skeleton                           ║ PARALLEL

WEEK 3:
  [self-mon] Phase 2: IngestionQueue + Manifest Fix
  [self-mon] Phase 3: Event Wiring
  [this]     WS1.3: Generate labeled dataset (200 query-result pairs)     ║ after WS1.2
  [this]     WS1.4: Baseline measurement (Recall@10, NDCG@10, MRR@10)    ║ after WS1.3
  [this]     WS9.2: Wire eval metrics to dashboard                        ║ after WS1.4

WEEK 4:
  [self-mon] Phase 4: Health Integration + Retry
  [self-mon] Phase 5: Staleness Detection
  [this]     WS2.1: Gemini Embedding 2 provider                           ║ after Phase 1
  [this]     WS2.2: Qdrant collection migration (768 → 3072)              ║ after WS2.1
  [this]     WS3.1: CodeChunkStore FTS5 table                             ║ PARALLEL w/ WS2

WEEK 5:
  [this]     WS2.3: Fallback chain (Gemini → OpenAI → deterministic)      ║ after WS2.2
  [this]     WS3.2: Wire BM25 to CodeIndexer.search()                     ║ after WS3.1
  [this]     WS4.1: Function-level chunking                                ║ PARALLEL w/ WS3

WEEK 6:
  [this]     WS4.2: Class-level + file-level chunks with overlap           ║ after WS4.1
  [this]     WS4.3: Re-index all projects with new chunking                ║ after WS4.2
  [this]     WS1.5: Post-upgrade eval measurement (target: Recall@10 > 0.7) ║ after WS4.3

WEEK 7:
  [this]     WS5.1: StreamableHTTP transport on port 3003                  ║ start
  [this]     WS5.2: Session isolation (per-client session state)           ║ after WS5.1
  [this]     WS6.1: Blue-Green docker-compose configuration                ║ PARALLEL w/ WS5

WEEK 8:
  [this]     WS5.3: Client capability negotiation                          ║ after WS5.2
  [this]     WS6.2: Nightly improvement script (Claude Code headless)      ║ after WS6.1
  [this]     WS6.3: Eval-gated deployment (keep/discard based on delta)    ║ after WS6.2
  [understory] Epic 3 PR-Zero swarm can now use concurrent MCP access

WEEK 9:
  [this]     WS7.1: Agent identity persistence                             ║ start
  [this]     WS7.2: Cross-session continuity                               ║ after WS7.1
  [this]     WS7.3: Contradiction detection                                ║ after WS7.2

WEEK 10:
  [this]     WS7.4: Memory compression                                     ║ after WS7.3
  [this]     WS7.5: 360-degree situational awareness                       ║ after WS7.4
  [this]     WS8.1: cc-memory write-through to ping-mem enrichment         ║ PARALLEL w/ WS7

WEEK 11:
  [this]     WS8.2: Cross-project learnings propagation                    ║ after WS8.1
  [this]     WS8.3: cc-connect write-back loop                             ║ after WS8.2
  [this]     WS9.3: Full observability dashboard (all 9 workstreams)       ║ after WS8.3

WEEK 12:
  [this]     Final eval measurement (target: Recall@10 > 0.95)
  [this]     All 5 loops verified closed
  [understory] Epic 2 LLM Routing can use ping-mem for model selection context
```

---

## Wave 1: Measurement Foundation

### WS1: Eval Suite with LLM-as-Judge

**Goal**: Build a repeatable, automated evaluation pipeline that measures search quality across 5 query types using LLM judges instead of manual labeling.

#### WS1.1 Eval Schema + Query Types

**New file**: `src/eval/types.ts`

```typescript
export type QueryType =
  | "code_search"        // "find the function that handles BM25 scoring"
  | "decision_recall"    // "why did we switch from OpenAI to Gemini fallback?"
  | "cross_project"      // "what auth patterns exist across all projects?"
  | "causal_chain"       // "what caused the Qdrant drift alerts during ingestion?"
  | "temporal";          // "what changed in the search module last week?"

export interface EvalQuery {
  id: string;
  type: QueryType;
  query: string;
  expectedResultIds: string[];     // ground truth (populated by LLM judges)
  relevanceScores: Map<string, number>; // resultId → 0-3 relevance grade
  metadata: {
    project?: string;
    dateRange?: { from: string; to: string };
    difficulty: "easy" | "medium" | "hard";
  };
}

export interface EvalResult {
  queryId: string;
  retrievedIds: string[];
  scores: {
    recallAt10: number;   // |relevant ∩ retrieved| / |relevant|
    ndcgAt10: number;     // normalized discounted cumulative gain
    mrrAt10: number;      // 1 / rank_of_first_relevant
  };
  latencyMs: number;
  searchMode: string;
}

export interface EvalRun {
  runId: string;
  timestamp: string;
  datasetVersion: string;
  engineConfig: Record<string, unknown>;
  results: EvalResult[];
  aggregate: {
    meanRecallAt10: number;
    meanNdcgAt10: number;
    meanMrrAt10: number;
    meanLatencyMs: number;
    p95LatencyMs: number;
  };
}
```

#### WS1.2 LLM-as-Judge Harness

**New file**: `src/eval/LLMJudge.ts`

Uses two independent LLM judges to rate relevance of search results. Follows autoresearch patterns: structured output, calibrated scoring, disagreement resolution.

```typescript
export interface JudgeConfig {
  primary: {
    provider: "anthropic";
    model: "claude-opus-4-20250514";  // Opus 1M context
    apiKey: string;
  };
  secondary: {
    provider: "google";
    model: "gemini-3.1-pro";         // Gemini 3.1 Pro
    apiKey: string;
  };
  maxBudgetUsd: number;              // 20x plan cost ceiling
}

export interface JudgeVerdict {
  queryId: string;
  resultId: string;
  relevance: 0 | 1 | 2 | 3;  // 0=irrelevant, 1=marginal, 2=relevant, 3=perfect
  reasoning: string;
  judge: "primary" | "secondary";
}

// Relevance grading prompt (sent to both judges):
// "Given this query and this search result, rate relevance 0-3:
//  0 = completely irrelevant
//  1 = marginally relevant (mentions related concepts)
//  2 = relevant (directly addresses query topic)
//  3 = perfectly relevant (exact answer to query)
//  Respond with JSON: { relevance: N, reasoning: '...' }"

export class LLMJudge {
  private costAccumulator = 0;
  private readonly maxBudget: number;

  constructor(private config: JudgeConfig) {
    this.maxBudget = config.maxBudgetUsd;
  }

  async judge(query: string, result: string, resultId: string, queryId: string): Promise<JudgeVerdict[]> {
    if (this.costAccumulator >= this.maxBudget) {
      throw new Error(`Budget ceiling reached: $${this.costAccumulator.toFixed(2)} >= $${this.maxBudget}`);
    }

    // Run both judges in parallel
    const [primary, secondary] = await Promise.all([
      this.callJudge("primary", query, result, resultId, queryId),
      this.callJudge("secondary", query, result, resultId, queryId),
    ]);

    // Disagreement resolution: if |delta| >= 2, use average rounded down
    if (Math.abs(primary.relevance - secondary.relevance) >= 2) {
      const resolved = Math.floor((primary.relevance + secondary.relevance) / 2) as 0 | 1 | 2 | 3;
      primary.relevance = resolved;
      secondary.relevance = resolved;
    }

    return [primary, secondary];
  }

  private async callJudge(
    which: "primary" | "secondary",
    query: string,
    result: string,
    resultId: string,
    queryId: string
  ): Promise<JudgeVerdict> {
    const config = which === "primary" ? this.config.primary : this.config.secondary;
    // Implementation: call config.provider API with structured output prompt
    // Track cost via response usage tokens
    // Return parsed JudgeVerdict
    throw new Error("Implementation in WS1.2");
  }

  getCostSoFar(): number { return this.costAccumulator; }
}
```

**Budget enforcement**: The `maxBudgetUsd` is the 20x plan cost ceiling. This is NOT a Claude Code `--max-cost` flag — it is an application-level budget tracked by `costAccumulator` across all LLM calls (Claude, Gemini, OpenAI). Every API call in the eval pipeline (judge calls, embedding generation, improvement mutations) increments this accumulator. When exceeded, all LLM operations throw.

#### WS1.3 Dataset Generation

**New file**: `src/eval/DatasetGenerator.ts`

Generate 200 query-result pairs (40 per query type) using LLM-as-judge:

```typescript
export class DatasetGenerator {
  constructor(
    private judge: LLMJudge,
    private searchEngine: HybridSearchEngine,
    private codeIndexer: CodeIndexer,
  ) {}

  async generate(): Promise<EvalQuery[]> {
    const queries: EvalQuery[] = [];

    // For each query type, generate 40 queries:
    // 1. Generate natural language queries using Opus 1M
    //    (prompt: "Generate 40 realistic {type} queries a developer would ask
    //     about a TypeScript codebase with MCP tools, SQLite, Neo4j, Qdrant")
    // 2. Execute each query against current search engine
    // 3. Have both judges rate top-20 results (0-3 relevance)
    // 4. Store as labeled dataset in src/eval/datasets/v1.jsonl

    return queries;
  }
}
```

**Output**: `src/eval/datasets/v1.jsonl` — 200 queries, each with up to 20 graded results.

#### WS1.4 Eval Runner + Metrics

**New file**: `src/eval/EvalRunner.ts`

```typescript
export class EvalRunner {
  constructor(
    private searchEngine: HybridSearchEngine,
    private codeIndexer: CodeIndexer,
    private dataset: EvalQuery[],
  ) {}

  async run(config?: Partial<HybridSearchEngineConfig>): Promise<EvalRun> {
    const results: EvalResult[] = [];

    for (const query of this.dataset) {
      const start = performance.now();
      const searchResults = await this.executeSearch(query);
      const latencyMs = performance.now() - start;

      results.push({
        queryId: query.id,
        retrievedIds: searchResults.map(r => r.id),
        scores: {
          recallAt10: this.computeRecall(query, searchResults, 10),
          ndcgAt10: this.computeNDCG(query, searchResults, 10),
          mrrAt10: this.computeMRR(query, searchResults, 10),
        },
        latencyMs,
        searchMode: query.type,
      });
    }

    return {
      runId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      datasetVersion: "v1",
      engineConfig: config ?? {},
      results,
      aggregate: this.computeAggregates(results),
    };
  }

  private computeRecall(query: EvalQuery, results: SearchResult[], k: number): number {
    const relevant = new Set(query.expectedResultIds);
    const retrieved = new Set(results.slice(0, k).map(r => r.id));
    const intersection = [...retrieved].filter(id => relevant.has(id));
    return relevant.size > 0 ? intersection.length / relevant.size : 0;
  }

  private computeNDCG(query: EvalQuery, results: SearchResult[], k: number): number {
    // DCG = sum(rel_i / log2(i+1)) for i in 1..k
    // IDCG = DCG of ideal ranking
    let dcg = 0;
    for (let i = 0; i < Math.min(k, results.length); i++) {
      const rel = query.relevanceScores.get(results[i]!.id) ?? 0;
      dcg += rel / Math.log2(i + 2);
    }
    const idealRels = [...query.relevanceScores.values()].sort((a, b) => b - a).slice(0, k);
    let idcg = 0;
    for (let i = 0; i < idealRels.length; i++) {
      idcg += idealRels[i]! / Math.log2(i + 2);
    }
    return idcg > 0 ? dcg / idcg : 0;
  }

  private computeMRR(query: EvalQuery, results: SearchResult[], k: number): number {
    const relevant = new Set(query.expectedResultIds);
    for (let i = 0; i < Math.min(k, results.length); i++) {
      if (relevant.has(results[i]!.id)) {
        return 1 / (i + 1);
      }
    }
    return 0;
  }
}
```

**CLI command**: `bun run eval` — runs eval suite, outputs JSON report, stores in SQLite for trend tracking.

#### WS1.5 Eval Storage

**New file**: `src/eval/EvalStore.ts`

```typescript
// SQLite table in ping-mem.db:
// CREATE TABLE IF NOT EXISTS eval_runs (
//   run_id TEXT PRIMARY KEY,
//   timestamp TEXT NOT NULL,
//   dataset_version TEXT NOT NULL,
//   engine_config TEXT NOT NULL,  -- JSON
//   aggregate_recall REAL NOT NULL,
//   aggregate_ndcg REAL NOT NULL,
//   aggregate_mrr REAL NOT NULL,
//   mean_latency_ms REAL NOT NULL,
//   p95_latency_ms REAL NOT NULL,
//   result_count INTEGER NOT NULL,
//   results_json TEXT NOT NULL,   -- full EvalResult[] JSON
//   improvement_run_id TEXT,      -- links to blue-green improvement (WS6)
//   created_at TEXT NOT NULL DEFAULT (datetime('now'))
// );
```

#### Phase 1 Quality Gate

- [ ] `bun run typecheck` — 0 errors
- [ ] `bun test` — all pass
- [ ] New tests: EvalRunner computes correct Recall/NDCG/MRR on synthetic data, LLMJudge budget enforcement, DatasetGenerator produces valid JSONL
- [ ] Baseline eval run produces non-zero metrics
- [ ] Eval results visible at `/ui/eval`

---

### WS9: Observability Dashboard (Eval Metrics)

**Goal**: Extend the existing HTMX UI at `/ui` with eval metrics, improvement history, and search quality trends.

#### WS9.1 Eval Dashboard Route

**File**: `src/http/ui/` — add new partial

```typescript
// GET /ui/eval — HTMX partial
// Shows:
// - Latest eval run aggregate scores (Recall@10, NDCG@10, MRR@10)
// - Score trend chart (last 20 runs) — rendered as ASCII sparkline or SVG
// - Per-query-type breakdown table
// - Cost accumulator status vs budget ceiling
```

#### WS9.2 Wire Eval Metrics

After WS1.4 produces baseline measurements, wire `EvalStore` data to the dashboard:

```typescript
// GET /api/v1/eval/latest — JSON
// GET /api/v1/eval/history?limit=20 — JSON array
// GET /api/v1/eval/run/:runId — JSON (full detail)
```

#### WS9.3 Full Dashboard (after Wave 4)

Add panels for:
- Improvement history (WS6 blue-green runs, keep/discard decisions)
- Trust-verify rates (LLM judge agreement percentage)
- Search quality trends per query type
- Agent memory intelligence stats (WS7 contradiction count, compression ratio)
- Cross-project learnings propagation status (WS8)

---

## Wave 2: Search Quality Upgrade

**Prerequisite**: Self-monitoring plan Phase 1 (smart filtering) complete. Clean data in Qdrant is required before upgrading embeddings — no point embedding garbage.

### WS2: Gemini Embedding 2 Upgrade

**Goal**: Replace the current text-embedding-3-small (768 dims) / text-embedding-004 (768 dims) with gemini-embedding-2 (3072 dims, 8K context window). Maintain fallback chain.

#### WS2.1 Gemini Embedding 2 Provider

**File**: `src/search/EmbeddingService.ts`

Update `GeminiEmbeddingProvider`:

```typescript
// Current: model = "text-embedding-004", dimensions = 768
// New:     model = "gemini-embedding-2", dimensions = 3072, context = 8192 tokens

// The existing GeminiEmbeddingProvider REST API call at line 369 already supports
// outputDimensionality. Change defaults:
//   model: "gemini-embedding-2"
//   dimensions: 3072

// The REST endpoint remains the same:
// POST https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent
```

Update `createEmbeddingServiceFromEnv()` to use new defaults:

```typescript
// EMBEDDING_DIMENSIONS env var default: 3072 (was 768)
// EMBEDDING_MODEL env var default: "gemini-embedding-2" (was "text-embedding-3-small")
```

#### WS2.2 Qdrant Collection Migration

**New file**: `scripts/migrate-qdrant-collection.ts`

Cannot change dimensions on an existing Qdrant collection. Must create new, re-index, swap.

```typescript
// 1. Create new collection: ping-mem-vectors-v2 (3072 dims, cosine distance)
// 2. Re-index all projects using new embedding provider
//    (uses IngestionQueue from self-monitoring plan — serial, trackable)
// 3. Verify point count matches: v1 count == v2 count (within 5% tolerance)
// 4. Rename: ping-mem-vectors → ping-mem-vectors-v1-archived
//            ping-mem-vectors-v2 → ping-mem-vectors
// 5. Update QDRANT_COLLECTION_NAME and QDRANT_VECTOR_DIMENSIONS in docker-compose.yml

// Rollback: rename collections back. v1-archived data preserved.
```

**File**: `docker-compose.yml` — update env vars:

```yaml
- QDRANT_VECTOR_DIMENSIONS=3072  # was 768
```

#### WS2.3 Fallback Chain

**File**: `src/search/EmbeddingService.ts`

Update `createEmbeddingServiceFromEnv()` to build a 3-tier fallback:

```typescript
// Tier 1: Gemini gemini-embedding-2 (3072 dims)
// Tier 2: OpenAI text-embedding-3-small (3072 dims — supports up to 3072)
// Tier 3: DeterministicVectorizer (3072 dims — update constructor default)

// FallbackEmbeddingProvider already enforces dimension match (line 436).
// Chain: new FallbackEmbeddingProvider(
//   new FallbackEmbeddingProvider(gemini, openai),
//   deterministicProvider
// )
```

**File**: `src/search/DeterministicVectorizer.ts` — update default dimensions:

```typescript
// this.dimensions = options.dimensions ?? 3072;  // was 768
```

**Note**: The DeterministicVectorizer needs to implement the `EmbeddingProvider` interface (add `embed(text: string): Promise<Float32Array>` wrapper that calls `vectorize()` and converts `number[]` to `Float32Array`).

#### Phase 2.2 Quality Gate

- [ ] `bun run typecheck` — 0 errors
- [ ] `bun test` — all pass
- [ ] New tests: Gemini embedding 2 returns 3072-dim vectors, fallback chain degrades gracefully, DeterministicVectorizer at 3072 dims
- [ ] Re-run eval suite: expect Recall@10 improvement from embedding upgrade alone
- [ ] Qdrant collection has 3072-dim vectors after migration

---

### WS3: BM25+FTS5 Integration (Issue #28)

**Goal**: Replace DeterministicVectorizer as primary keyword search for code with BM25 via SQLite FTS5. The BM25Index in HybridSearchEngine (memory search) already works correctly — this wires it to code search.

#### WS3.1 CodeChunkStore FTS5 Table

**New file**: `src/search/CodeChunkStore.ts`

```typescript
// SQLite FTS5 table for code chunks (separate from memory BM25):
//
// CREATE VIRTUAL TABLE IF NOT EXISTS code_fts USING fts5(
//   content,
//   file_path,
//   project_id UNINDEXED,
//   chunk_id UNINDEXED,
//   tokenize = 'porter unicode61'
// );
//
// CREATE TABLE IF NOT EXISTS code_chunks (
//   chunk_id TEXT PRIMARY KEY,
//   project_id TEXT NOT NULL,
//   file_path TEXT NOT NULL,
//   content TEXT NOT NULL,
//   start_line INTEGER NOT NULL,
//   end_line INTEGER NOT NULL,
//   chunk_type TEXT NOT NULL,  -- 'function' | 'class' | 'file' | 'block'
//   language TEXT,
//   indexed_at TEXT NOT NULL
// );

export class CodeChunkStore {
  constructor(private db: Database) { /* create tables */ }

  addChunk(chunk: CodeChunk): void {
    // INSERT into code_chunks + code_fts
  }

  search(query: string, projectId?: string, limit = 10): CodeChunkSearchResult[] {
    // SELECT chunk_id, file_path, content, start_line, end_line,
    //   (-1.0 * bm25(code_fts, 1.0, 2.0)) AS score
    // FROM code_fts JOIN code_chunks ON code_fts.rowid = code_chunks.rowid
    // WHERE code_fts MATCH ?
    // ORDER BY score DESC LIMIT ?
  }
}
```

#### WS3.2 Wire to CodeIndexer.search()

**File**: `src/search/CodeIndexer.ts`

```typescript
// Current: CodeIndexer.search() → Qdrant only (DeterministicVectorizer embeddings)
// New:     CodeIndexer.search() → RRF merge of:
//   [PRIMARY]   CodeChunkStore.search() → FTS5 BM25 (deterministic, no API cost)
//   [SECONDARY] Qdrant vector search (Gemini embedding 2, semantic)
//
// RRF (Reciprocal Rank Fusion):
//   score(d) = 1/(k+rank_bm25(d)) + 1/(k+rank_qdrant(d)), k=60
//
// This matches the architecture from the deterministic-search-quality plan.
```

#### Phase 2.3 Quality Gate

- [ ] `bun run typecheck` — 0 errors
- [ ] `bun test` — all pass
- [ ] New tests: CodeChunkStore FTS5 returns ranked results, RRF merge produces correct ordering
- [ ] Re-run eval suite: code_search queries should show significant Recall@10 improvement
- [ ] BM25 scores for relevant code results: 0.35-0.70 (was 0.05-0.20 with DeterministicVectorizer)

---

### WS4: Semantic Chunking Overhaul

**Goal**: Replace single-line fragments with hierarchical, overlapping chunks: function-level, class-level, and file-level. Better chunks produce better embeddings and better BM25 matches.

#### WS4.1 Function-Level Chunking

**File**: `src/ingest/CodeChunker.ts`

```typescript
// Current: CodeChunker produces line-range chunks based on simple heuristics
// New: 3-level hierarchical chunks:
//
// Level 1: Function/method bodies (most specific)
//   - Extracted via existing SymbolExtractor (already finds function boundaries)
//   - Include function signature + docstring + body
//   - Overlap: 2 lines before/after for context
//
// Level 2: Class bodies (medium specificity)
//   - Entire class including all methods
//   - Only for classes > 10 lines
//   - Overlap: class header from parent scope
//
// Level 3: File-level (broadest context)
//   - Entire file content (up to 8K tokens for Gemini embedding 2 context window)
//   - For files > 8K tokens: split at class/function boundaries
//   - Include file path in chunk text for BM25 path matching

export interface SemanticChunk {
  chunkId: string;
  projectId: string;
  filePath: string;
  content: string;
  startLine: number;
  endLine: number;
  chunkType: "function" | "class" | "file" | "block";
  language: string;
  parentChunkId?: string;  // class chunk for method chunks
  overlapLines: number;
}
```

#### WS4.2 Class-Level + File-Level Chunks

Extend WS4.1 to produce all 3 levels per file. Store chunk hierarchy via `parentChunkId` for retrieval-time context expansion (if a function matches, also return its parent class context).

#### WS4.3 Re-Index All Projects

Use `IngestionQueue` (from self-monitoring plan) to re-index all registered projects with the new chunking strategy. Track via `/api/v1/ingestion/queue` endpoints.

```typescript
// For each registered project:
// 1. Delete existing chunks from code_fts + code_chunks
// 2. Delete existing vectors from Qdrant for this project
// 3. Re-ingest with new chunker + new embeddings
// 4. Verify chunk counts are reasonable (functions + classes + files)
```

#### Phase 2.4 Quality Gate

- [ ] `bun run typecheck` — 0 errors
- [ ] `bun test` — all pass
- [ ] New tests: SemanticChunker produces function/class/file chunks, overlap correct, parentChunkId links valid
- [ ] Re-run eval suite: all 5 query types should improve
- [ ] Target after Wave 2: Recall@10 > 0.7 (baseline was ~0.3-0.4 with DeterministicVectorizer)

---

## Wave 3: Platform Architecture

### WS5: Multi-Client Architecture

**Goal**: Enable concurrent connections from Claude Code, Codex, Cursor, OpenCode, and Antigravity IDE via StreamableHTTP transport with session isolation.

#### WS5.1 StreamableHTTP Transport

**File**: `src/http/rest-server.ts`

This is partially addressed by Issue #26 (deterministic-search-quality plan). Add MCP endpoint to existing Hono server:

```typescript
// Mount MCP at /mcp on the REST server (port 3003):
//
// import { WebStandardStreamableHTTPTransport } from "@anthropic-ai/mcp-sdk/server/streamablehttp.js";
//
// app.all("/mcp", async (c) => {
//   const transport = new WebStandardStreamableHTTPTransport({
//     sessionIdGenerator: () => crypto.randomUUID(),
//   });
//   await mcpServer.connect(transport);
//   return transport.handleRequest(c.req.raw);
// });
//
// This enables ANY MCP client to connect via HTTP POST to http://localhost:3003/mcp
// without spawning a subprocess. Each request gets a session ID for isolation.
```

#### WS5.2 Session Isolation

**New file**: `src/mcp/SessionIsolation.ts`

```typescript
// Per-client session state:
// - Each StreamableHTTP session gets a unique sessionId
// - Session state includes: active project, search context, memory cursor
// - Sessions are isolated: Client A's context_save doesn't appear in Client B's search
//   unless explicitly cross-session (context_search without sessionId filter)
// - Session TTL: 1 hour inactivity → cleanup
// - Max concurrent sessions: 20 (configurable via PING_MEM_MAX_SESSIONS)

export interface ClientSession {
  sessionId: string;
  clientName: string;      // "claude-code" | "codex" | "cursor" | "opencode" | "antigravity"
  projectDir?: string;
  createdAt: string;
  lastActivityAt: string;
  memoryIds: Set<string>;  // memories created in this session
}

export class SessionRegistry {
  private sessions = new Map<string, ClientSession>();
  private readonly maxSessions: number;
  private readonly ttlMs: number;

  constructor(maxSessions = 20, ttlMs = 3600000) {
    this.maxSessions = maxSessions;
    this.ttlMs = ttlMs;
  }

  register(sessionId: string, clientName: string): ClientSession { /* ... */ }
  get(sessionId: string): ClientSession | undefined { /* ... */ }
  cleanup(): number { /* remove expired, return count */ }
}
```

#### WS5.3 Client Capability Negotiation

Different AI coding tools have different MCP capabilities:

```typescript
// Client capability matrix:
// | Client       | Transport    | Supports SSE? | Supports StreamableHTTP? |
// |-------------|-------------|---------------|--------------------------|
// | Claude Code  | stdio/SSE   | Yes           | Yes (MCP SDK 1.25+)      |
// | Codex        | HTTP        | No            | Yes                      |
// | Cursor       | stdio       | Yes           | Planned                  |
// | OpenCode     | stdio       | Yes           | Yes                      |
// | Antigravity  | HTTP        | No            | Yes                      |
//
// ping-mem exposes BOTH transports:
// - Port 3000: SSE (existing, for Claude Code stdio relay)
// - Port 3003: REST + StreamableHTTP at /mcp (for HTTP-native clients)
// - stdio: existing PingMemServer via bun run src/mcp/cli.ts (for stdio-native clients)
```

#### Phase 3.5 Quality Gate

- [ ] `bun run typecheck` — 0 errors
- [ ] `bun test` — all pass
- [ ] New tests: StreamableHTTP accepts POST to /mcp, session isolation verified, concurrent sessions don't leak state
- [ ] Manual test: Connect Claude Code AND Codex simultaneously, verify independent sessions

---

### WS6: Self-Improvement Loop (Blue-Green)

**Goal**: Blue instance serves production traffic. Green instance runs nightly improvement experiments. ONE improvement per night. Keep/discard based on eval delta.

#### WS6.1 Blue-Green Docker Compose

**File**: `docker-compose.blue-green.yml`

```yaml
services:
  # Blue: production — NEVER modified during improvement runs
  ping-mem-blue:
    build: .
    container_name: ping-mem-blue
    ports:
      - "3000:3000"
    environment:
      - PING_MEM_INSTANCE=blue
      - PING_MEM_PORT=3000
    volumes:
      - ping-mem-blue-data:/data
      - /Users/umasankr/Projects:/projects:ro  # READ-ONLY for Blue
    # ... same as existing ping-mem config
    restart: unless-stopped

  # Green: improvement experiments — isolated data volume
  ping-mem-green:
    build: .
    container_name: ping-mem-green
    ports:
      - "3001:3000"
    environment:
      - PING_MEM_INSTANCE=green
      - PING_MEM_PORT=3000
      - PING_MEM_IMPROVEMENT_MODE=true
    volumes:
      - ping-mem-green-data:/data
      - /Users/umasankr/Projects:/projects:ro
    profiles:
      - improvement  # Only started during nightly runs

volumes:
  ping-mem-blue-data:
  ping-mem-green-data:
```

**Critical constraint**: Blue instance volumes are NEVER mounted by Green. Blue's data directory is never modified during improvement runs. Green gets its own copy.

#### WS6.2 Nightly Improvement Script

**New file**: `scripts/nightly-improve.ts`

```typescript
// Nightly improvement loop:
// 1. Copy Blue data to Green volume (docker volume snapshot)
// 2. Start Green instance (docker compose --profile improvement up -d)
// 3. Run baseline eval on Green (WS1 eval suite)
// 4. Spawn ONE Claude Code headless session:
//    `claude --headless --model claude-sonnet-4-20250514 \
//      --max-turns 20 \
//      -p "Improve ping-mem search quality. Current Recall@10: ${baseline}.
//          Target: > 0.95. You may modify search weights, BM25 parameters,
//          embedding preprocessing, or chunking strategy. Do NOT modify
//          the eval suite. Budget: $${remainingBudget}"`
// 5. Run post-improvement eval on Green
// 6. Compare: if aggregate Recall@10 improved by >= 0.02 AND no metric regressed:
//    a. KEEP: commit changes, tag as improvement-YYYY-MM-DD
//    b. Record in decisions.jsonl: { type: "nightly_improvement", ... }
//    c. Schedule Blue deployment (manual approval gate)
// 7. If eval regressed or no improvement:
//    a. DISCARD: reset Green, log discarded attempt
// 8. Stop Green instance
// 9. Update dashboard with improvement history

// Budget tracking:
// - 20x plan cost ceiling is CUMULATIVE across ALL nightly runs
// - costAccumulator persists in SQLite eval_runs table
// - If budget exhausted, skip nightly run and alert
```

**Scheduling**: launchd plist for nightly runs at 2 AM:

```xml
<!-- ~/Library/LaunchAgents/com.ping-mem.nightly-improve.plist -->
<!-- ProgramArguments: bun run /Users/umasankr/Projects/ping-mem/scripts/nightly-improve.ts -->
<!-- StartCalendarInterval: Hour=2, Minute=0 -->
```

#### WS6.3 Eval-Gated Deployment

```typescript
// Deployment gate:
// 1. Green eval results stored in eval_runs table with improvement_run_id
// 2. Comparison query: SELECT blue.aggregate_recall, green.aggregate_recall
//    FROM eval_runs blue, eval_runs green WHERE ...
// 3. Keep criteria:
//    - aggregate_recall improved by >= 0.02
//    - No individual query type regressed by > 0.05
//    - aggregate_latency_ms did not increase by > 20%
//    - No new test failures (bun test passes on Green)
// 4. If kept: git diff between Blue and Green committed to improvement branch
// 5. Manual approval: PR from improvement branch to main
```

#### Phase 3.6 Quality Gate

- [ ] `bun run typecheck` — 0 errors
- [ ] `bun test` — all pass
- [ ] New tests: blue-green isolation (Green cannot read Blue data), eval comparison logic, keep/discard decision
- [ ] Manual test: Run nightly-improve.ts, verify Blue is untouched
- [ ] Budget ceiling enforced across improvement runs

---

## Wave 4: Intelligence Layer

### WS7: Agent Memory Intelligence

**Goal**: Transform ping-mem from passive storage to active intelligence. Agents should benefit from persistent identity, cross-session continuity, contradiction detection, memory compression, and situational awareness.

#### WS7.1 Agent Identity Persistence

**File**: `src/memory/AgentIdentity.ts`

```typescript
// Build on existing multi-agent system (src/agents/):
// - Agent registration already exists with quotas and TTL
// - Add: persistent identity across sessions
//
// Schema extension to agents table:
// ALTER TABLE agents ADD COLUMN identity_hash TEXT;
// ALTER TABLE agents ADD COLUMN first_seen TEXT;
// ALTER TABLE agents ADD COLUMN session_count INTEGER DEFAULT 0;
// ALTER TABLE agents ADD COLUMN personality_vector TEXT;  -- JSON array, derived from behavior
//
// When an agent connects with same name + project, recognize it:
// - Increment session_count
// - Load prior context from last session
// - Apply personality_vector to search weights (agents that do code review
//   get boosted code_search weights, agents that do planning get boosted
//   decision_recall weights)
```

#### WS7.2 Cross-Session Continuity

**File**: `src/memory/SessionContinuity.ts`

```typescript
// When a new session starts for a known agent:
// 1. Load last 5 sessions' checkpoints
// 2. Summarize via LLM: "What was this agent working on? Key decisions? Blockers?"
// 3. Inject summary as session context (context_save with key="session-continuity")
// 4. Agent sees: "Last session (2h ago): implemented BM25 integration, blocked on
//    Qdrant migration. Decision: chose FTS5 over Tantivy for zero-dep constraint."
//
// Cost: 1 LLM call per session start (~$0.01 with Gemini 3.1 Pro)
// Budget: counted toward 20x ceiling
```

#### WS7.3 Contradiction Detection

**File**: `src/memory/ContradictionDetector.ts`

```typescript
// When context_save is called:
// 1. Search existing memories for semantically similar content (hybrid search)
// 2. If similarity > 0.85 AND content differs substantively:
//    a. Flag as potential contradiction
//    b. Store both versions with contradiction link
//    c. On next context_get, return: "Note: conflicting information found.
//       Version A (2026-03-14): 'BM25 k1=1.5 is optimal'
//       Version B (2026-03-15): 'BM25 k1=2.0 performs better'
//       Most recent wins unless user specifies."
// 3. Contradiction count tracked per project for dashboard (WS9)

export interface Contradiction {
  id: string;
  memoryIdA: string;
  memoryIdB: string;
  similarity: number;
  detectedAt: string;
  resolved: boolean;
  resolution?: "a_wins" | "b_wins" | "merged" | "user_resolved";
}
```

#### WS7.4 Memory Compression

**File**: `src/memory/MemoryCompressor.ts`

```typescript
// When a session's memory count exceeds threshold (default: 200):
// 1. Group memories by tag/category
// 2. For each group > 20 entries:
//    a. LLM summarize: condense 20 entries into 3-5 key facts
//    b. Archive originals (status: "compressed")
//    c. Replace with summary entries (tag: "compressed-summary")
// 3. Maintain full audit trail: compressed entries link to originals
//
// Compression ratio target: 4:1 (200 entries → ~50)
// Budget: counted toward 20x ceiling

export interface CompressionRun {
  runId: string;
  sessionId: string;
  inputCount: number;
  outputCount: number;
  compressionRatio: number;
  costUsd: number;
  timestamp: string;
}
```

#### WS7.5 360-Degree Situational Awareness

**File**: `src/memory/SituationalAwareness.ts`

```typescript
// On every context_search or codebase_search:
// Enrich results with situational context:
//
// 1. Temporal context: "This code was modified 2 days ago by agent-builder-1"
// 2. Causal context: "This function was changed because of Issue #28 (BM25 migration)"
// 3. Social context: "3 agents have queried this file in the last hour"
// 4. Quality context: "This file has 2 open contradictions in memory"
// 5. Staleness context: "This file changed since last ingestion" (from self-monitoring staleness checker)
//
// Implementation: post-processing step in HybridSearchEngine.search()
// that annotates results with additional context from Neo4j graph + event store.

export interface SituationalContext {
  temporalNote?: string;
  causalNote?: string;
  socialNote?: string;
  qualityNote?: string;
  stalenessNote?: string;
}
```

#### Phase 4.7 Quality Gate

- [ ] `bun run typecheck` — 0 errors
- [ ] `bun test` — all pass
- [ ] New tests: agent identity persists across sessions, contradictions detected, compression reduces memory count, situational context enriches search results
- [ ] Integration test: Agent A writes conflicting info, Agent B searches and sees contradiction warning

---

### WS8: cc-memory/cc-connect Integration

**Goal**: Close the cross-project intelligence loop. cc-memory writes per-project data, ping-mem enriches it, cc-connect synthesizes across projects, and learnings propagate back.

#### WS8.1 cc-memory Write-Through Enrichment

When cc-memory calls `context_save` or `knowledge_ingest`:

```typescript
// In MCP handler for context_save:
// 1. Save memory (existing behavior)
// 2. NEW: Extract entities from content (NER via LLM or regex)
// 3. NEW: Create Neo4j nodes for entities + relationships
// 4. NEW: Cross-reference with other projects' memories
//    - "Auth decision in sn-assist" links to "Auth pattern in ping-learn"
// 5. NEW: If cross-project pattern detected, create knowledge entry:
//    knowledge_ingest({
//      key: "cross-project-pattern-auth-<hash>",
//      content: "Auth pattern found in 3 projects: ...",
//      tags: ["cross-project", "auth", "pattern"]
//    })
```

**File**: `src/mcp/handlers/ContextToolModule.ts` — add post-save enrichment hook.

#### WS8.2 Cross-Project Learnings Propagation

**New file**: `src/intelligence/LearningsPropagator.ts`

```typescript
// When a learning is recorded in project A:
// 1. Check if learning applies to other registered projects
//    (semantic search across all project memories)
// 2. If relevance > 0.8 for project B:
//    a. Create a "propagated-learning" entry in project B's memory
//    b. Tag with source project: "propagated-from-sn-assist"
//    c. On next session in project B, agent sees:
//       "Learning from sn-assist: ServiceNow auth tokens expire after 30min,
//        implement refresh flow. Relevance to this project: 0.87"
//
// Propagation is read-only for target project — agent decides whether to act.

export interface PropagatedLearning {
  sourceProject: string;
  targetProject: string;
  learning: string;
  relevanceScore: number;
  propagatedAt: string;
  actedUpon: boolean;
}
```

#### WS8.3 cc-connect Write-Back Loop

Currently cc-connect only READS from cc-memory and writes summaries to `~/.claude/cc-connect/state.json`. Close the loop:

```typescript
// After cc-connect synthesizes cross-project signals:
// 1. Write synthesis results back to ping-mem:
//    context_save({
//      key: "cc-connect-synthesis-<timestamp>",
//      value: JSON.stringify(synthesis),
//      tags: ["cc-connect", "cross-project", "synthesis"]
//    })
// 2. Detected patterns become searchable via ping-mem hybrid search
// 3. Next cc-connect run can query previous syntheses for trend detection
//
// This closes Loop 3: cc-memory writes → ping-mem indexes → cc-connect
// synthesizes → writes back to ping-mem → next agent query finds it
```

**File**: Update `~/.claude/skills/cc-connect/SKILL.md` Phase 4 to add ping-mem write-back.

#### Phase 4.8 Quality Gate

- [ ] `bun run typecheck` — 0 errors
- [ ] `bun test` — all pass
- [ ] New tests: entity extraction from context_save, cross-project pattern detection, learning propagation, cc-connect write-back
- [ ] Integration test: Save learning in project A, verify it appears in project B's search results
- [ ] cc-connect synthesis stored in ping-mem and queryable

---

## Five Loops — Closure Criteria

| Loop | Description | Closure Metric | Target |
|------|-------------|----------------|--------|
| 1. SEARCH QUALITY | measure → improve → measure | Recall@10 | > 0.95 |
| 2. MEMORY INTELLIGENCE | agents write → ping-mem enriches → agents query better | Contradiction detection rate | > 90% of conflicts flagged |
| 3. CROSS-PROJECT | cc-memory writes → ping-mem indexes → cc-connect synthesizes | Propagated learnings acted upon | > 50% |
| 4. SELF-IMPROVEMENT | eval → mutate → eval → keep/discard | Nightly improvement keep rate | > 30% of runs produce gains |
| 5. CLIENT ADOPTION | better quality → more tools integrate → more data | Active concurrent clients | >= 3 different tools |

### Loop 1: Search Quality (Closes at Recall@10 > 0.95)

```
Baseline (DeterministicVectorizer):  Recall@10 ~0.3
After Gemini Embed 2 (WS2):         Recall@10 ~0.5  (better embeddings)
After BM25+FTS5 (WS3):              Recall@10 ~0.65 (hybrid retrieval)
After Semantic Chunking (WS4):      Recall@10 ~0.75 (better chunks)
After Nightly Improvements (WS6):   Recall@10 ~0.85 (weight tuning)
After Agent Intelligence (WS7):     Recall@10 ~0.90 (context enrichment)
Convergence (multiple cycles):      Recall@10 > 0.95 (loop closed)
```

### Loop 2: Memory Intelligence

```
Agents write observations → ping-mem stores (existing)
  + contradiction detection (WS7.3) → agents see conflicts
  + memory compression (WS7.4) → agents get concise context
  + situational awareness (WS7.5) → agents make better decisions
  → agents write better observations (loop continues)
```

### Loop 3: Cross-Project

```
cc-memory writes per-project (existing)
  → ping-mem indexes + enriches (WS8.1)
  → cc-connect synthesizes across projects (existing)
  → cc-connect writes back to ping-mem (WS8.3)
  → next agent query finds cross-project patterns
  → agent acts on propagated learnings (WS8.2)
```

### Loop 4: Self-Improvement

```
Nightly:
  1. Eval suite measures current quality (WS1)
  2. Claude Code headless proposes ONE mutation (WS6.2)
  3. Eval suite measures again
  4. Keep (delta >= +0.02) or discard
  5. If kept → deploy to Blue after manual approval
  6. Repeat tomorrow with new baseline
```

### Loop 5: Client Adoption

```
Better search quality (Loops 1-4)
  → More AI tools integrate via StreamableHTTP (WS5)
  → More diverse queries from more tools
  → More data for eval suite refinement
  → Better search quality (loop continues)
```

---

## Complete File Structure (New/Modified)

```
src/eval/
  types.ts                    — NEW (EvalQuery, EvalResult, EvalRun types)
  LLMJudge.ts                 — NEW (Opus 1M + Gemini 3.1 dual-judge)
  DatasetGenerator.ts         — NEW (200 query-result pair generation)
  EvalRunner.ts               — NEW (Recall@10, NDCG@10, MRR@10 computation)
  EvalStore.ts                — NEW (SQLite persistence for eval runs)
  datasets/
    v1.jsonl                  — NEW (generated labeled dataset)

src/search/
  EmbeddingService.ts         — MODIFIED (Gemini embedding 2 default, 3072 dims)
  DeterministicVectorizer.ts  — MODIFIED (3072 dims default, EmbeddingProvider interface)
  CodeChunkStore.ts           — NEW (FTS5 BM25 for code search)
  CodeIndexer.ts              — MODIFIED (RRF merge of BM25 + Qdrant)
  HybridSearchEngine.ts       — MODIFIED (situational awareness post-processing)

src/ingest/
  CodeChunker.ts              — MODIFIED (3-level hierarchical chunking)

src/mcp/
  SessionIsolation.ts         — NEW (per-client session state)
  handlers/
    ContextToolModule.ts      — MODIFIED (post-save enrichment hook)

src/memory/
  AgentIdentity.ts            — NEW (persistent identity, personality vector)
  SessionContinuity.ts        — NEW (cross-session context loading)
  ContradictionDetector.ts    — NEW (semantic similarity conflict detection)
  MemoryCompressor.ts         — NEW (LLM-based memory compression)
  SituationalAwareness.ts     — NEW (360-degree context enrichment)

src/intelligence/
  LearningsPropagator.ts      — NEW (cross-project learning propagation)

src/http/
  rest-server.ts              — MODIFIED (StreamableHTTP at /mcp, eval endpoints)
  ui/
    eval.ts                   — NEW (eval dashboard HTMX partial)

scripts/
  migrate-qdrant-collection.ts — NEW (768 → 3072 dim migration)
  nightly-improve.ts           — NEW (blue-green improvement loop)

docker-compose.blue-green.yml — NEW (Blue port 3000, Green port 3001)
docker-compose.yml             — MODIFIED (QDRANT_VECTOR_DIMENSIONS=3072)
```

---

## Risk Analysis

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Gemini embedding 2 API instability | Search degradation | Medium | 3-tier fallback chain (Gemini → OpenAI → deterministic) |
| Qdrant 768→3072 migration data loss | Total search failure | Low | Keep v1 collection as archived backup; verify point counts match |
| LLM judge costs exceed 20x ceiling | Budget exhaustion | Medium | Hard budget enforcement in LLMJudge; accumulator persists in SQLite |
| Blue-Green data volume corruption | Production data loss | Low | Blue volumes are read-only during Green runs; snapshot before copy |
| Nightly improvement degrades quality | Search regression | Medium | Eval-gated deployment; no improvement without +0.02 Recall@10 |
| Contradiction detection false positives | Alert fatigue | Medium | Require similarity > 0.85 AND semantic diff; tune threshold |
| Cross-project learning propagation noise | Irrelevant suggestions | Medium | Require relevance > 0.8; agents can dismiss propagated learnings |
| StreamableHTTP session leak | Memory exhaustion | Low | 1h TTL, max 20 sessions, periodic cleanup |
| Re-indexing with new chunks takes too long | Extended downtime | Medium | Use IngestionQueue (serial); Blue serves during re-index |

---

## Acceptance Criteria

### Functional

- Eval suite runs end-to-end and produces Recall@10, NDCG@10, MRR@10 for all 5 query types
- LLM judges (Opus 1M + Gemini 3.1) rate results 0-3 with agreement > 70%
- Gemini embedding 2 produces 3072-dim vectors; fallback chain activates on API failure
- BM25+FTS5 code search returns ranked results with scores 0.35-0.70
- Semantic chunks at 3 levels (function, class, file) with parent linkage
- StreamableHTTP at /mcp accepts concurrent connections from different AI tools
- Blue-Green isolation: Blue data is never modified during Green improvement runs
- Nightly improvement produces at least one accepted improvement within 10 runs
- Contradiction detection flags conflicting memories with > 90% precision
- Cross-project learnings appear in target project search results

### Non-Functional

- Recall@10 > 0.95 by Loop 1 closure (baseline: ~0.3)
- Eval suite runs in < 5 minutes (200 queries)
- Embedding generation: < 500ms per chunk via Gemini embedding 2
- StreamableHTTP session creation: < 100ms
- Memory compression achieves 4:1 ratio
- Nightly improvement run completes in < 30 minutes
- Total model costs stay under 20x plan ceiling across ALL operations
- Zero production downtime during Qdrant migration (Blue serves while Green re-indexes)

### Quality Gates (per workstream)

- `bun run typecheck` — 0 errors
- `bun run lint` — 0 errors
- `bun test` — all pass
- No `any` types introduced
- No `as any` type escapes
- Eval suite metrics do not regress between workstreams

---

## Success Metrics

| Metric | Baseline (today) | Target | Measurement |
|--------|-------------------|--------|-------------|
| Recall@10 (code search) | ~0.3 (estimated) | > 0.95 | Eval suite |
| NDCG@10 (all queries) | Unknown | > 0.85 | Eval suite |
| MRR@10 (all queries) | Unknown | > 0.80 | Eval suite |
| Embedding dimensions | 768 | 3072 | Qdrant collection config |
| Concurrent AI tool clients | 1 (Claude Code) | >= 3 | Session registry count |
| Nightly improvements kept | 0 | >= 3 in first month | Improvement history |
| Cross-project learnings propagated | 0 | >= 10 per week | Propagation log |
| Contradictions detected | 0 | All conflicts flagged | Contradiction store |
| Memory compression ratio | 1:1 (no compression) | 4:1 | Compression run stats |
| Search latency p95 | ~200ms | < 300ms (despite richer pipeline) | Eval suite |

---

## Explicitly Out of Scope

- **GPU-based local embeddings** — Requires hardware investment. Gemini embedding 2 via API is sufficient.
- **Custom fine-tuned embedding model** — Premature. Standard models with better chunking will close the gap.
- **Real-time streaming search** — Batch search is sufficient. WebSocket streaming adds complexity.
- **Multi-language support beyond TS/JS/Python** — CodeChunker already handles TS/JS/Python. Other languages are additive.
- **Automatic Blue→Green promotion** — Always requires manual approval gate (PR from improvement branch).
- **Cost optimization for LLM judge calls** — Use cached results where possible, but don't sacrifice eval quality for cost.
- **Mobile/edge deployment** — ping-mem is a server-side system. No mobile runtime needed.
