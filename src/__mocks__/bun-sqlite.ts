/**
 * Mock for bun:sqlite in test environment
 *
 * Includes support for:
 * - Standard SQL operations (CREATE TABLE, INSERT, SELECT, DELETE)
 * - sqlite-vec vec0 virtual tables with cosine similarity simulation
 */

// Vector storage for vec0 virtual tables
interface VectorRow {
  memory_id: string;
  session_id: string;
  content: string;
  category: string | null;
  indexed_at: string;
  metadata: string | null;
  embedding: Float32Array;
}

/**
 * Calculate cosine similarity between two vectors
 */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  if (magnitude === 0) return 0;

  return dotProduct / magnitude;
}

export class Database {
  private data: Map<string, any[]> = new Map();
  private vectorData: Map<string, VectorRow[]> = new Map();
  private isVec0Table: Set<string> = new Set();
  private preparedStatements: Map<string, Statement> = new Map();
  private _closed = false;

  constructor(public path: string) {}

  _isClosed(): boolean {
    return this._closed;
  }

  exec(sql: string): void {
    // Handle vec0 virtual tables
    if (sql.includes("USING vec0")) {
      const match = sql.match(
        /CREATE VIRTUAL TABLE (?:IF NOT EXISTS )?(\w+) USING vec0/
      );
      const tableName = match?.[1];
      if (tableName) {
        this.vectorData.set(tableName, []);
        this.isVec0Table.add(tableName);
      }
      return;
    }

    // Handle regular CREATE TABLE
    if (sql.includes("CREATE TABLE")) {
      const match = sql.match(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)/);
      const tableName = match?.[1];
      if (tableName) {
        this.data.set(tableName, []);
      }
    }

    // Handle CREATE INDEX (no-op but don't error)
    if (sql.includes("CREATE INDEX")) {
      return;
    }

    // Handle DELETE FROM
    if (sql.includes("DELETE FROM")) {
      const match = sql.match(/DELETE FROM (\w+)/);
      const tableName = match?.[1];
      if (tableName) {
        if (this.isVec0Table.has(tableName)) {
          this.vectorData.set(tableName, []);
        } else if (this.data.has(tableName)) {
          this.data.set(tableName, []);
        }
      }
    }

    // Handle PRAGMA (no-op)
    if (sql.includes("PRAGMA")) {
      return;
    }
  }

  prepare(sql: string): Statement {
    // Cache prepared statements for reuse
    let stmt = this.preparedStatements.get(sql);
    if (!stmt) {
      stmt = new Statement(this, sql);
      this.preparedStatements.set(sql, stmt);
    }
    return stmt;
  }

  transaction(fn: () => void): () => void {
    return fn;
  }

  close(): void {
    this._closed = true;
    this.data.clear();
    this.vectorData.clear();
    this.isVec0Table.clear();
    this.preparedStatements.clear();
  }

  // Internal methods for Statement class
  _getData(): Map<string, any[]> {
    return this.data;
  }

  _getVectorData(): Map<string, VectorRow[]> {
    return this.vectorData;
  }

  _isVec0Table(tableName: string): boolean {
    return this.isVec0Table.has(tableName);
  }
}

export class Statement {
  constructor(
    private db: Database,
    private sql: string
  ) {}

  run(...params: any[]): { changes: number } {
    // Check if database is closed
    if (this.db._isClosed()) {
      throw new Error("Database is closed");
    }

    // Handle vec0 INSERT OR REPLACE
    if (
      (this.sql.includes("INSERT INTO") ||
        this.sql.includes("INSERT OR REPLACE INTO")) &&
      this.sql.includes("vector_memories")
    ) {
      const vectorData = this.db._getVectorData();
      let rows = vectorData.get("vector_memories");
      if (!rows) {
        rows = [];
        vectorData.set("vector_memories", rows);
      }

      // Parse params: memory_id, session_id, content, category, indexed_at, metadata, embedding
      const [
        memory_id,
        session_id,
        content,
        category,
        indexed_at,
        metadata,
        embedding,
      ] = params;

      // Remove existing entry with same memory_id (for INSERT OR REPLACE)
      const existingIndex = rows.findIndex((r) => r.memory_id === memory_id);
      if (existingIndex >= 0) {
        rows.splice(existingIndex, 1);
      }

      rows.push({
        memory_id,
        session_id,
        content,
        category: category || null,
        indexed_at,
        metadata: metadata || null,
        embedding:
          embedding instanceof Float32Array
            ? embedding
            : new Float32Array(embedding || []),
      });

      return { changes: 1 };
    }

    // Handle vec0 DELETE
    if (this.sql.includes("DELETE FROM vector_memories")) {
      const vectorData = this.db._getVectorData();
      const rows = vectorData.get("vector_memories") || [];
      const memory_id = params[0];

      const initialLength = rows.length;
      const filteredRows = rows.filter((r) => r.memory_id !== memory_id);
      vectorData.set("vector_memories", filteredRows);

      return { changes: initialLength - filteredRows.length };
    }

    // Handle regular INSERT
    if (this.sql.includes("INSERT INTO")) {
      const match = this.sql.match(/INSERT INTO (\w+)/);
      const table = match?.[1];
      if (table && params.length > 0) {
        const data = this.db._getData();
        if (!data.has(table)) {
          data.set(table, []);
        }

        // If params is an object (named params), store it directly
        if (typeof params[0] === "object" && !Array.isArray(params[0])) {
          const cleanParams: any = {};
          for (const [key, value] of Object.entries(params[0])) {
            const cleanKey = key.startsWith("$") ? key.slice(1) : key;
            cleanParams[cleanKey] = value;
          }
          data.get(table)?.push(cleanParams);
        } else {
          // Positional params - store as array
          data.get(table)?.push(params);
        }

        return { changes: 1 };
      }
    }

    return { changes: 0 };
  }

