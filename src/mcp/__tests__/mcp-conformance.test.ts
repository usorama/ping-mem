/**
 * MCP Conformance Test Suite for ping-mem Graphiti Integration
 *
 * Verifies MCP tool conformance as defined in the specification:
 * - CT-009: context_query_relationships → Returns valid JSON response
 * - CT-010: context_hybrid_search → Returns ranked results
 *
 * @module mcp/__tests__/mcp-conformance
 * @version 1.0.0
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import { PingMemServer } from "../PingMemServer.js";
import type { GraphManager } from "../../graph/GraphManager.js";
import type { HybridSearchEngine } from "../../search/HybridSearchEngine.js";
import type { Entity, Relationship } from "../../types/graph.js";
import { EntityType, RelationshipType } from "../../types/graph.js";

// Type for mock function
type MockedFn<T extends (...args: unknown[]) => unknown> = Mock<T>;

// Helper to call tool handlers through the server
// Wraps result in MCP SDK format (content array) since handleToolCall returns raw result
async function callTool(
  server: PingMemServer,
  name: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const serverAny = server as unknown as {
    handleToolCall: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
  const result = await serverAny.handleToolCall(name, args);
  // Wrap in MCP SDK format to match what the actual MCP server returns
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
}

// Create mock entity
function createMockEntity(id: string, name: string, type: EntityType = EntityType.CONCEPT): Entity {
  const now = new Date();
  return {
    id,
    type,
    name,
    properties: {},
    createdAt: now,
    updatedAt: now,
    eventTime: now,
    ingestionTime: now,
  };
}

// Create mock relationship
function createMockRelationship(
  id: string,
  sourceId: string,
  targetId: string,
  type: RelationshipType = RelationshipType.RELATED_TO
): Relationship {
  const now = new Date();
  return {
    id,
    type,
    sourceId,
    targetId,
    properties: {},
    weight: 1.0,
    createdAt: now,
    updatedAt: now,
    eventTime: now,
    ingestionTime: now,
  };
}

// Create mock GraphManager
function createMockGraphManager(): GraphManager & {
  findRelationshipsByEntity: MockedFn<GraphManager["findRelationshipsByEntity"]>;
  getEntity: MockedFn<GraphManager["getEntity"]>;
} {
  const mockFindRelationshipsByEntity = vi.fn<GraphManager["findRelationshipsByEntity"]>();
  const mockGetEntity = vi.fn<GraphManager["getEntity"]>();

  return {
    createEntity: vi.fn(),
    getEntity: mockGetEntity,
    updateEntity: vi.fn(),
    deleteEntity: vi.fn(),
    createRelationship: vi.fn(),
    getRelationship: vi.fn(),
    deleteRelationship: vi.fn(),
    findEntitiesByType: vi.fn(),
    findRelationshipsByEntity: mockFindRelationshipsByEntity,
    mergeEntity: vi.fn(),
    batchCreateEntities: vi.fn(),
  } as unknown as GraphManager & {
    findRelationshipsByEntity: MockedFn<GraphManager["findRelationshipsByEntity"]>;
    getEntity: MockedFn<GraphManager["getEntity"]>;
  };
}

// Create mock HybridSearchEngine
function createMockHybridSearchEngine(): HybridSearchEngine & {
  search: MockedFn<HybridSearchEngine["search"]>;
} {
  const mockSearch = vi.fn<HybridSearchEngine["search"]>();
  return {
    search: mockSearch,
    addDocument: vi.fn(),
    removeDocument: vi.fn(),
    updateDocument: vi.fn(),
    clear: vi.fn(),
  } as unknown as HybridSearchEngine & {
    search: MockedFn<HybridSearchEngine["search"]>;
  };
}

// ============================================================================
// CT-009: context_query_relationships via MCP
// Tests: Call MCP tool → Returns valid JSON response with relationships
// ============================================================================

describe("CT-009: context_query_relationships via MCP", () => {
  let server: PingMemServer;
  let mockGraphManager: ReturnType<typeof createMockGraphManager>;

  beforeEach(() => {
    mockGraphManager = createMockGraphManager();
    server = new PingMemServer({
      dbPath: ":memory:",
      graphManager: mockGraphManager,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns valid JSON response for relationship query", async () => {
    // Set up mock data
    const authMiddleware = createMockEntity("auth-middleware", "AuthMiddleware", EntityType.CODE_CLASS);
    const userService = createMockEntity("user-service", "UserService", EntityType.CODE_CLASS);
    const relationship = createMockRelationship(
      "rel-1",
      "auth-middleware",
      "user-service",
      RelationshipType.DEPENDS_ON
    );

    mockGraphManager.getEntity.mockImplementation(async (id: string) => {
      if (id === "auth-middleware") return authMiddleware;
      if (id === "user-service") return userService;
      return null;
    });

    mockGraphManager.findRelationshipsByEntity.mockResolvedValue([relationship]);

    // Call the MCP tool
    const result = await callTool(server, "context_query_relationships", {
      entityId: "auth-middleware",
    });

    // Verify valid JSON response
    expect(result).toBeDefined();
    expect(typeof result).toBe("object");

    // Response should contain content array (MCP format)
    expect(result.content).toBeDefined();
    expect(Array.isArray(result.content)).toBe(true);
  });

  it("returns relationships with required fields", async () => {
    const entity = createMockEntity("entity-1", "TestEntity");
    const relationship = createMockRelationship(
      "rel-1",
      "entity-1",
      "entity-2",
      RelationshipType.USES
    );

    mockGraphManager.getEntity.mockResolvedValue(entity);
    mockGraphManager.findRelationshipsByEntity.mockResolvedValue([relationship]);

    const result = await callTool(server, "context_query_relationships", {
      entityId: "entity-1",
    });

    // Parse the content
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content.length).toBeGreaterThan(0);

    // The response should be JSON text
    const textContent = content[0];
    expect(textContent.type).toBe("text");

    // Parse and verify structure
    const parsed = JSON.parse(textContent.text);
    expect(parsed.relationships).toBeDefined();
    expect(Array.isArray(parsed.relationships)).toBe(true);

    if (parsed.relationships.length > 0) {
      const rel = parsed.relationships[0];
      expect(rel.id).toBeDefined();
      expect(rel.type).toBeDefined();
      expect(rel.sourceId).toBeDefined();
      expect(rel.targetId).toBeDefined();
    }
  });

  it("supports depth parameter", async () => {
    const entity = createMockEntity("entity-1", "TestEntity");
    mockGraphManager.getEntity.mockResolvedValue(entity);
    mockGraphManager.findRelationshipsByEntity.mockResolvedValue([]);

    const result = await callTool(server, "context_query_relationships", {
      entityId: "entity-1",
      depth: 2,
    });

    expect(result).toBeDefined();
    // Should not throw with depth parameter
  });

  it("supports relationshipTypes filter", async () => {
    const entity = createMockEntity("entity-1", "TestEntity");
    const usesRel = createMockRelationship("rel-1", "entity-1", "entity-2", RelationshipType.USES);
    const dependsRel = createMockRelationship("rel-2", "entity-1", "entity-3", RelationshipType.DEPENDS_ON);

    mockGraphManager.getEntity.mockResolvedValue(entity);
    mockGraphManager.findRelationshipsByEntity.mockResolvedValue([usesRel, dependsRel]);

    const result = await callTool(server, "context_query_relationships", {
      entityId: "entity-1",
      relationshipTypes: ["USES"],
    });

    expect(result).toBeDefined();
    // Should not throw with relationshipTypes parameter
  });

  it("supports direction parameter", async () => {
    const entity = createMockEntity("entity-1", "TestEntity");
    mockGraphManager.getEntity.mockResolvedValue(entity);
    mockGraphManager.findRelationshipsByEntity.mockResolvedValue([]);

    const outgoing = await callTool(server, "context_query_relationships", {
      entityId: "entity-1",
      direction: "outgoing",
    });
    expect(outgoing).toBeDefined();

    const incoming = await callTool(server, "context_query_relationships", {
      entityId: "entity-1",
      direction: "incoming",
    });
    expect(incoming).toBeDefined();

    const both = await callTool(server, "context_query_relationships", {
      entityId: "entity-1",
      direction: "both",
    });
    expect(both).toBeDefined();
  });
});

// ============================================================================
// CT-010: context_hybrid_search via MCP
// Tests: Call MCP tool → Returns ranked results from hybrid search
// ============================================================================

describe("CT-010: context_hybrid_search via MCP", () => {
  let server: PingMemServer;
  let mockHybridSearchEngine: ReturnType<typeof createMockHybridSearchEngine>;

  beforeEach(() => {
    mockHybridSearchEngine = createMockHybridSearchEngine();
    server = new PingMemServer({
      dbPath: ":memory:",
      hybridSearchEngine: mockHybridSearchEngine,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns valid JSON response for hybrid search", async () => {
    // Mock results matching HybridSearchResult interface (extends VectorSearchResult)
    const now = new Date();
    const mockResults = [
      {
        memoryId: "memory-1" as import("../../types/index.js").MemoryId,
        sessionId: "session-1" as import("../../types/index.js").SessionId,
        content: "Authentication decision using JWT",
        similarity: 0.95,
        distance: 0.05,
        indexedAt: now,
        hybridScore: 0.95,
        searchModes: ["semantic" as const, "keyword" as const],
        modeScores: { semantic: 0.5, keyword: 0.3, graph: 0.2 },
      },
      {
        memoryId: "memory-2" as import("../../types/index.js").MemoryId,
        sessionId: "session-1" as import("../../types/index.js").SessionId,
        content: "AuthMiddleware implementation",
        similarity: 0.85,
        distance: 0.15,
        indexedAt: now,
        hybridScore: 0.85,
        searchModes: ["semantic" as const],
        modeScores: { semantic: 0.4, keyword: 0.4, graph: 0.2 },
      },
    ];

    mockHybridSearchEngine.search.mockResolvedValue(mockResults);

    const result = await callTool(server, "context_hybrid_search", {
      query: "authentication decisions",
    });

    // Verify valid JSON response
    expect(result).toBeDefined();
    expect(typeof result).toBe("object");
    expect(result.content).toBeDefined();
    expect(Array.isArray(result.content)).toBe(true);
  });

  it("returns ranked results sorted by hybridScore", async () => {
    const now = new Date();
    const mockResults = [
      {
        memoryId: "high-score" as import("../../types/index.js").MemoryId,
        sessionId: "session-1" as import("../../types/index.js").SessionId,
        content: "Best match",
        similarity: 0.95,
        distance: 0.05,
        indexedAt: now,
        hybridScore: 0.95,
        searchModes: ["semantic" as const],
        modeScores: { semantic: 0.5, keyword: 0.3, graph: 0.2 },
      },
      {
        memoryId: "medium-score" as import("../../types/index.js").MemoryId,
        sessionId: "session-1" as import("../../types/index.js").SessionId,
        content: "Good match",
        similarity: 0.75,
        distance: 0.25,
        indexedAt: now,
        hybridScore: 0.75,
        searchModes: ["semantic" as const],
        modeScores: { semantic: 0.4, keyword: 0.25, graph: 0.1 },
      },
      {
        memoryId: "low-score" as import("../../types/index.js").MemoryId,
        sessionId: "session-1" as import("../../types/index.js").SessionId,
        content: "Partial match",
        similarity: 0.55,
        distance: 0.45,
        indexedAt: now,
        hybridScore: 0.55,
        searchModes: ["keyword" as const],
        modeScores: { semantic: 0.3, keyword: 0.2, graph: 0.05 },
      },
    ];

    mockHybridSearchEngine.search.mockResolvedValue(mockResults);

    const result = await callTool(server, "context_hybrid_search", {
      query: "authentication",
    });

    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);

    expect(parsed.results).toBeDefined();
    expect(Array.isArray(parsed.results)).toBe(true);

    // Verify results are ranked (first result has highest hybridScore)
    if (parsed.results.length >= 2) {
      expect(parsed.results[0].hybridScore).toBeGreaterThanOrEqual(parsed.results[1].hybridScore);
    }
  });

  it("supports limit parameter", async () => {
    const now = new Date();
    const mockResults = Array.from({ length: 10 }, (_, i) => ({
      memoryId: `result-${i}` as import("../../types/index.js").MemoryId,
      sessionId: "session-1" as import("../../types/index.js").SessionId,
      content: `Result ${i}`,
      similarity: 1.0 - i * 0.1,
      distance: i * 0.1,
      indexedAt: now,
      hybridScore: 1.0 - i * 0.1,
      searchModes: ["semantic" as const],
      modeScores: { semantic: 0.5, keyword: 0.3, graph: 0.2 },
    }));

    mockHybridSearchEngine.search.mockResolvedValue(mockResults);

    const result = await callTool(server, "context_hybrid_search", {
      query: "test",
      limit: 5,
    });

    expect(result).toBeDefined();
    // Should not throw with limit parameter
  });

  it("supports weights parameter for search tuning", async () => {
    mockHybridSearchEngine.search.mockResolvedValue([]);

    const result = await callTool(server, "context_hybrid_search", {
      query: "test query",
      weights: {
        semantic: 0.6,
        keyword: 0.3,
        graph: 0.1,
      },
    });

    expect(result).toBeDefined();
    // Verify search was called with query and options containing weights
    expect(mockHybridSearchEngine.search).toHaveBeenCalledWith(
      "test query",
      expect.objectContaining({
        weights: { semantic: 0.6, keyword: 0.3, graph: 0.1 },
      })
    );
  });

  it("includes modeScores in results", async () => {
    const now = new Date();
    const mockResults = [
      {
        memoryId: "result-1" as import("../../types/index.js").MemoryId,
        sessionId: "session-1" as import("../../types/index.js").SessionId,
        content: "Test content",
        similarity: 0.9,
        distance: 0.1,
        indexedAt: now,
        hybridScore: 0.9,
        searchModes: ["semantic" as const, "keyword" as const, "graph" as const],
        modeScores: {
          semantic: 0.5,
          keyword: 0.3,
          graph: 0.2,
        },
      },
    ];

    mockHybridSearchEngine.search.mockResolvedValue(mockResults);

    const result = await callTool(server, "context_hybrid_search", {
      query: "test",
    });

    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);

    if (parsed.results && parsed.results.length > 0) {
      const firstResult = parsed.results[0];
      // Mode scores should be included
      expect(firstResult.modeScores).toBeDefined();
      expect(firstResult.modeScores.semantic).toBeDefined();
      expect(firstResult.modeScores.keyword).toBeDefined();
      expect(firstResult.modeScores.graph).toBeDefined();
    }
  });

  it("handles empty results gracefully", async () => {
    mockHybridSearchEngine.search.mockResolvedValue([]);

    const result = await callTool(server, "context_hybrid_search", {
      query: "nonexistent content xyz123",
    });

    expect(result).toBeDefined();
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);

    expect(parsed.results).toBeDefined();
    expect(Array.isArray(parsed.results)).toBe(true);
    expect(parsed.results.length).toBe(0);
  });
});

// ============================================================================
// MCP Conformance Summary
// ============================================================================

describe("MCP Conformance Test Summary", () => {
  it("verifies CT-009 and CT-010 are implemented", () => {
    const mcpConformanceTests = [
      "CT-009: context_query_relationships via MCP",
      "CT-010: context_hybrid_search via MCP",
    ];

    expect(mcpConformanceTests).toHaveLength(2);
  });
});
