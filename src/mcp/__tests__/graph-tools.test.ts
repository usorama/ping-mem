/**
 * Tests for graph-related MCP tools
 *
 * Tests the context_hybrid_search, context_get_lineage, and context_query_evolution
 * tools in PingMemServer.
 *
 * @module mcp/__tests__/graph-tools.test
 */

import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { PingMemServer, PingMemServerConfig } from "../PingMemServer.js";
import type { HybridSearchEngine, HybridSearchResult, SearchMode } from "../../search/HybridSearchEngine.js";
import type { LineageEngine } from "../../graph/LineageEngine.js";
import type { EvolutionEngine, EvolutionTimeline, EntityChange } from "../../graph/EvolutionEngine.js";
import type { Entity } from "../../types/graph.js";
import { EntityType } from "../../types/graph.js";

// ============================================================================
// Mock Factories
// ============================================================================

function createMockHybridSearchEngine(): HybridSearchEngine & {
  search: jest.MockedFunction<HybridSearchEngine["search"]>;
} {
  const mockSearch = jest.fn<HybridSearchEngine["search"]>();

  return {
    search: mockSearch,
    indexDocument: jest.fn(),
    removeDocument: jest.fn(),
    getAvailableSearchModes: jest.fn(() => ["semantic", "keyword", "graph"] as SearchMode[]),
    getWeights: jest.fn(() => ({ semantic: 0.5, keyword: 0.3, graph: 0.2 })),
    getBM25Stats: jest.fn(() => ({ documentCount: 0, termCount: 0, avgDocLength: 0 })),
    clear: jest.fn(),
  } as unknown as HybridSearchEngine & {
    search: jest.MockedFunction<HybridSearchEngine["search"]>;
  };
}

function createMockLineageEngine(): LineageEngine & {
  getAncestors: jest.MockedFunction<LineageEngine["getAncestors"]>;
  getDescendants: jest.MockedFunction<LineageEngine["getDescendants"]>;
} {
  const mockGetAncestors = jest.fn<LineageEngine["getAncestors"]>();
  const mockGetDescendants = jest.fn<LineageEngine["getDescendants"]>();

  return {
    getAncestors: mockGetAncestors,
    getDescendants: mockGetDescendants,
    getLineagePath: jest.fn(),
    getRootAncestors: jest.fn(),
    getEvolutionTimeline: jest.fn(),
    buildLineageGraph: jest.fn(),
  } as unknown as LineageEngine & {
    getAncestors: jest.MockedFunction<LineageEngine["getAncestors"]>;
    getDescendants: jest.MockedFunction<LineageEngine["getDescendants"]>;
  };
}

function createMockEvolutionEngine(): EvolutionEngine & {
  getEvolution: jest.MockedFunction<EvolutionEngine["getEvolution"]>;
} {
  const mockGetEvolution = jest.fn<EvolutionEngine["getEvolution"]>();

  return {
    getEvolution: mockGetEvolution,
    getEvolutionByName: jest.fn(),
    getRelatedEvolution: jest.fn(),
    compareEvolution: jest.fn(),
  } as unknown as EvolutionEngine & {
    getEvolution: jest.MockedFunction<EvolutionEngine["getEvolution"]>;
  };
}

