/**
 * Tests for context_query_relationships tool
 *
 * Tests the MCP tool that queries entity relationships from the knowledge graph,
 * supporting depth traversal, relationship type filtering, and direction filtering.
 *
 * @module mcp/__tests__/query-relationships.test
 */

import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { PingMemServer } from "../PingMemServer.js";
import type { GraphManager } from "../../graph/GraphManager.js";
import type { Entity, Relationship } from "../../types/graph.js";
import { EntityType, RelationshipType } from "../../types/graph.js";

// Helper type for mock function
type MockedFn<T extends (...args: never[]) => unknown> = jest.MockedFunction<T>;

// Create a mock GraphManager for testing
function createMockGraphManager(): GraphManager & {
  findRelationshipsByEntity: MockedFn<GraphManager["findRelationshipsByEntity"]>;
  getEntity: MockedFn<GraphManager["getEntity"]>;
} {
  const mockFindRelationshipsByEntity = jest.fn<GraphManager["findRelationshipsByEntity"]>();
  const mockGetEntity = jest.fn<GraphManager["getEntity"]>();

  return {
    createEntity: jest.fn(),
    getEntity: mockGetEntity,
    updateEntity: jest.fn(),
    deleteEntity: jest.fn(),
    createRelationship: jest.fn(),
    getRelationship: jest.fn(),
    deleteRelationship: jest.fn(),
    findEntitiesByType: jest.fn(),
    findRelationshipsByEntity: mockFindRelationshipsByEntity,
    mergeEntity: jest.fn(),
    batchCreateEntities: jest.fn(),
  } as unknown as GraphManager & {
    findRelationshipsByEntity: MockedFn<GraphManager["findRelationshipsByEntity"]>;
    getEntity: MockedFn<GraphManager["getEntity"]>;
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

// Create mock entities
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

// Create mock relationships
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

describe("context_query_relationships", () => {
  describe("without graphManager configured", () => {
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

    it("should throw error when graphManager not configured", async () => {
      await expect(
        callTool(server, "context_query_relationships", { entityId: "entity-1" })
      ).rejects.toThrow("GraphManager not configured. Cannot query relationships.");
    });
  });

  describe("with graphManager configured", () => {
    let server: PingMemServer;
    let mockGraphManager: ReturnType<typeof createMockGraphManager>;

    beforeEach(() => {
      mockGraphManager = createMockGraphManager();
      server = new PingMemServer({
        dbPath: ":memory:",
        enableVectorSearch: false,
        graphManager: mockGraphManager,
      });
    });

    afterEach(async () => {
      await server.close();
    });

    it("should return related entities with default parameters", async () => {
      // Setup mock data
      const sourceEntity = createMockEntity("entity-1", "Source Entity");
      const targetEntity = createMockEntity("entity-2", "Target Entity");

      const relationship = createMockRelationship("rel-1", "entity-1", "entity-2");

      mockGraphManager.findRelationshipsByEntity.mockResolvedValue([relationship]);
      mockGraphManager.getEntity.mockImplementation(async (id: string) => {
        if (id === "entity-2") return targetEntity;
        return null;
      });

      const result = await callTool(server, "context_query_relationships", {
        entityId: "entity-1",
      });

      expect(result.entities).toBeDefined();
      expect(result.relationships).toBeDefined();
      expect(result.paths).toBeDefined();

      const entities = result.entities as Array<{ id: string; name: string }>;
      expect(entities).toHaveLength(1);
      expect(entities[0]?.id).toBe("entity-2");
      expect(entities[0]?.name).toBe("Target Entity");

      const relationships = result.relationships as Array<{ id: string; sourceId: string; targetId: string }>;
      expect(relationships).toHaveLength(1);
      expect(relationships[0]?.sourceId).toBe("entity-1");
      expect(relationships[0]?.targetId).toBe("entity-2");
    });

    it("should respect depth parameter for multi-level traversal", async () => {
      // Setup: entity-1 -> entity-2 -> entity-3
      const entity2 = createMockEntity("entity-2", "Entity 2");
      const entity3 = createMockEntity("entity-3", "Entity 3");

      const rel1 = createMockRelationship("rel-1", "entity-1", "entity-2");
      const rel2 = createMockRelationship("rel-2", "entity-2", "entity-3");

      mockGraphManager.findRelationshipsByEntity.mockImplementation(async (id: string) => {
        if (id === "entity-1") return [rel1];
        if (id === "entity-2") return [rel1, rel2]; // entity-2 has both relationships
        return [];
      });

      mockGraphManager.getEntity.mockImplementation(async (id: string) => {
        if (id === "entity-2") return entity2;
        if (id === "entity-3") return entity3;
        return null;
      });

      // Query with depth 2
      const result = await callTool(server, "context_query_relationships", {
        entityId: "entity-1",
        depth: 2,
      });

      const entities = result.entities as Array<{ id: string }>;
      const entityIds = entities.map((e) => e.id);

      // Should find both entity-2 (depth 1) and entity-3 (depth 2)
      expect(entityIds).toContain("entity-2");
      expect(entityIds).toContain("entity-3");
    });

    it("should filter by relationshipTypes", async () => {
      const entity2 = createMockEntity("entity-2", "Entity 2");
      const entity3 = createMockEntity("entity-3", "Entity 3");

      const relDependsOn = createMockRelationship("rel-1", "entity-1", "entity-2", RelationshipType.DEPENDS_ON);
      const relRelatedTo = createMockRelationship("rel-2", "entity-1", "entity-3", RelationshipType.RELATED_TO);

      mockGraphManager.findRelationshipsByEntity.mockResolvedValue([relDependsOn, relRelatedTo]);
      mockGraphManager.getEntity.mockImplementation(async (id: string) => {
        if (id === "entity-2") return entity2;
        if (id === "entity-3") return entity3;
        return null;
      });

      // Query filtering only DEPENDS_ON relationships
      const result = await callTool(server, "context_query_relationships", {
        entityId: "entity-1",
        relationshipTypes: [RelationshipType.DEPENDS_ON],
      });

      const relationships = result.relationships as Array<{ type: string }>;
      expect(relationships).toHaveLength(1);
      expect(relationships[0]?.type).toBe(RelationshipType.DEPENDS_ON);

      const entities = result.entities as Array<{ id: string }>;
      expect(entities).toHaveLength(1);
      expect(entities[0]?.id).toBe("entity-2");
    });

    it("should filter by direction: outgoing", async () => {
      const entity2 = createMockEntity("entity-2", "Entity 2");
      const entity3 = createMockEntity("entity-3", "Entity 3");

      // Outgoing: entity-1 -> entity-2
      // Incoming: entity-3 -> entity-1
      const relOutgoing = createMockRelationship("rel-1", "entity-1", "entity-2");
      const relIncoming = createMockRelationship("rel-2", "entity-3", "entity-1");

      mockGraphManager.findRelationshipsByEntity.mockResolvedValue([relOutgoing, relIncoming]);
      mockGraphManager.getEntity.mockImplementation(async (id: string) => {
        if (id === "entity-2") return entity2;
        if (id === "entity-3") return entity3;
        return null;
      });

      // Query only outgoing relationships
      const result = await callTool(server, "context_query_relationships", {
        entityId: "entity-1",
        direction: "outgoing",
      });

      const relationships = result.relationships as Array<{ sourceId: string }>;
      expect(relationships).toHaveLength(1);
      expect(relationships[0]?.sourceId).toBe("entity-1");

      const entities = result.entities as Array<{ id: string }>;
      expect(entities).toHaveLength(1);
      expect(entities[0]?.id).toBe("entity-2");
    });

    it("should filter by direction: incoming", async () => {
      const entity2 = createMockEntity("entity-2", "Entity 2");
      const entity3 = createMockEntity("entity-3", "Entity 3");

      // Outgoing: entity-1 -> entity-2
      // Incoming: entity-3 -> entity-1
      const relOutgoing = createMockRelationship("rel-1", "entity-1", "entity-2");
      const relIncoming = createMockRelationship("rel-2", "entity-3", "entity-1");

      mockGraphManager.findRelationshipsByEntity.mockResolvedValue([relOutgoing, relIncoming]);
      mockGraphManager.getEntity.mockImplementation(async (id: string) => {
        if (id === "entity-2") return entity2;
        if (id === "entity-3") return entity3;
        return null;
      });

      // Query only incoming relationships
      const result = await callTool(server, "context_query_relationships", {
        entityId: "entity-1",
        direction: "incoming",
      });

      const relationships = result.relationships as Array<{ targetId: string }>;
      expect(relationships).toHaveLength(1);
      expect(relationships[0]?.targetId).toBe("entity-1");

      const entities = result.entities as Array<{ id: string }>;
      expect(entities).toHaveLength(1);
      expect(entities[0]?.id).toBe("entity-3");
    });

    it("should handle entity with no relationships", async () => {
      mockGraphManager.findRelationshipsByEntity.mockResolvedValue([]);

      const result = await callTool(server, "context_query_relationships", {
        entityId: "lonely-entity",
      });

      expect(result.entities).toEqual([]);
      expect(result.relationships).toEqual([]);
      expect(result.paths).toEqual([]);
    });

    it("should handle entity not found in graph", async () => {
      // Entity has relationships but we can't fetch the related entities
      const relationship = createMockRelationship("rel-1", "entity-1", "missing-entity");

      mockGraphManager.findRelationshipsByEntity.mockResolvedValue([relationship]);
      mockGraphManager.getEntity.mockResolvedValue(null);

      const result = await callTool(server, "context_query_relationships", {
        entityId: "entity-1",
      });

      // Relationships should still be returned
      const relationships = result.relationships as Array<{ id: string }>;
      expect(relationships).toHaveLength(1);

      // But entities array will be empty since the related entity couldn't be fetched
      const entities = result.entities as Array<{ id: string }>;
      expect(entities).toHaveLength(0);

      // Paths should still show the relationship
      const paths = result.paths as Array<{ from: string; to: string }>;
      expect(paths).toHaveLength(1);
    });

    it("should return properly serialized response", async () => {
      const now = new Date("2024-01-15T10:00:00Z");
      const entity = {
        id: "entity-2",
        type: EntityType.PERSON,
        name: "Test Person",
        properties: { role: "developer" },
        createdAt: now,
        updatedAt: now,
        eventTime: now,
        ingestionTime: now,
      };

      const relationship: Relationship = {
        id: "rel-1",
        type: RelationshipType.USES,
        sourceId: "entity-1",
        targetId: "entity-2",
        properties: { frequency: "daily" },
        weight: 0.8,
        createdAt: now,
        updatedAt: now,
        eventTime: now,
        ingestionTime: now,
      };

      mockGraphManager.findRelationshipsByEntity.mockResolvedValue([relationship]);
      mockGraphManager.getEntity.mockResolvedValue(entity);

      const result = await callTool(server, "context_query_relationships", {
        entityId: "entity-1",
      });

      // Verify entity serialization
      const entities = result.entities as Array<{
        id: string;
        type: string;
        name: string;
        properties: Record<string, unknown>;
        createdAt: string;
        updatedAt: string;
      }>;
      expect(entities[0]).toMatchObject({
        id: "entity-2",
        type: EntityType.PERSON,
        name: "Test Person",
        properties: { role: "developer" },
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      });

      // Verify relationship serialization
      const relationships = result.relationships as Array<{
        id: string;
        type: string;
        sourceId: string;
        targetId: string;
        weight: number;
        properties: Record<string, unknown>;
        createdAt: string;
        updatedAt: string;
      }>;
      expect(relationships[0]).toMatchObject({
        id: "rel-1",
        type: RelationshipType.USES,
        sourceId: "entity-1",
        targetId: "entity-2",
        weight: 0.8,
        properties: { frequency: "daily" },
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      });

      // Verify paths
      const paths = result.paths as Array<{ from: string; relationship: string; to: string }>;
      expect(paths[0]).toEqual({
        from: "entity-1",
        relationship: RelationshipType.USES,
        to: "entity-2",
      });
    });

    it("should combine direction and relationshipTypes filters", async () => {
      const entity2 = createMockEntity("entity-2", "Entity 2");
      const entity3 = createMockEntity("entity-3", "Entity 3");
      const entity4 = createMockEntity("entity-4", "Entity 4");

      // Various relationships
      const rel1 = createMockRelationship("rel-1", "entity-1", "entity-2", RelationshipType.DEPENDS_ON); // outgoing, DEPENDS_ON
      const rel2 = createMockRelationship("rel-2", "entity-3", "entity-1", RelationshipType.DEPENDS_ON); // incoming, DEPENDS_ON
      const rel3 = createMockRelationship("rel-3", "entity-1", "entity-4", RelationshipType.USES); // outgoing, USES

      mockGraphManager.findRelationshipsByEntity.mockResolvedValue([rel1, rel2, rel3]);
      mockGraphManager.getEntity.mockImplementation(async (id: string) => {
        if (id === "entity-2") return entity2;
        if (id === "entity-3") return entity3;
        if (id === "entity-4") return entity4;
        return null;
      });

      // Query outgoing DEPENDS_ON only
      const result = await callTool(server, "context_query_relationships", {
        entityId: "entity-1",
        direction: "outgoing",
        relationshipTypes: [RelationshipType.DEPENDS_ON],
      });

      const relationships = result.relationships as Array<{ id: string }>;
      expect(relationships).toHaveLength(1);

      const entities = result.entities as Array<{ id: string }>;
      expect(entities).toHaveLength(1);
      expect(entities[0]?.id).toBe("entity-2");
    });
  });
});
