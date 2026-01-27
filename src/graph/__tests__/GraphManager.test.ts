/**
 * Tests for GraphManager
 *
 * @module graph/__tests__/GraphManager.test
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import {
  GraphManager,
  GraphManagerConfig,
  GraphManagerError,
  EntityNotFoundError,
  RelationshipNotFoundError,
  createGraphManager,
} from "../GraphManager.js";
import type { Neo4jClient } from "../Neo4jClient.js";
import { EntityType, RelationshipType } from "../../types/graph.js";
import type { Entity, Relationship } from "../../types/graph.js";

// ============================================================================
// Mock Setup
// ============================================================================

// Mock crypto.randomUUID
vi.mock("crypto", () => ({
  randomUUID: vi.fn(() => "test-uuid-1234"),
}));

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
 * Create a test entity input
 */
function createTestEntityInput() {
  return {
    type: EntityType.CONCEPT,
    name: "Test Entity",
    properties: { description: "A test entity" },
    eventTime: new Date("2024-01-01T00:00:00Z"),
    ingestionTime: new Date("2024-01-01T00:00:00Z"),
  };
}

/**
 * Create a test entity with all fields
 */
function createTestEntity(overrides?: Partial<Entity>): Entity {
  return {
    id: "test-uuid-1234",
    type: EntityType.CONCEPT,
    name: "Test Entity",
    properties: { description: "A test entity" },
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-01T00:00:00Z"),
    eventTime: new Date("2024-01-01T00:00:00Z"),
    ingestionTime: new Date("2024-01-01T00:00:00Z"),
    ...overrides,
  };
}

/**
 * Create a test relationship input
 */
function createTestRelationshipInput() {
  return {
    type: RelationshipType.RELATED_TO,
    sourceId: "source-uuid",
    targetId: "target-uuid",
    properties: { reason: "test" },
    weight: 0.8,
    eventTime: new Date("2024-01-01T00:00:00Z"),
    ingestionTime: new Date("2024-01-01T00:00:00Z"),
  };
}

/**
 * Create a test relationship with all fields
 */
function createTestRelationship(overrides?: Partial<Relationship>): Relationship {
  return {
    id: "test-uuid-1234",
    type: RelationshipType.RELATED_TO,
    sourceId: "source-uuid",
    targetId: "target-uuid",
    properties: { reason: "test" },
    weight: 0.8,
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-01T00:00:00Z"),
    eventTime: new Date("2024-01-01T00:00:00Z"),
    ingestionTime: new Date("2024-01-01T00:00:00Z"),
    ...overrides,
  };
}

// ============================================================================
// Unit Tests
// ============================================================================

