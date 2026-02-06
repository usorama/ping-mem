/**
 * Vector Index for semantic search using sqlite-vec
 *
 * Provides vector storage and cosine similarity search for memory embeddings.
 * Integrates with EventStore pattern and follows ping-mem architecture.
 *
 * @module search/VectorIndex
 * @version 1.0.0
 */

import { Database } from "bun:sqlite";

// Use require for CJS module compatibility with bun
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sqliteVec = require("sqlite-vec") as { load: (db: unknown) => void };
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import type { MemoryId, SessionId } from "../types/index.js";

// ============================================================================
// Vector Index Configuration
// ============================================================================

/**
 * SQLite-vec loader interface for dependency injection
 */
export interface SqliteVecLoader {
  load: (db: unknown) => void;
}

/**
 * Minimal database interface for dependency injection
 * Matches the bun:sqlite Database API used by VectorIndex
 */
export interface VectorDatabase {
  exec(sql: string): void;
  prepare(sql: string): VectorStatement;
  close(): void;
}

/**
 * Minimal statement interface for dependency injection
 */
export interface VectorStatement {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

/**
 * Configuration for the vector index
 */
export interface VectorIndexConfig {
  /** Path to SQLite database file */
  dbPath?: string;
  /** Vector dimensions (default: 768 for OpenAI embeddings) */
  vectorDimensions?: number;
  /** Cosine similarity threshold for relevance (default: 0.7) */
  similarityThreshold?: number;
  /** Enable WAL mode for better concurrency */
  walMode?: boolean;
  /** Busy timeout in milliseconds */
  busyTimeout?: number;
  /** Optional sqlite-vec loader for testing (uses require if not provided) */
  sqliteVecLoader?: SqliteVecLoader;
  /** Optional database instance for testing (bypasses sqlite-vec loading) */
  database?: VectorDatabase;
}

/**
 * Core config type (excludes optional injection properties)
 */
type CoreConfig = Omit<VectorIndexConfig, "database" | "sqliteVecLoader">;

/**
 * Default configuration
 */
const DEFAULT_CONFIG: Required<CoreConfig> = {
  dbPath: path.join(os.homedir(), ".ping-mem", "vectors.db"),
  vectorDimensions: 768,
  similarityThreshold: 0.7,
  walMode: true,
  busyTimeout: 5000,
};

/**
 * Vector search result with similarity score
 */
export interface VectorSearchResult {
  /** Memory ID that matched */
  memoryId: MemoryId;
  /** Cosine similarity score (0-1, higher is more similar) */
  similarity: number;
  /** Distance metric from sqlite-vec (lower is more similar) */
  distance: number;
  /** Original memory content */
  content: string;
  /** Session ID this memory belongs to */
  sessionId: SessionId;
  /** When this memory was indexed */
  indexedAt: Date;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Vector embedding with metadata
 */
export interface VectorEmbedding {
  /** Memory ID this vector represents */
  memoryId: MemoryId;
  /** Session ID this memory belongs to */
  sessionId: SessionId;
  /** Vector embedding (typically 768 dimensions for OpenAI) */
  embedding: Float32Array;
  /** Original text content */
  content: string;
  /** Memory category or type */
  category?: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Custom Error Classes
// ============================================================================

export class VectorIndexError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "VectorIndexError";
  }
}

export class VectorDimensionMismatchError extends VectorIndexError {
  constructor(expected: number, actual: number) {
    super(
      `Vector dimension mismatch: expected ${expected}, got ${actual}`,
      "DIMENSION_MISMATCH"
    );
  }
}

export class VectorNotFoundError extends VectorIndexError {
  constructor(memoryId: MemoryId) {
    super(`Vector not found for memory ID: ${memoryId}`, "VECTOR_NOT_FOUND");
  }
}

// ============================================================================
// Vector Index Implementation
// ============================================================================

/**
 * SQLite-based vector index using sqlite-vec for semantic search
 */
export class VectorIndex {
  private db: VectorDatabase;
  private config: Required<CoreConfig>;
  private insertStmt!: VectorStatement;
  private searchStmt!: VectorStatement;
  private getStmt!: VectorStatement;
  private deleteStmt!: VectorStatement;
  private listStmt!: VectorStatement;

