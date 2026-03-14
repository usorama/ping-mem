# Codebase Current State Analysis

**Date**: 2026-03-09
**Status**: Final
**Method**: Direct codebase analysis (Grep + Read)

---

## 1. Search Architecture — Two Disconnected Systems

### System A: Memory/General Search (BM25-powered)

Located in: `src/search/HybridSearchEngine.ts`, `src/search/BM25Store.ts`

```
User query
    ↓
HybridSearchEngine.search()
    ├── BM25Index.search()         [BM25 over memory items]
    ├── VectorIndex.search()       [OpenAI embeddings → Qdrant]
    └── RRF merge (k=60)          [Reciprocal Rank Fusion]
         ↓
    Ranked memory results
```

BM25 is **correctly implemented** here (lines 237-436 of HybridSearchEngine.ts):
- IDF: `log((N - df + 0.5) / (df + 0.5) + 1)`
- TF saturation: k1=1.5, b=0.75
- Persisted in SQLite via `BM25Store` (`bm25_documents` table)

### System B: Code Chunk Search (n-gram hash + Qdrant ONLY)

Located in: `src/search/CodeIndexer.ts`, `src/search/DeterministicVectorizer.ts`

```
User query
    ↓
CodeIndexer.searchCode()
    └── DeterministicVectorizer.vectorize()   [n-gram hash → 768-dim sparse vector]
         └── QdrantClient.search()            [cosine similarity]
              ↓
         Code chunk results (scores: 0.05-0.20)
```

**No BM25, no FTS5, no IDF.** The reason scores are 0.05-0.20.

---

## 2. DeterministicVectorizer Analysis

File: `src/search/DeterministicVectorizer.ts`

```typescript
// Actual implementation (simplified)
tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 2);
}

vectorize(text: string): number[] {
  const tokens = this.tokenize(text);
  const ngrams = this.generateNgrams(tokens, [1, 2, 3]);
  const vector = new Float32Array(768).fill(0);
  for (const gram of ngrams) {
    const hash = sha256(gram).slice(0, 4); // first 4 bytes
    const idx = Math.abs(new DataView(hash).getInt32(0)) % 768;
    vector[idx] += 1;  // collision-prone increment
  }
  return l2normalize(vector);
}
```

**Flaws**:
1. Hash collisions: multiple n-grams → same index → values cancel or accumulate arbitrarily
2. No IDF: "the" and "BM25Index" have same weight
3. No length normalization beyond L2 (not the same as BM25's avgdl normalization)
4. Binary increment (not TF-weighted)

---

## 3. KnowledgeStore FTS5 Bug

File: `src/knowledge/KnowledgeStore.ts`, lines 264-272

```typescript
// BUG: Wraps entire query in double quotes = phrase search only
const sanitized = options.query
  .replace(/[*^(){}:]/g, " ")
  .replace(/\b(AND|OR|NOT|NEAR)\b/gi, " ")
  .trim();
params.$query = '"' + sanitized.replace(/"/g, '""') + '"';
//              ^^^                                    ^^^
//         Double quotes force EXACT PHRASE MATCH
```

**Effect**: Query "biometric authentication" only matches documents containing
those words adjacent. No match for separate occurrences. 0 results for most
multi-word natural language queries.

**Fix** (OR-of-words semantics):
```typescript
const terms = sanitized.split(/\s+/).filter(Boolean);
params.$query = terms.length === 1
  ? '"' + terms[0]!.replace(/"/g, '""') + '"'
  : terms.map(t => '"' + t.replace(/"/g, '""') + '"').join(' OR ');
```

Additional gap: `[` and `]` characters not stripped (minor — `[ ]` in code can cause FTS5 parse errors).

---

## 4. MCP Transport — Current State

File: `src/mcp/cli.ts`

```typescript
const transport = new StdioServerTransport();
await server.connect(transport);
```

**Stdio only**. No HTTP. No port. To use MCP, must run `bun run dist/mcp/cli.js` as a subprocess.

**Current CLAUDE.md claim** (incorrect): States port 3000 is SSE/REST — implies MCP is on HTTP. Reality: MCP is never on HTTP in current code.

---

## 5. REST Server Port Architecture

File: `src/http/rest-server.ts` — Hono app, port from env or default

```
docker-compose.yml:
  ping-mem-rest:   PORT=3003  (REST API, no MCP)
  ping-mem:        PORT=3000  (SSE/REST mode, no MCP)
```

Both REST servers use same codebase; ping-mem-rest is the "production" REST server.
Neither exposes MCP over HTTP.

---

## 6. CodeIndexer — UUID Truncation Bug

File: `src/search/CodeIndexer.ts`

```typescript
// BUG: Only first 32 chars of SHA-256 (64 hex chars) used as Qdrant point ID
const pointId = chunkId.slice(0, 32);
```

SHA-256 hex = 64 chars. UUID = 32 hex chars. Using first half only increases collision probability
from astronomically small to just very small (still probably fine, but unnecessarily imprecise).

---

## 7. Missing: Code Chunk SQLite Persistence

Code chunks are stored in **Qdrant only** (via `CodeIndexer`). They are not in SQLite.
This means:
- No BM25 search over code chunks is possible today (BM25 runs over in-memory/SQLite documents)
- To add FTS5 BM25 for code chunks, must add SQLite storage alongside Qdrant

**Required schema addition**:
```sql
-- code_chunks table (new)
CREATE TABLE code_chunks (id INTEGER PRIMARY KEY, chunk_id TEXT UNIQUE, project_id TEXT, file_path TEXT, language TEXT, kind TEXT, content TEXT, start_line INTEGER, end_line INTEGER);

-- FTS5 virtual table (new)
CREATE VIRTUAL TABLE code_fts USING fts5(file_path, content, tokenize='unicode61 tokenchars ''_-''', content='code_chunks', content_rowid='id');
```

---

## 8. HybridSearchEngine — Not Used for Code

The sophisticated `HybridSearchEngine` (BM25 + vector + graph + RRF) is wired to:
- `MemoryManager.search()` — general context search
- Agent memory search endpoints

It is **NOT wired to** `CodeIndexer.searchCode()` or the REST endpoint
`GET /api/v1/codebase/search`. Those go through:
```typescript
// rest-server.ts
const results = await ingestionService.searchCode(query, options);
// → IngestionService.searchCode()
// → CodeIndexer.search()
// → DeterministicVectorizer → Qdrant
```

---

## 9. Package Versions

```json
// package.json (relevant)
"@modelcontextprotocol/sdk": "^1.x",  // need to verify exact version
"hono": "^4.x",
"bun": "^1.x",
```

Must verify `@modelcontextprotocol/sdk` version supports `StreamableHTTPServerTransport`
(requires ≥ 1.0.0).

---

## 10. Summary: What Must Change Per Issue

| Issue | File(s) | Change |
|-------|---------|--------|
| #26 Port consolidation | `src/http/rest-server.ts`, `src/mcp/PingMemServer.ts` | Add `/mcp` HTTP endpoint using StreamableHTTPServerTransport |
| #27 FTS5 multi-word | `src/knowledge/KnowledgeStore.ts` (line 272) | OR-of-words instead of phrase-wrapping |
| #28 BM25 for code search | `src/search/CodeIndexer.ts`, `src/graph/TemporalCodeGraph.ts`, SQLite schema | Add code_chunks table + FTS5 index; search returns BM25 scores |
| Eval harness | `src/search/__tests__/eval.test.ts` (new) | NDCG@5, MRR@5 quality gates in CI |