describe("GraphManager - Unit Tests", () => {
  let mockClient: MockNeo4jClient;
  let manager: GraphManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = createMockNeo4jClient();
    manager = new GraphManager({ neo4jClient: mockClient as unknown as Neo4jClient });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("Configuration", () => {
    it("should accept required configuration", () => {
      const config: GraphManagerConfig = {
        neo4jClient: mockClient as unknown as Neo4jClient,
      };
      const mgr = new GraphManager(config);
      expect(mgr).toBeInstanceOf(GraphManager);
    });

    it("should use default values for optional config", () => {
      const mgr = new GraphManager({ neo4jClient: mockClient as unknown as Neo4jClient });
      expect(mgr).toBeInstanceOf(GraphManager);
      // Default batchSize is 100, enableAutoMerge is true
    });

    it("should override default values with provided config", () => {
      const config: GraphManagerConfig = {
        neo4jClient: mockClient as unknown as Neo4jClient,
        defaultBatchSize: 50,
        enableAutoMerge: false,
      };
      const mgr = new GraphManager(config);
      expect(mgr).toBeInstanceOf(GraphManager);
    });
  });

  // ==========================================================================
  // Entity CRUD Tests
  // ==========================================================================

  describe("createEntity", () => {
    it("should create an entity with generated id and timestamps", async () => {
      const input = createTestEntityInput();
      const mockResult = {
        id: "test-uuid-1234",
        type: EntityType.CONCEPT,
        name: "Test Entity",
        properties: JSON.stringify({ description: "A test entity" }),
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        eventTime: "2024-01-01T00:00:00.000Z",
        ingestionTime: "2024-01-01T00:00:00.000Z",
      };

      mockClient.executeWrite.mockResolvedValue(mockResult);

      const result = await manager.createEntity(input);

      expect(result.id).toBe("test-uuid-1234");
      expect(result.type).toBe(EntityType.CONCEPT);
      expect(result.name).toBe("Test Entity");
      expect(result.properties).toEqual({ description: "A test entity" });
      expect(mockClient.executeWrite).toHaveBeenCalledTimes(1);
    });

    it("should throw GraphManagerError on failure", async () => {
      const input = createTestEntityInput();
      mockClient.executeWrite.mockRejectedValue(new Error("DB Error"));

      await expect(manager.createEntity(input)).rejects.toThrow(GraphManagerError);
      await expect(manager.createEntity(input)).rejects.toThrow("Failed to create entity");
    });
  });

  describe("getEntity", () => {
    it("should return entity when found", async () => {
      const mockResult = {
        id: "test-uuid-1234",
        type: EntityType.CONCEPT,
        name: "Test Entity",
        properties: JSON.stringify({ description: "A test entity" }),
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        eventTime: "2024-01-01T00:00:00.000Z",
        ingestionTime: "2024-01-01T00:00:00.000Z",
      };

      mockClient.executeQuery.mockResolvedValue([mockResult]);

      const result = await manager.getEntity("test-uuid-1234");

      expect(result).not.toBeNull();
      expect(result?.id).toBe("test-uuid-1234");
      expect(result?.type).toBe(EntityType.CONCEPT);
    });

    it("should return null when entity not found", async () => {
      mockClient.executeQuery.mockResolvedValue([]);

      const result = await manager.getEntity("nonexistent-id");

      expect(result).toBeNull();
    });

    it("should throw GraphManagerError on failure", async () => {
      mockClient.executeQuery.mockRejectedValue(new Error("DB Error"));

      await expect(manager.getEntity("test-id")).rejects.toThrow(GraphManagerError);
      await expect(manager.getEntity("test-id")).rejects.toThrow("Failed to get entity");
    });
  });

  describe("updateEntity", () => {
    it("should update entity with partial data", async () => {
      const mockResult = {
        id: "test-uuid-1234",
        type: EntityType.CONCEPT,
        name: "Updated Entity",
        properties: JSON.stringify({ description: "Updated" }),
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-02T00:00:00.000Z",
        eventTime: "2024-01-01T00:00:00.000Z",
        ingestionTime: "2024-01-01T00:00:00.000Z",
      };

      mockClient.executeWrite.mockResolvedValue(mockResult);

      const result = await manager.updateEntity("test-uuid-1234", {
        name: "Updated Entity",
        properties: { description: "Updated" },
      });

      expect(result.name).toBe("Updated Entity");
      expect(result.properties).toEqual({ description: "Updated" });
    });

    it("should throw EntityNotFoundError when entity does not exist", async () => {
      // Return result without id to simulate not found
      mockClient.executeWrite.mockResolvedValue({
        nodesCreated: 0,
        nodesDeleted: 0,
        relationshipsCreated: 0,
        relationshipsDeleted: 0,
        propertiesSet: 0,
      });

      await expect(
        manager.updateEntity("nonexistent", { name: "New Name" })
      ).rejects.toThrow(EntityNotFoundError);
    });

    it("should throw GraphManagerError on failure", async () => {
      mockClient.executeWrite.mockRejectedValue(new Error("DB Error"));

      await expect(
        manager.updateEntity("test-id", { name: "New Name" })
      ).rejects.toThrow(GraphManagerError);
    });
  });

  describe("deleteEntity", () => {
    it("should return true when entity is deleted", async () => {
      mockClient.executeWrite.mockResolvedValue({ deleted: 1 });

      const result = await manager.deleteEntity("test-uuid-1234");

      expect(result).toBe(true);
    });

    it("should return false when entity is not found", async () => {
      mockClient.executeWrite.mockResolvedValue({ deleted: 0 });

      const result = await manager.deleteEntity("nonexistent");

      expect(result).toBe(false);
    });

    it("should throw GraphManagerError on failure", async () => {
      mockClient.executeWrite.mockRejectedValue(new Error("DB Error"));

      await expect(manager.deleteEntity("test-id")).rejects.toThrow(GraphManagerError);
      await expect(manager.deleteEntity("test-id")).rejects.toThrow("Failed to delete entity");
    });
  });

  // ==========================================================================
  // Relationship CRUD Tests
  // ==========================================================================

  describe("createRelationship", () => {
    it("should create a relationship with generated id and timestamps", async () => {
      const input = createTestRelationshipInput();
      const mockResult = {
        id: "test-uuid-1234",
        type: RelationshipType.RELATED_TO,
        sourceId: "source-uuid",
        targetId: "target-uuid",
        properties: JSON.stringify({ reason: "test" }),
        weight: 0.8,
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        eventTime: "2024-01-01T00:00:00.000Z",
        ingestionTime: "2024-01-01T00:00:00.000Z",
      };

      mockClient.executeWrite.mockResolvedValue(mockResult);

      const result = await manager.createRelationship(input);

      expect(result.id).toBe("test-uuid-1234");
      expect(result.type).toBe(RelationshipType.RELATED_TO);
      expect(result.sourceId).toBe("source-uuid");
      expect(result.targetId).toBe("target-uuid");
      expect(result.weight).toBe(0.8);
    });

    it("should throw GraphManagerError on failure", async () => {
      const input = createTestRelationshipInput();
      mockClient.executeWrite.mockRejectedValue(new Error("DB Error"));

      await expect(manager.createRelationship(input)).rejects.toThrow(GraphManagerError);
      await expect(manager.createRelationship(input)).rejects.toThrow(
        "Failed to create relationship"
      );
    });
  });

  describe("getRelationship", () => {
    it("should return relationship when found", async () => {
      const mockResult = {
        id: "test-uuid-1234",
        type: RelationshipType.RELATED_TO,
        sourceId: "source-uuid",
        targetId: "target-uuid",
        properties: JSON.stringify({ reason: "test" }),
        weight: 0.8,
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        eventTime: "2024-01-01T00:00:00.000Z",
        ingestionTime: "2024-01-01T00:00:00.000Z",
      };

      mockClient.executeQuery.mockResolvedValue([mockResult]);

      const result = await manager.getRelationship("test-uuid-1234");

      expect(result).not.toBeNull();
      expect(result?.id).toBe("test-uuid-1234");
      expect(result?.type).toBe(RelationshipType.RELATED_TO);
    });

    it("should return null when relationship not found", async () => {
      mockClient.executeQuery.mockResolvedValue([]);

      const result = await manager.getRelationship("nonexistent-id");

      expect(result).toBeNull();
    });

    it("should throw GraphManagerError on failure", async () => {
      mockClient.executeQuery.mockRejectedValue(new Error("DB Error"));

      await expect(manager.getRelationship("test-id")).rejects.toThrow(GraphManagerError);
      await expect(manager.getRelationship("test-id")).rejects.toThrow(
        "Failed to get relationship"
      );
    });
  });

  describe("deleteRelationship", () => {
    it("should return true when relationship is deleted", async () => {
      mockClient.executeWrite.mockResolvedValue({ deleted: 1 });

      const result = await manager.deleteRelationship("test-uuid-1234");

      expect(result).toBe(true);
    });

    it("should return false when relationship is not found", async () => {
      mockClient.executeWrite.mockResolvedValue({ deleted: 0 });

      const result = await manager.deleteRelationship("nonexistent");

      expect(result).toBe(false);
    });

    it("should throw GraphManagerError on failure", async () => {
      mockClient.executeWrite.mockRejectedValue(new Error("DB Error"));

      await expect(manager.deleteRelationship("test-id")).rejects.toThrow(GraphManagerError);
    });
  });

  // ==========================================================================
  // Query Operation Tests
  // ==========================================================================

  describe("findEntitiesByType", () => {
    it("should return entities of specified type", async () => {
      const mockResults = [
        {
          id: "entity-1",
          type: EntityType.CONCEPT,
          name: "Concept 1",
          properties: JSON.stringify({}),
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
          eventTime: "2024-01-01T00:00:00.000Z",
          ingestionTime: "2024-01-01T00:00:00.000Z",
        },
        {
          id: "entity-2",
          type: EntityType.CONCEPT,
          name: "Concept 2",
          properties: JSON.stringify({}),
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
          eventTime: "2024-01-01T00:00:00.000Z",
          ingestionTime: "2024-01-01T00:00:00.000Z",
        },
      ];

      mockClient.executeQuery.mockResolvedValue(mockResults);

      const results = await manager.findEntitiesByType(EntityType.CONCEPT);

      expect(results).toHaveLength(2);
      expect(results[0]?.id).toBe("entity-1");
      expect(results[1]?.id).toBe("entity-2");
    });

    it("should return empty array when no entities found", async () => {
      mockClient.executeQuery.mockResolvedValue([]);

      const results = await manager.findEntitiesByType(EntityType.PERSON);

      expect(results).toHaveLength(0);
    });

    it("should throw GraphManagerError on failure", async () => {
      mockClient.executeQuery.mockRejectedValue(new Error("DB Error"));

      await expect(manager.findEntitiesByType(EntityType.CONCEPT)).rejects.toThrow(
        GraphManagerError
      );
    });
  });

  describe("findRelationshipsByEntity", () => {
    it("should return relationships connected to entity", async () => {
      const mockResults = [
        {
          id: "rel-1",
          type: RelationshipType.RELATED_TO,
          sourceId: "entity-1",
          targetId: "entity-2",
          properties: JSON.stringify({}),
          weight: 0.5,
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
          eventTime: "2024-01-01T00:00:00.000Z",
          ingestionTime: "2024-01-01T00:00:00.000Z",
        },
      ];

      mockClient.executeQuery.mockResolvedValue(mockResults);

      const results = await manager.findRelationshipsByEntity("entity-1");

      expect(results).toHaveLength(1);
      expect(results[0]?.sourceId).toBe("entity-1");
    });

    it("should return empty array when no relationships found", async () => {
      mockClient.executeQuery.mockResolvedValue([]);

      const results = await manager.findRelationshipsByEntity("isolated-entity");

      expect(results).toHaveLength(0);
    });

    it("should throw GraphManagerError on failure", async () => {
      mockClient.executeQuery.mockRejectedValue(new Error("DB Error"));

      await expect(manager.findRelationshipsByEntity("entity-id")).rejects.toThrow(
        GraphManagerError
      );
    });
  });

  // ==========================================================================
  // Merge and Batch Operation Tests
  // ==========================================================================

  describe("mergeEntity", () => {
    it("should merge entity with auto-merge enabled (default)", async () => {
      const entity = createTestEntity();
      const mockResult = {
        id: "test-uuid-1234",
        type: EntityType.CONCEPT,
        name: "Test Entity",
        properties: JSON.stringify({ description: "A test entity" }),
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        eventTime: "2024-01-01T00:00:00.000Z",
        ingestionTime: "2024-01-01T00:00:00.000Z",
      };

      mockClient.executeWrite.mockResolvedValue(mockResult);

      const result = await manager.mergeEntity(entity);

      expect(result.id).toBe("test-uuid-1234");
      expect(mockClient.executeWrite).toHaveBeenCalledTimes(1);
      // Check that MERGE query was used
      const callArg = mockClient.executeWrite.mock.calls[0]?.[0];
      expect(callArg).toContain("MERGE");
    });

    it("should create new entity when auto-merge disabled and entity not found", async () => {
      const mgr = new GraphManager({
        neo4jClient: mockClient as unknown as Neo4jClient,
        enableAutoMerge: false,
      });

      const entity = createTestEntity();
      const mockCreateResult = {
        id: "new-uuid",
        type: EntityType.CONCEPT,
        name: "Test Entity",
        properties: JSON.stringify({ description: "A test entity" }),
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        eventTime: "2024-01-01T00:00:00.000Z",
        ingestionTime: "2024-01-01T00:00:00.000Z",
      };

      // First call is getEntity (returns empty), second is createEntity
      mockClient.executeQuery.mockResolvedValue([]);
      mockClient.executeWrite.mockResolvedValue(mockCreateResult);

      const result = await mgr.mergeEntity(entity);

      expect(result.id).toBe("new-uuid");
      expect(mockClient.executeQuery).toHaveBeenCalledTimes(1);
      expect(mockClient.executeWrite).toHaveBeenCalledTimes(1);
    });

    it("should throw GraphManagerError on failure", async () => {
      const entity = createTestEntity();
      mockClient.executeWrite.mockRejectedValue(new Error("DB Error"));

      await expect(manager.mergeEntity(entity)).rejects.toThrow(GraphManagerError);
      await expect(manager.mergeEntity(entity)).rejects.toThrow("Failed to merge entity");
    });
  });

  describe("batchCreateEntities", () => {
    it("should create multiple entities", async () => {
      const entities = [
        createTestEntity({ id: "entity-1", name: "Entity 1" }),
        createTestEntity({ id: "entity-2", name: "Entity 2" }),
      ];

      const mockResults = [
        {
          id: "entity-1",
          type: EntityType.CONCEPT,
          name: "Entity 1",
          properties: JSON.stringify({}),
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
          eventTime: "2024-01-01T00:00:00.000Z",
          ingestionTime: "2024-01-01T00:00:00.000Z",
        },
        {
          id: "entity-2",
          type: EntityType.CONCEPT,
          name: "Entity 2",
          properties: JSON.stringify({}),
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
          eventTime: "2024-01-01T00:00:00.000Z",
          ingestionTime: "2024-01-01T00:00:00.000Z",
        },
      ];

      mockClient.executeQuery.mockResolvedValue(mockResults);

      const results = await manager.batchCreateEntities(entities);

      expect(results).toHaveLength(2);
      expect(results[0]?.id).toBe("entity-1");
      expect(results[1]?.id).toBe("entity-2");
    });

    it("should return empty array for empty input", async () => {
      const results = await manager.batchCreateEntities([]);

      expect(results).toHaveLength(0);
      expect(mockClient.executeQuery).not.toHaveBeenCalled();
    });

    it("should process entities in batches based on batchSize", async () => {
      const mgr = new GraphManager({
        neo4jClient: mockClient as unknown as Neo4jClient,
        defaultBatchSize: 2,
      });

      const entities = [
        createTestEntity({ id: "entity-1", name: "Entity 1" }),
        createTestEntity({ id: "entity-2", name: "Entity 2" }),
        createTestEntity({ id: "entity-3", name: "Entity 3" }),
      ];

      // First batch
      const mockResults1 = [
        {
          id: "entity-1",
          type: EntityType.CONCEPT,
          name: "Entity 1",
          properties: JSON.stringify({}),
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
          eventTime: "2024-01-01T00:00:00.000Z",
          ingestionTime: "2024-01-01T00:00:00.000Z",
        },
        {
          id: "entity-2",
          type: EntityType.CONCEPT,
          name: "Entity 2",
          properties: JSON.stringify({}),
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
          eventTime: "2024-01-01T00:00:00.000Z",
          ingestionTime: "2024-01-01T00:00:00.000Z",
        },
      ];

      // Second batch
      const mockResults2 = [
        {
          id: "entity-3",
          type: EntityType.CONCEPT,
          name: "Entity 3",
          properties: JSON.stringify({}),
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
          eventTime: "2024-01-01T00:00:00.000Z",
          ingestionTime: "2024-01-01T00:00:00.000Z",
        },
      ];

      mockClient.executeQuery
        .mockResolvedValueOnce(mockResults1)
        .mockResolvedValueOnce(mockResults2);

      const results = await mgr.batchCreateEntities(entities);

      expect(results).toHaveLength(3);
      expect(mockClient.executeQuery).toHaveBeenCalledTimes(2);
    });

    it("should throw GraphManagerError on failure", async () => {
      const entities = [createTestEntity()];
      mockClient.executeQuery.mockRejectedValue(new Error("DB Error"));

      await expect(manager.batchCreateEntities(entities)).rejects.toThrow(GraphManagerError);
      await expect(manager.batchCreateEntities(entities)).rejects.toThrow(
        "Failed to batch create entities"
      );
    });
  });
});

