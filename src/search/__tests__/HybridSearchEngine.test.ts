/**
 * Tests for HybridSearchEngine
 *
 * Tests hybrid search combining semantic, keyword (BM25), and graph search
 * with reciprocal rank fusion for optimal result ranking.
 *
 * @module search/__tests__/HybridSearchEngine.test
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  HybridSearchEngine,
  HybridSearchError,
  SearchModeError,
  createHybridSearchEngine,
  createKeywordOnlySearchEngine,
  type HybridSearchEngineConfig,
  type HybridSearchResult,
  type SearchMode,
} from "../HybridSearchEngine.js";
import type { EmbeddingService } from "../EmbeddingService.js";
import type { QdrantClientWrapper } from "../QdrantClient.js";
import type { VectorIndex, VectorSearchResult } from "../VectorIndex.js";
import type { GraphManager } from "../../graph/GraphManager.js";
import type { MemoryId, SessionId } from "../../types/index.js";

// ============================================================================
// Mock Implementations
// ============================================================================

/**
 * Create a mock embedding service
 */
function createMockEmbeddingService(dimensions: number = 768): EmbeddingService {
  return {
    embed: vi.fn().mockImplementation((text: string) => {
      // Create a deterministic embedding based on text content
      const embedding = new Float32Array(dimensions);
      let hash = 0;
      for (let i = 0; i < text.length; i++) {
        hash = ((hash << 5) - hash + text.charCodeAt(i)) & 0xffffffff;
      }
      for (let i = 0; i < dimensions; i++) {
        embedding[i] = Math.sin((hash + i) * 0.001);
      }
      // Normalize
      const norm = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
      if (norm > 0) {
        for (let i = 0; i < dimensions; i++) {
          embedding[i] = embedding[i]! / norm;
        }
      }
      return Promise.resolve(embedding);
    }),
    embedBatch: vi.fn().mockImplementation((texts: string[]) => {
      return Promise.all(texts.map((t) => createMockEmbeddingService().embed(t)));
    }),
    dimensions,
    providerName: "mock",
    getCacheStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, entries: 0, hitRate: 0 }),
    clearCache: vi.fn(),
    isCacheEnabled: vi.fn().mockReturnValue(false),
  } as unknown as EmbeddingService;
}

/**
 * Create a mock Qdrant client
 */
function createMockQdrantClient(storedResults: VectorSearchResult[] = []): QdrantClientWrapper {
  const vectors = new Map<MemoryId, { embedding: Float32Array; result: VectorSearchResult }>();

  // Pre-populate with stored results
  for (const result of storedResults) {
    vectors.set(result.memoryId, {
      embedding: new Float32Array(768).fill(0.1),
      result,
    });
  }

  return {
    storeVector: vi.fn().mockImplementation((data) => {
      vectors.set(data.memoryId, {
        embedding: data.embedding,
        result: {
          memoryId: data.memoryId,
          sessionId: data.sessionId,
          content: data.content,
          similarity: 1,
          distance: 0,
          indexedAt: new Date(),
          metadata: data.metadata,
        },
      });
      return Promise.resolve();
    }),
    deleteVector: vi.fn().mockImplementation((memoryId: MemoryId) => {
      const deleted = vectors.delete(memoryId);
      return Promise.resolve(deleted);
    }),
    semanticSearch: vi.fn().mockImplementation(
      (
        _queryEmbedding: Float32Array,
        options: { limit?: number; sessionId?: SessionId; category?: string }
      ) => {
        const results: VectorSearchResult[] = [];
        for (const { result } of vectors.values()) {
          if (options.sessionId && result.sessionId !== options.sessionId) continue;
          results.push({
            ...result,
            similarity: 0.8 + Math.random() * 0.2, // Random high similarity
          });
        }
        return Promise.resolve(
          results
            .sort((a, b) => b.similarity - a.similarity)
            .slice(0, options.limit ?? 10)
        );
      }
    ),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
  } as unknown as QdrantClientWrapper;
}

/**
 * Create a mock VectorIndex
 */
