/**
 * Tests for VectorIndex
 *
 * Uses dependency injection with a mock database to avoid sqlite-vec module loading issues.
 * The mock database simulates vec0 virtual table behavior for testing.
 *
 * @module search/__tests__/VectorIndex.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  VectorIndex,
  VectorIndexError,
  VectorDimensionMismatchError,
  type VectorEmbedding,
  type VectorIndexConfig,
  type VectorDatabase,
  type VectorStatement,
} from "../VectorIndex.js";

// ============================================================================
// Mock Database Implementation
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

/**
 * Shared database state for checking closed status
 */
interface DatabaseState {
  closed: boolean;
}

/**
 * Mock statement for testing
 */
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

/**
 * Mock database that simulates vec0 virtual table behavior
 */
class MockVec0Database implements VectorDatabase {
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
// Test Utilities
// ============================================================================

/**
 * Create a normalized vector from values (extended to 768 dimensions)
 */
function createNormalizedVector(values: number[]): Float32Array {
  const vector = new Float32Array(768);

  // Set the first few dimensions to the provided values
  for (let i = 0; i < Math.min(values.length, 768); i++) {
    vector[i] = values[i]!;
  }

  // Normalize the vector to unit length
  const norm = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
  if (norm > 0) {
    for (let i = 0; i < vector.length; i++) {
      vector[i] = vector[i]! / norm;
    }
  }

  return vector;
}

/**
 * Create a synthetic embedding based on content (for testing)
 */
function createSyntheticEmbedding(content: string): Float32Array {
  const vector = new Float32Array(768);

  // Create a simple hash-based embedding for testing
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) - hash + content.charCodeAt(i)) & 0xffffffff;
  }

  // Fill vector with pseudo-random values based on content hash
  for (let i = 0; i < 768; i++) {
    const seed = (hash + i) * 0.00001;
    vector[i] = (Math.sin(seed) + Math.cos(seed * 1.1)) * 0.5;
  }

  // Normalize
  const norm = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
  if (norm > 0) {
    for (let i = 0; i < vector.length; i++) {
      vector[i] = vector[i]! / norm;
    }
  }

  return vector;
}

/**
 * Create a VectorIndex with mock database for testing
 */
function createTestVectorIndex(config: Partial<VectorIndexConfig> = {}): VectorIndex {
  const vectorDimensions = config.vectorDimensions ?? 768;
  return new VectorIndex({
    dbPath: ":memory:",
    database: new MockVec0Database(vectorDimensions),
    ...config,
  });
}

// ============================================================================
// Tests
// ============================================================================

