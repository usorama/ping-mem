/**
 * Tests for LineageEngine
 *
 * @module graph/__tests__/LineageEngine.test
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import {
  LineageEngine,
  LineageEngineError,
  LineageEntityNotFoundError,
  LineagePathNotFoundError,
  createLineageEngine,
  type EntityEvolutionEntry,
  type LineageGraph,
} from "../LineageEngine.js";
import type { Neo4jClient } from "../Neo4jClient.js";
import { EntityType } from "../../types/graph.js";
import type { Entity } from "../../types/graph.js";

// ============================================================================
// Mock Setup
// ============================================================================

interface MockNeo4jClient {
  executeQuery: Mock<(...args: unknown[]) => Promise<unknown[]>>;
  executeWrite: Mock<(...args: unknown[]) => Promise<unknown>>;
  executeTransaction: Mock<(...args: unknown[]) => Promise<unknown>>;
  connect: Mock<() => Promise<void>>;
  disconnect: Mock<() => Promise<void>>;
  isConnected: Mock<() => boolean>;
  ping: Mock<() => Promise<boolean>>;
  getSession: Mock<() => unknown>;
  getDriver: Mock<() => unknown>;
}

/**
 * Create a mock Neo4jClient
 */
function createMockNeo4jClient(): MockNeo4jClient {
  return {
    executeQuery: vi.fn(),
    executeWrite: vi.fn(),
    executeTransaction: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
    ping: vi.fn().mockResolvedValue(true),
    getSession: vi.fn(),
    getDriver: vi.fn(),
  };
}

/**
 * Create a test entity result (as returned from Neo4j)
 */
