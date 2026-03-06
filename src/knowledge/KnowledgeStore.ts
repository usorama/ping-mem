/**
 * SQLite-backed knowledge entry store with FTS5 full-text search.
 *
 * Provides structured knowledge management for cross-agent and
 * cross-project knowledge sharing. Entries are keyed by
 * SHA-256(projectId + "::" + title) for deterministic deduplication.
 *
 * @module knowledge/KnowledgeStore
 */

import type Database from "bun:sqlite";

// ============================================================================
// Types
// ============================================================================

export interface KnowledgeEntry {
  id: string;
  projectId: string;
  title: string;
  solution: string;
  symptoms?: string;
  rootCause?: string;
  tags: string[];
  agentId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeSearchOptions {
  query: string;
  projectId?: string;
  crossProject?: boolean;
  tags?: string[];
  limit?: number;
}

export interface KnowledgeSearchResult {
  entry: KnowledgeEntry;
  rank: number;
}

// ============================================================================
// Row shape from SQLite
// ============================================================================

interface KnowledgeRow {
  id: string;
  project_id: string;
  title: string;
  solution: string;
  symptoms: string | null;
  root_cause: string | null;
  tags: string;
  agent_id: string | null;
  created_at: string;
  updated_at: string;
}

interface KnowledgeSearchRow extends KnowledgeRow {
  rank: number;
}

interface CountRow {
  project_id: string;
  cnt: number;
}

// ============================================================================
// Helpers
// ============================================================================

function computeKnowledgeId(projectId: string, title: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(projectId + "::" + title);
  return hasher.digest("hex");
}

function rowToEntry(row: KnowledgeRow): KnowledgeEntry {
  const entry: KnowledgeEntry = {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    solution: row.solution,
    tags: (() => { try { return JSON.parse(row.tags) as string[]; } catch { return []; } })(),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.symptoms !== null) {
    entry.symptoms = row.symptoms;
  }
  if (row.root_cause !== null) {
    entry.rootCause = row.root_cause;
  }
  if (row.agent_id !== null) {
    entry.agentId = row.agent_id;
  }
  return entry;
}

// ============================================================================
// KnowledgeStore
// ============================================================================

export class KnowledgeStore {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
    this.ensureTables();
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_entries (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        solution TEXT NOT NULL,
        symptoms TEXT,
        root_cause TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        agent_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
        title, solution, symptoms, root_cause, tags,
        content='knowledge_entries',
        content_rowid='rowid'
      )
    `);

    // Triggers to keep FTS in sync
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS knowledge_ai AFTER INSERT ON knowledge_entries BEGIN
        INSERT INTO knowledge_fts(rowid, title, solution, symptoms, root_cause, tags)
        VALUES (new.rowid, new.title, new.solution, new.symptoms, new.root_cause, new.tags);
      END
    `);

    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS knowledge_ad AFTER DELETE ON knowledge_entries BEGIN
        INSERT INTO knowledge_fts(knowledge_fts, rowid, title, solution, symptoms, root_cause, tags)
        VALUES ('delete', old.rowid, old.title, old.solution, old.symptoms, old.root_cause, old.tags);
      END
    `);

    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS knowledge_au AFTER UPDATE ON knowledge_entries BEGIN
        INSERT INTO knowledge_fts(knowledge_fts, rowid, title, solution, symptoms, root_cause, tags)
        VALUES ('delete', old.rowid, old.title, old.solution, old.symptoms, old.root_cause, old.tags);
        INSERT INTO knowledge_fts(rowid, title, solution, symptoms, root_cause, tags)
        VALUES (new.rowid, new.title, new.solution, new.symptoms, new.root_cause, new.tags);
      END
    `);

    // Performance indexes
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_knowledge_project_id ON knowledge_entries(project_id)`);
  }

  /**
   * Upsert a knowledge entry.
   * ID = SHA-256(projectId + "::" + title)
   */
  ingest(
    entry: Omit<KnowledgeEntry, "id" | "createdAt" | "updatedAt">
  ): KnowledgeEntry {
    const id = computeKnowledgeId(entry.projectId, entry.title);
    const now = new Date().toISOString();
    const tagsJson = JSON.stringify(entry.tags);

    this.db
      .prepare(
        `INSERT INTO knowledge_entries (id, project_id, title, solution, symptoms, root_cause, tags, agent_id, created_at, updated_at)
         VALUES ($id, $project_id, $title, $solution, $symptoms, $root_cause, $tags, $agent_id, $created_at, $updated_at)
         ON CONFLICT(id) DO UPDATE SET
           solution = $solution,
           symptoms = $symptoms,
           root_cause = $root_cause,
           tags = $tags,
           agent_id = $agent_id,
           updated_at = $updated_at`
      )
      .run({
        $id: id,
        $project_id: entry.projectId,
        $title: entry.title,
        $solution: entry.solution,
        $symptoms: entry.symptoms ?? null,
        $root_cause: entry.rootCause ?? null,
        $tags: tagsJson,
        $agent_id: entry.agentId ?? null,
        $created_at: now,
        $updated_at: now,
      });

    // Read back to get actual created_at (may differ on update)
    const row = this.db
      .prepare("SELECT * FROM knowledge_entries WHERE id = $id")
      .get({ $id: id }) as KnowledgeRow;

    return rowToEntry(row);
  }

  /**
   * Full-text search using FTS5 MATCH.
   *
   * When crossProject is false (default), filters by projectId.
   * When crossProject is true, searches all projects.
   */
  search(options: KnowledgeSearchOptions): KnowledgeSearchResult[] {
    const limit = options.limit ?? 20;
    const crossProject = options.crossProject ?? false;

    // Build the FTS query
    let sql: string;
    const params: Record<string, string | number> = {};

    if (crossProject || !options.projectId) {
      sql = `
        SELECT ke.*, fts.rank
        FROM knowledge_fts fts
        JOIN knowledge_entries ke ON ke.rowid = fts.rowid
        WHERE knowledge_fts MATCH $query
      `;
    } else {
      sql = `
        SELECT ke.*, fts.rank
        FROM knowledge_fts fts
        JOIN knowledge_entries ke ON ke.rowid = fts.rowid
        WHERE knowledge_fts MATCH $query
          AND ke.project_id = $project_id
      `;
      params.$project_id = options.projectId;
    }

    // Tag filtering: entries must contain all specified tags
    if (options.tags && options.tags.length > 0) {
      for (let i = 0; i < options.tags.length; i++) {
        sql += ` AND EXISTS (SELECT 1 FROM json_each(ke.tags) WHERE json_each.value = $tag${i})`;
        params[`$tag${i}`] = options.tags[i]!;
      }
    }

    sql += ` ORDER BY fts.rank LIMIT $limit`;
    // Strip FTS5 operators that could alter query semantics
    let sanitized = options.query
      .replace(/[*^():]/g, " ")
      .replace(/\b(AND|OR|NOT|NEAR)\b/gi, " ")
      .trim();
    if (!sanitized) sanitized = options.query.trim(); // fallback to original if everything was stripped
    params.$query = '"' + sanitized.replace(/"/g, '""') + '"';
    params.$limit = limit;

    const rows = this.db.prepare(sql).all(params) as KnowledgeSearchRow[];

    return rows.map((row) => ({
      entry: rowToEntry(row),
      rank: row.rank,
    }));
  }

  /**
   * Get a knowledge entry by id.
   */
  get(id: string): KnowledgeEntry | undefined {
    const row = this.db
      .prepare("SELECT * FROM knowledge_entries WHERE id = $id")
      .get({ $id: id }) as KnowledgeRow | null;

    return row ? rowToEntry(row) : undefined;
  }

  /**
   * Delete a knowledge entry by id.
   * Returns true if a row was deleted.
   */
  delete(id: string): boolean {
    const result = this.db
      .prepare("DELETE FROM knowledge_entries WHERE id = $id")
      .run({ $id: id });

    return result.changes > 0;
  }

  /**
   * Aggregate stats: total entries and counts by project.
   */
  stats(): { totalEntries: number; byProject: Record<string, number> } {
    const totalRow = this.db
      .prepare("SELECT COUNT(*) as cnt FROM knowledge_entries")
      .get() as { cnt: number };

    const projectRows = this.db
      .prepare(
        "SELECT project_id, COUNT(*) as cnt FROM knowledge_entries GROUP BY project_id"
      )
      .all() as CountRow[];

    const byProject: Record<string, number> = {};
    for (const row of projectRows) {
      byProject[row.project_id] = row.cnt;
    }

    return {
      totalEntries: totalRow.cnt,
      byProject,
    };
  }
}
