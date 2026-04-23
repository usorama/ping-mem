/**
 * CodeChunkStore — SQLite FTS5-backed code chunk search
 *
 * Provides BM25-scored full-text search over indexed code chunks
 * using SQLite's FTS5 extension with porter stemming and unicode61 tokenizer.
 *
 * Note: This file uses Database.exec() from bun:sqlite (NOT child_process.exec).
 *
 * @module search/CodeChunkStore
 */

import { Database } from "bun:sqlite";

export type ChunkType = "function" | "class" | "file" | "block";

export interface CodeChunk {
  chunkId: string;
  projectId: string;
  filePath: string;
  content: string;
  startLine: number;
  endLine: number;
  chunkType: ChunkType;
  language?: string;
}

export interface CodeChunkSearchResult {
  chunkId: string;
  projectId: string;
  filePath: string;
  content: string;
  startLine: number;
  endLine: number;
  chunkType: ChunkType;
  language: string;
  score: number;
}

export interface CodeChunkRow {
  chunkId: string;
  projectId: string;
  filePath: string;
  content: string;
  startLine: number;
  endLine: number;
  chunkType: ChunkType;
  language: string;
}

export class CodeChunkStore {
  private readonly db: Database;
  private readonly insertChunkStmt: ReturnType<Database["prepare"]>;
  private readonly insertFtsStmt: ReturnType<Database["prepare"]>;
  private readonly deleteChunkStmt: ReturnType<Database["prepare"]>;
  private readonly deleteFtsStmt: ReturnType<Database["prepare"]>;
  private readonly countStmt: ReturnType<Database["prepare"]>;

  constructor(db: Database) {
    this.db = db;
    this.initTables();

    this.insertChunkStmt = this.db.prepare(
      `INSERT OR REPLACE INTO code_chunks
       (chunk_id, project_id, file_path, content, start_line, end_line, chunk_type, language, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    this.insertFtsStmt = this.db.prepare(
      `INSERT INTO code_fts (content, file_path, chunk_id, project_id)
       VALUES (?, ?, ?, ?)`
    );

    this.deleteChunkStmt = this.db.prepare(
      `DELETE FROM code_chunks WHERE chunk_id = ?`
    );

    this.deleteFtsStmt = this.db.prepare(
      `DELETE FROM code_fts WHERE chunk_id = ?`
    );

    this.countStmt = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM code_chunks`
    );
  }

  private initTables(): void {
    // Metadata table for code chunks
    const createChunks = `
      CREATE TABLE IF NOT EXISTS code_chunks (
        chunk_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        content TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        chunk_type TEXT NOT NULL,
        language TEXT,
        indexed_at TEXT NOT NULL
      )
    `;
    this.db.exec(createChunks);

    // FTS5 virtual table for full-text search with BM25 scoring
    const createFts = `
      CREATE VIRTUAL TABLE IF NOT EXISTS code_fts USING fts5(
        content,
        file_path,
        chunk_id UNINDEXED,
        project_id UNINDEXED,
        tokenize = 'porter unicode61'
      )
    `;
    this.db.exec(createFts);
  }

  addChunk(chunk: CodeChunk): void {
    // Remove existing FTS entry if present (for upsert semantics)
    this.deleteFtsStmt.run(chunk.chunkId);

    this.insertChunkStmt.run(
      chunk.chunkId,
      chunk.projectId,
      chunk.filePath,
      chunk.content,
      chunk.startLine,
      chunk.endLine,
      chunk.chunkType,
      chunk.language ?? null,
      new Date().toISOString(),
    );

    this.insertFtsStmt.run(
      chunk.content,
      chunk.filePath,
      chunk.chunkId,
      chunk.projectId,
    );
  }

  removeChunk(chunkId: string): void {
    this.deleteFtsStmt.run(chunkId);
    this.deleteChunkStmt.run(chunkId);
  }

  removeProject(projectId: string): void {
    const chunks = this.db.prepare(
      `SELECT chunk_id FROM code_chunks WHERE project_id = ?`
    ).all(projectId) as Array<{ chunk_id: string }>;

    for (const chunk of chunks) {
      this.deleteFtsStmt.run(chunk.chunk_id);
    }

    this.db.prepare(
      `DELETE FROM code_chunks WHERE project_id = ?`
    ).run(projectId);
  }