  constructor(config: VectorIndexConfig = {}) {
    // Extract database and loader from config (not part of stored config)
    const { database, sqliteVecLoader, ...restConfig } = config;
    this.config = { ...DEFAULT_CONFIG, ...restConfig };

    // Use injected database or create a new one
    if (database) {
      // Use injected database (for testing)
      this.db = database;
    } else {
      // Ensure directory exists (skip for in-memory databases)
      if (this.config.dbPath !== ":memory:") {
        const dbDir = path.dirname(this.config.dbPath);
        if (!fs.existsSync(dbDir)) {
          fs.mkdirSync(dbDir, { recursive: true });
        }
      }

      // Initialize database
      this.db = new Database(this.config.dbPath) as unknown as VectorDatabase;

      // Load sqlite-vec extension (use injected loader or require)
      const loader = sqliteVecLoader || sqliteVec;
      loader.load(this.db);

      // Configure database
      if (this.config.walMode) {
        this.db.exec("PRAGMA journal_mode = WAL");
      }
      this.db.exec("PRAGMA foreign_keys = ON");
      this.db.exec(`PRAGMA busy_timeout = ${this.config.busyTimeout}`);

      // Initialize schema
      this.initializeSchema();
    }

    // Prepare frequently used statements
    this.prepareStatements();
  }

  /**
   * Initialize the database schema
   */
  private initializeSchema(): void {
    // Create virtual table for vectors with cosine distance
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vector_memories USING vec0(
        memory_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        content TEXT NOT NULL,
        category TEXT,
        indexed_at TEXT NOT NULL,
        metadata TEXT,
        embedding float[${this.config.vectorDimensions}] distance_metric=cosine
      )
    `);

    // Create companion table for relevance tracking
    // Note: vec0 virtual tables don't support ALTER TABLE
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_relevance (
        memory_id TEXT PRIMARY KEY,
        last_accessed TEXT,
        access_count INTEGER DEFAULT 0,
        relevance_score REAL DEFAULT 1.0
      )
    `);

    // Create indexes for better query performance
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_vector_memories_session
      ON vector_memories(session_id)
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_vector_memories_category
      ON vector_memories(category)
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memory_relevance_score
      ON memory_relevance(relevance_score)
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memory_relevance_accessed
      ON memory_relevance(last_accessed)
    `);
  }

  /**
   * Prepare frequently used SQL statements
   */
  private prepareStatements(): void {
    this.insertStmt = this.db.prepare(`
      INSERT OR REPLACE INTO vector_memories (
        memory_id, session_id, content, category, indexed_at, metadata, embedding
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    this.searchStmt = this.db.prepare(`
      SELECT
        memory_id,
        session_id,
        content,
        category,
        indexed_at,
        metadata,
        distance,
        (1 - distance) as similarity
      FROM vector_memories
      WHERE embedding MATCH ?
        AND (1 - distance) >= ?
      ORDER BY distance
      LIMIT ?
    `);

    this.getStmt = this.db.prepare(`
      SELECT
        memory_id,
        session_id,
        content,
        category,
        indexed_at,
        metadata
      FROM vector_memories
      WHERE memory_id = ?
    `);

    this.deleteStmt = this.db.prepare(`
      DELETE FROM vector_memories WHERE memory_id = ?
    `);

    this.listStmt = this.db.prepare(`
      SELECT
        memory_id,
        session_id,
        content,
        category,
        indexed_at,
        metadata
      FROM vector_memories
      WHERE session_id = ?
      ORDER BY indexed_at DESC
      LIMIT ?
    `);
  }

  /**
   * Store a vector embedding for a memory
   */
  async storeVector(vectorData: VectorEmbedding): Promise<void> {
    if (!this.insertStmt) {
      throw new VectorIndexError("Database not properly initialized", "DB_NOT_INITIALIZED");
    }

    // Validate vector dimensions
    if (vectorData.embedding.length !== this.config.vectorDimensions) {
      throw new VectorDimensionMismatchError(
        this.config.vectorDimensions,
        vectorData.embedding.length
      );
    }

    try {
      this.insertStmt.run(
        vectorData.memoryId,
        vectorData.sessionId,
        vectorData.content,
        vectorData.category || null,
        new Date().toISOString(),
        vectorData.metadata ? JSON.stringify(vectorData.metadata) : null,
        vectorData.embedding
      );
    } catch (error) {
      throw new VectorIndexError(
        `Failed to store vector: ${error instanceof Error ? error.message : 'Unknown error'}`,
        "STORE_FAILED"
      );
    }
  }

