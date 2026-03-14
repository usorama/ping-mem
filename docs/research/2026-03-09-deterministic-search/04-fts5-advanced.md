# SQLite FTS5 Advanced Configuration for Multi-Word Search and Code Search

**Date**: 2026-03-09
**Context**: ping-mem deterministic search research series
**Status**: Final

---

## Table of Contents

1. [FTS5 Tokenizer Comparison](#1-fts5-tokenizer-comparison)
2. [FTS5 Query Syntax Reference](#2-fts5-query-syntax-reference)
3. [FTS5 BM25 Ranking Function](#3-fts5-bm25-ranking-function)
4. [FTS5 Trigram Mode for Code Search](#4-fts5-trigram-mode-for-code-search)
5. [Fix: Multi-Word Query Returns 0 Results](#5-fix-multi-word-query-returns-0-results)
6. [FTS5 Built-in vs External BM25](#6-fts5-built-in-vs-external-bm25)
7. [External Content Tables](#7-external-content-tables)
8. [Performance: 100K Code Chunks](#8-performance-100k-code-chunks)
9. [Highlight and Snippet Functions](#9-highlight-and-snippet-functions)
10. [Schema Design for Code Chunk FTS5 Table](#10-schema-design-for-code-chunk-fts5-table)
11. [Best Practices Summary](#11-best-practices-summary)
12. [Sources](#12-sources)

---

## 1. FTS5 Tokenizer Comparison

SQLite FTS5 ships four built-in tokenizers. The table below compares them for general text vs. code search use cases.

| Tokenizer | Word Boundary | Stemming | Substring Match | Case Sensitive | Best For |
|-----------|---------------|----------|-----------------|----------------|----------|
| `unicode61` (default) | Unicode 6.1 rules (letters + numbers = tokens, punctuation = separator) | No | No | No (folds to lowercase) | Natural language, human prose |
| `ascii` | ASCII rules only (non-ASCII always treated as token chars) | No | No | No (ASCII only folding) | ASCII-only text, legacy data |
| `porter` | Wraps `unicode61` (or another tokenizer), then applies Porter stemming | Yes (English) | No | No | English prose where stemmed matching is acceptable |
| `trigram` | Every 3-character sequence is a token (no word boundaries) | No | Yes (LIKE/GLOB/MATCH all work as substring) | Optional (`case_sensitive 1`) | Code identifiers, names, substring search |

### Notes on each tokenizer for code search

**unicode61** — Reasonable for searching comments and docstrings. Treats `_` and `-` as separators by default, so `snake_case` splits into `snake` + `case`, and `kebab-case` splits into `kebab` + `case`. Searching for `snake_case` as a whole token fails unless you add `tokenchars '_-'`. Single-word queries work well; multi-word queries use AND semantics by default.

**porter** — Useful only for prose in knowledge entries (symptoms, root_cause fields). Counterproductive for code because `getData` stems differently from `get` + `Data`. Never use for source code content.

**trigram** — The correct tokenizer when you need substring matching (e.g., searching `Auth` to find `AuthService`, `authMiddleware`, `useAuth`). Any sequence of 3+ characters will match. Works with LIKE and GLOB operators directly against the FTS virtual table. Requires SQLite 3.38.0+.

### Custom unicode61 for code identifiers

Add underscore and hyphen as token characters so `snake_case` and `kebab-case` are not split:

```sql
CREATE VIRTUAL TABLE code_fts USING fts5(
  content,
  tokenize = 'unicode61 tokenchars ''_-'''
);
```

This keeps `snake_case` as a single token and `my-method` as a single token, improving exact-identifier lookup. The cost: you lose word-boundary search within the identifier.

### Dual-index approach for code search

For code chunks, the best practice is to maintain two FTS5 tables:
- `code_fts_token` — uses `unicode61 tokenchars '_-'` for exact token/identifier search
- `code_fts_trigram` — uses `trigram` for substring/partial search

Merge results with a rank-weighted union query (see Section 10).

---

## 2. FTS5 Query Syntax Reference

### Boolean operators

```sql
-- AND (implicit when terms are space-separated)
SELECT * FROM code_fts WHERE code_fts MATCH 'useEffect useState';

-- Explicit AND
SELECT * FROM code_fts WHERE code_fts MATCH 'useEffect AND useState';

-- OR (either term)
SELECT * FROM code_fts WHERE code_fts MATCH 'useEffect OR useCallback';

-- NOT (exclude term)
SELECT * FROM code_fts WHERE code_fts MATCH 'auth NOT deprecated';
```

Operator precedence: NOT > AND > OR. Use parentheses to override:

```sql
SELECT * FROM code_fts WHERE code_fts MATCH '(auth OR session) AND token';
```

### Phrase queries

Tokens within double quotes must appear adjacent in document order:

```sql
-- Exact phrase
SELECT * FROM code_fts WHERE code_fts MATCH '"export default function"';

-- Alternative using + operator
SELECT * FROM code_fts WHERE code_fts MATCH 'export + default + function';
```

### Prefix queries

The `*` wildcard at the end of a token matches any continuation:

```sql
-- Match "auth", "authenticate", "authorization", etc.
SELECT * FROM code_fts WHERE code_fts MATCH 'auth*';

-- Prefix with phrase
SELECT * FROM code_fts WHERE code_fts MATCH '"React.use*"';
```

Without a prefix index, prefix queries require a range scan over all tokens. Add a prefix index for fast prefix lookup:

```sql
CREATE VIRTUAL TABLE code_fts USING fts5(
  content,
  tokenize = 'unicode61 tokenchars ''_-''',
  prefix = '2 3 4'   -- maintain prefix indexes for 2, 3, and 4-char prefixes
);
```

### NEAR queries

NEAR constrains two phrases to be within N tokens of each other:

```sql
-- "error" within 5 tokens of "handler"
SELECT * FROM code_fts WHERE code_fts MATCH 'error NEAR/5 handler';

-- NEAR with phrases
SELECT * FROM code_fts WHERE code_fts MATCH 'NEAR("throw new" "Error", 3)';
```

Default NEAR distance (when `/N` is omitted) is 10 tokens.

### Column filters

Restrict a query to a specific column:

```sql
-- Only search the "path" column
SELECT * FROM code_fts WHERE code_fts MATCH 'path:src/auth*';

-- Search "content" column for one term, "path" for another
SELECT * FROM code_fts WHERE code_fts MATCH 'content:useState path:components*';
```

### Initial-token anchor

`^` matches only if the phrase appears at the very start of the column:

```sql
-- Only match if "import" is the first word in the content column
SELECT * FROM code_fts WHERE code_fts MATCH '^import';
```

---

## 3. FTS5 BM25 Ranking Function

SQLite FTS5 ships a built-in BM25 implementation with parameters `k1=1.2` and `b=0.75` (hardcoded). The function is available as `bm25(table_name[, weight0, weight1, ...])`.

**Important**: BM25 returns negative scores. More negative = more relevant. Always `ORDER BY bm25(...) ASC` (ascending) to get most-relevant-first, or equivalently `ORDER BY rank ASC` when using the `rank` virtual column.

### Basic usage

```sql
SELECT
  id,
  path,
  bm25(code_fts) AS score
FROM code_fts
WHERE code_fts MATCH '"authentication"'
ORDER BY bm25(code_fts) ASC   -- most relevant first (most negative score)
LIMIT 20;
```

### Using the `rank` virtual column

FTS5 exposes a `rank` virtual column that defaults to `bm25()`. This is the idiomatic way to sort:

```sql
SELECT id, path, rank
FROM code_fts
WHERE code_fts MATCH '"useState"'
ORDER BY rank
LIMIT 20;
```

### Column-weighted BM25

When the FTS table has multiple columns, weight matches in specific columns higher. Weights are floats, positional (column 0 first):

```sql
-- Table schema: fts5(path, content, comments)
-- Weight path matches 3x, content 1x, comments 0.5x
SELECT
  id,
  bm25(code_fts, 3.0, 1.0, 0.5) AS score
FROM code_fts
WHERE code_fts MATCH 'authentication'
ORDER BY bm25(code_fts, 3.0, 1.0, 0.5)
LIMIT 20;
```

### Override default rank function at table level

```sql
-- Set bm25 with custom weights as the table-default ranker
INSERT INTO code_fts(code_fts, rank) VALUES ('rank', 'bm25(10.0, 1.0)');
```

After this, `ORDER BY rank` uses the custom weights automatically.

### Normalizing to positive scores

BM25 scores are negative in FTS5. To get positive scores for display or further computation:

```sql
SELECT id, path, (-1.0 * bm25(code_fts)) AS relevance
FROM code_fts
WHERE code_fts MATCH 'auth*'
ORDER BY relevance DESC
LIMIT 20;
```

---

## 4. FTS5 Trigram Mode for Code Search

### What trigram tokenization does

With `tokenize='trigram'`, the text "hello" is stored as overlapping 3-char sequences: `hel`, `ell`, `llo`. A MATCH query for `'ello'` produces tokens `ell`, `llo` and returns any row containing that subsequence. This enables LIKE-style substring search at FTS5 speed.

### Creating a trigram table

```sql
CREATE VIRTUAL TABLE code_trigram USING fts5(
  content,
  tokenize = 'trigram'
);
```

### Case-sensitive trigram (correct for code identifiers)

Code identifiers are case-sensitive. `AuthService` != `authservice`. Use `case_sensitive 1`:

```sql
CREATE VIRTUAL TABLE code_trigram USING fts5(
  content,
  tokenize = 'trigram case_sensitive 1'
);
```

### Querying — MATCH, LIKE, and GLOB all work

```sql
-- MATCH (FTS5 query syntax)
SELECT rowid FROM code_trigram WHERE code_trigram MATCH 'AuthService';

-- LIKE (SQL LIKE operator, optimized through the trigram index)
SELECT rowid FROM code_trigram WHERE content LIKE '%AuthService%';

-- GLOB (case-sensitive glob, optimized)
SELECT rowid FROM code_trigram WHERE content GLOB '*AuthService*';
```

LIKE and GLOB optimizations require the trigram index to be on the same column. SQLite transparently uses the trigram FTS index for LIKE/GLOB queries when the pattern starts with a wildcard.

### Handling short tokens (< 3 characters)

The built-in trigram tokenizer cannot index tokens shorter than 3 characters. Queries for `id`, `fn`, `db` return 0 results. Two workarounds:

1. **Prefix expansion**: Index `id` as `id ` (padded to 3 chars) — not recommended.
2. **sqlite-better-trigram** (external C extension): Handles word segmentation and short tokens with proper word boundaries. Source: [streetwriters/sqlite-better-trigram](https://github.com/streetwriters/sqlite-better-trigram).

For ping-mem's use case (searching code chunks in bun:sqlite), the built-in trigram is sufficient because:
- Most code identifiers are 3+ characters
- Function names, class names, and module paths are always 3+
- Short variable names like `i`, `id` are low-value search targets

### Trigram index size

Trigram indexes are large. For 1.3 GiB of source text, expect +2.4 GiB of FTS5 index at `detail='full'`, or +1.5 GiB at `detail='none'`. For ping-mem code chunks (typical code corpus: 1–50 MB), this is not a concern.

---

## 5. Fix: Multi-Word Query Returns 0 Results

### Root cause

FTS5 query syntax treats space-separated terms as implicit AND. If the user types `"React hooks"` (with quotes in the input string), FTS5 interprets the double quote as a phrase delimiter. Any special character in user input that matches FTS5 operators (`"`, `-`, `^`, `*`, `(`, `)`, `AND`, `OR`, `NOT`, `NEAR`) will silently alter semantics or throw `fts5: syntax error`.

The most common failure mode:
- User types: `getUserById`
- Code passes `getUserById` directly to MATCH
- FTS5 tokenizes it to `getUser` + `ById` (under unicode61), matches nothing or wrong results
- Zero results returned

### The correct fix: wrap input in double quotes

Wrapping the entire sanitized query in double quotes converts it to a phrase query. FTS5 then searches for those tokens in sequence, which is usually what users want for code search.

```typescript
function buildFts5Query(userInput: string): string | null {
  // 1. Remove characters that alter FTS5 operator semantics
  const stripped = userInput
    .replace(/[*^(){}:\[\]]/g, ' ')           // remove FTS5 operators
    .replace(/\b(AND|OR|NOT|NEAR)\b/gi, ' ')  // remove boolean keywords
    .trim();

  if (!stripped) return null;  // all operators, nothing left

  // 2. Escape embedded double quotes by doubling them (SQLite FTS5 rule)
  const escaped = stripped.replace(/"/g, '""');

  // 3. Wrap in double quotes → phrase query
  return '"' + escaped + '"';
}
```

Concrete SQL examples:

```sql
-- Input: "useEffect useState"
-- Phrase query: finds rows where both tokens appear adjacent
WHERE code_fts MATCH '"useEffect useState"'

-- Input: "getUserById"
-- Single-phrase: finds exact token sequence
WHERE code_fts MATCH '"getUserById"'

-- Input: "it's a test"  (embedded apostrophe — not a FTS5 problem but worth noting)
-- Result after escaping: '"it''s a test"'
WHERE code_fts MATCH '"it''s a test"'
```

### Multi-word OR search pattern

When you want OR semantics across multiple words (e.g., user typed a natural language query), split on whitespace and OR the terms:

```typescript
function buildOrQuery(userInput: string): string | null {
  const terms = userInput
    .replace(/[*^(){}:\[\]]/g, ' ')
    .replace(/\b(AND|OR|NOT|NEAR)\b/gi, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (terms.length === 0) return null;

  // Each term wrapped and joined with OR
  return terms
    .map(t => '"' + t.replace(/"/g, '""') + '"')
    .join(' OR ');
}

// "auth handler error" → '"auth" OR "handler" OR "error"'
```

### Comparison of query strategies

| Strategy | SQL Pattern | Use Case |
|----------|-------------|----------|
| Phrase (default) | `'"term1 term2"'` | Code identifier or exact phrase |
| Prefix | `'"auth*"'` or `'auth*'` | Autocomplete, partial identifier |
| OR-of-words | `'"word1" OR "word2"'` | Natural language keyword search |
| AND-of-words | `'"word1" AND "word2"'` | Require all terms, any position |
| Column-scoped | `'path:"src/auth*"'` | File path filtering |

### Current ping-mem implementation (KnowledgeStore.ts)

The existing implementation uses the phrase-wrapping approach:

```typescript
// src/knowledge/KnowledgeStore.ts — lines 264-272
const sanitized = options.query
  .replace(/[*^(){}:]/g, " ")
  .replace(/\b(AND|OR|NOT|NEAR)\b/gi, " ")
  .trim();
if (!sanitized) {
  return [];
}
params.$query = '"' + sanitized.replace(/"/g, '""') + '"';
```

This is correct for phrase search. Gap: square brackets `[]` are not stripped (minor). Gap: multi-word natural-language queries get AND semantics (because the phrase query `"word1 word2"` requires them adjacent). For natural language, the OR-of-words pattern above is more useful.

---

## 6. FTS5 Built-in vs External BM25

### Recommendation: use FTS5 built-in BM25

For SQLite FTS5, the built-in `bm25()` function is the correct choice. Reasons:

1. **Zero dependencies**: No external C extension or custom ranking code required. Works in any SQLite environment including bun:sqlite.
2. **Battle-tested**: Ships in SQLite core since version 3.9.0 (2015). Bugs like the one found in Peewee's Python port of BM25 do not apply.
3. **Column weighting built-in**: Pass per-column weights to `bm25(table, w0, w1, ...)`.
4. **FTS4 is the historical reason for external BM25**: FTS4 exposed raw `matchinfo()` statistics and required external implementations (like [sqlite-okapi-bm25](https://github.com/rads/sqlite-okapi-bm25)). FTS5 eliminated this need.

### When external implementations are needed

- **FTS3/FTS4**: Neither has built-in ranking. An external BM25 over `matchinfo()` is necessary.
- **Custom k1/b parameters**: FTS5 hardcodes k1=1.2 and b=0.75. If your corpus requires different parameters, a custom C extension is the only option.
- **Cross-table BM25 over non-FTS data**: If ranking non-FTS results, an external implementation is required.

For ping-mem's code chunk store (SQLite + bun:sqlite), the built-in FTS5 BM25 is sufficient.

---

## 7. External Content Tables

### What `content=` does

Setting `content='table_name'` on an FTS5 virtual table creates an *external content table*. The FTS index stores only the inverted index (terms → rowids). When `highlight()`, `snippet()`, or column projection is needed, FTS5 queries the content table to retrieve actual column values.

Benefits:
- Source data stored once (no duplication)
- FTS index is smaller
- Can use triggers to keep index in sync

### Schema pattern

```sql
-- Source (content) table
CREATE TABLE code_chunks (
  id INTEGER PRIMARY KEY,        -- must be INTEGER PRIMARY KEY for FTS rowid
  chunk_id   TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  file_path  TEXT NOT NULL,
  language   TEXT NOT NULL,
  kind       TEXT NOT NULL,      -- 'code' | 'comment' | 'docstring'
  content    TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line   INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

-- External content FTS5 table
CREATE VIRTUAL TABLE code_fts USING fts5(
  file_path,
  content,
  content='code_chunks',
  content_rowid='id'
);
```

### Trigger synchronization (required)

FTS5 external content tables do not auto-sync. Triggers are the canonical approach:

```sql
-- INSERT trigger
CREATE TRIGGER code_chunks_ai AFTER INSERT ON code_chunks BEGIN
  INSERT INTO code_fts(rowid, file_path, content)
  VALUES (new.id, new.file_path, new.content);
END;

-- DELETE trigger
CREATE TRIGGER code_chunks_ad AFTER DELETE ON code_chunks BEGIN
  INSERT INTO code_fts(code_fts, rowid, file_path, content)
  VALUES ('delete', old.id, old.file_path, old.content);
END;

-- UPDATE trigger — IMPORTANT: must be BEFORE UPDATE to capture old values
CREATE TRIGGER code_chunks_bu BEFORE UPDATE ON code_chunks BEGIN
  INSERT INTO code_fts(code_fts, rowid, file_path, content)
  VALUES ('delete', old.id, old.file_path, old.content);
END;

CREATE TRIGGER code_chunks_au AFTER UPDATE ON code_chunks BEGIN
  INSERT INTO code_fts(rowid, file_path, content)
  VALUES (new.id, new.file_path, new.content);
END;
```

Note on UPDATE triggers: The BEFORE UPDATE trigger deletes the old FTS entry using old column values. The AFTER UPDATE trigger inserts the new entry. If only AFTER UPDATE is used, FTS5 fetches updated values when trying to delete the old entry, causing stale tokens to remain in the index.

### Rebuilding the index

If the FTS index gets out of sync with the content table:

```sql
INSERT INTO code_fts(code_fts) VALUES ('rebuild');
```

This re-reads all rows from `code_chunks` and rebuilds the FTS index.

### `content_rowid` vs implicit `rowid`

`content_rowid='id'` tells FTS5 which column in the content table is the integer primary key. This is required when the primary key column is not named `rowid`. It must be an `INTEGER PRIMARY KEY` column (SQLite rowid alias).

### Contentless tables (no content storage at all)

For maximum storage efficiency when only rowid-based retrieval is needed:

```sql
CREATE VIRTUAL TABLE code_fts_contentless USING fts5(
  file_path,
  content='',             -- empty string = contentless
  tokenize = 'unicode61 tokenchars ''_-'''
);
```

With contentless tables, `highlight()` and `snippet()` do not work because FTS5 cannot retrieve original column values. Only `bm25()` and `rowid` retrieval are available.

---

## 8. Performance: 100K Code Chunks

### Index creation benchmarks (reference data)

| Corpus Size | Tokenizer | detail= | Index Creation | Index Size | Query Speed |
|-------------|-----------|---------|----------------|------------|-------------|
| 18.2M rows (large) | trigram | none | ~3 min | +1.5 GiB (over 1.3 GiB source) | 14 ms |
| 18.2M rows (large) | trigram | full | ~3 min | +2.4 GiB | 10-30 ms |
| 200K rows (medium) | trigram | full | < 30 s | proportional | 28 ms |
| 100K rows (code chunks) | unicode61 | full | < 5 s | ~50-200 MB | < 5 ms |

For 100K code chunks (ping-mem's typical workload):
- `unicode61` FTS index: negligible size overhead, sub-5ms query time
- `trigram` FTS index: 3x source size, but code chunk source is small (50–200 MB max), so absolute size is acceptable
- Both tokenizers: index creation is instantaneous at this scale

### `detail=` option tradeoff

| `detail=` | Stores | Supports | Index Size |
|-----------|--------|----------|------------|
| `full` (default) | rowid + column + token offset | All queries, highlight, snippet, NEAR | Largest |
| `column` | rowid + column | Queries, column-filtered MATCH, no offset-based ops | Medium |
| `none` | rowid only | Basic MATCH, no column filtering, no highlight/snippet | Smallest |

For code search with highlight/snippet support, use `detail='full'` (default). For a contentless trigram index used only as a LIKE accelerator, use `detail='none'`.

### Prefix index for autocomplete

Adding `prefix='2 3'` precomputes indexes for 2-char and 3-char prefixes. This is necessary for autocomplete-style queries (`auth*`, `use*`) to be fast at scale:

```sql
CREATE VIRTUAL TABLE code_fts USING fts5(
  file_path, content,
  tokenize = 'unicode61 tokenchars ''_-''',
  prefix = '2 3 4',
  content = 'code_chunks',
  content_rowid = 'id'
);
```

Without prefix indexes, `auth*` requires a full range scan of the token list. With `prefix='4'`, a 4-char prefix query hits a dedicated index segment in O(log n).

### Maintenance: optimize and automerge

FTS5 uses an LSM-tree (log-structured merge tree). After many INSERT/UPDATE/DELETE operations, the index fragments into many small b-tree segments. To compact:

```sql
-- Merge all segments into one (reduces query latency after heavy writes)
INSERT INTO code_fts(code_fts) VALUES ('optimize');

-- Followed by VACUUM to reclaim disk space
VACUUM;
```

For write-heavy workloads, tune the `automerge` parameter (default 4) and `crisismerge` parameter (default 16):

```sql
-- More aggressive background merging (reduces fragmentation, slightly slower writes)
INSERT INTO code_fts(code_fts, rank) VALUES ('automerge', '8');
```

---

## 9. Highlight and Snippet Functions

Both functions are FTS5 auxiliary functions: they can only be called in the context of an FTS5 MATCH query.

### `highlight(table, column_index, open_tag, close_tag)`

Returns the entire column value with matched terms wrapped in markup tags.

```sql
SELECT
  highlight(code_fts, 0, '<mark>', '</mark>') AS path_highlighted,
  highlight(code_fts, 1, '<mark>', '</mark>') AS content_highlighted
FROM code_fts
WHERE code_fts MATCH '"useState"'
ORDER BY rank
LIMIT 10;
```

Parameters:
- `column_index`: 0-based column position in the FTS table definition
- `open_tag`: string to insert before each matched term
- `close_tag`: string to insert after each matched term

### `snippet(table, column_index, open_tag, close_tag, ellipsis, max_tokens)`

Extracts a short fragment from the matched column, maximizing the number of matched terms in the excerpt.

```sql
SELECT
  file_path,
  snippet(code_fts, 1, '<b>', '</b>', '...', 32) AS excerpt
FROM code_fts
WHERE code_fts MATCH '"authentication" OR "authorize"'
ORDER BY rank
LIMIT 10;
```

Parameters:
- `column_index`: 0-based column. Use `-1` to let FTS5 auto-select the best matching column.
- `open_tag`, `close_tag`: markup around matched terms
- `ellipsis`: text prepended/appended to indicate truncation (typically `'...'`)
- `max_tokens`: maximum number of tokens in the returned excerpt. Range: 1–64. For code, 32–48 is useful (captures a full function signature).

### Auto-select column with `-1`

```sql
SELECT
  file_path,
  snippet(code_fts, -1, '>>>', '<<<', '...', 40) AS best_excerpt
FROM code_fts
WHERE code_fts MATCH '"useAuth"'
ORDER BY rank
LIMIT 10;
```

With `-1`, FTS5 picks the column with the highest density of matched terms.

### Known issue: snippet with trigram tokenizer

There is a known interaction between `snippet()` / `highlight()` and the trigram tokenizer: because trigrams do not align with word boundaries, the markup can split words in unexpected ways. For trigram-indexed tables, retrieval by rowid and manual string highlighting in application code is more reliable than using `snippet()` directly.

Reference: [SQLite User Forum — snippet() and highlight() with fts5 in trigram tokenization mode](https://sqlite.org/forum/forumpost/63735293ec)

---

## 10. Schema Design for Code Chunk FTS5 Table in SQLite

### Recommended production schema

```sql
-- ============================================================
-- Source table: authoritative code chunk storage
-- ============================================================
CREATE TABLE IF NOT EXISTS code_chunks (
  id          INTEGER PRIMARY KEY,  -- integer PK = rowid alias, required for FTS external content
  chunk_id    TEXT    NOT NULL UNIQUE, -- deterministic SHA-256 ID
  project_id  TEXT    NOT NULL,
  file_path   TEXT    NOT NULL,
  language    TEXT    NOT NULL,
  kind        TEXT    NOT NULL CHECK (kind IN ('code', 'comment', 'docstring')),
  content     TEXT    NOT NULL,
  start_line  INTEGER NOT NULL,
  end_line    INTEGER NOT NULL,
  commit_hash TEXT,                 -- git commit at time of ingestion
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Indexes for non-FTS queries
CREATE INDEX IF NOT EXISTS idx_cc_project_id  ON code_chunks(project_id);
CREATE INDEX IF NOT EXISTS idx_cc_file_path   ON code_chunks(project_id, file_path);
CREATE INDEX IF NOT EXISTS idx_cc_kind        ON code_chunks(project_id, kind);

-- ============================================================
-- FTS5 table: token-based search (identifiers, exact tokens)
-- Uses unicode61 with underscore/hyphen as token chars
-- Supports: exact identifier lookup, prefix search, NEAR
-- ============================================================
CREATE VIRTUAL TABLE IF NOT EXISTS code_fts_token USING fts5(
  file_path   UNINDEXED,   -- stored but not indexed; used by content table join
  kind        UNINDEXED,   -- stored but not indexed
  content,                 -- full indexed text (code + comments)
  tokenize  = 'unicode61 tokenchars ''_-''',
  prefix    = '2 3 4',     -- prefix indexes for autocomplete up to 4 chars
  content   = 'code_chunks',
  content_rowid = 'id'
);

-- ============================================================
-- FTS5 table: trigram-based search (substring, partial match)
-- Uses trigram tokenizer with case sensitivity
-- Supports: LIKE-style substring, partial identifier match
-- detail='none' reduces index size; no highlight/snippet
-- ============================================================
CREATE VIRTUAL TABLE IF NOT EXISTS code_fts_trigram USING fts5(
  content,
  tokenize  = 'trigram case_sensitive 1',
  detail    = 'none',      -- omit position data; saves space, disables snippet()
  content   = 'code_chunks',
  content_rowid = 'id'
);

-- ============================================================
-- Triggers: keep FTS indexes in sync with code_chunks
-- ============================================================

-- INSERT: add to both FTS indexes
CREATE TRIGGER IF NOT EXISTS code_chunks_ai AFTER INSERT ON code_chunks BEGIN
  INSERT INTO code_fts_token(rowid, file_path, kind, content)
    VALUES (new.id, new.file_path, new.kind, new.content);
  INSERT INTO code_fts_trigram(rowid, content)
    VALUES (new.id, new.content);
END;

-- DELETE: remove from both FTS indexes
CREATE TRIGGER IF NOT EXISTS code_chunks_ad AFTER DELETE ON code_chunks BEGIN
  INSERT INTO code_fts_token(code_fts_token, rowid, file_path, kind, content)
    VALUES ('delete', old.id, old.file_path, old.kind, old.content);
  INSERT INTO code_fts_trigram(code_fts_trigram, rowid, content)
    VALUES ('delete', old.id, old.content);
END;

-- UPDATE (before): delete old FTS entries with old column values
CREATE TRIGGER IF NOT EXISTS code_chunks_bu BEFORE UPDATE ON code_chunks BEGIN
  INSERT INTO code_fts_token(code_fts_token, rowid, file_path, kind, content)
    VALUES ('delete', old.id, old.file_path, old.kind, old.content);
  INSERT INTO code_fts_trigram(code_fts_trigram, rowid, content)
    VALUES ('delete', old.id, old.content);
END;

-- UPDATE (after): insert new FTS entries with new column values
CREATE TRIGGER IF NOT EXISTS code_chunks_au AFTER UPDATE ON code_chunks BEGIN
  INSERT INTO code_fts_token(rowid, file_path, kind, content)
    VALUES (new.id, new.file_path, new.kind, new.content);
  INSERT INTO code_fts_trigram(rowid, content)
    VALUES (new.id, new.content);
END;
```

### Query patterns against the dual-index schema

```typescript
// TypeScript (bun:sqlite) — safe query builder
function buildTokenQuery(input: string): string | null {
  const cleaned = input
    .replace(/[*^(){}:\[\]]/g, ' ')
    .replace(/\b(AND|OR|NOT|NEAR)\b/gi, ' ')
    .trim();
  if (!cleaned) return null;

  const terms = cleaned.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return null;

  // Phrase for exact multi-word, OR-of-words for natural language
  if (terms.length === 1) {
    // Single term: use prefix search for autocomplete feel
    return '"' + terms[0]!.replace(/"/g, '""') + '*"';
  }
  // Multi-word: OR semantics (any term matches)
  return terms.map(t => '"' + t.replace(/"/g, '""') + '"').join(' OR ');
}

// Token-based search: returns rowids
const tokenQuery = buildTokenQuery(userInput);
if (tokenQuery) {
  const rows = db.prepare(`
    SELECT
      cc.chunk_id,
      cc.file_path,
      cc.kind,
      bm25(code_fts_token, 2.0, 0.0, 1.0) AS score,
      snippet(code_fts_token, 2, '<mark>', '</mark>', '...', 40) AS excerpt
    FROM code_fts_token fts
    JOIN code_chunks cc ON cc.id = fts.rowid
    WHERE code_fts_token MATCH ?
      AND cc.project_id = ?
    ORDER BY score
    LIMIT 20
  `).all(tokenQuery, projectId);
}

// Trigram search: substring match (use LIKE against the FTS virtual table)
const rows = db.prepare(`
  SELECT cc.chunk_id, cc.file_path, cc.kind, cc.content
  FROM code_fts_trigram fts
  JOIN code_chunks cc ON cc.id = fts.rowid
  WHERE code_fts_trigram MATCH ?
    AND cc.project_id = ?
  ORDER BY fts.rank
  LIMIT 20
`).all(userInput, projectId);  -- trigram MATCH is safe for raw input (no operators)
```

---

## 11. Best Practices Summary

### Tokenizer selection

- Use `unicode61 tokenchars '_-'` as the default tokenizer for code content. This keeps identifiers intact while treating spaces and other punctuation as separators.
- Add a separate `trigram case_sensitive 1` index for substring/partial-match queries.
- Never use `porter` on source code content.

### Query building

- Always wrap user input in double quotes: `'"' + input.replace(/"/g, '""') + '"'` before passing to MATCH.
- Strip FTS5 operator characters from user input: `*`, `^`, `(`, `)`, `{`, `}`, `:`, `[`, `]`.
- Strip FTS5 boolean keywords: `AND`, `OR`, `NOT`, `NEAR` (case-insensitive).
- Return empty results if the cleaned query is empty — do not fall back to unescaped input.

### BM25

- Use the built-in `bm25()` function — not an external implementation.
- Sort `ORDER BY bm25(table) ASC` (ascending, most negative first) or use `ORDER BY rank`.
- For multi-column tables, provide column weights: `bm25(table, w_path, w_content, w_comments)`.

### External content tables

- Use `content='table_name'` and `content_rowid='id'` to avoid storing content twice.
- Implement BEFORE UPDATE + AFTER UPDATE trigger pair (not just AFTER UPDATE) to correctly delete stale tokens.
- Run `INSERT INTO fts_table(fts_table) VALUES ('rebuild')` after bulk imports.
- Run `INSERT INTO fts_table(fts_table) VALUES ('optimize')` followed by `VACUUM` after major deletes.

### Prefix indexes

- Add `prefix='2 3 4'` if the application uses autocomplete or prefix queries (e.g., `auth*`).
- Omit prefix indexes for pure phrase/substring-only workloads (saves space).

### `detail=` option

- Use `detail='full'` (default) when `highlight()` or `snippet()` are required.
- Use `detail='none'` for a trigram table used only as a LIKE/GLOB accelerator (reduces index size by ~40%).

### Highlight and snippet

- Use `snippet(table, col, '<mark>', '</mark>', '...', 40)` to show match context.
- Use column index `-1` to auto-select the most relevant column.
- For trigram-indexed tables, prefer application-level highlighting over `snippet()` due to word-boundary issues.

---

## 12. Sources

- [SQLite FTS5 Extension — Official Documentation](https://sqlite.org/fts5.html)
- [Full-Text Search in SQLite: A Practical Guide — Johni Douglas Marangon](https://medium.com/@johnidouglasmarangon/full-text-search-in-sqlite-a-practical-guide-80a69c3f42a4)
- [SQLite FTS5 Tokenizers: unicode61 and ascii — audrey.feldroy.com](https://audrey.feldroy.com/articles/2025-01-13-SQLite-FTS5-Tokenizers-unicode61-and-ascii)
- [Escape your Full Text Search queries — Harold Admin](https://blog.haroldadmin.com/posts/escape-fts-queries)
- [Exploring search relevance algorithms with SQLite — Simon Willison](https://simonwillison.net/2019/Jan/7/exploring-search-relevance-algorithms-sqlite/)
- [FTS5 Integration and BM25 Ranking — KohakuVault DeepWiki](https://deepwiki.com/KohakuBlueleaf/KohakuVault/6.2-fts5-integration-and-bm25-ranking)
- [Full-Text Search 5 (FTS5) — sqlite/sqlite DeepWiki](https://deepwiki.com/sqlite/sqlite/5.1-full-text-search-5-(fts5))
- [SQLite FTS5 Trigram Name Matching — David Muraya](https://davidmuraya.com/blog/sqlite-fts5-trigram-name-matching/)
- [Faster SQLite LIKE Queries Using FTS5 Trigram Indexes — Andrew Mara](https://andrewmara.com/blog/faster-sqlite-like-queries-using-fts5-trigram-indexes)
- [SQLite Full-Text Search (FTS5) in Practice — TheLinuxCode](https://thelinuxcode.com/sqlite-full-text-search-fts5-in-practice-fast-search-ranking-and-real-world-patterns/)
- [GitHub: streetwriters/sqlite-better-trigram — better trigram with word segmentation](https://github.com/streetwriters/sqlite-better-trigram)
- [GitHub: simonw/sqlite-fts5-trigram](https://github.com/simonw/sqlite-fts5-trigram)
- [SQLite User Forum: FTS5 Handling of multi-token phrases](https://sqlite.org/forum/forumpost/790fac5f06?t=h)
- [SQLite User Forum: Issue with snippet() and highlight() with fts5 in trigram mode](https://sqlite.org/forum/forumpost/63735293ec)
- [Optimizing FTS5 External Content Tables and Vacuum Interactions](https://sqlite.work/optimizing-fts5-external-content-tables-and-vacuum-interactions/)
- [Notes on FTS5 Merging Algorithm — GitHub Gist, indutny](https://gist.github.com/indutny/ae44fd93dde2736205609d19a21b87cc)
- [SQLite Extensions — peewee 3.15.3 documentation](http://docs.peewee-orm.com/en/3.15.3/peewee/sqlite_ext.html)
- [sqlite-okapi-bm25 — external BM25 for FTS3/FTS4](https://github.com/rads/sqlite-okapi-bm25)
- [Advanced Full-Text Search Features in SQLite — Sling Academy](https://www.slingacademy.com/article/advanced-full-text-search-features-in-sqlite-you-should-know/)
- [SQLite Performance Tuning: FTS5 — DEV Community, LabEx](https://dev.to/labex/sqlite-performance-tuning-3-practical-labs-for-pragma-indexing-and-fts5-full-text-search-4gmk)
- [Full-Text Search Performance Tuning: Avoiding Pitfalls in SQLite — Sling Academy](https://www.slingacademy.com/article/full-text-search-performance-tuning-avoiding-pitfalls-in-sqlite/)
- [simonh.uk — SQLite FTS5 Triggers](https://simonh.uk/2021/05/11/sqlite-fts5-triggers/)
- [Structure of FTS5 Index in SQLite — darksi.de](https://darksi.de/13.sqlite-fts5-structure/)
- [Full text search — APSW 3.51.2.0 documentation](https://rogerbinns.github.io/apsw/textsearch.html)