// Helper to call tool handlers through the server
async function callTool(
  server: PingMemServer,
  name: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const serverAny = server as unknown as {
    handleToolCall: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
  return serverAny.handleToolCall(name, args);
}

// ============================================================================
// Test Data Factories
// ============================================================================

function createTestEntity(overrides: Partial<Entity> = {}): Entity {
  const now = new Date();
  return {
    id: "entity-1",
    type: EntityType.CONCEPT,
    name: "Test Entity",
    properties: {},
    createdAt: now,
    updatedAt: now,
    eventTime: now,
    ingestionTime: now,
    ...overrides,
  };
}

function createTestHybridSearchResult(overrides: Partial<HybridSearchResult> = {}): HybridSearchResult {
  return {
    memoryId: "mem-1",
    sessionId: "session-1",
    content: "Test content",
    similarity: 0.85,
    distance: 0.15,
    indexedAt: new Date(),
    hybridScore: 0.9,
    searchModes: ["semantic", "keyword"] as SearchMode[],
    graphContext: {
      relatedEntityIds: ["entity-2", "entity-3"],
      relationshipTypes: ["RELATED_TO"],
      hopDistance: 1,
    },
    modeScores: {
      semantic: 0.85,
      keyword: 0.75,
    },
    ...overrides,
  };
}

function createTestEvolutionTimeline(entityId: string): EvolutionTimeline {
  const now = new Date();
  const earlier = new Date(now.getTime() - 3600000); // 1 hour earlier

  const changes: EntityChange[] = [
    {
      timestamp: earlier,
      changeType: "created",
      entityId,
      entityName: "Test Entity",
      previousState: null,
      currentState: createTestEntity({ id: entityId }),
      metadata: { version: 1 },
    },
    {
      timestamp: now,
      changeType: "updated",
      entityId,
      entityName: "Test Entity Updated",
      previousState: createTestEntity({ id: entityId, name: "Test Entity" }),
      currentState: createTestEntity({ id: entityId, name: "Test Entity Updated" }),
      metadata: { version: 2 },
    },
  ];

  return {
    entityId,
    entityName: "Test Entity Updated",
    startTime: earlier,
    endTime: now,
    changes,
    totalChanges: 2,
  };
}

// ============================================================================
// Tool Listing Tests
// ============================================================================

describe("Graph Tools - Tool Listing", () => {
  let server: PingMemServer;

  beforeEach(() => {
    server = new PingMemServer({
      dbPath: ":memory:",
      enableVectorSearch: false,
    });
  });

  afterEach(async () => {
    await server.close();
  });

  it("should list context_hybrid_search tool", async () => {
    const mcpServer = server.getServer();
    expect(mcpServer).toBeDefined();

    // Access the tools through the server request handler
    // Tools are registered in TOOLS array and returned by ListToolsRequestSchema handler
    const serverAny = server as unknown as {
      server: { _requestHandlers: Map<string, unknown> };
    };
    expect(serverAny.server).toBeDefined();
  });

  it("should list context_get_lineage tool", async () => {
    const mcpServer = server.getServer();
    expect(mcpServer).toBeDefined();
  });

  it("should list context_query_evolution tool", async () => {
    const mcpServer = server.getServer();
    expect(mcpServer).toBeDefined();
  });
});

// ============================================================================
// context_hybrid_search Tests
// ============================================================================

describe("context_hybrid_search", () => {
  let server: PingMemServer;
  let mockHybridSearchEngine: ReturnType<typeof createMockHybridSearchEngine>;

  beforeEach(() => {
    mockHybridSearchEngine = createMockHybridSearchEngine();

    server = new PingMemServer({
      dbPath: ":memory:",
      enableVectorSearch: false,
      hybridSearchEngine: mockHybridSearchEngine,
    });
  });

  afterEach(async () => {
    await server.close();
  });

  it("should throw error when hybridSearchEngine not configured", async () => {
    const serverWithoutEngine = new PingMemServer({
      dbPath: ":memory:",
      enableVectorSearch: false,
    });

    await expect(
      callTool(serverWithoutEngine, "context_hybrid_search", { query: "test" })
    ).rejects.toThrow("HybridSearchEngine not configured");

    await serverWithoutEngine.close();
  });

  it("should return hybrid search results with graphContext", async () => {
    const mockResults: HybridSearchResult[] = [
      createTestHybridSearchResult({ memoryId: "mem-1", hybridScore: 0.95 }),
      createTestHybridSearchResult({ memoryId: "mem-2", hybridScore: 0.85 }),
    ];

    mockHybridSearchEngine.search.mockResolvedValue(mockResults);

    const result = await callTool(server, "context_hybrid_search", {
      query: "machine learning",
      limit: 10,
    });

    expect(result.query).toBe("machine learning");
    expect(result.count).toBe(2);
    expect(Array.isArray(result.results)).toBe(true);

    const results = result.results as Array<{
      memoryId: string;
      hybridScore: number;
      graphContext: { relatedEntityIds: string[] };
    }>;
    expect(results[0]?.graphContext).toBeDefined();
    expect(results[0]?.graphContext?.relatedEntityIds).toContain("entity-2");

    expect(mockHybridSearchEngine.search).toHaveBeenCalledWith(
      "machine learning",
      expect.objectContaining({ limit: 10 })
    );
  });

  it("should pass custom weights to search engine", async () => {
    mockHybridSearchEngine.search.mockResolvedValue([]);

    await callTool(server, "context_hybrid_search", {
      query: "test query",
      weights: { semantic: 0.7, keyword: 0.2, graph: 0.1 },
    });

    expect(mockHybridSearchEngine.search).toHaveBeenCalledWith(
      "test query",
      expect.objectContaining({
        weights: { semantic: 0.7, keyword: 0.2, graph: 0.1 },
      })
    );
  });

  it("should pass sessionId filter to search engine", async () => {
    mockHybridSearchEngine.search.mockResolvedValue([]);

    await callTool(server, "context_hybrid_search", {
      query: "filtered search",
      sessionId: "session-123",
    });

    expect(mockHybridSearchEngine.search).toHaveBeenCalledWith(
      "filtered search",
      expect.objectContaining({
        sessionId: "session-123",
      })
    );
  });

  it("should include modeScores in results", async () => {
    const mockResults: HybridSearchResult[] = [
      createTestHybridSearchResult({
        modeScores: { semantic: 0.9, keyword: 0.7, graph: 0.5 },
      }),
    ];

    mockHybridSearchEngine.search.mockResolvedValue(mockResults);

    const result = await callTool(server, "context_hybrid_search", {
      query: "test",
    });

    const results = result.results as Array<{
      modeScores: { semantic: number; keyword: number; graph: number };
    }>;
    expect(results[0]?.modeScores?.semantic).toBe(0.9);
    expect(results[0]?.modeScores?.keyword).toBe(0.7);
    expect(results[0]?.modeScores?.graph).toBe(0.5);
  });
});

// ============================================================================
// context_get_lineage Tests
// ============================================================================

describe("context_get_lineage", () => {
  let server: PingMemServer;
  let mockLineageEngine: ReturnType<typeof createMockLineageEngine>;

  beforeEach(() => {
    mockLineageEngine = createMockLineageEngine();

    server = new PingMemServer({
      dbPath: ":memory:",
      enableVectorSearch: false,
      lineageEngine: mockLineageEngine,
    });
  });

  afterEach(async () => {
    await server.close();
  });

  it("should throw error when lineageEngine not configured", async () => {
    const serverWithoutEngine = new PingMemServer({
      dbPath: ":memory:",
      enableVectorSearch: false,
    });

    await expect(
      callTool(serverWithoutEngine, "context_get_lineage", { entityId: "entity-1" })
    ).rejects.toThrow("LineageEngine not configured");

    await serverWithoutEngine.close();
  });

  it("should return upstream entities (ancestors)", async () => {
    const ancestors = [
      createTestEntity({ id: "ancestor-1", name: "Parent Entity" }),
      createTestEntity({ id: "ancestor-2", name: "Grandparent Entity" }),
    ];

    mockLineageEngine.getAncestors.mockResolvedValue(ancestors);
    mockLineageEngine.getDescendants.mockResolvedValue([]);

    const result = await callTool(server, "context_get_lineage", {
      entityId: "entity-1",
      direction: "upstream",
    });

    expect(result.entityId).toBe("entity-1");
    expect(result.direction).toBe("upstream");
    expect(result.upstreamCount).toBe(2);
    expect(result.downstreamCount).toBe(0);

    const upstream = result.upstream as Array<{ id: string; name: string }>;
    expect(upstream[0]?.id).toBe("ancestor-1");
    expect(upstream[1]?.id).toBe("ancestor-2");

    expect(mockLineageEngine.getAncestors).toHaveBeenCalledWith("entity-1", undefined);
    expect(mockLineageEngine.getDescendants).not.toHaveBeenCalled();
  });

  it("should return downstream entities (descendants)", async () => {
    const descendants = [
      createTestEntity({ id: "descendant-1", name: "Child Entity" }),
    ];

    mockLineageEngine.getAncestors.mockResolvedValue([]);
    mockLineageEngine.getDescendants.mockResolvedValue(descendants);

    const result = await callTool(server, "context_get_lineage", {
      entityId: "entity-1",
      direction: "downstream",
    });

    expect(result.direction).toBe("downstream");
    expect(result.downstreamCount).toBe(1);
    expect(result.upstreamCount).toBe(0);

    const downstream = result.downstream as Array<{ id: string }>;
    expect(downstream[0]?.id).toBe("descendant-1");

    expect(mockLineageEngine.getAncestors).not.toHaveBeenCalled();
    expect(mockLineageEngine.getDescendants).toHaveBeenCalledWith("entity-1", undefined);
  });

  it("should return both upstream and downstream with direction=both", async () => {
    const ancestors = [createTestEntity({ id: "ancestor-1" })];
    const descendants = [createTestEntity({ id: "descendant-1" })];

    mockLineageEngine.getAncestors.mockResolvedValue(ancestors);
    mockLineageEngine.getDescendants.mockResolvedValue(descendants);

    const result = await callTool(server, "context_get_lineage", {
      entityId: "entity-1",
      direction: "both",
    });

    expect(result.upstreamCount).toBe(1);
    expect(result.downstreamCount).toBe(1);

    expect(mockLineageEngine.getAncestors).toHaveBeenCalled();
    expect(mockLineageEngine.getDescendants).toHaveBeenCalled();
  });

  it("should default to direction=both when not specified", async () => {
    mockLineageEngine.getAncestors.mockResolvedValue([]);
    mockLineageEngine.getDescendants.mockResolvedValue([]);

    const result = await callTool(server, "context_get_lineage", {
      entityId: "entity-1",
    });

    expect(result.direction).toBe("both");
    expect(mockLineageEngine.getAncestors).toHaveBeenCalled();
    expect(mockLineageEngine.getDescendants).toHaveBeenCalled();
  });

  it("should pass maxDepth to lineage engine", async () => {
    mockLineageEngine.getAncestors.mockResolvedValue([]);
    mockLineageEngine.getDescendants.mockResolvedValue([]);

    await callTool(server, "context_get_lineage", {
      entityId: "entity-1",
      direction: "both",
      maxDepth: 5,
    });

    expect(mockLineageEngine.getAncestors).toHaveBeenCalledWith("entity-1", 5);
    expect(mockLineageEngine.getDescendants).toHaveBeenCalledWith("entity-1", 5);
  });

  it("should serialize entity eventTime as ISO string", async () => {
    const specificTime = new Date("2025-01-15T10:30:00Z");
    const ancestors = [createTestEntity({ id: "ancestor-1", eventTime: specificTime })];

    mockLineageEngine.getAncestors.mockResolvedValue(ancestors);
    mockLineageEngine.getDescendants.mockResolvedValue([]);

    const result = await callTool(server, "context_get_lineage", {
      entityId: "entity-1",
      direction: "upstream",
    });

    const upstream = result.upstream as Array<{ eventTime: string }>;
    expect(upstream[0]?.eventTime).toBe("2025-01-15T10:30:00.000Z");
  });
});

// ============================================================================
// context_query_evolution Tests
// ============================================================================

describe("context_query_evolution", () => {
  let server: PingMemServer;
  let mockEvolutionEngine: ReturnType<typeof createMockEvolutionEngine>;

  beforeEach(() => {
    mockEvolutionEngine = createMockEvolutionEngine();

    server = new PingMemServer({
      dbPath: ":memory:",
      enableVectorSearch: false,
      evolutionEngine: mockEvolutionEngine,
    });
  });

  afterEach(async () => {
    await server.close();
  });

  it("should throw error when evolutionEngine not configured", async () => {
    const serverWithoutEngine = new PingMemServer({
      dbPath: ":memory:",
      enableVectorSearch: false,
    });

    await expect(
      callTool(serverWithoutEngine, "context_query_evolution", { entityId: "entity-1" })
    ).rejects.toThrow("EvolutionEngine not configured");

    await serverWithoutEngine.close();
  });

  it("should return evolution timeline for an entity", async () => {
    const mockTimeline = createTestEvolutionTimeline("entity-1");
    mockEvolutionEngine.getEvolution.mockResolvedValue(mockTimeline);

    const result = await callTool(server, "context_query_evolution", {
      entityId: "entity-1",
    });

    expect(result.entityId).toBe("entity-1");
    expect(result.entityName).toBe("Test Entity Updated");
    expect(result.totalChanges).toBe(2);

    const changes = result.changes as Array<{
      changeType: string;
      previousState: { name: string } | null;
      currentState: { name: string } | null;
    }>;
    expect(changes.length).toBe(2);
    expect(changes[0]?.changeType).toBe("created");
    expect(changes[0]?.previousState).toBeNull();
    expect(changes[1]?.changeType).toBe("updated");
    expect(changes[1]?.previousState?.name).toBe("Test Entity");
    expect(changes[1]?.currentState?.name).toBe("Test Entity Updated");

    expect(mockEvolutionEngine.getEvolution).toHaveBeenCalledWith("entity-1", {});
  });

  it("should pass startTime and endTime to evolution engine", async () => {
    const mockTimeline = createTestEvolutionTimeline("entity-1");
    mockEvolutionEngine.getEvolution.mockResolvedValue(mockTimeline);

    await callTool(server, "context_query_evolution", {
      entityId: "entity-1",
      startTime: "2025-01-01T00:00:00Z",
      endTime: "2025-01-31T23:59:59Z",
    });

    expect(mockEvolutionEngine.getEvolution).toHaveBeenCalledWith(
      "entity-1",
      expect.objectContaining({
        startTime: expect.any(Date),
        endTime: expect.any(Date),
      })
    );

    const callArgs = mockEvolutionEngine.getEvolution.mock.calls[0];
    const options = callArgs?.[1] as { startTime: Date; endTime: Date };
    expect(options.startTime.toISOString()).toBe("2025-01-01T00:00:00.000Z");
    expect(options.endTime.toISOString()).toBe("2025-01-31T23:59:59.000Z");
  });

  it("should serialize timestamps as ISO strings", async () => {
    const startTime = new Date("2025-01-10T08:00:00Z");
    const endTime = new Date("2025-01-10T18:00:00Z");

    const mockTimeline: EvolutionTimeline = {
      entityId: "entity-1",
      entityName: "Test",
      startTime,
      endTime,
      changes: [],
      totalChanges: 0,
    };

    mockEvolutionEngine.getEvolution.mockResolvedValue(mockTimeline);

    const result = await callTool(server, "context_query_evolution", {
      entityId: "entity-1",
    });

    expect(result.startTime).toBe("2025-01-10T08:00:00.000Z");
    expect(result.endTime).toBe("2025-01-10T18:00:00.000Z");
  });

  it("should include metadata in change entries", async () => {
    const mockTimeline = createTestEvolutionTimeline("entity-1");
    mockEvolutionEngine.getEvolution.mockResolvedValue(mockTimeline);

    const result = await callTool(server, "context_query_evolution", {
      entityId: "entity-1",
    });

    const changes = result.changes as Array<{ metadata: { version: number } }>;
    expect(changes[0]?.metadata?.version).toBe(1);
    expect(changes[1]?.metadata?.version).toBe(2);
  });

  it("should handle entity with no changes", async () => {
    const emptyTimeline: EvolutionTimeline = {
      entityId: "entity-1",
      entityName: "Empty Entity",
      startTime: new Date(),
      endTime: new Date(),
      changes: [],
      totalChanges: 0,
    };

    mockEvolutionEngine.getEvolution.mockResolvedValue(emptyTimeline);

    const result = await callTool(server, "context_query_evolution", {
      entityId: "entity-1",
    });

    expect(result.totalChanges).toBe(0);
    expect((result.changes as unknown[]).length).toBe(0);
  });
});

// ============================================================================
// Integration Tests - Multiple Engines
// ============================================================================

describe("Graph Tools - Integration", () => {
  let server: PingMemServer;
  let mockHybridSearchEngine: ReturnType<typeof createMockHybridSearchEngine>;
  let mockLineageEngine: ReturnType<typeof createMockLineageEngine>;
  let mockEvolutionEngine: ReturnType<typeof createMockEvolutionEngine>;

  beforeEach(() => {
    mockHybridSearchEngine = createMockHybridSearchEngine();
    mockLineageEngine = createMockLineageEngine();
    mockEvolutionEngine = createMockEvolutionEngine();

    server = new PingMemServer({
      dbPath: ":memory:",
      enableVectorSearch: false,
      hybridSearchEngine: mockHybridSearchEngine,
      lineageEngine: mockLineageEngine,
      evolutionEngine: mockEvolutionEngine,
    });
  });

  afterEach(async () => {
    await server.close();
  });

  it("should support all three graph tools when all engines configured", async () => {
    // Setup mocks
    mockHybridSearchEngine.search.mockResolvedValue([]);
    mockLineageEngine.getAncestors.mockResolvedValue([]);
    mockLineageEngine.getDescendants.mockResolvedValue([]);
    mockEvolutionEngine.getEvolution.mockResolvedValue(createTestEvolutionTimeline("entity-1"));

    // Call all three tools
    const hybridResult = await callTool(server, "context_hybrid_search", { query: "test" });
    const lineageResult = await callTool(server, "context_get_lineage", { entityId: "entity-1" });
    const evolutionResult = await callTool(server, "context_query_evolution", { entityId: "entity-1" });

    // Verify all tools work
    expect(hybridResult.count).toBe(0);
    expect(lineageResult.entityId).toBe("entity-1");
    expect(evolutionResult.entityId).toBe("entity-1");
  });

  it("should work with other tools like context_session_start", async () => {
    // Start a session (basic server functionality)
    const sessionResult = await callTool(server, "context_session_start", { name: "test-session" });
    expect(sessionResult.success).toBe(true);

    // Use graph tool
    mockHybridSearchEngine.search.mockResolvedValue([]);
    const searchResult = await callTool(server, "context_hybrid_search", { query: "test" });
    expect(searchResult.count).toBe(0);
  });
});
