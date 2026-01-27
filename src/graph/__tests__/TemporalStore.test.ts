/**
 * Tests for TemporalStore
 *
 * @module graph/__tests__/TemporalStore.test
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import {
  TemporalStore,
  TemporalStoreConfig,
  TemporalStoreError,
  BiTemporalMeta,
  createTemporalStore,
} from "../TemporalStore.js";
import type { Neo4jClient } from "../Neo4jClient.js";
import { EntityType, RelationshipType } from "../../types/graph.js";
import type { Entity, Relationship } from "../../types/graph.js";

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

function createTestEntity(overrides?: Partial<Entity>): Entity {
  const now = new Date();
  return {
    id: "entity-1",
    type: EntityType.CONCEPT,
    name: "Test Entity",
    properties: { foo: "bar" },
    createdAt: now,
    updatedAt: now,
    eventTime: now,
    ingestionTime: now,
    ...overrides,
  };
}

function createTestRelationship(overrides?: Partial<Relationship>): Relationship {
  const now = new Date();
  return {
    id: "rel-1",
    type: RelationshipType.RELATED_TO,
    sourceId: "entity-1",
    targetId: "entity-2",
    properties: { strength: 0.8 },
    weight: 0.8,
    createdAt: now,
    updatedAt: now,
    eventTime: now,
    ingestionTime: now,
    ...overrides,
  };
}

// ============================================================================
// Unit Tests
// ============================================================================

describe("TemporalStore", () => {
  let mockClient: MockNeo4jClient;
  let store: TemporalStore;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = createMockNeo4jClient();
    store = new TemporalStore({
      neo4jClient: mockClient as unknown as Neo4jClient,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("Configuration", () => {
    it("should accept minimal configuration", () => {
      const minimalStore = new TemporalStore({
        neo4jClient: mockClient as unknown as Neo4jClient,
      });
      expect(minimalStore).toBeInstanceOf(TemporalStore);
    });

    it("should use default values for optional config", () => {
      const minimalStore = new TemporalStore({
        neo4jClient: mockClient as unknown as Neo4jClient,
      });
      expect(minimalStore.getDefaultRetentionDays()).toBe(365);
      expect(minimalStore.isVersioningEnabled()).toBe(true);
    });

    it("should override default values with provided config", () => {
      const customStore = new TemporalStore({
        neo4jClient: mockClient as unknown as Neo4jClient,
        defaultRetentionDays: 30,
        enableVersioning: false,
      });
      expect(customStore.getDefaultRetentionDays()).toBe(30);
      expect(customStore.isVersioningEnabled()).toBe(false);
    });
  });

  describe("storeEntity", () => {
    it("should store entity with bi-temporal metadata", async () => {
      const entity = createTestEntity();
      mockClient.executeWrite.mockResolvedValueOnce({ id: entity.id });

      const result = await store.storeEntity(entity);

      expect(result).toBe(entity.id);
      expect(mockClient.executeWrite).toHaveBeenCalledTimes(1);

      const [cypher, params] = mockClient.executeWrite.mock.calls[0] as [
        string,
        Record<string, unknown>
      ];
      expect(cypher).toContain("CREATE (e:Entity");
      expect(cypher).toContain("eventTime: datetime($eventTime)");
      expect(cypher).toContain("ingestionTime: datetime($ingestionTime)");
      expect(params).toHaveProperty("id", entity.id);
      expect(params).toHaveProperty("entityType", entity.type);
      expect(params).toHaveProperty("name", entity.name);
      expect(params).toHaveProperty("version", 1);
      expect(params).toHaveProperty("validTo", null);
    });

    it("should use provided event time", async () => {
      const entity = createTestEntity();
      const eventTime = new Date("2024-01-15T10:00:00Z");
      mockClient.executeWrite.mockResolvedValueOnce({ id: entity.id });

      await store.storeEntity(entity, eventTime);

      const [, params] = mockClient.executeWrite.mock.calls[0] as [
        string,
        Record<string, unknown>
      ];
      expect(params).toHaveProperty("eventTime", eventTime.toISOString());
    });

    it("should throw TemporalStoreError on failure", async () => {
      const entity = createTestEntity();
      mockClient.executeWrite.mockRejectedValueOnce(
        new Error("Database error")
      );

      await expect(store.storeEntity(entity)).rejects.toThrow(TemporalStoreError);
      await expect(store.storeEntity(entity)).rejects.toThrow(
        /Failed to store entity/
      );
    });
  });

  describe("getEntityAtTime", () => {
    it("should return entity at specific time", async () => {
      const asOfTime = new Date("2024-01-20T10:00:00Z");
      const mockResult = {
        id: "entity-1",
        entityType: EntityType.CONCEPT,
        name: "Test Entity",
        properties: JSON.stringify({ foo: "bar" }),
        createdAt: "2024-01-15T10:00:00.000Z",
        updatedAt: "2024-01-15T10:00:00.000Z",
        eventTime: "2024-01-15T10:00:00.000Z",
        ingestionTime: "2024-01-15T10:00:00.000Z",
      };
      mockClient.executeQuery.mockResolvedValueOnce([mockResult]);

      const result = await store.getEntityAtTime("entity-1", asOfTime);

      expect(result).not.toBeNull();
      expect(result?.id).toBe("entity-1");
      expect(result?.type).toBe(EntityType.CONCEPT);
      expect(result?.properties).toEqual({ foo: "bar" });

      const [cypher, params] = mockClient.executeQuery.mock.calls[0] as [
        string,
        Record<string, unknown>
      ];
      expect(cypher).toContain("datetime($asOfTime) >= e.validFrom");
      expect(cypher).toContain("datetime($asOfTime) >= e.eventTime");
      expect(params).toHaveProperty("id", "entity-1");
      expect(params).toHaveProperty("asOfTime", asOfTime.toISOString());
    });

    it("should return null when no entity found", async () => {
      mockClient.executeQuery.mockResolvedValueOnce([]);

      const result = await store.getEntityAtTime(
        "non-existent",
        new Date()
      );

      expect(result).toBeNull();
    });

    it("should throw TemporalStoreError on failure", async () => {
      mockClient.executeQuery.mockRejectedValueOnce(
        new Error("Database error")
      );

      await expect(
        store.getEntityAtTime("entity-1", new Date())
      ).rejects.toThrow(TemporalStoreError);
    });
  });

  describe("getEntityHistory", () => {
    it("should return all versions of entity", async () => {
      const mockResults = [
        {
          id: "entity-1",
          entityType: EntityType.CONCEPT,
          name: "Updated Entity",
          properties: JSON.stringify({ foo: "baz" }),
          createdAt: "2024-01-15T10:00:00.000Z",
          updatedAt: "2024-01-20T10:00:00.000Z",
          eventTime: "2024-01-20T09:00:00.000Z",
          ingestionTime: "2024-01-20T10:00:00.000Z",
          validFrom: "2024-01-20T10:00:00.000Z",
          validTo: null,
          version: 2,
        },
        {
          id: "entity-1",
          entityType: EntityType.CONCEPT,
          name: "Test Entity",
          properties: JSON.stringify({ foo: "bar" }),
          createdAt: "2024-01-15T10:00:00.000Z",
          updatedAt: "2024-01-15T10:00:00.000Z",
          eventTime: "2024-01-15T09:00:00.000Z",
          ingestionTime: "2024-01-15T10:00:00.000Z",
          validFrom: "2024-01-15T10:00:00.000Z",
          validTo: "2024-01-20T10:00:00.000Z",
          version: 1,
        },
      ];
      mockClient.executeQuery.mockResolvedValueOnce(mockResults);

      const result = await store.getEntityHistory("entity-1");

      expect(result).toHaveLength(2);
      expect(result[0]?.version).toBe(2);
      expect(result[0]?.validTo).toBeNull();
      expect(result[1]?.version).toBe(1);
      expect(result[1]?.validTo).toBeInstanceOf(Date);
    });

    it("should return empty array when no history", async () => {
      mockClient.executeQuery.mockResolvedValueOnce([]);

      const result = await store.getEntityHistory("non-existent");

      expect(result).toEqual([]);
    });

    it("should throw TemporalStoreError on failure", async () => {
      mockClient.executeQuery.mockRejectedValueOnce(
        new Error("Database error")
      );

      await expect(store.getEntityHistory("entity-1")).rejects.toThrow(
        TemporalStoreError
      );
    });
  });

  describe("storeRelationship", () => {
    it("should store relationship with bi-temporal metadata", async () => {
      const relationship = createTestRelationship();
      mockClient.executeWrite.mockResolvedValueOnce({
        id: relationship.id,
      });

      const result = await store.storeRelationship(relationship);

      expect(result).toBe(relationship.id);
      expect(mockClient.executeWrite).toHaveBeenCalledTimes(1);

      const [cypher, params] = mockClient.executeWrite.mock.calls[0] as [
        string,
        Record<string, unknown>
      ];
      expect(cypher).toContain("MATCH (source:Entity {id: $sourceId})");
      expect(cypher).toContain("MATCH (target:Entity {id: $targetId})");
      expect(cypher).toContain("CREATE (source)-[r:RELATES_TO");
      expect(cypher).toContain("eventTime: datetime($eventTime)");
      expect(cypher).toContain("ingestionTime: datetime($ingestionTime)");
      expect(params).toHaveProperty("id", relationship.id);
      expect(params).toHaveProperty("relType", relationship.type);
      expect(params).toHaveProperty("sourceId", relationship.sourceId);
      expect(params).toHaveProperty("targetId", relationship.targetId);
    });

    it("should use provided event time", async () => {
      const relationship = createTestRelationship();
      const eventTime = new Date("2024-01-15T10:00:00Z");
      mockClient.executeWrite.mockResolvedValueOnce({
        id: relationship.id,
      });

      await store.storeRelationship(relationship, eventTime);

      const [, params] = mockClient.executeWrite.mock.calls[0] as [
        string,
        Record<string, unknown>
      ];
      expect(params).toHaveProperty("eventTime", eventTime.toISOString());
    });

    it("should throw TemporalStoreError on failure", async () => {
      const relationship = createTestRelationship();
      mockClient.executeWrite.mockRejectedValueOnce(
        new Error("Database error")
      );

      await expect(store.storeRelationship(relationship)).rejects.toThrow(
        TemporalStoreError
      );
    });
  });

  describe("invalidateEntity", () => {
    it("should set validTo on entity", async () => {
      mockClient.executeWrite.mockResolvedValueOnce({ id: "entity-1" });

      await store.invalidateEntity("entity-1");

      expect(mockClient.executeWrite).toHaveBeenCalledTimes(1);

      const [cypher, params] = mockClient.executeWrite.mock.calls[0] as [
        string,
        Record<string, unknown>
      ];
      expect(cypher).toContain("WHERE e.validTo IS NULL");
      expect(cypher).toContain("SET e.validTo = datetime($validTo)");
      expect(params).toHaveProperty("id", "entity-1");
      expect(params).toHaveProperty("validTo");
    });

    it("should throw TemporalStoreError on failure", async () => {
      mockClient.executeWrite.mockRejectedValueOnce(
        new Error("Database error")
      );

      await expect(store.invalidateEntity("entity-1")).rejects.toThrow(
        TemporalStoreError
      );
    });
  });

  describe("updateEntity", () => {
    describe("with versioning enabled", () => {
      it("should create new version and invalidate old", async () => {
        const currentResult = {
          id: "entity-1",
          entityType: EntityType.CONCEPT,
          name: "Test Entity",
          properties: JSON.stringify({ foo: "bar" }),
          createdAt: "2024-01-15T10:00:00.000Z",
          version: 1,
        };
        mockClient.executeQuery.mockResolvedValueOnce([currentResult]);
        mockClient.executeWrite.mockResolvedValueOnce({ id: "entity-1" });

        const result = await store.updateEntity("entity-1", {
          name: "Updated Entity",
        });

        expect(result).toBe("entity-1");
        expect(mockClient.executeQuery).toHaveBeenCalledTimes(1);
        expect(mockClient.executeWrite).toHaveBeenCalledTimes(1);

        const [cypher, params] = mockClient.executeWrite.mock.calls[0] as [
          string,
          Record<string, unknown>
        ];
        expect(cypher).toContain("SET old.validTo = datetime($validTo)");
        expect(cypher).toContain("CREATE (new:Entity");
        expect(params).toHaveProperty("version", 2);
        expect(params).toHaveProperty("newName", "Updated Entity");
      });

      it("should throw when entity not found", async () => {
        mockClient.executeQuery.mockResolvedValue([]);

        await expect(
          store.updateEntity("non-existent", { name: "Updated" })
        ).rejects.toThrow(TemporalStoreError);
        await expect(
          store.updateEntity("non-existent", { name: "Updated" })
        ).rejects.toThrow(/not found or already invalidated/);
      });
    });

    describe("with versioning disabled", () => {
      let noVersionStore: TemporalStore;

      beforeEach(() => {
        noVersionStore = new TemporalStore({
          neo4jClient: mockClient as unknown as Neo4jClient,
          enableVersioning: false,
        });
      });

      it("should update entity in place", async () => {
        mockClient.executeWrite.mockResolvedValueOnce({ id: "entity-1" });

        const result = await noVersionStore.updateEntity("entity-1", {
          name: "Updated Entity",
        });

        expect(result).toBe("entity-1");
        expect(mockClient.executeQuery).not.toHaveBeenCalled();
        expect(mockClient.executeWrite).toHaveBeenCalledTimes(1);

        const [cypher, params] = mockClient.executeWrite.mock.calls[0] as [
          string,
          Record<string, unknown>
        ];
        expect(cypher).toContain("SET e.updatedAt = datetime($updatedAt)");
        expect(cypher).toContain("e.name = $name");
        expect(cypher).not.toContain("CREATE");
        expect(params).toHaveProperty("name", "Updated Entity");
      });

      it("should update multiple fields", async () => {
        mockClient.executeWrite.mockResolvedValueOnce({ id: "entity-1" });

        await noVersionStore.updateEntity("entity-1", {
          name: "New Name",
          type: EntityType.PERSON,
          properties: { new: "props" },
        });

        const [cypher, params] = mockClient.executeWrite.mock.calls[0] as [
          string,
          Record<string, unknown>
        ];
        expect(cypher).toContain("e.entityType = $entityType");
        expect(cypher).toContain("e.name = $name");
        expect(cypher).toContain("e.properties = $properties");
        expect(params).toHaveProperty("entityType", EntityType.PERSON);
        expect(params).toHaveProperty("name", "New Name");
        expect(params).toHaveProperty("properties", JSON.stringify({ new: "props" }));
      });
    });
  });
});

describe("TemporalStoreError", () => {
  it("should have correct name and message", () => {
    const error = new TemporalStoreError("Something failed", "TS0001");
    expect(error.name).toBe("TemporalStoreError");
    expect(error.message).toBe("Something failed");
    expect(error.code).toBe("TS0001");
  });

  it("should handle undefined code", () => {
    const error = new TemporalStoreError("Something failed");
    expect(error.code).toBeUndefined();
  });

  it("should preserve cause", () => {
    const cause = new Error("Original error");
    const error = new TemporalStoreError("Something failed", undefined, cause);
    expect(error.cause).toBe(cause);
  });

  it("should be instanceof Error", () => {
    const error = new TemporalStoreError("Test");
    expect(error).toBeInstanceOf(Error);
  });
});

describe("Factory Functions", () => {
  describe("createTemporalStore", () => {
    it("should create a new TemporalStore instance", () => {
      const mockClient = createMockNeo4jClient();
      const store = createTemporalStore({ neo4jClient: mockClient as unknown as Neo4jClient });
      expect(store).toBeInstanceOf(TemporalStore);
    });

    it("should accept full config", () => {
      const mockClient = createMockNeo4jClient();
      const store = createTemporalStore({
        neo4jClient: mockClient as unknown as Neo4jClient,
        defaultRetentionDays: 90,
        enableVersioning: false,
      });
      expect(store).toBeInstanceOf(TemporalStore);
      expect(store.getDefaultRetentionDays()).toBe(90);
      expect(store.isVersioningEnabled()).toBe(false);
    });
  });
});

describe("BiTemporalMeta Interface", () => {
  it("should be compatible with entity history results", async () => {
    const mockClient = createMockNeo4jClient();
    const store = new TemporalStore({ neo4jClient: mockClient as unknown as Neo4jClient });

    const mockResults = [
      {
        id: "entity-1",
        entityType: EntityType.CONCEPT,
        name: "Test Entity",
        properties: JSON.stringify({ foo: "bar" }),
        createdAt: "2024-01-15T10:00:00.000Z",
        updatedAt: "2024-01-15T10:00:00.000Z",
        eventTime: "2024-01-15T09:00:00.000Z",
        ingestionTime: "2024-01-15T10:00:00.000Z",
        validFrom: "2024-01-15T10:00:00.000Z",
        validTo: null,
        version: 1,
      },
    ];
    mockClient.executeQuery.mockResolvedValueOnce(mockResults);

    const history = await store.getEntityHistory("entity-1");

    expect(history[0]).toHaveProperty("eventTime");
    expect(history[0]).toHaveProperty("ingestionTime");
    expect(history[0]).toHaveProperty("validFrom");
    expect(history[0]).toHaveProperty("validTo");
    expect(history[0]).toHaveProperty("version");

    // Type check: BiTemporalMeta properties
    const item = history[0] as Entity & BiTemporalMeta;
    expect(item.eventTime).toBeInstanceOf(Date);
    expect(item.ingestionTime).toBeInstanceOf(Date);
    expect(item.validFrom).toBeInstanceOf(Date);
    expect(item.validTo).toBeNull();
    expect(typeof item.version).toBe("number");
  });
});
