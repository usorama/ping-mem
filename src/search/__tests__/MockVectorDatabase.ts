/**
 * Mock VectorDatabase for testing
 *
 * Simulates sqlite-vec vec0 virtual table behavior in memory.
 * Use this to create VectorIndex instances in tests without requiring sqlite-vec.
 *
 * @module search/__tests__/MockVectorDatabase
 */

import type { VectorDatabase, VectorStatement } from "../VectorIndex.js";

// ============================================================================
// Mock Types
// ============================================================================

interface MockVectorRow {
  memory_id: string;
  session_id: string;
  content: string;
  category: string | null;
  indexed_at: string;
  metadata: string | null;
  embedding: Float32Array;
}

interface DatabaseState {
  closed: boolean;
}

// ============================================================================
// Mock Statement
// ============================================================================

class MockStatement implements VectorStatement {
  constructor(
    private sql: string,
    private storage: Map<string, MockVectorRow>,
    private config: { vectorDimensions: number },
    private dbState: DatabaseState
  ) {}

  run(...params: unknown[]): { changes: number } {
    if (this.dbState.closed) {
      throw new Error("Database is closed");
    }

    if (this.sql.includes("INSERT OR REPLACE")) {
      const [memoryId, sessionId, content, category, indexedAt, metadata, embedding] =
        params as [string, string, string, string | null, string, string | null, Float32Array];

      this.storage.set(memoryId, {
        memory_id: memoryId,
        session_id: sessionId,
        content: content,
        category: category,
        indexed_at: indexedAt,
        metadata: metadata,
        embedding: embedding,
      });
      return { changes: 1 };
    }

    if (this.sql.includes("DELETE FROM")) {
      const memoryId = params[0] as string;
      const deleted = this.storage.delete(memoryId);
      return { changes: deleted ? 1 : 0 };
    }

    return { changes: 0 };
  }

  get(...params: unknown[]): unknown {
    if (this.dbState.closed) {
      throw new Error("Database is closed");
    }

    // Handle SELECT by memory_id
    if (this.sql.includes("WHERE memory_id = ?")) {
      const memoryId = params[0] as string;
      const row = this.storage.get(memoryId);
      return row || null;
    }

    // Handle COUNT(*)
    if (this.sql.includes("COUNT(*)")) {
      return { count: this.storage.size };
    }

    return null;
  }

  all(...params: unknown[]): unknown[] {
    if (this.dbState.closed) {
      throw new Error("Database is closed");
    }

    // Handle vector search with MATCH
    if (this.sql.includes("embedding MATCH")) {
      const queryEmbedding = params[0] as Float32Array;
      const threshold = params[1] as number;
      const limit = params[params.length - 1] as number;

      // Extract optional filters from params
      let sessionIdFilter: string | undefined;
      let categoryFilter: string | undefined;

      if (this.sql.includes("session_id = ?")) {
        sessionIdFilter = params[2] as string;
        if (this.sql.includes("category = ?")) {
          categoryFilter = params[3] as string;
        }
      } else if (this.sql.includes("category = ?")) {
        categoryFilter = params[2] as string;
      }

      const results: Array<MockVectorRow & { distance: number; similarity: number }> = [];

      for (const row of this.storage.values()) {
        // Apply filters
        if (sessionIdFilter && row.session_id !== sessionIdFilter) continue;
        if (categoryFilter && row.category !== categoryFilter) continue;

        // Calculate cosine similarity
        const similarity = this.cosineSimilarity(queryEmbedding, row.embedding);
        if (similarity >= threshold) {
          results.push({
            ...row,
            distance: 1 - similarity,
            similarity: similarity,
          });
        }
      }

      // Sort by similarity (descending) and apply limit
      return results
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit);
    }

    // Handle list by session_id
    if (this.sql.includes("WHERE session_id = ?")) {
      const sessionId = params[0] as string;
      const limit = params[1] as number;

      return Array.from(this.storage.values())
        .filter((row) => row.session_id === sessionId)
        .slice(0, limit);
    }

    return [];
  }

  /**
   * Calculate cosine similarity between two vectors
   */
  private cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i]! * b[i]!;
      normA += a[i]! * a[i]!;
      normB += b[i]! * b[i]!;
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator === 0 ? 0 : dotProduct / denominator;
  }
}

// ============================================================================
// Mock Database
// ============================================================================

/**
 * Mock database that simulates vec0 virtual table behavior in memory.
 * Use this with VectorIndex's database injection to test without sqlite-vec.
 */
export class MockVectorDatabase implements VectorDatabase {
  private storage: Map<string, MockVectorRow> = new Map();
  private dbState: DatabaseState = { closed: false };
  private config: { vectorDimensions: number };

  constructor(vectorDimensions: number = 768) {
    this.config = { vectorDimensions };
  }

  exec(_sql: string): void {
    // No-op for schema creation and pragmas
    // The mock storage handles everything in memory
  }

  prepare(sql: string): VectorStatement {
    if (this.dbState.closed) {
      throw new Error("Database is closed");
    }
    return new MockStatement(sql, this.storage, this.config, this.dbState);
  }

  close(): void {
    this.dbState.closed = true;
  }

  // Test helper to check if database is closed
  isClosed(): boolean {
    return this.dbState.closed;
  }

  // Test helper to get storage size
  getStorageSize(): number {
    return this.storage.size;
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a mock vector database for testing
 */
export function createMockVectorDatabase(vectorDimensions: number = 768): MockVectorDatabase {
  return new MockVectorDatabase(vectorDimensions);
}