describe("VectorIndex", () => {
  let vectorIndex: VectorIndex;

  beforeEach(() => {
    vi.clearAllMocks();
    vectorIndex = createTestVectorIndex();
  });

  afterEach(async () => {
    if (vectorIndex) {
      await vectorIndex.close();
    }
  });

  describe("Initialization", () => {
    it("should create vector index with default configuration", async () => {
      const stats = await vectorIndex.getStats();
      expect(stats.vectorDimensions).toBe(768);
      expect(stats.similarityThreshold).toBe(0.7);
      expect(stats.totalVectors).toBe(0);
    });

    it("should create vector index with custom configuration", async () => {
      const customIndex = createTestVectorIndex({
        vectorDimensions: 512,
        similarityThreshold: 0.8,
      });

      const stats = await customIndex.getStats();
      expect(stats.vectorDimensions).toBe(512);
      expect(stats.similarityThreshold).toBe(0.8);

      await customIndex.close();
    });

    it("should use injected database", () => {
      const mockDb = new MockVec0Database();
      const index = new VectorIndex({
        dbPath: ":memory:",
        database: mockDb,
      });

      // The database should be used without throwing
      expect(index).toBeInstanceOf(VectorIndex);
      index.close();
    });
  });

  describe("Vector Storage", () => {
    it("should store a vector embedding", async () => {
      const embedding: VectorEmbedding = {
        memoryId: "mem-001",
        sessionId: "session-001",
        embedding: new Float32Array(768).fill(0.1),
        content: "Test memory content",
        category: "test",
        metadata: { source: "unit-test" },
      };

      await vectorIndex.storeVector(embedding);

      const stats = await vectorIndex.getStats();
      expect(stats.totalVectors).toBe(1);
    });

    it("should replace existing vector when storing with same memory ID", async () => {
      const embedding1: VectorEmbedding = {
        memoryId: "mem-001",
        sessionId: "session-001",
        embedding: new Float32Array(768).fill(0.1),
        content: "Original content",
      };

      const embedding2: VectorEmbedding = {
        memoryId: "mem-001",
        sessionId: "session-001",
        embedding: new Float32Array(768).fill(0.2),
        content: "Updated content",
      };

      await vectorIndex.storeVector(embedding1);
      await vectorIndex.storeVector(embedding2);

      const stats = await vectorIndex.getStats();
      expect(stats.totalVectors).toBe(1);

      const retrieved = await vectorIndex.getVector("mem-001");
      expect(retrieved?.content).toBe("Updated content");
    });

    it("should throw error for invalid vector dimensions", async () => {
      const embedding: VectorEmbedding = {
        memoryId: "mem-001",
        sessionId: "session-001",
        embedding: new Float32Array(512).fill(0.1), // Wrong dimension
        content: "Test content",
      };

      await expect(vectorIndex.storeVector(embedding)).rejects.toThrow(
        VectorDimensionMismatchError
      );
    });
  });

  describe("Vector Retrieval", () => {
    beforeEach(async () => {
      // Store test vectors
      const embeddings: VectorEmbedding[] = [
        {
          memoryId: "mem-001",
          sessionId: "session-001",
          embedding: new Float32Array(768).fill(0.1),
          content: "JavaScript programming concepts",
          category: "programming",
        },
        {
          memoryId: "mem-002",
          sessionId: "session-001",
          embedding: new Float32Array(768).fill(0.2),
          content: "TypeScript type definitions",
          category: "programming",
        },
        {
          memoryId: "mem-003",
          sessionId: "session-002",
          embedding: new Float32Array(768).fill(0.5),
          content: "Database schema design",
          category: "database",
        },
      ];

      for (const embedding of embeddings) {
        await vectorIndex.storeVector(embedding);
      }
    });

    it("should retrieve vector by memory ID", async () => {
      const vector = await vectorIndex.getVector("mem-001");

      expect(vector).not.toBeNull();
      expect(vector?.memoryId).toBe("mem-001");
      expect(vector?.sessionId).toBe("session-001");
      expect(vector?.content).toBe("JavaScript programming concepts");
      expect(vector?.category).toBe("programming");
    });

    it("should return null for non-existent memory ID", async () => {
      const vector = await vectorIndex.getVector("non-existent");
      expect(vector).toBeNull();
    });

    it("should list vectors in a session", async () => {
      const vectors = await vectorIndex.listVectors("session-001");

      expect(vectors).toHaveLength(2);
      expect(vectors.map((v) => v.memoryId)).toContain("mem-001");
      expect(vectors.map((v) => v.memoryId)).toContain("mem-002");
    });

    it("should limit vector list results", async () => {
      const vectors = await vectorIndex.listVectors("session-001", 1);
      expect(vectors).toHaveLength(1);
    });
  });

  describe("Semantic Search", () => {
    beforeEach(async () => {
      // Create vectors with different similarity patterns
      const embeddings: VectorEmbedding[] = [
        {
          memoryId: "similar-1",
          sessionId: "session-001",
          embedding: createNormalizedVector([1, 0, 0]),
          content: "Very similar content to query",
          category: "test",
        },
        {
          memoryId: "similar-2",
          sessionId: "session-001",
          embedding: createNormalizedVector([0.8, 0.6, 0]),
          content: "Somewhat similar content",
          category: "test",
        },
        {
          memoryId: "different-1",
          sessionId: "session-001",
          embedding: createNormalizedVector([0, 1, 0]),
          content: "Very different content",
          category: "other",
        },
        {
          memoryId: "different-session",
          sessionId: "session-002",
          embedding: createNormalizedVector([1, 0, 0]),
          content: "Similar but different session",
          category: "other-session",
        },
      ];

      for (const embedding of embeddings) {
        await vectorIndex.storeVector(embedding);
      }
    });

    it("should perform semantic search with cosine similarity", async () => {
      const queryEmbedding = createNormalizedVector([1, 0, 0]);
      const results = await vectorIndex.semanticSearch(queryEmbedding, {
        threshold: 0.5,
        limit: 5,
      });

      expect(results.length).toBeGreaterThanOrEqual(2);
      expect(results[0]!.memoryId).toBe("similar-1");
      expect(results[0]!.similarity).toBeGreaterThan(0.9);
    });

    it("should respect similarity threshold", async () => {
      const queryEmbedding = createNormalizedVector([1, 0, 0]);
      const results = await vectorIndex.semanticSearch(queryEmbedding, {
        threshold: 0.9, // Very strict threshold
        limit: 5,
      });

      results.forEach((result) => {
        expect(result.similarity).toBeGreaterThanOrEqual(0.9);
      });
    });

    it("should filter by session ID", async () => {
      const queryEmbedding = createNormalizedVector([1, 0, 0]);
      const results = await vectorIndex.semanticSearch(queryEmbedding, {
        sessionId: "session-001",
        threshold: 0.5,
      });

      results.forEach((result) => {
        expect(result.sessionId).toBe("session-001");
      });
    });

    it("should filter by category", async () => {
      const queryEmbedding = createNormalizedVector([1, 0, 0]);
      const results = await vectorIndex.semanticSearch(queryEmbedding, {
        category: "test",
        threshold: 0.5,
      });

      results.forEach((result) => {
        expect(["similar-1", "similar-2"]).toContain(result.memoryId);
      });
    });

    it("should throw error for invalid query vector dimensions", async () => {
      const invalidQuery = new Float32Array(512); // Wrong dimension

      await expect(vectorIndex.semanticSearch(invalidQuery)).rejects.toThrow(
        VectorDimensionMismatchError
      );
    });

    it("should return empty results when no vectors meet threshold", async () => {
      const queryEmbedding = createNormalizedVector([0, 0, 1]);
      const results = await vectorIndex.semanticSearch(queryEmbedding, {
        threshold: 0.99, // Impossibly high threshold
      });

      expect(results).toHaveLength(0);
    });
  });

  describe("Vector Deletion", () => {
    beforeEach(async () => {
      const embedding: VectorEmbedding = {
        memoryId: "mem-to-delete",
        sessionId: "session-001",
        embedding: new Float32Array(768).fill(0.1),
        content: "Content to delete",
      };

      await vectorIndex.storeVector(embedding);
    });

    it("should delete existing vector", async () => {
      const deleted = await vectorIndex.deleteVector("mem-to-delete");
      expect(deleted).toBe(true);

      const vector = await vectorIndex.getVector("mem-to-delete");
      expect(vector).toBeNull();

      const stats = await vectorIndex.getStats();
      expect(stats.totalVectors).toBe(0);
    });

    it("should return false when deleting non-existent vector", async () => {
      const deleted = await vectorIndex.deleteVector("non-existent");
      expect(deleted).toBe(false);
    });
  });

  describe("Error Handling", () => {
    it("should handle database errors gracefully", async () => {
      // Close the database to simulate error conditions
      await vectorIndex.close();

      const embedding: VectorEmbedding = {
        memoryId: "mem-001",
        sessionId: "session-001",
        embedding: new Float32Array(768).fill(0.1),
        content: "Test content",
      };

      // Should throw VectorIndexError, not raw database error
      await expect(vectorIndex.storeVector(embedding)).rejects.toThrow(VectorIndexError);
    });
  });

  describe("Integration Tests", () => {
    it("should handle complete workflow: store, search, delete", async () => {
      // Store multiple related memories
      const memories = [
        "Machine learning algorithms",
        "Deep learning neural networks",
        "Natural language processing",
        "Computer vision techniques",
        "Database normalization rules",
      ];

      for (let i = 0; i < memories.length; i++) {
        const embedding: VectorEmbedding = {
          memoryId: `mem-${i}`,
          sessionId: "session-001",
          embedding: createSyntheticEmbedding(memories[i]!),
          content: memories[i]!,
          category: i < 4 ? "ai" : "database",
        };
        await vectorIndex.storeVector(embedding);
      }

      // Search for AI-related content
      const aiQuery = createSyntheticEmbedding("artificial intelligence");
      const aiResults = await vectorIndex.semanticSearch(aiQuery, {
        category: "ai",
        threshold: 0.1,
      });

      expect(aiResults.length).toBeGreaterThan(0);
      expect(aiResults[0]!.similarity).toBeGreaterThan(0.1);

      // Delete one memory
      const deleted = await vectorIndex.deleteVector("mem-0");
      expect(deleted).toBe(true);

      // Verify it's gone
      const deletedMemory = await vectorIndex.getVector("mem-0");
      expect(deletedMemory).toBeNull();

      // Verify others remain
      const remaining = await vectorIndex.listVectors("session-001");
      expect(remaining).toHaveLength(4);
    });

    it("should maintain data consistency across operations", async () => {
      const embedding: VectorEmbedding = {
        memoryId: "consistency-test",
        sessionId: "session-001",
        embedding: new Float32Array(768).fill(0.5),
        content: "Consistency test content",
        metadata: { version: 1 },
      };

      // Store
      await vectorIndex.storeVector(embedding);

      // Retrieve and verify
      const retrieved = await vectorIndex.getVector("consistency-test");
      expect(retrieved?.content).toBe(embedding.content);
      expect(retrieved?.metadata).toEqual(embedding.metadata);

      // Search and verify
      const searchResults = await vectorIndex.semanticSearch(embedding.embedding, {
        threshold: 0.9,
      });
      expect(searchResults[0]?.memoryId).toBe("consistency-test");
      expect(searchResults[0]?.content).toBe(embedding.content);
    });
  });
});

describe("VectorIndex Error Classes", () => {
  it("VectorIndexError should have correct properties", () => {
    const error = new VectorIndexError("Test error", "TEST_CODE");

    expect(error.message).toBe("Test error");
    expect(error.code).toBe("TEST_CODE");
    expect(error.name).toBe("VectorIndexError");
    expect(error instanceof Error).toBe(true);
  });

  it("VectorDimensionMismatchError should format message correctly", () => {
    const error = new VectorDimensionMismatchError(768, 512);

    expect(error.message).toBe("Vector dimension mismatch: expected 768, got 512");
    expect(error.code).toBe("DIMENSION_MISMATCH");
    expect(error instanceof VectorIndexError).toBe(true);
  });
});
