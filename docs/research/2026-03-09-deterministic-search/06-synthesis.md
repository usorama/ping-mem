# Synthesis: Deterministic Search Quality + MCP HTTP Transport

**Date**: 2026-03-09
**Research base**: 5 documents (01–05), ~120KB, 45+ sources
**Issues addressed**: #26 (MCP HTTP), #27 (FTS5 multi-word), #28 (BM25 code search)

---

## 1. Founding Principles

These principles are non-negotiable constraints governing every implementation decision:

1. **Determinism**: Same input → same ranked output, always. No ML inference, no randomness, no environment-dependent scoring. BM25 formula with fixed k1, b parameters is deterministic.

2. **Mathematical rigor**: Every score has a defined formula (BM25 IDF, TF saturation, RRF). "I don't know why this scored higher" is not acceptable.

3. **Zero new infrastructure**: FTS5 is already in bun:sqlite. StreamableHTTPServerTransport is already in @modelcontextprotocol/sdk@1.25.3. No new Docker containers, no new services.

4. **Backward compatibility**: REST API contract (`GET /api/v1/codebase/search`, etc.) unchanged. Qdrant continues to work as secondary search path.

5. **Quality gates in CI**: NDCG@5 ≥ 0.35, MRR@5 ≥ 0.50 are binary PASS/FAIL tests in `bun test`. Aspirational targets are not quality gates.

6. **Leverage existing BM25**: `src/search/HybridSearchEngine.ts:237–436` has a correct BM25 implementation. The problem is CodeIndexer doesn't use it. Wire the existing code rather than reinventing.

7. **OR-of-words is the correct default**: Natural language queries express intent with keywords, not adjacent phrase constraints. Multi-word FTS5 queries must use OR semantics by default.

---

## 2. Measurable Outcomes

| Metric | Baseline (Measured) | Target | Measurement |
|--------|---------------------|--------|-------------|
| Code search NDCG@5 | ~0.10–0.15 (n-gram hash vectors, cosine 0.05–0.20) | ≥ 0.35 | `bun test src/search/__tests__/eval.test.ts` |
| Knowledge FTS5 multi-word recall | 0% (phrase-only bug) | ≥ 80% | unit test: 5 multi-word queries |
| MCP HTTP accessibility | stdio only (no HTTP port) | POST /mcp on port 3003 | `curl -X POST http://localhost:3003/mcp` |
| Token reduction (code search) | 99.98% broad, 98.1% targeted | ≥ 95% (maintained) | existing UAT metric |
| Search latency p50 | ~50ms (Qdrant round-trip) | ≤ 100ms (no regression) | timer in eval test |
| FTS5 schema migration safety | N/A (new feature) | Idempotent (CREATE IF NOT EXISTS) | typecheck + test |

---

## 3. Architecture Decision Records

### ADR-1: SQLite FTS5 over Elasticsearch for code search
- **Decision**: Use SQLite FTS5 with unicode61 tokenizer and built-in `bm25()` function
- **Rationale**: Zero new infrastructure, bun:sqlite handles it, external content table avoids duplication, built-in BM25 (k1=1.2, b=0.75) is sufficient
- **Rejected**: Elasticsearch (new Docker container, operational overhead), custom BM25 over raw SQLite (FTS5 bm25() is already there)

### ADR-2: WebStandardStreamableHTTPServerTransport for MCP HTTP
- **Decision**: Use `WebStandardStreamableHTTPServerTransport` from @modelcontextprotocol/sdk@1.25.3
- **Rationale**: Uses Web Standard Fetch API natively (works with Hono + Bun), available in installed SDK version, single `/mcp` endpoint handles GET/POST/DELETE
- **Rejected**: SSEServerTransport (deprecated in new MCP spec), @hono/mcp (extra dependency, same SDK used underneath)

### ADR-3: Separate PingMemServer instance for MCP-over-HTTP
- **Decision**: Instantiate PingMemServer (without calling start()) in server.ts, pass Server to RESTPingMemServer
- **Rationale**: PingMemServer already has all 66 tool handlers registered; re-implementing in RESTPingMemServer would duplicate ~200 lines of tool setup code
- **Accepted cost**: Two EventStore instances on same SQLite file (SQLite WAL mode handles concurrent access)
- **Rejected**: Refactor tool handlers into shared module (too broad; out of scope)

### ADR-4: OR-of-words for FTS5 multi-word queries
- **Decision**: Split user input on whitespace, wrap each term in quotes, join with `OR`
- **Rationale**: Natural language queries should match ANY term, not require phrase adjacency
- **Exception**: Single-word queries use prefix search (`"term*"`) for autocomplete feel

### ADR-5: CodeChunkStore as new abstraction
- **Decision**: New `src/search/CodeChunkStore.ts` manages SQLite code_chunks table + FTS5 virtual table
- **Rationale**: Separation of concerns (SQLite vs Qdrant); CodeIndexer already has Qdrant; don't mix storage backends in one class
- **Integration**: CodeIndexer accepts optional `CodeChunkStore` and dual-writes

---

## 4. Gap Analysis

| Gap | Severity | Current State | Target State |
|-----|----------|---------------|--------------|
| Code search scores 0.05–0.20 | CRITICAL | DeterministicVectorizer n-gram hashing, no IDF | SQLite FTS5 BM25 primary, Qdrant secondary, RRF merge |
| Knowledge FTS5 multi-word 0 results | HIGH | Phrase-wrapping (line 272 KnowledgeStore.ts) forces adjacent match | OR-of-words: `"word1" OR "word2"` |
| MCP not on port 3003 | HIGH | stdio only, no HTTP | WebStandardStreamableHTTPServerTransport at /mcp on port 3003 |
| No eval harness | MEDIUM | No quality gates, scores accepted as "expected" | NDCG@5, MRR@5 tests in bun test CI |
| FTS5 strip pattern incomplete | LOW | Missing `[` and `]` chars (can cause FTS5 parse error on code with array syntax) | Add `[\\[\\]]` to strip pattern |

---

## 5. Key Facts from Research

- `@modelcontextprotocol/sdk@1.25.3` installed — `WebStandardStreamableHTTPServerTransport` confirmed at `dist/esm/server/webStandardStreamableHttp.d.ts` with `handleRequest(req: Request): Promise<Response>` signature
- `hono@4.11.6` installed — Web Standard Request/Response, no conversion needed
- `BM25Index` already in `HybridSearchEngine.ts:237–436` with correct IDF formula — just not wired to code search
- `KnowledgeStore.ts:272` bug confirmed: `params.$query = '"' + sanitized.replace(...)` wraps ALL queries in double quotes = phrase-only
- `IngestionService` is constructed before `EventStore` in `server.ts` — need `dbPath` injection, not `Database` instance injection
- FTS5 external content table pattern (`content='code_chunks', content_rowid='id'`) prevents data duplication
- FTS5 built-in `bm25(table, w_path, w_content)` column weights: path matches should score 2x content