function createMockVectorIndex(storedResults: VectorSearchResult[] = []): VectorIndex {
  const vectors = new Map<MemoryId, VectorSearchResult>();

  for (const result of storedResults) {
    vectors.set(result.memoryId, result);
  }

  return {
    storeVector: vi.fn().mockImplementation((data) => {
      vectors.set(data.memoryId, {
        memoryId: data.memoryId,
        sessionId: data.sessionId,
        content: data.content,
        similarity: 1,
        distance: 0,
        indexedAt: new Date(),
        metadata: data.metadata,
      });
      return Promise.resolve();
    }),
    deleteVector: vi.fn().mockImplementation((memoryId: MemoryId) => {
      return Promise.resolve(vectors.delete(memoryId));
    }),
    semanticSearch: vi.fn().mockImplementation(
      (
        _queryEmbedding: Float32Array,
        options: { limit?: number; sessionId?: SessionId; category?: string }
      ) => {
        const results: VectorSearchResult[] = [];
        for (const result of vectors.values()) {
          if (options.sessionId && result.sessionId !== options.sessionId) continue;
          results.push({
            ...result,
            similarity: 0.7 + Math.random() * 0.3,
          });
        }
        return Promise.resolve(
          results
            .sort((a, b) => b.similarity - a.similarity)
            .slice(0, options.limit ?? 10)
        );
      }
    ),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as VectorIndex;
}

/**
 * Create a mock GraphManager
 */
function createMockGraphManager(): GraphManager {
  return {
    findRelationshipsByEntity: vi.fn().mockResolvedValue([
      {
        id: "rel-001",
        type: "RELATED_TO",
        sourceId: "entity-001",
        targetId: "entity-002",
        properties: {},
        weight: 0.8,
        createdAt: new Date(),
        updatedAt: new Date(),
        eventTime: new Date(),
        ingestionTime: new Date(),
      },
    ]),
    getEntity: vi.fn().mockResolvedValue(null),
    createEntity: vi.fn().mockResolvedValue({}),
    deleteEntity: vi.fn().mockResolvedValue(true),
  } as unknown as GraphManager;
}

// ============================================================================
// Test Data
// ============================================================================

const testDocuments = [
  {
    memoryId: "mem-001" as MemoryId,
    sessionId: "session-001" as SessionId,
    content: "Machine learning is a subset of artificial intelligence",
    indexedAt: new Date("2024-01-01"),
  },
  {
    memoryId: "mem-002" as MemoryId,
    sessionId: "session-001" as SessionId,
    content: "Deep learning uses neural networks with many layers",
    indexedAt: new Date("2024-01-02"),
  },
  {
    memoryId: "mem-003" as MemoryId,
    sessionId: "session-001" as SessionId,
    content: "Natural language processing enables text analysis",
    indexedAt: new Date("2024-01-03"),
  },
  {
    memoryId: "mem-004" as MemoryId,
    sessionId: "session-002" as SessionId,
    content: "Database indexing improves query performance",
    indexedAt: new Date("2024-01-04"),
  },
];

// ============================================================================
// Tests
// ============================================================================

describe("HybridSearchEngine", () => {
  let embeddingService: EmbeddingService;
  let qdrantClient: QdrantClientWrapper;
  let localVectorIndex: VectorIndex;
  let graphManager: GraphManager;
  let engine: HybridSearchEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    embeddingService = createMockEmbeddingService();
    qdrantClient = createMockQdrantClient();
    localVectorIndex = createMockVectorIndex();
    graphManager = createMockGraphManager();
  });

  describe("Initialization", () => {
    it("should create engine with default weights", () => {
      engine = createHybridSearchEngine({ embeddingService });

      const weights = engine.getWeights();
      expect(weights.semantic).toBe(0.5);
      expect(weights.keyword).toBe(0.3);
      expect(weights.graph).toBe(0.2);
    });

    it("should create engine with custom weights", () => {
      engine = createHybridSearchEngine({
        embeddingService,
        weights: { semantic: 0.6, keyword: 0.3, graph: 0.1 },
      });

      const weights = engine.getWeights();
      expect(weights.semantic).toBe(0.6);
      expect(weights.keyword).toBe(0.3);
      expect(weights.graph).toBe(0.1);
    });

    it("should detect available search modes with Qdrant client", () => {
      engine = createHybridSearchEngine({
        embeddingService,
        qdrantClient,
      });

      const modes = engine.getAvailableSearchModes();
      expect(modes).toContain("semantic");
      expect(modes).toContain("keyword");
      expect(modes).not.toContain("graph");
    });

    it("should detect available search modes with local vector index", () => {
      engine = createHybridSearchEngine({
        embeddingService,
        localVectorIndex,
      });

      const modes = engine.getAvailableSearchModes();
      expect(modes).toContain("semantic");
      expect(modes).toContain("keyword");
    });

    it("should detect available search modes with graph manager", () => {
      engine = createHybridSearchEngine({
        embeddingService,
        qdrantClient,
        graphManager,
      });

      const modes = engine.getAvailableSearchModes();
      expect(modes).toContain("semantic");
      expect(modes).toContain("keyword");
      expect(modes).toContain("graph");
    });

    it("should have keyword mode available even without vector search", () => {
      engine = createHybridSearchEngine({ embeddingService });

      const modes = engine.getAvailableSearchModes();
      expect(modes).toContain("keyword");
    });
  });

  describe("Document Indexing", () => {
    beforeEach(() => {
      engine = createHybridSearchEngine({
        embeddingService,
        qdrantClient,
      });
    });

    it("should index document in both BM25 and vector indexes", async () => {
      await engine.indexDocument(
        "mem-001" as MemoryId,
        "session-001" as SessionId,
        "Machine learning concepts",
        new Date()
      );

      const bm25Stats = engine.getBM25Stats();
      expect(bm25Stats.documentCount).toBe(1);
      expect(qdrantClient.storeVector).toHaveBeenCalledTimes(1);
    });

    it("should index multiple documents", async () => {
      for (const doc of testDocuments) {
        await engine.indexDocument(
          doc.memoryId,
          doc.sessionId,
          doc.content,
          doc.indexedAt
        );
      }

      const bm25Stats = engine.getBM25Stats();
      expect(bm25Stats.documentCount).toBe(4);
    });

    it("should remove document from all indexes", async () => {
      await engine.indexDocument(
        "mem-001" as MemoryId,
        "session-001" as SessionId,
        "Test content",
        new Date()
      );

      const removed = await engine.removeDocument("mem-001" as MemoryId);

      expect(removed).toBe(true);
      expect(engine.getBM25Stats().documentCount).toBe(0);
      expect(qdrantClient.deleteVector).toHaveBeenCalledWith("mem-001");
    });
  });

  describe("Keyword Search (BM25)", () => {
    beforeEach(async () => {
      engine = createKeywordOnlySearchEngine();

      for (const doc of testDocuments) {
        // Use indexDocument without embedding (will fail on embedding but BM25 works)
        engine["bm25Index"].addDocument(
          doc.memoryId,
          doc.sessionId,
          doc.content,
          doc.indexedAt
        );
      }
    });

    it("should perform keyword-only search", async () => {
      const results = await engine.search("machine learning", {
        modes: ["keyword"],
        limit: 5,
      });

      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.searchModes).toContain("keyword");
    });

    it("should rank results by BM25 relevance", async () => {
      const results = await engine.search("artificial intelligence", {
        modes: ["keyword"],
        limit: 5,
      });

      // First result should be most relevant to "artificial intelligence"
      expect(results[0]!.content).toContain("artificial intelligence");
    });

    it("should filter by session ID", async () => {
      const results = await engine.search("learning", {
        modes: ["keyword"],
        sessionId: "session-001" as SessionId,
        limit: 10,
      });

      for (const result of results) {
        expect(result.sessionId).toBe("session-001");
      }
    });

    it("should return empty results for non-matching query", async () => {
      const results = await engine.search("xyz123nonexistent", {
        modes: ["keyword"],
        limit: 5,
      });

      expect(results).toHaveLength(0);
    });

    it("should handle empty query", async () => {
      const results = await engine.search("", {
        modes: ["keyword"],
        limit: 5,
      });

      expect(results).toHaveLength(0);
    });
  });

  describe("Semantic Search", () => {
    beforeEach(async () => {
      const storedResults: VectorSearchResult[] = testDocuments.map((doc) => ({
        memoryId: doc.memoryId,
        sessionId: doc.sessionId,
        content: doc.content,
        similarity: 0.9,
        distance: 0.1,
        indexedAt: doc.indexedAt,
      }));

      qdrantClient = createMockQdrantClient(storedResults);

      engine = createHybridSearchEngine({
        embeddingService,
        qdrantClient,
      });
    });

    it("should perform semantic-only search", async () => {
      const results = await engine.search("AI and machine learning", {
        modes: ["semantic"],
        limit: 5,
      });

      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.searchModes).toContain("semantic");
      expect(embeddingService.embed).toHaveBeenCalledWith("AI and machine learning");
    });

    it("should use Qdrant client when available", async () => {
      await engine.search("neural networks", {
        modes: ["semantic"],
        limit: 5,
      });

      expect(qdrantClient.semanticSearch).toHaveBeenCalled();
    });

    it("should fallback to local vector index", async () => {
      const storedResults: VectorSearchResult[] = testDocuments.map((doc) => ({
        memoryId: doc.memoryId,
        sessionId: doc.sessionId,
        content: doc.content,
        similarity: 0.85,
        distance: 0.15,
        indexedAt: doc.indexedAt,
      }));

      localVectorIndex = createMockVectorIndex(storedResults);

      engine = createHybridSearchEngine({
        embeddingService,
        localVectorIndex,
      });

      const results = await engine.search("text processing", {
        modes: ["semantic"],
        limit: 5,
      });

      expect(results.length).toBeGreaterThan(0);
      expect(localVectorIndex.semanticSearch).toHaveBeenCalled();
    });
  });

  describe("Graph Search", () => {
    beforeEach(() => {
      engine = createHybridSearchEngine({
        embeddingService,
        qdrantClient,
        graphManager,
      });
    });

    it("should include graph mode when graph manager is available", () => {
      const modes = engine.getAvailableSearchModes();
      expect(modes).toContain("graph");
    });

    it("should perform graph search when entity ID is provided", async () => {
      const results = await engine.search("related concepts", {
        modes: ["graph"],
        graphEntityId: "entity-001",
        limit: 5,
      });

      expect(graphManager.findRelationshipsByEntity).toHaveBeenCalledWith("entity-001");
    });

    it("should not perform graph search without entity ID", async () => {
      const results = await engine.search("test query", {
        modes: ["graph"],
        limit: 5,
      });

      // Graph search requires graphEntityId
      expect(graphManager.findRelationshipsByEntity).not.toHaveBeenCalled();
    });
  });

  describe("Hybrid Search (All Modes)", () => {
    beforeEach(async () => {
      const storedResults: VectorSearchResult[] = testDocuments.map((doc) => ({
        memoryId: doc.memoryId,
        sessionId: doc.sessionId,
        content: doc.content,
        similarity: 0.85,
        distance: 0.15,
        indexedAt: doc.indexedAt,
      }));

      qdrantClient = createMockQdrantClient(storedResults);

      engine = createHybridSearchEngine({
        embeddingService,
        qdrantClient,
        graphManager,
      });

      // Add documents to BM25 index
      for (const doc of testDocuments) {
        engine["bm25Index"].addDocument(
          doc.memoryId,
          doc.sessionId,
          doc.content,
          doc.indexedAt
        );
      }
    });

    it("should combine semantic and keyword search", async () => {
      const results = await engine.search("machine learning", {
        modes: ["semantic", "keyword"],
        limit: 5,
      });

      expect(results.length).toBeGreaterThan(0);

      // Results should have hybrid scores
      for (const result of results) {
        expect(result.hybridScore).toBeGreaterThan(0);
        expect(result.hybridScore).toBeLessThanOrEqual(1);
      }
    });

    it("should use all available modes by default", async () => {
      const results = await engine.search("neural networks", {
        limit: 5,
      });

      expect(results.length).toBeGreaterThan(0);
      expect(embeddingService.embed).toHaveBeenCalled();
    });

    it("should respect custom weights for fusion", async () => {
      const results = await engine.search("deep learning", {
        weights: { semantic: 0.8, keyword: 0.2, graph: 0 },
        limit: 5,
      });

      expect(results.length).toBeGreaterThan(0);
    });

    it("should include mode scores when available", async () => {
      const results = await engine.search("natural language", {
        modes: ["semantic", "keyword"],
        limit: 5,
      });

      const resultWithModeScores = results.find((r) => r.modeScores);
      if (resultWithModeScores) {
        expect(resultWithModeScores.modeScores).toBeDefined();
      }
    });
  });

  describe("Reciprocal Rank Fusion", () => {
    beforeEach(() => {
      engine = createKeywordOnlySearchEngine();

      // Add test documents
      for (const doc of testDocuments) {
        engine["bm25Index"].addDocument(
          doc.memoryId,
          doc.sessionId,
          doc.content,
          doc.indexedAt
        );
      }
    });

    it("should normalize hybrid scores to 0-1 range", async () => {
      const results = await engine.search("machine learning neural", {
        modes: ["keyword"],
        limit: 10,
      });

      for (const result of results) {
        expect(result.hybridScore).toBeGreaterThanOrEqual(0);
        expect(result.hybridScore).toBeLessThanOrEqual(1);
      }
    });

    it("should sort results by hybrid score descending", async () => {
      const results = await engine.search("learning", {
        modes: ["keyword"],
        limit: 10,
      });

      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1]!.hybridScore).toBeGreaterThanOrEqual(results[i]!.hybridScore);
      }
    });

    it("should respect threshold filtering", async () => {
      const results = await engine.search("learning", {
        modes: ["keyword"],
        threshold: 0.5,
        limit: 10,
      });

      for (const result of results) {
        expect(result.hybridScore).toBeGreaterThanOrEqual(0.5);
      }
    });
  });

  describe("Different Weight Configurations", () => {
    beforeEach(async () => {
      const storedResults: VectorSearchResult[] = testDocuments.map((doc) => ({
        memoryId: doc.memoryId,
        sessionId: doc.sessionId,
        content: doc.content,
        similarity: 0.9,
        distance: 0.1,
        indexedAt: doc.indexedAt,
      }));

      qdrantClient = createMockQdrantClient(storedResults);

      engine = createHybridSearchEngine({
        embeddingService,
        qdrantClient,
      });

      for (const doc of testDocuments) {
        engine["bm25Index"].addDocument(
          doc.memoryId,
          doc.sessionId,
          doc.content,
          doc.indexedAt
        );
      }
    });

    it("should handle semantic-heavy weights", async () => {
      const results = await engine.search("artificial intelligence", {
        weights: { semantic: 0.9, keyword: 0.1, graph: 0 },
        limit: 5,
      });

      expect(results.length).toBeGreaterThan(0);
    });

    it("should handle keyword-heavy weights", async () => {
      const results = await engine.search("database indexing", {
        weights: { semantic: 0.1, keyword: 0.9, graph: 0 },
        limit: 5,
      });

      expect(results.length).toBeGreaterThan(0);
    });

    it("should handle equal weights", async () => {
      const results = await engine.search("learning concepts", {
        weights: { semantic: 0.33, keyword: 0.33, graph: 0.34 },
        limit: 5,
      });

      expect(results.length).toBeGreaterThan(0);
    });

    it("should handle zero weight for a mode", async () => {
      const results = await engine.search("neural networks", {
        weights: { semantic: 0.5, keyword: 0.5, graph: 0 },
        modes: ["semantic", "keyword"],
        limit: 5,
      });

      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe("Fallback Behavior", () => {
    it("should work with only keyword search when vector services unavailable", async () => {
      engine = createHybridSearchEngine({
        embeddingService: createMockEmbeddingService(),
        // No qdrantClient or localVectorIndex
      });

      // Add documents to BM25
      for (const doc of testDocuments) {
        engine["bm25Index"].addDocument(
          doc.memoryId,
          doc.sessionId,
          doc.content,
          doc.indexedAt
        );
      }

      const results = await engine.search("machine learning", {
        modes: ["keyword"],
        limit: 5,
      });

      expect(results.length).toBeGreaterThan(0);
    });

    it("should use local vector index when Qdrant is unavailable", async () => {
      const storedResults: VectorSearchResult[] = testDocuments.map((doc) => ({
        memoryId: doc.memoryId,
        sessionId: doc.sessionId,
        content: doc.content,
        similarity: 0.8,
        distance: 0.2,
        indexedAt: doc.indexedAt,
      }));

      localVectorIndex = createMockVectorIndex(storedResults);

      engine = createHybridSearchEngine({
        embeddingService,
        localVectorIndex, // Use local instead of Qdrant
      });

      const results = await engine.search("deep learning", {
        modes: ["semantic"],
        limit: 5,
      });

      expect(results.length).toBeGreaterThan(0);
      expect(localVectorIndex.semanticSearch).toHaveBeenCalled();
    });
  });

  describe("Error Handling", () => {
    it("should throw HybridSearchError on indexing failure", async () => {
      const failingEmbeddingService = {
        ...createMockEmbeddingService(),
        embed: vi.fn().mockRejectedValue(new Error("Embedding service error")),
      } as unknown as EmbeddingService;

      engine = createHybridSearchEngine({
        embeddingService: failingEmbeddingService,
        qdrantClient,
      });

      await expect(
        engine.indexDocument(
          "mem-001" as MemoryId,
          "session-001" as SessionId,
          "Test content",
          new Date()
        )
      ).rejects.toThrow(HybridSearchError);
    });

    it("should throw SearchModeError on semantic search failure", async () => {
      const failingEmbeddingService = {
        ...createMockEmbeddingService(),
        embed: vi.fn().mockRejectedValue(new Error("Embedding failed")),
      } as unknown as EmbeddingService;

      engine = createHybridSearchEngine({
        embeddingService: failingEmbeddingService,
        qdrantClient,
      });

      await expect(
        engine.search("test query", { modes: ["semantic"] })
      ).rejects.toThrow(SearchModeError);
    });
  });

  describe("BM25 Statistics", () => {
    beforeEach(() => {
      engine = createKeywordOnlySearchEngine();
    });

    it("should track document count", async () => {
      for (const doc of testDocuments) {
        engine["bm25Index"].addDocument(
          doc.memoryId,
          doc.sessionId,
          doc.content,
          doc.indexedAt
        );
      }

      const stats = engine.getBM25Stats();
      expect(stats.documentCount).toBe(4);
    });

    it("should track term count", async () => {
      engine["bm25Index"].addDocument(
        "mem-001" as MemoryId,
        "session-001" as SessionId,
        "hello world test",
        new Date()
      );

      const stats = engine.getBM25Stats();
      expect(stats.termCount).toBeGreaterThan(0);
    });

    it("should track average document length", async () => {
      engine["bm25Index"].addDocument(
        "mem-001" as MemoryId,
        "session-001" as SessionId,
        "one two three four five",
        new Date()
      );
      engine["bm25Index"].addDocument(
        "mem-002" as MemoryId,
        "session-001" as SessionId,
        "one two three",
        new Date()
      );

      const stats = engine.getBM25Stats();
      expect(stats.avgDocLength).toBeGreaterThan(0);
    });

    it("should clear all indexes", async () => {
      for (const doc of testDocuments) {
        engine["bm25Index"].addDocument(
          doc.memoryId,
          doc.sessionId,
          doc.content,
          doc.indexedAt
        );
      }

      engine.clear();

      const stats = engine.getBM25Stats();
      expect(stats.documentCount).toBe(0);
      expect(stats.termCount).toBe(0);
    });
  });
});

describe("HybridSearchEngine Error Classes", () => {
  it("HybridSearchError should have correct properties", () => {
    const error = new HybridSearchError("Test error", "TEST_CODE");

    expect(error.message).toBe("Test error");
    expect(error.code).toBe("TEST_CODE");
    expect(error.name).toBe("HybridSearchError");
    expect(error instanceof Error).toBe(true);
  });

  it("HybridSearchError should include cause when provided", () => {
    const cause = new Error("Original error");
    const error = new HybridSearchError("Wrapped error", "WRAPPED", cause);

    expect(error.cause).toBe(cause);
  });

  it("SearchModeError should include mode", () => {
    const error = new SearchModeError("Mode failed", "semantic", "MODE_FAILED");

    expect(error.message).toBe("Mode failed");
    expect(error.mode).toBe("semantic");
    expect(error.code).toBe("MODE_FAILED");
    expect(error.name).toBe("SearchModeError");
    expect(error instanceof HybridSearchError).toBe(true);
  });
});

describe("Factory Functions", () => {
  it("createHybridSearchEngine should create engine with config", () => {
    const embeddingService = createMockEmbeddingService();
    const engine = createHybridSearchEngine({
      embeddingService,
      weights: { semantic: 0.7, keyword: 0.2, graph: 0.1 },
    });

    expect(engine).toBeInstanceOf(HybridSearchEngine);
    expect(engine.getWeights().semantic).toBe(0.7);
  });

  it("createKeywordOnlySearchEngine should create keyword-only engine", () => {
    const engine = createKeywordOnlySearchEngine();

    const modes = engine.getAvailableSearchModes();
    expect(modes).toContain("keyword");
    expect(modes).not.toContain("semantic");

    const weights = engine.getWeights();
    expect(weights.semantic).toBe(0);
    expect(weights.keyword).toBe(1);
    expect(weights.graph).toBe(0);
  });

  it("createKeywordOnlySearchEngine should accept custom BM25 config", () => {
    const engine = createKeywordOnlySearchEngine({ k1: 2.0, b: 0.5 });

    expect(engine).toBeInstanceOf(HybridSearchEngine);
  });
});
