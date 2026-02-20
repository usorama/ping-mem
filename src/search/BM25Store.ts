import { Database } from "bun:sqlite";

export interface BM25StoredDocument {
  memoryId: string;
  sessionId: string;
  content: string;
  indexedAt: Date;
  metadata?: string;
}

/**
 * Persistent BM25 index storage via SQLite.
 * Saves BM25 documents so the index survives restarts without rebuild.
 */
export class BM25Store {
  private db: Database;
  private insertStmt: ReturnType<Database["prepare"]>;
  private deleteStmt: ReturnType<Database["prepare"]>;
  private loadStmt: ReturnType<Database["prepare"]>;

  constructor(db: Database) {
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bm25_documents (
        memory_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        content TEXT NOT NULL,
        indexed_at INTEGER NOT NULL,
        metadata TEXT
      )
    `);
    this.insertStmt = this.db.prepare(
      `INSERT OR REPLACE INTO bm25_documents (memory_id, session_id, content, indexed_at, metadata)
       VALUES (?, ?, ?, ?, ?)`
    );
    this.deleteStmt = this.db.prepare(
      `DELETE FROM bm25_documents WHERE memory_id = ?`
    );
    this.loadStmt = this.db.prepare(
      `SELECT memory_id, session_id, content, indexed_at, metadata FROM bm25_documents`
    );
  }

  addDocument(
    memoryId: string,
    sessionId: string,
    content: string,
    indexedAt: Date,
    metadata?: Record<string, unknown>
  ): void {
    this.insertStmt.run(
      memoryId,
      sessionId,
      content,
      indexedAt.getTime(),
      metadata ? JSON.stringify(metadata) : null
    );
  }

  removeDocument(memoryId: string): void {
    this.deleteStmt.run(memoryId);
  }

  loadAll(): BM25StoredDocument[] {
    const rows = this.loadStmt.all() as Array<{
      memory_id: string;
      session_id: string;
      content: string;
      indexed_at: number;
      metadata: string | null;
    }>;
    return rows.map((row) => {
      const doc: BM25StoredDocument = {
        memoryId: row.memory_id,
        sessionId: row.session_id,
        content: row.content,
        indexedAt: new Date(row.indexed_at),
      };
      if (row.metadata !== null) {
        doc.metadata = row.metadata;
      }
      return doc;
    });
  }
}