  search(query: string, projectId?: string, limit = 10): CodeChunkSearchResult[] {
    if (!query.trim()) return [];

    const queryTerms = tokenizeFts5Terms(query);
    if (queryTerms.length === 0) return [];
    const safeQuery = buildFts5Query(queryTerms);

    const clampedLimit = Math.max(1, Math.min(Math.floor(limit), 1000));

    let sql: string;
    const params: Array<string | number> = [];

    if (projectId) {
      sql = `
        SELECT
          f.chunk_id,
          f.project_id,
          c.file_path,
          c.content,
          c.start_line,
          c.end_line,
          c.chunk_type,
          c.language,
          (-1.0 * bm25(code_fts, 1.0, 2.0)) AS score
        FROM code_fts f
        JOIN code_chunks c ON f.chunk_id = c.chunk_id
        WHERE code_fts MATCH ?
          AND f.project_id = ?
        ORDER BY score DESC
        LIMIT ?
      `;
      params.push(safeQuery, projectId, clampedLimit);
    } else {
      sql = `
        SELECT
          f.chunk_id,
          f.project_id,
          c.file_path,
          c.content,
          c.start_line,
          c.end_line,
          c.chunk_type,
          c.language,
          (-1.0 * bm25(code_fts, 1.0, 2.0)) AS score
        FROM code_fts f
        JOIN code_chunks c ON f.chunk_id = c.chunk_id
        WHERE code_fts MATCH ?
        ORDER BY score DESC
        LIMIT ?
      `;
      params.push(safeQuery, clampedLimit);
    }

    const rows = this.db.prepare(sql).all(...params) as Array<{
      chunk_id: string;
      project_id: string;
      file_path: string;
      content: string;
      start_line: number;
      end_line: number;
      chunk_type: string;
      language: string | null;
      score: number;
    }>;

    const results = rows.map((row) => ({
      chunkId: row.chunk_id,
      projectId: row.project_id,
      filePath: row.file_path,
      content: row.content,
      startLine: row.start_line,
      endLine: row.end_line,
      chunkType: row.chunk_type as ChunkType,
      language: row.language ?? "",
      score: row.score,
    }));

    // Enforce lexical evidence: avoid returning chunks that match only weakly
    // on a single common token (for example "api") when the query has multiple
    // distinctive terms.
    const normalizedTerms = queryTerms.map((t) => t.toLowerCase());
    const minOverlap = normalizedTerms.length >= 2 ? 2 : 1;
    return results.filter((result) => {
      const haystack = `${result.filePath}\n${result.content}`.toLowerCase();
      let overlap = 0;
      for (const term of normalizedTerms) {
        if (haystack.includes(term)) overlap += 1;
      }
      return overlap >= Math.min(minOverlap, normalizedTerms.length);
    });
  }

  getChunkCount(): number {
    const row = this.countStmt.get() as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  }

  getChunksForFile(projectId: string, filePath: string): CodeChunkRow[] {
    const rows = this.db.prepare(
      `SELECT
         chunk_id,
         project_id,
         file_path,
         content,
         start_line,
         end_line,
         chunk_type,
         language
       FROM code_chunks
       WHERE project_id = ?
         AND file_path = ?
       ORDER BY start_line ASC`
    ).all(projectId, filePath) as Array<{
      chunk_id: string;
      project_id: string;
      file_path: string;
      content: string;
      start_line: number;
      end_line: number;
      chunk_type: string;
      language: string | null;
    }>;

    return rows.map((row) => ({
      chunkId: row.chunk_id,
      projectId: row.project_id,
      filePath: row.file_path,
      content: row.content,
      startLine: row.start_line,
      endLine: row.end_line,
      chunkType: row.chunk_type as ChunkType,
      language: row.language ?? "",
    }));
  }
}

/**
 * Sanitize user input for FTS5 MATCH queries.
 * Strips special FTS5 operators and wraps each token in double quotes
 * to prevent injection of FTS5 syntax.
 */
function tokenizeFts5Terms(query: string): string[] {
  return query
    .replace(/[(){}*^"]/g, " ")
    // Path-like and symbol-heavy queries are common for code lookups.
    // Split on non-word separators so "/api/v1/codebase/projects" becomes
    // searchable terms instead of one punctuation-heavy token.
    .replace(/[^A-Za-z0-9_]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .filter((t) => !["AND", "OR", "NOT", "NEAR"].includes(t.toUpperCase()));
}

function buildFts5Query(tokens: string[]): string {
  return tokens.map((t) => `"${t}"`).join(" ");
}