  /**
   * Perform semantic search using cosine similarity
   */
  async semanticSearch(
    queryEmbedding: Float32Array,
    options: {
      limit?: number;
      threshold?: number;
      sessionId?: SessionId;
      category?: string;
    } = {}
  ): Promise<VectorSearchResult[]> {
    if (!this.searchStmt) {
      throw new VectorIndexError("Database not properly initialized", "DB_NOT_INITIALIZED");
    }

    // Validate query vector dimensions
    if (queryEmbedding.length !== this.config.vectorDimensions) {
      throw new VectorDimensionMismatchError(
        this.config.vectorDimensions,
        queryEmbedding.length
      );
    }

    const limit = options.limit || 10;
    const threshold = options.threshold || this.config.similarityThreshold;

    try {
      let stmt = this.searchStmt;
      let params: any[] = [queryEmbedding, threshold, limit];

      // If filtering by session or category, use a different query
      if (options.sessionId || options.category) {
        let whereClause = "embedding MATCH ? AND (1 - distance) >= ?";
        params = [queryEmbedding, threshold];

        if (options.sessionId) {
          whereClause += " AND session_id = ?";
          params.push(options.sessionId);
        }

        if (options.category) {
          whereClause += " AND category = ?";
          params.push(options.category);
        }

        params.push(limit);

        stmt = this.db.prepare(`
          SELECT
            memory_id,
            session_id,
            content,
            category,
            indexed_at,
            metadata,
            distance,
            (1 - distance) as similarity
          FROM vector_memories
          WHERE ${whereClause}
          ORDER BY distance
          LIMIT ?
        `);
      }

      const rows = stmt.all(...params) as any[];

      return rows.map((row) => ({
        memoryId: row.memory_id,
        sessionId: row.session_id,
        content: row.content,
        similarity: row.similarity,
        distance: row.distance,
        indexedAt: new Date(row.indexed_at),
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      }));
    } catch (error) {
      throw new VectorIndexError(
        `Semantic search failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        "SEARCH_FAILED"
      );
    }
  }

  /**
   * Get vector metadata by memory ID
   */
  async getVector(memoryId: MemoryId): Promise<Omit<VectorEmbedding, 'embedding'> | null> {
    if (!this.getStmt) {
      throw new VectorIndexError("Database not properly initialized", "DB_NOT_INITIALIZED");
    }

    try {
      const row = this.getStmt.get(memoryId) as any;
      if (!row) {
        return null;
      }

      return {
        memoryId: row.memory_id,
        sessionId: row.session_id,
        content: row.content,
        category: row.category || undefined,
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      };
    } catch (error) {
      throw new VectorIndexError(
        `Failed to get vector: ${error instanceof Error ? error.message : 'Unknown error'}`,
        "GET_FAILED"
      );
    }
  }

  /**
   * Delete a vector by memory ID
   */
  async deleteVector(memoryId: MemoryId): Promise<boolean> {
    if (!this.deleteStmt) {
      throw new VectorIndexError("Database not properly initialized", "DB_NOT_INITIALIZED");
    }

    try {
      const result = this.deleteStmt.run(memoryId);
      return result.changes > 0;
    } catch (error) {
      throw new VectorIndexError(
        `Failed to delete vector: ${error instanceof Error ? error.message : 'Unknown error'}`,
        "DELETE_FAILED"
      );
    }
  }

  /**
   * List all vectors in a session
   */
  async listVectors(sessionId: SessionId, limit: number = 100): Promise<Omit<VectorEmbedding, 'embedding'>[]> {
    if (!this.listStmt) {
      throw new VectorIndexError("Database not properly initialized", "DB_NOT_INITIALIZED");
    }

    try {
      const rows = this.listStmt.all(sessionId, limit) as any[];

      return rows.map((row) => ({
        memoryId: row.memory_id,
        sessionId: row.session_id,
        content: row.content,
        category: row.category || undefined,
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      }));
    } catch (error) {
      throw new VectorIndexError(
        `Failed to list vectors: ${error instanceof Error ? error.message : 'Unknown error'}`,
        "LIST_FAILED"
      );
    }
  }

  /**
   * Get vector index statistics
   */
  async getStats(): Promise<{
    totalVectors: number;
    vectorDimensions: number;
    similarityThreshold: number;
    dbPath: string;
  }> {
    try {
      const result = this.db.prepare("SELECT COUNT(*) as count FROM vector_memories").get() as any;

      return {
        totalVectors: result.count,
        vectorDimensions: this.config.vectorDimensions,
        similarityThreshold: this.config.similarityThreshold,
        dbPath: this.config.dbPath,
      };
    } catch (error) {
      throw new VectorIndexError(
        `Failed to get stats: ${error instanceof Error ? error.message : 'Unknown error'}`,
        "STATS_FAILED"
      );
    }
  }

  /**
   * Close the database connection
   */
  async close(): Promise<void> {
    try {
      this.db.close();
    } catch (error) {
      throw new VectorIndexError(
        `Failed to close database: ${error instanceof Error ? error.message : 'Unknown error'}`,
        "CLOSE_FAILED"
      );
    }
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create an in-memory vector index for testing
 */
export function createInMemoryVectorIndex(config: Partial<VectorIndexConfig> = {}): VectorIndex {
  return new VectorIndex({
    ...config,
    dbPath: ":memory:",
  });
}

/**
 * Create a vector index with default configuration
 */
export function createVectorIndex(config: VectorIndexConfig = {}): VectorIndex {
  return new VectorIndex(config);
}