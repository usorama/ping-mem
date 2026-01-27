/**
 * Tests for QdrantClient Wrapper
 *
 * Uses mocks for @qdrant/js-client-rest to test without a running Qdrant server.
 * Tests cover connection, health check, upsert, search, and fallback behavior.
 *
 * @module search/__tests__/QdrantClient.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  QdrantClientWrapper,
  QdrantClientError,
  QdrantConnectionError,
  QdrantOperationError,
  createQdrantClient,
  createQdrantClientFromEnv,
} from "../QdrantClient.js";
import type { QdrantClientConfig } from "../QdrantClient.js";
import type { VectorEmbedding } from "../VectorIndex.js";

// ============================================================================
// Mock Setup
// ============================================================================

// Mock the Qdrant SDK client
const mockGetCollections = vi.fn();
const mockCreateCollection = vi.fn();
const mockGetCollection = vi.fn();
const mockUpsert = vi.fn();
const mockSearch = vi.fn();
const mockDelete = vi.fn();

vi.mock("@qdrant/js-client-rest", () => ({
  QdrantClient: vi.fn().mockImplementation(() => ({
    getCollections: mockGetCollections,
    createCollection: mockCreateCollection,
    getCollection: mockGetCollection,
    upsert: mockUpsert,
    search: mockSearch,
    delete: mockDelete,
  })),
}));

// Mock VectorIndex for fallback testing
vi.mock("../VectorIndex.js", () => ({
  VectorIndex: vi.fn().mockImplementation(() => ({
    storeVector: vi.fn().mockResolvedValue(undefined),
    semanticSearch: vi.fn().mockResolvedValue([
      {
        memoryId: "fallback-mem-001",
        sessionId: "session-001",
        content: "Fallback content",
        similarity: 0.9,
        distance: 0.1,
        indexedAt: new Date(),
      },
    ]),
    deleteVector: vi.fn().mockResolvedValue(true),
    getStats: vi.fn().mockResolvedValue({
      totalVectors: 5,
      vectorDimensions: 768,
      similarityThreshold: 0.7,
      dbPath: ":memory:",
    }),
    close: vi.fn().mockResolvedValue(undefined),
  })),
  VectorIndexError: class VectorIndexError extends Error {
    constructor(message: string, public readonly code: string) {
      super(message);
      this.name = "VectorIndexError";
    }
  },
}));

// ============================================================================
// Test Configuration
// ============================================================================

const testConfig: QdrantClientConfig = {
  url: "http://localhost:6333",
  collectionName: "test-collection",
  vectorDimensions: 768,
  apiKey: "test-api-key",
};

// ============================================================================
// Unit Tests
// ============================================================================

describe("QdrantClientWrapper - Unit Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock implementations
    mockGetCollections.mockResolvedValue({ collections: [] });
    mockCreateCollection.mockResolvedValue({});
    mockGetCollection.mockResolvedValue({ points_count: 10 });
    mockUpsert.mockResolvedValue({});
    mockSearch.mockResolvedValue([]);
    mockDelete.mockResolvedValue({});
  });

  describe("Configuration", () => {
    it("should accept required configuration", () => {
      const minimalConfig: QdrantClientConfig = {
        url: "http://localhost:6333",
        collectionName: "test-collection",
      };
      const client = new QdrantClientWrapper(minimalConfig);
      expect(client).toBeInstanceOf(QdrantClientWrapper);
    });

    it("should use default values for optional config", () => {
      const minimalConfig: QdrantClientConfig = {
        url: "http://localhost:6333",
        collectionName: "test-collection",
      };
      const client = new QdrantClientWrapper(minimalConfig);
      expect(client).toBeInstanceOf(QdrantClientWrapper);
    });

    it("should override default values with provided config", () => {
      const customConfig: QdrantClientConfig = {
        url: "http://custom-host:6333",
        collectionName: "custom-collection",
        vectorDimensions: 1024,
        distanceMetric: "Euclid",
        timeout: 10000,
        enableFallback: false,
      };
      const client = new QdrantClientWrapper(customConfig);
      expect(client).toBeInstanceOf(QdrantClientWrapper);
    });
  });

  describe("Connection State (Before Connect)", () => {
    it("should not be connected initially", () => {
      const client = new QdrantClientWrapper(testConfig);
      expect(client.isConnected()).toBe(false);
    });

    it("should not be using fallback initially", () => {
      const client = new QdrantClientWrapper(testConfig);
      expect(client.isUsingFallback()).toBe(false);
    });

    it("should throw when getting client without connection", () => {
      const client = new QdrantClientWrapper(testConfig);
      expect(() => client.getClient()).toThrow(QdrantConnectionError);
    });
  });

  describe("Connection", () => {
    it("should connect successfully when server is healthy", async () => {
      mockGetCollections.mockResolvedValue({ collections: [] });

      const client = new QdrantClientWrapper(testConfig);
      await client.connect();

      expect(client.isConnected()).toBe(true);
      expect(client.isUsingFallback()).toBe(false);
      await client.disconnect();
    });

    it("should create collection if it does not exist", async () => {
      mockGetCollections.mockResolvedValue({ collections: [] });

      const client = new QdrantClientWrapper(testConfig);
      await client.connect();

      expect(mockCreateCollection).toHaveBeenCalledWith(
        testConfig.collectionName,
        expect.objectContaining({
          vectors: {
            size: 768,
            distance: "Cosine",
          },
        })
      );
      await client.disconnect();
    });

    it("should not create collection if it already exists", async () => {
      mockGetCollections.mockResolvedValue({
        collections: [{ name: testConfig.collectionName }],
      });

      const client = new QdrantClientWrapper(testConfig);
      await client.connect();

      expect(mockCreateCollection).not.toHaveBeenCalled();
      await client.disconnect();
    });

    it("should be idempotent when calling connect multiple times", async () => {
      mockGetCollections.mockResolvedValue({ collections: [] });

      const client = new QdrantClientWrapper(testConfig);
      await client.connect();
      await client.connect(); // Should not throw

      expect(client.isConnected()).toBe(true);
      await client.disconnect();
    });

    it("should handle disconnect when not connected", async () => {
      const client = new QdrantClientWrapper(testConfig);
      await client.disconnect(); // Should not throw
      expect(client.isConnected()).toBe(false);
    });
  });

  describe("Fallback Behavior", () => {
    it("should fallback to VectorIndex when connection fails", async () => {
      mockGetCollections.mockRejectedValue(new Error("Connection refused"));

      const client = new QdrantClientWrapper({
        ...testConfig,
        enableFallback: true,
      });
      await client.connect();

      expect(client.isConnected()).toBe(true);
      expect(client.isUsingFallback()).toBe(true);
      await client.disconnect();
    });

    it("should throw when connection fails and fallback is disabled", async () => {
      mockGetCollections.mockRejectedValue(new Error("Connection refused"));

      const client = new QdrantClientWrapper({
        ...testConfig,
        enableFallback: false,
      });

      await expect(client.connect()).rejects.toThrow(QdrantConnectionError);
      expect(client.isConnected()).toBe(false);
    });

    it("should use fallback for storeVector when in fallback mode", async () => {
      mockGetCollections.mockRejectedValue(new Error("Connection refused"));

      const client = new QdrantClientWrapper({
        ...testConfig,
        enableFallback: true,
      });
      await client.connect();

      const embedding: VectorEmbedding = {
        memoryId: "mem-001",
        sessionId: "session-001",
        embedding: new Float32Array(768).fill(0.1),
        content: "Test content",
      };

      await client.storeVector(embedding);

      // Verify fallback was used (VectorIndex is mocked)
      expect(client.isUsingFallback()).toBe(true);
      await client.disconnect();
    });

    it("should use fallback for semanticSearch when in fallback mode", async () => {
      mockGetCollections.mockRejectedValue(new Error("Connection refused"));

      const client = new QdrantClientWrapper({
        ...testConfig,
        enableFallback: true,
      });
      await client.connect();

      const results = await client.semanticSearch(
        new Float32Array(768).fill(0.1),
        { limit: 5 }
      );

      expect(results).toHaveLength(1);
      expect(results[0]?.memoryId).toBe("fallback-mem-001");
      await client.disconnect();
    });

    it("should use fallback for getStats when in fallback mode", async () => {
      mockGetCollections.mockRejectedValue(new Error("Connection refused"));

      const client = new QdrantClientWrapper({
        ...testConfig,
        enableFallback: true,
      });
      await client.connect();

      const stats = await client.getStats();

      expect(stats.usingFallback).toBe(true);
      expect(stats.totalVectors).toBe(5);
      await client.disconnect();
    });
  });

  describe("Health Check", () => {
    it("should return true when server is healthy", async () => {
      mockGetCollections.mockResolvedValue({ collections: [] });

      const client = new QdrantClientWrapper(testConfig);
      await client.connect();

      const isHealthy = await client.healthCheck();
      expect(isHealthy).toBe(true);
      await client.disconnect();
    });

    it("should return false when not connected", async () => {
      const client = new QdrantClientWrapper(testConfig);
      const isHealthy = await client.healthCheck();
      expect(isHealthy).toBe(false);
    });

    it("should return false when health check fails", async () => {
      mockGetCollections
        .mockResolvedValueOnce({ collections: [] }) // For connect
        .mockRejectedValueOnce(new Error("Server error")); // For health check

      const client = new QdrantClientWrapper(testConfig);
      await client.connect();

      const isHealthy = await client.healthCheck();
      expect(isHealthy).toBe(false);
      await client.disconnect();
    });
  });

  describe("Vector Operations", () => {
    let client: QdrantClientWrapper;

    beforeEach(async () => {
      mockGetCollections.mockResolvedValue({ collections: [] });
      client = new QdrantClientWrapper(testConfig);
      await client.connect();
    });

    afterEach(async () => {
      await client.disconnect();
    });

    describe("storeVector", () => {
      it("should store a vector successfully", async () => {
        const embedding: VectorEmbedding = {
          memoryId: "mem-001",
          sessionId: "session-001",
          embedding: new Float32Array(768).fill(0.1),
          content: "Test content",
          category: "test",
          metadata: { key: "value" },
        };

        await client.storeVector(embedding);

        expect(mockUpsert).toHaveBeenCalledWith(
          testConfig.collectionName,
          expect.objectContaining({
            wait: true,
            points: [
              expect.objectContaining({
                id: "mem-001",
                vector: expect.any(Array),
                payload: expect.objectContaining({
                  session_id: "session-001",
                  content: "Test content",
                  category: "test",
                }),
              }),
            ],
          })
        );
      });

      it("should throw QdrantOperationError on upsert failure", async () => {
        mockUpsert.mockRejectedValue(new Error("Upsert failed"));

        const embedding: VectorEmbedding = {
          memoryId: "mem-001",
          sessionId: "session-001",
          embedding: new Float32Array(768).fill(0.1),
          content: "Test content",
        };

        await expect(client.storeVector(embedding)).rejects.toThrow(
          QdrantOperationError
        );
      });

      it("should throw when not connected", async () => {
        await client.disconnect();

        const embedding: VectorEmbedding = {
          memoryId: "mem-001",
          sessionId: "session-001",
          embedding: new Float32Array(768).fill(0.1),
          content: "Test content",
        };

        await expect(client.storeVector(embedding)).rejects.toThrow(
          QdrantConnectionError
        );
      });
    });

    describe("semanticSearch", () => {
      it("should perform basic search", async () => {
        mockSearch.mockResolvedValue([
          {
            id: "mem-001",
            score: 0.95,
            payload: {
              session_id: "session-001",
              content: "Test content",
              indexed_at: "2024-01-01T00:00:00.000Z",
            },
          },
        ]);

        const results = await client.semanticSearch(
          new Float32Array(768).fill(0.1),
          { limit: 5 }
        );

        expect(results).toHaveLength(1);
        expect(results[0]?.memoryId).toBe("mem-001");
        expect(results[0]?.similarity).toBe(0.95);
        expect(results[0]?.sessionId).toBe("session-001");
      });

      it("should apply session filter", async () => {
        mockSearch.mockResolvedValue([]);

        await client.semanticSearch(new Float32Array(768).fill(0.1), {
          sessionId: "session-001",
        });

        expect(mockSearch).toHaveBeenCalledWith(
          testConfig.collectionName,
          expect.objectContaining({
            filter: {
              must: [{ key: "session_id", match: { value: "session-001" } }],
            },
          })
        );
      });

      it("should apply category filter", async () => {
        mockSearch.mockResolvedValue([]);

        await client.semanticSearch(new Float32Array(768).fill(0.1), {
          category: "test",
        });

        expect(mockSearch).toHaveBeenCalledWith(
          testConfig.collectionName,
          expect.objectContaining({
            filter: {
              must: [{ key: "category", match: { value: "test" } }],
            },
          })
        );
      });

      it("should apply multiple filters", async () => {
        mockSearch.mockResolvedValue([]);

        await client.semanticSearch(new Float32Array(768).fill(0.1), {
          sessionId: "session-001",
          category: "test",
        });

        expect(mockSearch).toHaveBeenCalledWith(
          testConfig.collectionName,
          expect.objectContaining({
            filter: {
              must: [
                { key: "session_id", match: { value: "session-001" } },
                { key: "category", match: { value: "test" } },
              ],
            },
          })
        );
      });

      it("should apply threshold", async () => {
        mockSearch.mockResolvedValue([]);

        await client.semanticSearch(new Float32Array(768).fill(0.1), {
          threshold: 0.8,
        });

        expect(mockSearch).toHaveBeenCalledWith(
          testConfig.collectionName,
          expect.objectContaining({
            score_threshold: 0.8,
          })
        );
      });

      it("should throw QdrantOperationError on search failure", async () => {
        mockSearch.mockRejectedValue(new Error("Search failed"));

        await expect(
          client.semanticSearch(new Float32Array(768).fill(0.1))
        ).rejects.toThrow(QdrantOperationError);
      });

      it("should throw when not connected", async () => {
        await client.disconnect();

        await expect(
          client.semanticSearch(new Float32Array(768).fill(0.1))
        ).rejects.toThrow(QdrantConnectionError);
      });
    });

    describe("deleteVector", () => {
      it("should delete a vector successfully", async () => {
        const result = await client.deleteVector("mem-001");

        expect(result).toBe(true);
        expect(mockDelete).toHaveBeenCalledWith(testConfig.collectionName, {
          wait: true,
          points: ["mem-001"],
        });
      });

      it("should return false on delete failure", async () => {
        mockDelete.mockRejectedValue(new Error("Delete failed"));

        const result = await client.deleteVector("mem-001");
        expect(result).toBe(false);
      });

      it("should throw when not connected", async () => {
        await client.disconnect();

        await expect(client.deleteVector("mem-001")).rejects.toThrow(
          QdrantConnectionError
        );
      });
    });

    describe("getStats", () => {
      it("should return collection statistics", async () => {
        mockGetCollection.mockResolvedValue({ points_count: 100 });

        const stats = await client.getStats();

        expect(stats.totalVectors).toBe(100);
        expect(stats.vectorDimensions).toBe(768);
        expect(stats.collectionName).toBe(testConfig.collectionName);
        expect(stats.usingFallback).toBe(false);
      });

      it("should throw QdrantOperationError on failure", async () => {
        mockGetCollection.mockRejectedValue(new Error("Stats failed"));

        await expect(client.getStats()).rejects.toThrow(QdrantOperationError);
      });

      it("should throw when not connected", async () => {
        await client.disconnect();

        await expect(client.getStats()).rejects.toThrow(QdrantConnectionError);
      });
    });
  });
});

// ============================================================================
// Error Classes Tests
// ============================================================================

describe("Error Classes", () => {
  describe("QdrantClientError", () => {
    it("should have correct name and message", () => {
      const error = new QdrantClientError("Something failed", "Q0000");
      expect(error.name).toBe("QdrantClientError");
      expect(error.message).toBe("Something failed");
      expect(error.code).toBe("Q0000");
    });

    it("should handle undefined code", () => {
      const error = new QdrantClientError("Something failed");
      expect(error.code).toBeUndefined();
    });

    it("should preserve cause", () => {
      const cause = new Error("Original error");
      const error = new QdrantClientError("Something failed", undefined, cause);
      expect(error.cause).toBe(cause);
    });

    it("should be instanceof Error", () => {
      const error = new QdrantClientError("Test");
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe("QdrantConnectionError", () => {
    it("should have correct name and message", () => {
      const error = new QdrantConnectionError("Connection failed", "Q0001");
      expect(error.name).toBe("QdrantConnectionError");
      expect(error.message).toBe("Connection failed");
      expect(error.code).toBe("Q0001");
    });

    it("should be instanceof QdrantClientError", () => {
      const error = new QdrantConnectionError("Test");
      expect(error).toBeInstanceOf(QdrantClientError);
    });

    it("should preserve cause", () => {
      const cause = new Error("Original error");
      const error = new QdrantConnectionError("Connection failed", undefined, cause);
      expect(error.cause).toBe(cause);
    });
  });

  describe("QdrantOperationError", () => {
    it("should have correct name, message, operation, and code", () => {
      const error = new QdrantOperationError(
        "Operation failed",
        "upsert",
        "Q0002"
      );
      expect(error.name).toBe("QdrantOperationError");
      expect(error.message).toBe("Operation failed");
      expect(error.operation).toBe("upsert");
      expect(error.code).toBe("Q0002");
    });

    it("should be instanceof QdrantClientError", () => {
      const error = new QdrantOperationError("Test", "search");
      expect(error).toBeInstanceOf(QdrantClientError);
    });

    it("should preserve cause", () => {
      const cause = new Error("Original error");
      const error = new QdrantOperationError(
        "Operation failed",
        "upsert",
        undefined,
        cause
      );
      expect(error.cause).toBe(cause);
    });
  });
});

// ============================================================================
// Factory Functions Tests
// ============================================================================

describe("Factory Functions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createQdrantClient", () => {
    it("should create a new QdrantClientWrapper instance", () => {
      const client = createQdrantClient(testConfig);
      expect(client).toBeInstanceOf(QdrantClientWrapper);
    });

    it("should accept minimal config", () => {
      const client = createQdrantClient({
        url: "http://localhost:6333",
        collectionName: "test-collection",
      });
      expect(client).toBeInstanceOf(QdrantClientWrapper);
    });
  });

  describe("createQdrantClientFromEnv", () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it("should create client from environment variables", () => {
      process.env["QDRANT_URL"] = "http://localhost:6333";
      process.env["QDRANT_COLLECTION_NAME"] = "test-collection";
      process.env["QDRANT_API_KEY"] = "test-key";
      process.env["QDRANT_VECTOR_DIMENSIONS"] = "1024";
      process.env["QDRANT_ENABLE_FALLBACK"] = "true";

      const client = createQdrantClientFromEnv();
      expect(client).toBeInstanceOf(QdrantClientWrapper);
    });

    it("should throw when QDRANT_URL is missing", () => {
      delete process.env["QDRANT_URL"];
      process.env["QDRANT_COLLECTION_NAME"] = "test-collection";

      expect(() => createQdrantClientFromEnv()).toThrow(
        "Missing required environment variables"
      );
    });

    it("should throw when QDRANT_COLLECTION_NAME is missing", () => {
      process.env["QDRANT_URL"] = "http://localhost:6333";
      delete process.env["QDRANT_COLLECTION_NAME"];

      expect(() => createQdrantClientFromEnv()).toThrow(
        "Missing required environment variables"
      );
    });

    it("should use defaults when optional variables are not set", () => {
      process.env["QDRANT_URL"] = "http://localhost:6333";
      process.env["QDRANT_COLLECTION_NAME"] = "test-collection";
      delete process.env["QDRANT_API_KEY"];
      delete process.env["QDRANT_VECTOR_DIMENSIONS"];
      delete process.env["QDRANT_ENABLE_FALLBACK"];

      const client = createQdrantClientFromEnv();
      expect(client).toBeInstanceOf(QdrantClientWrapper);
    });

    it("should disable fallback when QDRANT_ENABLE_FALLBACK is false", () => {
      process.env["QDRANT_URL"] = "http://localhost:6333";
      process.env["QDRANT_COLLECTION_NAME"] = "test-collection";
      process.env["QDRANT_ENABLE_FALLBACK"] = "false";

      const client = createQdrantClientFromEnv();
      expect(client).toBeInstanceOf(QdrantClientWrapper);
    });
  });
});
