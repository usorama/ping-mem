# BM25 and Deterministic Code Search — Research Findings

**Date**: 2026-03-09
**Status**: Final
**Sources**: Sourcegraph engineering blog, CodeSearchNet paper, SQLite FTS5 docs, BEIR benchmark

---

## 1. BM25 Formula (Okapi BM25)

The canonical BM25 scoring formula for term `t` in document `d`:

```
BM25(t, d) = IDF(t) × (tf(t,d) × (k1 + 1)) / (tf(t,d) + k1 × (1 - b + b × |d|/avgdl))
```

Where:
- `IDF(t) = log((N - df + 0.5) / (df + 0.5) + 1)` — inverse document frequency
- `tf(t,d)` = raw term frequency in document
- `k1 = 1.5` (TF saturation — higher = more weight on raw freq)
- `b = 0.75` (document length normalization)
- `|d|` = document length, `avgdl` = average document length across corpus
- `N` = total documents, `df` = documents containing term `t`

**Why it beats n-gram hashing**: BM25 has IDF weighting (rare terms matter more), TF saturation (prevents spam), and length normalization. N-gram hashing has none of these — a 768-dim hash vector scores similarly whether a token appears once or 100 times.

---

## 2. BM25F — Field-Weighted Variant

BM25F extends BM25 to multiple fields (title, body, anchor text) with per-field weight multipliers applied before merging into a single IDF. Used by Elasticsearch, Solr, and Sourcegraph.

**Sourcegraph's BM25F configuration** (from Zoekt codebase):
- Symbol names field: **5x weight boost**
- Filename field: **3x weight boost**
- File content field: **1x weight boost**
- Result: symbol/filename matches massively outrank content matches for the same term

**Formula (simplified for two fields)**:
```
BM25F(t, d) = IDF_combined(t) × sum_fields(w_f × tf_f / (tf_f + k1_f × (1 - b_f + b_f × |d_f|/avgdl_f)))
```

**Innovation opportunity**: ping-mem can implement BM25F with:
- `file_path` field: 3.0x weight
- `kind='code'` chunks: 1.0x weight
- `kind='comment'` chunks: 0.5x weight
- `kind='docstring'` chunks: 0.75x weight

---

## 3. Current ping-mem BM25 Implementation (Already Exists!)

**Critical finding**: `src/search/HybridSearchEngine.ts` lines 237-436 contains a complete, correct BM25 implementation (`BM25Index` class):

```typescript
// Already implemented in HybridSearchEngine.ts
private computeIDF(df: number, N: number): number {
  return Math.log((N - df + 0.5) / (df + 0.5) + 1);
}

private computeTF(tf: number, docLength: number, avgDocLength: number): number {
  const k1 = 1.5;
  const b = 0.75;
  return (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (docLength / avgDocLength)));
}
```

**The gap**: This BM25 powers **memory search** (the general context store). It does NOT power **code chunk search** — that uses `DeterministicVectorizer → Qdrant` via `CodeIndexer`. Two separate, disconnected search systems.

**`BM25Store`** (`src/search/BM25Store.ts`) persists BM25 documents in SQLite `bm25_documents` table across restarts.

**`HybridSearchEngine`** (`src/search/HybridSearchEngine.ts`) combines BM25 + semantic + graph via RRF (k=60) — but only for memory items, not code chunks.

---

## 4. Reciprocal Rank Fusion (RRF)

RRF merges ranked lists from multiple retrieval methods without requiring score normalization:

```
RRF_score(d) = Σ_systems 1 / (k + rank_i(d))
```

Where `k = 60` is literature-optimal (Cormack et al. 2009). For ping-mem:
- System 1: BM25/FTS5 ranked results (rank by BM25 score descending)
- System 2: Qdrant vector similarity (rank by score descending)

**Implementation**: Already in HybridSearchEngine.ts as `RRF_K = 60`, but not connected to code search.

---

## 5. DeterministicVectorizer — Known Weaknesses

Current implementation (`src/search/DeterministicVectorizer.ts`):
1. N-gram extraction: 1-gram, 2-gram, 3-gram character sequences
2. SHA-256 hash → first 4 bytes → `abs(int32) % 768` → dimension index
3. L2 normalization of resulting sparse vector

**Problems**:
- **Hash collisions**: Different tokens map to same dimension, cancel out (sign-based)
- **No IDF**: Rare/common tokens treated identically
- **No positional awareness**: "foo bar" and "bar foo" produce same vector
- **Low scores by design**: Sparse hash vectors with collisions produce cosine similarities of 0.05-0.20 even for highly relevant documents

---

## 6. Fix: Wire CodeIndexer to Use FTS5 BM25

**Primary recommendation** (no new dependencies, uses SQLite already present):

Replace Qdrant-only code search with SQLite FTS5 BM25 search:

```sql
-- FTS5 table for code chunks (external content, unicode61 tokenizer)
CREATE VIRTUAL TABLE code_fts USING fts5(
  file_path,
  content,
  tokenize = 'unicode61 tokenchars ''_-''',
  prefix = '2 3 4',
  content = 'code_chunks',
  content_rowid = 'id'
);
```

Then `CodeIndexer.search()` runs:
```sql
SELECT cc.*, bm25(code_fts, 2.0, 1.0) AS score
FROM code_fts
JOIN code_chunks cc ON cc.id = code_fts.rowid
WHERE code_fts MATCH ? AND cc.project_id = ?
ORDER BY bm25(code_fts, 2.0, 1.0)
LIMIT ?
```

**Hybrid approach (BM25 + Qdrant RRF)** for further quality gains:
- BM25 result set (top 20) → ranked list A
- Qdrant result set (top 20) → ranked list B
- RRF merge → final top 10

---

## 7. CodeSearchNet Benchmark — BM25 Baseline Performance

From the CodeSearchNet 2019 paper:
- **BM25 baseline**: NDCG@10 = 0.33 (Python), 0.36 (JavaScript)
- **CodeBERT** (neural): NDCG@10 = 0.71 (Python)
- **BM25 vs hash vectorizer**: BM25 outperforms n-gram hash vectorizers significantly

For ping-mem's deterministic constraint (no ML inference):
- BM25 is the gold standard for deterministic code search
- Adding trigram FTS5 for substring matching closes most of the gap to neural models for identifier search

---

## 8. Sourcegraph Zoekt Architecture

Sourcegraph's `zoekt` (fast trigram-based code search):
1. Trigram index over all source files (3-char substrings)
2. BM25F ranking with field weights
3. Regex matching over trigram-filtered candidate set
4. Result: < 100ms for searches across millions of files

**Key insight for ping-mem**: FTS5 trigram mode is the SQLite equivalent of Zoekt's trigram index. Adding it alongside the unicode61 FTS5 table provides both exact-token and substring search.

---

## 9. Sources

- [Okapi BM25 — Wikipedia](https://en.wikipedia.org/wiki/Okapi_BM25)
- [BM25F — Microsoft Research, Robertson & Zaragoza 2004](https://www.microsoft.com/en-us/research/publication/simple-bm25-extension-multiple-weighted-fields/)
- [CodeSearchNet Challenge — Husain et al. 2019](https://arxiv.org/abs/1909.09436)
- [Zoekt: fast trigram based code search — Sourcegraph](https://github.com/sourcegraph/zoekt)
- [Reciprocal Rank Fusion — Cormack, Clarke & Buettcher 2009](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf)
- [BEIR: A Heterogeneous Benchmark for Zero-shot Evaluation of IR Models](https://arxiv.org/abs/2104.08663)
