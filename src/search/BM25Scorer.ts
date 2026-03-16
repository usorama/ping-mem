/**
 * BM25Scorer: Deterministic BM25+TF-IDF ranking with SQLite inverted index
 *
 * Replaces DeterministicVectorizer (n-gram hash) as the default ranker.
 * Uses a proper inverted index stored in SQLite for deterministic, reproducible
 * BM25 scoring with configurable k1 and b parameters.
 *
 * Same input -> same scores (deterministic).
 *
 * @module search/BM25Scorer
 */

import { Database } from "bun:sqlite";

export interface BM25ScorerOptions {
  /** BM25 k1 parameter — controls term frequency saturation (default: 1.5) */
  k1?: number;
  /** BM25 b parameter — controls document length normalization (default: 0.75) */
  b?: number;
}

export interface BM25SearchResult {
  chunkId: string;
  score: number;
}

/**
 * Tokenize text into lowercase terms, stripping punctuation.
 * Deterministic: same text -> same tokens, always.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter((t) => t.length > 0);
}

/**
 * BM25Scorer with SQLite-backed inverted index.
 *
 * Stores term -> [chunkId, tf] mappings in SQLite during ingestion.
 * Computes IDF as log(1 + (N - df + 0.5) / (df + 0.5)) per the Lucene BM25 variant.
 * Scores are fully deterministic: same corpus + same query = same results.
 */
export class BM25Scorer {
  private readonly db: Database;
  private readonly k1: number;
  private readonly b: number;

  private readonly insertTermStmt: ReturnType<Database["prepare"]>;
  private readonly deleteChunkTermsStmt: ReturnType<Database["prepare"]>;
  private readonly insertDocLenStmt: ReturnType<Database["prepare"]>;
  private readonly deleteDocLenStmt: ReturnType<Database["prepare"]>;
  private readonly getDocLenStmt: ReturnType<Database["prepare"]>;
  private readonly getAvgDlStmt: ReturnType<Database["prepare"]>;
  private readonly getDocCountStmt: ReturnType<Database["prepare"]>;
  private readonly getDfStmt: ReturnType<Database["prepare"]>;
  private readonly getTermPostingsStmt: ReturnType<Database["prepare"]>;

  constructor(db: Database, options: BM25ScorerOptions = {}) {
    this.db = db;
    this.k1 = options.k1 ?? 1.5;
    this.b = options.b ?? 0.75;

    this.initTables();

    this.insertTermStmt = this.db.prepare(
      `INSERT OR REPLACE INTO bm25_inverted_index (term, chunk_id, tf) VALUES (?, ?, ?)`
    );
    this.deleteChunkTermsStmt = this.db.prepare(
      `DELETE FROM bm25_inverted_index WHERE chunk_id = ?`
    );
    this.insertDocLenStmt = this.db.prepare(
      `INSERT OR REPLACE INTO bm25_doc_lengths (chunk_id, doc_length) VALUES (?, ?)`
    );
    this.deleteDocLenStmt = this.db.prepare(
      `DELETE FROM bm25_doc_lengths WHERE chunk_id = ?`
    );
    this.getDocLenStmt = this.db.prepare(
      `SELECT doc_length FROM bm25_doc_lengths WHERE chunk_id = ?`
    );
    this.getAvgDlStmt = this.db.prepare(
      `SELECT AVG(doc_length) as avg_dl FROM bm25_doc_lengths`
    );
    this.getDocCountStmt = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM bm25_doc_lengths`
    );
    this.getDfStmt = this.db.prepare(
      `SELECT COUNT(DISTINCT chunk_id) as df FROM bm25_inverted_index WHERE term = ?`
    );
    this.getTermPostingsStmt = this.db.prepare(
      `SELECT chunk_id, tf FROM bm25_inverted_index WHERE term = ?`
    );
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bm25_inverted_index (
        term TEXT NOT NULL, chunk_id TEXT NOT NULL, tf REAL NOT NULL,
        PRIMARY KEY (term, chunk_id)
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_bm25_ii_term ON bm25_inverted_index (term)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_bm25_ii_chunk ON bm25_inverted_index (chunk_id)`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bm25_doc_lengths (
        chunk_id TEXT PRIMARY KEY, doc_length INTEGER NOT NULL
      )
    `);
  }

  indexDocument(chunkId: string, content: string): void {
    const tokens = tokenize(content);
    if (tokens.length === 0) return;
    this.deleteChunkTermsStmt.run(chunkId);
    this.deleteDocLenStmt.run(chunkId);
    const tfMap = new Map<string, number>();
    for (const token of tokens) {
      tfMap.set(token, (tfMap.get(token) ?? 0) + 1);
    }
    this.insertDocLenStmt.run(chunkId, tokens.length);
    for (const [term, tf] of tfMap.entries()) {
      this.insertTermStmt.run(term, chunkId, tf);
    }
  }

  removeDocument(chunkId: string): void {
    this.deleteChunkTermsStmt.run(chunkId);
    this.deleteDocLenStmt.run(chunkId);
  }

  removeDocuments(chunkIds: string[]): void {
    const txn = this.db.transaction(() => {
      for (const id of chunkIds) {
        this.deleteChunkTermsStmt.run(id);
        this.deleteDocLenStmt.run(id);
      }
    });
    txn();
  }

  indexDocumentsBatch(docs: Array<{ chunkId: string; content: string }>): void {
    const txn = this.db.transaction(() => {
      for (const doc of docs) {
        this.indexDocument(doc.chunkId, doc.content);
      }
    });
    txn();
  }

  search(query: string, limit = 10, filterChunkIds?: Set<string>): BM25SearchResult[] {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];
    const N = this.getDocumentCount();
    if (N === 0) return [];
    const avgDl = this.getAverageDocLength();
    const uniqueTerms = [...new Set(queryTokens)];
    const scores = new Map<string, number>();

    for (const term of uniqueTerms) {
      const df = this.getDocumentFrequency(term);
      if (df === 0) continue;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      if (idf <= 0) continue;
      const postings = this.getTermPostings(term);
      for (const posting of postings) {
        if (filterChunkIds && !filterChunkIds.has(posting.chunkId)) continue;
        const docLen = this.getDocLength(posting.chunkId);
        const tf = posting.tf;
        const numerator = tf * (this.k1 + 1);
        const denominator = tf + this.k1 * (1 - this.b + this.b * (docLen / avgDl));
        const termScore = idf * (numerator / denominator);
        scores.set(posting.chunkId, (scores.get(posting.chunkId) ?? 0) + termScore);
      }
    }

    const results: BM25SearchResult[] = [];
    for (const [chunkId, score] of scores.entries()) {
      results.push({ chunkId, score });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, Math.max(1, Math.min(limit, 1000)));
  }

  getDocumentCount(): number {
    const row = this.getDocCountStmt.get() as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  }

  getAverageDocLength(): number {
    const row = this.getAvgDlStmt.get() as { avg_dl: number | null } | undefined;
    return row?.avg_dl ?? 0;
  }

  getDocumentFrequency(term: string): number {
    const row = this.getDfStmt.get(term) as { df: number } | undefined;
    return row?.df ?? 0;
  }

  private getDocLength(chunkId: string): number {
    const row = this.getDocLenStmt.get(chunkId) as { doc_length: number } | undefined;
    return row?.doc_length ?? 0;
  }

  private getTermPostings(term: string): Array<{ chunkId: string; tf: number }> {
    const rows = this.getTermPostingsStmt.all(term) as Array<{ chunk_id: string; tf: number }>;
    return rows.map((r) => ({ chunkId: r.chunk_id, tf: r.tf }));
  }
}