function createTestEntityResult(overrides?: Partial<{
  id: string;
  type: string;
  name: string;
  properties: string;
  createdAt: string;
  updatedAt: string;
  eventTime: string;
  ingestionTime: string;
}>) {
  return {
    id: "entity-1",
    type: EntityType.CONCEPT,
    name: "Test Entity",
    properties: JSON.stringify({ description: "A test entity" }),
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    eventTime: "2024-01-01T00:00:00.000Z",
    ingestionTime: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * Create expected Entity object
 */
function createExpectedEntity(overrides?: Partial<Entity>): Entity {
  return {
    id: "entity-1",
    type: EntityType.CONCEPT,
    name: "Test Entity",
    properties: { description: "A test entity" },
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    updatedAt: new Date("2024-01-01T00:00:00.000Z"),
    eventTime: new Date("2024-01-01T00:00:00.000Z"),
    ingestionTime: new Date("2024-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

// ============================================================================
// Unit Tests
// ============================================================================

describe("LineageEngine - Unit Tests", () => {
  let mockClient: MockNeo4jClient;
  let engine: LineageEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = createMockNeo4jClient();
    engine = new LineageEngine(mockClient as unknown as Neo4jClient);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ==========================================================================
  // Constructor Tests
  // ==========================================================================

  describe("constructor", () => {
    it("should create a LineageEngine instance", () => {
      const eng = new LineageEngine(mockClient as unknown as Neo4jClient);
      expect(eng).toBeInstanceOf(LineageEngine);
    });
  });

  // ==========================================================================
  // getAncestors Tests
  // ==========================================================================

  describe("getAncestors", () => {
    it("should return ancestors ordered by depth", async () => {
      const mockResults = [
        createTestEntityResult({ id: "parent-1", name: "Parent 1" }),
        createTestEntityResult({ id: "grandparent-1", name: "Grandparent 1" }),
      ];

      mockClient.executeQuery.mockResolvedValue(mockResults);

      const result = await engine.getAncestors("child-1");

      expect(result).toHaveLength(2);
      expect(result[0]?.id).toBe("parent-1");
      expect(result[1]?.id).toBe("grandparent-1");
      expect(mockClient.executeQuery).toHaveBeenCalledTimes(1);
      expect(mockClient.executeQuery.mock.calls[0]?.[1]).toEqual({ entityId: "child-1" });
    });

    it("should return empty array when no ancestors found", async () => {
      mockClient.executeQuery.mockResolvedValue([]);

      const result = await engine.getAncestors("root-entity");

      expect(result).toHaveLength(0);
    });

    it("should respect maxDepth parameter", async () => {
      mockClient.executeQuery.mockResolvedValue([]);

      await engine.getAncestors("entity-1", 5);

      const query = mockClient.executeQuery.mock.calls[0]?.[0] as string;
      expect(query).toContain("*1..5");
    });

    it("should use default maxDepth of 10", async () => {
      mockClient.executeQuery.mockResolvedValue([]);

      await engine.getAncestors("entity-1");

      const query = mockClient.executeQuery.mock.calls[0]?.[0] as string;
      expect(query).toContain("*1..10");
    });

    it("should throw LineageEngineError on failure", async () => {
      mockClient.executeQuery.mockRejectedValue(new Error("DB Error"));

      await expect(engine.getAncestors("entity-1")).rejects.toThrow(LineageEngineError);
      await expect(engine.getAncestors("entity-1")).rejects.toThrow("Failed to get ancestors");
    });
  });

  // ==========================================================================
  // getDescendants Tests
  // ==========================================================================

  describe("getDescendants", () => {
    it("should return descendants ordered by depth", async () => {
      const mockResults = [
        createTestEntityResult({ id: "child-1", name: "Child 1" }),
        createTestEntityResult({ id: "grandchild-1", name: "Grandchild 1" }),
      ];

      mockClient.executeQuery.mockResolvedValue(mockResults);

      const result = await engine.getDescendants("parent-1");

      expect(result).toHaveLength(2);
      expect(result[0]?.id).toBe("child-1");
      expect(result[1]?.id).toBe("grandchild-1");
      expect(mockClient.executeQuery).toHaveBeenCalledTimes(1);
    });

    it("should return empty array when no descendants found", async () => {
      mockClient.executeQuery.mockResolvedValue([]);

      const result = await engine.getDescendants("leaf-entity");

      expect(result).toHaveLength(0);
    });

    it("should respect maxDepth parameter", async () => {
      mockClient.executeQuery.mockResolvedValue([]);

      await engine.getDescendants("entity-1", 3);

      const query = mockClient.executeQuery.mock.calls[0]?.[0] as string;
      expect(query).toContain("*1..3");
    });

    it("should throw LineageEngineError on failure", async () => {
      mockClient.executeQuery.mockRejectedValue(new Error("DB Error"));

      await expect(engine.getDescendants("entity-1")).rejects.toThrow(LineageEngineError);
      await expect(engine.getDescendants("entity-1")).rejects.toThrow("Failed to get descendants");
    });
  });

  // ==========================================================================
  // getLineagePath Tests
  // ==========================================================================

  describe("getLineagePath", () => {
    it("should return path from derived to ancestor", async () => {
      const mockResults = [
        createTestEntityResult({ id: "derived-1", name: "Derived" }),
        createTestEntityResult({ id: "intermediate-1", name: "Intermediate" }),
        createTestEntityResult({ id: "original-1", name: "Original" }),
      ];

      mockClient.executeQuery.mockResolvedValue(mockResults);

      const result = await engine.getLineagePath("derived-1", "original-1");

      expect(result).toHaveLength(3);
      expect(result[0]?.id).toBe("derived-1");
      expect(result[2]?.id).toBe("original-1");
    });

    it("should throw LineagePathNotFoundError when no path exists", async () => {
      mockClient.executeQuery.mockResolvedValue([]);

      await expect(engine.getLineagePath("entity-a", "entity-b")).rejects.toThrow(
        LineagePathNotFoundError
      );
    });

    it("should throw LineageEngineError on database failure", async () => {
      mockClient.executeQuery.mockRejectedValue(new Error("DB Error"));

      await expect(engine.getLineagePath("a", "b")).rejects.toThrow(LineageEngineError);
      await expect(engine.getLineagePath("a", "b")).rejects.toThrow("Failed to get lineage path");
    });
  });

  // ==========================================================================
  // getRootAncestors Tests
  // ==========================================================================

  describe("getRootAncestors", () => {
    it("should return root ancestors with no parents", async () => {
      const mockResults = [
        createTestEntityResult({ id: "root-1", name: "Root 1" }),
        createTestEntityResult({ id: "root-2", name: "Root 2" }),
      ];

      mockClient.executeQuery.mockResolvedValue(mockResults);

      const result = await engine.getRootAncestors("descendant-1");

      expect(result).toHaveLength(2);
      expect(result[0]?.id).toBe("root-1");
      expect(result[1]?.id).toBe("root-2");
    });

    it("should return empty array when entity is a root itself", async () => {
      mockClient.executeQuery.mockResolvedValue([]);

      const result = await engine.getRootAncestors("root-entity");

      expect(result).toHaveLength(0);
    });

    it("should throw LineageEngineError on failure", async () => {
      mockClient.executeQuery.mockRejectedValue(new Error("DB Error"));

      await expect(engine.getRootAncestors("entity-1")).rejects.toThrow(LineageEngineError);
      await expect(engine.getRootAncestors("entity-1")).rejects.toThrow(
        "Failed to get root ancestors"
      );
    });
  });

  // ==========================================================================
  // getEvolutionTimeline Tests
  // ==========================================================================

  describe("getEvolutionTimeline", () => {
    it("should return evolution timeline sorted by generation", async () => {
      const selfResult = [
        {
          ...createTestEntityResult({ id: "current-1", name: "Current" }),
          generation: 0,
          relId: "rel-1",
          relProperties: JSON.stringify({ reason: "derived" }),
          relWeight: 0.9,
          relEventTime: "2024-01-01T00:00:00.000Z",
        },
      ];

      const ancestorResults = [
        {
          ...createTestEntityResult({ id: "ancestor-1", name: "Ancestor" }),
          generation: 1,
          relId: null,
          relProperties: null,
          relWeight: null,
          relEventTime: null,
        },
      ];

      const descendantResults = [
        {
          ...createTestEntityResult({ id: "descendant-1", name: "Descendant" }),
          generation: 1,
          relId: "rel-2",
          relProperties: JSON.stringify({ reason: "evolved" }),
          relWeight: 0.8,
          relEventTime: "2024-01-02T00:00:00.000Z",
        },
      ];

      mockClient.executeQuery
        .mockResolvedValueOnce(selfResult)
        .mockResolvedValueOnce(ancestorResults)
        .mockResolvedValueOnce(descendantResults);

      const result = await engine.getEvolutionTimeline("current-1");

      expect(result).toHaveLength(3);
      // Should be sorted by generation
      expect(result[0]?.generation).toBeLessThanOrEqual(result[1]?.generation ?? 0);
      expect(result[1]?.generation).toBeLessThanOrEqual(result[2]?.generation ?? 0);
    });

    it("should include derivation relationship when present", async () => {
      const selfResult = [
        {
          ...createTestEntityResult({ id: "current-1", name: "Current" }),
          generation: 0,
          relId: "rel-1",
          relProperties: JSON.stringify({ reason: "derived" }),
          relWeight: 0.9,
          relEventTime: "2024-01-01T00:00:00.000Z",
        },
      ];

      mockClient.executeQuery
        .mockResolvedValueOnce(selfResult)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await engine.getEvolutionTimeline("current-1");

      expect(result).toHaveLength(1);
      expect(result[0]?.derivationRelationship).not.toBeNull();
      expect(result[0]?.derivationRelationship?.id).toBe("rel-1");
      expect(result[0]?.derivationRelationship?.weight).toBe(0.9);
    });

    it("should set derivationRelationship to null for root entities", async () => {
      const selfResult = [
        {
          ...createTestEntityResult({ id: "root-1", name: "Root" }),
          generation: 0,
          relId: null,
          relProperties: null,
          relWeight: null,
          relEventTime: null,
        },
      ];

      mockClient.executeQuery
        .mockResolvedValueOnce(selfResult)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await engine.getEvolutionTimeline("root-1");

      expect(result).toHaveLength(1);
      expect(result[0]?.derivationRelationship).toBeNull();
    });

    it("should throw LineageEngineError on failure", async () => {
      mockClient.executeQuery.mockRejectedValue(new Error("DB Error"));

      await expect(engine.getEvolutionTimeline("entity-1")).rejects.toThrow(LineageEngineError);
      await expect(engine.getEvolutionTimeline("entity-1")).rejects.toThrow(
        "Failed to get evolution timeline"
      );
    });
  });

  // ==========================================================================
  // buildLineageGraph Tests
  // ==========================================================================

  describe("buildLineageGraph", () => {
    it("should build lineage graph with nodes and edges", async () => {
      const centerResult = [
        {
          ...createTestEntityResult({ id: "center-1", name: "Center" }),
          depth: 0,
          ancestorCount: 1,
          descendantCount: 1,
        },
      ];

      const nodeResults = [
        { ...createTestEntityResult({ id: "center-1", name: "Center" }), depth: 0 },
        { ...createTestEntityResult({ id: "ancestor-1", name: "Ancestor" }), depth: -1 },
        { ...createTestEntityResult({ id: "descendant-1", name: "Descendant" }), depth: 1 },
      ];

      const edgeResults = [
        {
          sourceId: "center-1",
          targetId: "ancestor-1",
          properties: JSON.stringify({ reason: "derived" }),
          weight: 0.9,
        },
        {
          sourceId: "descendant-1",
          targetId: "center-1",
          properties: JSON.stringify({ reason: "evolved" }),
          weight: 0.8,
        },
      ];

      mockClient.executeQuery
        .mockResolvedValueOnce(centerResult)
        .mockResolvedValueOnce(nodeResults)
        .mockResolvedValueOnce(edgeResults);

      const result = await engine.buildLineageGraph("center-1");

      expect(result.centerEntityId).toBe("center-1");
      expect(result.nodes).toHaveLength(3);
      expect(result.edges).toHaveLength(2);
      expect(result.ancestorCount).toBe(1);
      expect(result.descendantCount).toBe(1);
    });

    it("should respect depth parameter", async () => {
      const centerResult = [
        {
          ...createTestEntityResult({ id: "center-1", name: "Center" }),
          depth: 0,
          ancestorCount: 0,
          descendantCount: 0,
        },
      ];

      mockClient.executeQuery
        .mockResolvedValueOnce(centerResult)
        .mockResolvedValueOnce([{ ...createTestEntityResult({ id: "center-1" }), depth: 0 }])
        .mockResolvedValueOnce([]);

      await engine.buildLineageGraph("center-1", 5);

      // Check that depth is used in queries
      const firstQuery = mockClient.executeQuery.mock.calls[0]?.[0] as string;
      expect(firstQuery).toContain("*1..5");
    });

    it("should use default depth of 3", async () => {
      const centerResult = [
        {
          ...createTestEntityResult({ id: "center-1", name: "Center" }),
          depth: 0,
          ancestorCount: 0,
          descendantCount: 0,
        },
      ];

      mockClient.executeQuery
        .mockResolvedValueOnce(centerResult)
        .mockResolvedValueOnce([{ ...createTestEntityResult({ id: "center-1" }), depth: 0 }])
        .mockResolvedValueOnce([]);

      await engine.buildLineageGraph("center-1");

      const firstQuery = mockClient.executeQuery.mock.calls[0]?.[0] as string;
      expect(firstQuery).toContain("*1..3");
    });

    it("should throw LineageEntityNotFoundError when entity not found", async () => {
      mockClient.executeQuery
        .mockResolvedValueOnce([]) // Empty center result
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      await expect(engine.buildLineageGraph("nonexistent")).rejects.toThrow(
        LineageEntityNotFoundError
      );
    });

    it("should throw LineageEngineError on database failure", async () => {
      mockClient.executeQuery.mockRejectedValue(new Error("DB Error"));

      await expect(engine.buildLineageGraph("entity-1")).rejects.toThrow(LineageEngineError);
      await expect(engine.buildLineageGraph("entity-1")).rejects.toThrow(
        "Failed to build lineage graph"
      );
    });

    it("should filter out null nodes and edges", async () => {
      const centerResult = [
        {
          ...createTestEntityResult({ id: "center-1", name: "Center" }),
          depth: 0,
          ancestorCount: 0,
          descendantCount: 0,
        },
      ];

      const nodeResults = [
        { ...createTestEntityResult({ id: "center-1", name: "Center" }), depth: 0 },
        { id: null, type: null, name: null, properties: null, createdAt: null, updatedAt: null, eventTime: null, ingestionTime: null, depth: null },
      ];

      const edgeResults = [
        { sourceId: null, targetId: null, properties: null, weight: null },
      ];

      mockClient.executeQuery
        .mockResolvedValueOnce(centerResult)
        .mockResolvedValueOnce(nodeResults)
        .mockResolvedValueOnce(edgeResults);

      const result = await engine.buildLineageGraph("center-1");

      expect(result.nodes).toHaveLength(1);
      expect(result.edges).toHaveLength(0);
    });
  });
});

// ============================================================================
// Error Class Tests
// ============================================================================

describe("Error Classes", () => {
  describe("LineageEngineError", () => {
    it("should have correct name, message, and operation", () => {
      const error = new LineageEngineError("Something failed", "testOp");
      expect(error.name).toBe("LineageEngineError");
      expect(error.message).toBe("Something failed");
      expect(error.operation).toBe("testOp");
    });

    it("should preserve cause", () => {
      const cause = new Error("Original error");
      const error = new LineageEngineError("Something failed", "testOp", cause);
      expect(error.cause).toBe(cause);
    });

    it("should be instanceof Error", () => {
      const error = new LineageEngineError("Test", "testOp");
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe("LineageEntityNotFoundError", () => {
    it("should have correct name, message, entityId, and operation", () => {
      const error = new LineageEntityNotFoundError("test-id", "getAncestors");
      expect(error.name).toBe("LineageEntityNotFoundError");
      expect(error.message).toBe("Entity not found: test-id");
      expect(error.entityId).toBe("test-id");
      expect(error.operation).toBe("getAncestors");
    });

    it("should be instanceof LineageEngineError", () => {
      const error = new LineageEntityNotFoundError("test-id", "getAncestors");
      expect(error).toBeInstanceOf(LineageEngineError);
    });
  });

  describe("LineagePathNotFoundError", () => {
    it("should have correct name, message, fromId, and toId", () => {
      const error = new LineagePathNotFoundError("from-id", "to-id");
      expect(error.name).toBe("LineagePathNotFoundError");
      expect(error.message).toBe("No lineage path found from from-id to to-id");
      expect(error.fromId).toBe("from-id");
      expect(error.toId).toBe("to-id");
      expect(error.operation).toBe("getLineagePath");
    });

    it("should be instanceof LineageEngineError", () => {
      const error = new LineagePathNotFoundError("from-id", "to-id");
      expect(error).toBeInstanceOf(LineageEngineError);
    });
  });
});

// ============================================================================
// Factory Function Tests
// ============================================================================

describe("Factory Functions", () => {
  describe("createLineageEngine", () => {
    it("should create a new LineageEngine instance", () => {
      const mockClient = createMockNeo4jClient();
      const engine = createLineageEngine(mockClient as unknown as Neo4jClient);
      expect(engine).toBeInstanceOf(LineageEngine);
    });
  });
});

// ============================================================================
// Type Export Tests
// ============================================================================

describe("Type Exports", () => {
  it("should export EntityEvolutionEntry type", () => {
    const entry: EntityEvolutionEntry = {
      entity: createExpectedEntity(),
      generation: 0,
      derivationRelationship: null,
    };
    expect(entry.generation).toBe(0);
  });

  it("should export LineageGraph type", () => {
    const graph: LineageGraph = {
      centerEntityId: "center-1",
      nodes: [],
      edges: [],
      ancestorCount: 0,
      descendantCount: 0,
    };
    expect(graph.centerEntityId).toBe("center-1");
  });
});