  get(...params: any[]): any {
    // Check if database is closed
    if (this.db._isClosed()) {
      throw new Error("Database is closed");
    }

    // Handle vec0 SELECT by memory_id
    if (
      this.sql.includes("FROM vector_memories") &&
      this.sql.includes("WHERE memory_id")
    ) {
      const vectorData = this.db._getVectorData();
      const rows = vectorData.get("vector_memories") || [];
      const memory_id = params[0];

      const row = rows.find((r) => r.memory_id === memory_id);
      if (row) {
        return {
          memory_id: row.memory_id,
          session_id: row.session_id,
          content: row.content,
          category: row.category,
          indexed_at: row.indexed_at,
          metadata: row.metadata,
        };
      }
      return undefined;
    }

    // Handle SELECT 1 (connection test)
    if (this.sql.includes("SELECT 1")) {
      return { value: 1 };
    }

    // Handle COUNT(*)
    if (this.sql.includes("COUNT(*)")) {
      if (this.sql.includes("vector_memories")) {
        const vectorData = this.db._getVectorData();
        const rows = vectorData.get("vector_memories") || [];
        return { count: rows.length };
      }

      const match = this.sql.match(/FROM (\w+)/);
      const table = match?.[1];
      const data = this.db._getData();
      return { count: data.get(table || "events")?.length || 0 };
    }

    // Return first matching row from regular tables
    const match = this.sql.match(/FROM (\w+)/);
    const table = match?.[1];
    if (table) {
      const data = this.db._getData();
      const rows = data.get(table) || [];
      if (params.length > 0 && typeof params[0] === "object" && rows.length > 0) {
        // Simple filter by first param
        const filterKey = Object.keys(params[0])[0];
        if (filterKey) {
          const cleanKey = filterKey.startsWith("$")
            ? filterKey.slice(1)
            : filterKey;
          return rows.find((row) => row[cleanKey] === params[0][filterKey]);
        }
      }
      return rows[0];
    }
    return undefined;
  }

  all(...params: any[]): any[] {
    // Check if database is closed
    if (this.db._isClosed()) {
      throw new Error("Database is closed");
    }

    // Handle vec0 similarity search with MATCH
    if (
      this.sql.includes("FROM vector_memories") &&
      this.sql.includes("embedding MATCH")
    ) {
      const vectorData = this.db._getVectorData();
      const rows = vectorData.get("vector_memories") || [];

      // Extract query embedding, threshold, and limit from params
      // Params: [embedding, threshold, ...filters, limit]
      const queryEmbedding = params[0] as Float32Array;
      const threshold = params[1] as number;

      // Find optional session_id and category filters
      let sessionFilter: string | undefined;
      let categoryFilter: string | undefined;
      let limit = 10;

      // Parse SQL to determine what filters are present
      const hasSessionFilter = this.sql.includes("session_id = ?");
      const hasCategoryFilter = this.sql.includes("category = ?");

      let paramIndex = 2;
      if (hasSessionFilter) {
        sessionFilter = params[paramIndex++];
      }
      if (hasCategoryFilter) {
        categoryFilter = params[paramIndex++];
      }
      limit = params[paramIndex] || 10;

      // Calculate similarities and filter
      const results = rows
        .map((row) => {
          const similarity = cosineSimilarity(queryEmbedding, row.embedding);
          const distance = 1 - similarity;
          return {
            memory_id: row.memory_id,
            session_id: row.session_id,
            content: row.content,
            category: row.category,
            indexed_at: row.indexed_at,
            metadata: row.metadata,
            distance,
            similarity,
          };
        })
        .filter((r) => r.similarity >= threshold)
        .filter((r) => !sessionFilter || r.session_id === sessionFilter)
        .filter((r) => !categoryFilter || r.category === categoryFilter)
        .sort((a, b) => a.distance - b.distance)
        .slice(0, limit);

      return results;
    }

    // Handle vec0 list by session_id
    if (
      this.sql.includes("FROM vector_memories") &&
      this.sql.includes("WHERE session_id")
    ) {
      const vectorData = this.db._getVectorData();
      const rows = vectorData.get("vector_memories") || [];
      const session_id = params[0];
      const limit = params[1] || 100;

      return rows
        .filter((r) => r.session_id === session_id)
        .sort(
          (a, b) =>
            new Date(b.indexed_at).getTime() - new Date(a.indexed_at).getTime()
        )
        .slice(0, limit)
        .map((row) => ({
          memory_id: row.memory_id,
          session_id: row.session_id,
          content: row.content,
          category: row.category,
          indexed_at: row.indexed_at,
          metadata: row.metadata,
        }));
    }

    // Handle regular SELECT with multiple results
    const match = this.sql.match(/FROM (\w+)/);
    const table = match?.[1];
    if (table) {
      const data = this.db._getData();
      const rows = data.get(table) || [];
      if (params.length > 0 && typeof params[0] === "object" && rows.length > 0) {
        // Simple filter by first param
        const filterKey = Object.keys(params[0])[0];
        if (filterKey) {
          const cleanKey = filterKey.startsWith("$")
            ? filterKey.slice(1)
            : filterKey;
          return rows.filter((row) => row[cleanKey] === params[0][filterKey]);
        }
      }
      return rows;
    }
    return [];
  }
}