// ============================================================================
// Error Class Tests
// ============================================================================

describe("Error Classes", () => {
  describe("GraphManagerError", () => {
    it("should have correct name, message, and operation", () => {
      const error = new GraphManagerError("Something failed", "testOp");
      expect(error.name).toBe("GraphManagerError");
      expect(error.message).toBe("Something failed");
      expect(error.operation).toBe("testOp");
    });

    it("should preserve cause", () => {
      const cause = new Error("Original error");
      const error = new GraphManagerError("Something failed", "testOp", cause);
      expect(error.cause).toBe(cause);
    });

    it("should be instanceof Error", () => {
      const error = new GraphManagerError("Test", "testOp");
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe("EntityNotFoundError", () => {
    it("should have correct name, message, and entityId", () => {
      const error = new EntityNotFoundError("test-id");
      expect(error.name).toBe("EntityNotFoundError");
      expect(error.message).toBe("Entity not found: test-id");
      expect(error.entityId).toBe("test-id");
      expect(error.operation).toBe("getEntity");
    });

    it("should be instanceof GraphManagerError", () => {
      const error = new EntityNotFoundError("test-id");
      expect(error).toBeInstanceOf(GraphManagerError);
    });
  });

  describe("RelationshipNotFoundError", () => {
    it("should have correct name, message, and relationshipId", () => {
      const error = new RelationshipNotFoundError("test-id");
      expect(error.name).toBe("RelationshipNotFoundError");
      expect(error.message).toBe("Relationship not found: test-id");
      expect(error.relationshipId).toBe("test-id");
      expect(error.operation).toBe("getRelationship");
    });

    it("should be instanceof GraphManagerError", () => {
      const error = new RelationshipNotFoundError("test-id");
      expect(error).toBeInstanceOf(GraphManagerError);
    });
  });
});

// ============================================================================
// Factory Function Tests
// ============================================================================

describe("Factory Functions", () => {
  describe("createGraphManager", () => {
    it("should create a new GraphManager instance", () => {
      const mockClient = createMockNeo4jClient();
      const manager = createGraphManager({ neo4jClient: mockClient as unknown as Neo4jClient });
      expect(manager).toBeInstanceOf(GraphManager);
    });

    it("should accept optional config", () => {
      const mockClient = createMockNeo4jClient();
      const manager = createGraphManager({
        neo4jClient: mockClient as unknown as Neo4jClient,
        defaultBatchSize: 50,
        enableAutoMerge: false,
      });
      expect(manager).toBeInstanceOf(GraphManager);
    });
  });
});
