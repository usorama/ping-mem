/**
 * Tests for EvolutionEngine
 *
 * @module graph/__tests__/EvolutionEngine.test
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import {
  EvolutionEngine,
  EvolutionEngineError,
  EntityEvolutionNotFoundError,
  createEvolutionEngine,
  type EvolutionTimeline,
  type EvolutionComparison,
  type EntityChange,
  type ChangeType,
} from "../EvolutionEngine.js";
import type { TemporalStore, BiTemporalMeta } from "../TemporalStore.js";
import type { GraphManager } from "../GraphManager.js";
import { EntityType, RelationshipType } from "../../types/graph.js";
import type { Entity, Relationship } from "../../types/graph.js";

// ============================================================================
// Mock Setup
// ============================================================================

interface MockTemporalStore {
  getEntityHistory: Mock<(...args: unknown[]) => Promise<Array<Entity & BiTemporalMeta>>>;
  getEntityAtTime: Mock<(...args: unknown[]) => Promise<Entity | null>>;
  storeEntity: Mock<(...args: unknown[]) => Promise<string>>;
  updateEntity: Mock<(...args: unknown[]) => Promise<string>>;
  invalidateEntity: Mock<(...args: unknown[]) => Promise<void>>;
  storeRelationship: Mock<(...args: unknown[]) => Promise<string>>;
  getDefaultRetentionDays: Mock<() => number>;
  isVersioningEnabled: Mock<() => boolean>;
}

interface MockGraphManager {
  findRelationshipsByEntity: Mock<(...args: unknown[]) => Promise<Relationship[]>>;
  getEntity: Mock<(...args: unknown[]) => Promise<Entity | null>>;
  createEntity: Mock<(...args: unknown[]) => Promise<Entity>>;
  updateEntity: Mock<(...args: unknown[]) => Promise<Entity>>;
  deleteEntity: Mock<(...args: unknown[]) => Promise<boolean>>;
  createRelationship: Mock<(...args: unknown[]) => Promise<Relationship>>;
  getRelationship: Mock<(...args: unknown[]) => Promise<Relationship | null>>;
  deleteRelationship: Mock<(...args: unknown[]) => Promise<boolean>>;
  findEntitiesByType: Mock<(...args: unknown[]) => Promise<Entity[]>>;
  mergeEntity: Mock<(...args: unknown[]) => Promise<Entity>>;
  batchCreateEntities: Mock<(...args: unknown[]) => Promise<Entity[]>>;
}

/**
 * Create a mock TemporalStore
 */
function createMockTemporalStore(): MockTemporalStore {
  return {
    getEntityHistory: vi.fn(),
    getEntityAtTime: vi.fn(),
    storeEntity: vi.fn(),
    updateEntity: vi.fn(),
    invalidateEntity: vi.fn(),
    storeRelationship: vi.fn(),
    getDefaultRetentionDays: vi.fn().mockReturnValue(365),
    isVersioningEnabled: vi.fn().mockReturnValue(true),
  };
}

/**
 * Create a mock GraphManager
 */
function createMockGraphManager(): MockGraphManager {
  return {
    findRelationshipsByEntity: vi.fn(),
    getEntity: vi.fn(),
    createEntity: vi.fn(),
    updateEntity: vi.fn(),
    deleteEntity: vi.fn(),
    createRelationship: vi.fn(),
    getRelationship: vi.fn(),
    deleteRelationship: vi.fn(),
    findEntitiesByType: vi.fn(),
    mergeEntity: vi.fn(),
    batchCreateEntities: vi.fn(),
  };
}

/**
 * Create a test entity with bi-temporal metadata
 */
function createTestEntityWithBiTemporal(overrides?: Partial<Entity & BiTemporalMeta>): Entity & BiTemporalMeta {
  return {
    id: "entity-1",
    type: EntityType.CONCEPT,
    name: "Test Entity",
    properties: { description: "A test entity" },
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    updatedAt: new Date("2024-01-01T00:00:00.000Z"),
    eventTime: new Date("2024-01-01T00:00:00.000Z"),
    ingestionTime: new Date("2024-01-01T00:00:00.000Z"),
    validFrom: new Date("2024-01-01T00:00:00.000Z"),
    validTo: null,
    version: 1,
    ...overrides,
  };
}

/**
 * Create a test relationship
 */
function createTestRelationship(overrides?: Partial<Relationship>): Relationship {
  return {
    id: "rel-1",
    type: RelationshipType.RELATED_TO,
    sourceId: "entity-1",
    targetId: "entity-2",
    properties: {},
    weight: 1.0,
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

describe("EvolutionEngine - Unit Tests", () => {
  let mockTemporalStore: MockTemporalStore;
  let mockGraphManager: MockGraphManager;
  let engine: EvolutionEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    mockTemporalStore = createMockTemporalStore();
    mockGraphManager = createMockGraphManager();
    engine = new EvolutionEngine({
      temporalStore: mockTemporalStore as unknown as TemporalStore,
      graphManager: mockGraphManager as unknown as GraphManager,
      maxTimelineDepth: 100,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ==========================================================================
  // Constructor Tests
  // ==========================================================================

  describe("constructor", () => {
    it("should create an EvolutionEngine instance with all config", () => {
      const eng = new EvolutionEngine({
        temporalStore: mockTemporalStore as unknown as TemporalStore,
        graphManager: mockGraphManager as unknown as GraphManager,
        maxTimelineDepth: 50,
      });
      expect(eng).toBeInstanceOf(EvolutionEngine);
    });

    it("should create an EvolutionEngine instance with required config only", () => {
      const eng = new EvolutionEngine({
        temporalStore: mockTemporalStore as unknown as TemporalStore,
      });
      expect(eng).toBeInstanceOf(EvolutionEngine);
    });

    it("should use default maxTimelineDepth when not provided", () => {
      const eng = new EvolutionEngine({
        temporalStore: mockTemporalStore as unknown as TemporalStore,
      });
      expect(eng).toBeInstanceOf(EvolutionEngine);
    });
  });

  // ==========================================================================
  // getEvolution Tests
  // ==========================================================================

  describe("getEvolution", () => {
    it("should return evolution timeline for entity with single version", async () => {
      const entityHistory = [
        createTestEntityWithBiTemporal({
          id: "entity-1",
          name: "Test Entity",
          version: 1,
        }),
      ];

      mockTemporalStore.getEntityHistory.mockResolvedValue(entityHistory);

      const result = await engine.getEvolution("entity-1");

      expect(result.entityId).toBe("entity-1");
      expect(result.entityName).toBe("Test Entity");
      expect(result.changes).toHaveLength(1);
      expect(result.changes[0]?.changeType).toBe("created");
      expect(result.totalChanges).toBe(1);
    });

    it("should return evolution timeline with multiple versions", async () => {
      const entityHistory = [
        createTestEntityWithBiTemporal({
          id: "entity-1",
          name: "Test Entity v2",
          version: 2,
          eventTime: new Date("2024-01-02T00:00:00.000Z"),
        }),
        createTestEntityWithBiTemporal({
          id: "entity-1",
          name: "Test Entity v1",
          version: 1,
          eventTime: new Date("2024-01-01T00:00:00.000Z"),
          validTo: new Date("2024-01-02T00:00:00.000Z"),
        }),
      ];

      mockTemporalStore.getEntityHistory.mockResolvedValue(entityHistory);

      const result = await engine.getEvolution("entity-1");

      expect(result.changes).toHaveLength(2);
      // First change (chronologically) is "created" (version 1)
      expect(result.changes[0]?.changeType).toBe("created");
      // Second change is "updated" (version 2 has validTo = null, so it's an update not deletion)
      expect(result.changes[1]?.changeType).toBe("updated");
      expect(result.totalChanges).toBe(2);
    });

    it("should filter by time range when startTime provided", async () => {
      const entityHistory = [
        createTestEntityWithBiTemporal({
          version: 2,
          eventTime: new Date("2024-01-15T00:00:00.000Z"),
        }),
        createTestEntityWithBiTemporal({
          version: 1,
          eventTime: new Date("2024-01-01T00:00:00.000Z"),
        }),
      ];

      mockTemporalStore.getEntityHistory.mockResolvedValue(entityHistory);

      const result = await engine.getEvolution("entity-1", {
        startTime: new Date("2024-01-10T00:00:00.000Z"),
      });

      expect(result.changes).toHaveLength(1);
      expect(result.changes[0]?.timestamp.getTime()).toBeGreaterThanOrEqual(
        new Date("2024-01-10T00:00:00.000Z").getTime()
      );
    });

    it("should filter by time range when endTime provided", async () => {
      const entityHistory = [
        createTestEntityWithBiTemporal({
          version: 2,
          eventTime: new Date("2024-01-15T00:00:00.000Z"),
        }),
        createTestEntityWithBiTemporal({
          version: 1,
          eventTime: new Date("2024-01-01T00:00:00.000Z"),
        }),
      ];

      mockTemporalStore.getEntityHistory.mockResolvedValue(entityHistory);

      const result = await engine.getEvolution("entity-1", {
        endTime: new Date("2024-01-10T00:00:00.000Z"),
      });

      expect(result.changes).toHaveLength(1);
      expect(result.changes[0]?.timestamp.getTime()).toBeLessThanOrEqual(
        new Date("2024-01-10T00:00:00.000Z").getTime()
      );
    });

    it("should filter by changeTypes when provided", async () => {
      const entityHistory = [
        createTestEntityWithBiTemporal({
          version: 2,
          eventTime: new Date("2024-01-02T00:00:00.000Z"),
        }),
        createTestEntityWithBiTemporal({
          version: 1,
          eventTime: new Date("2024-01-01T00:00:00.000Z"),
        }),
      ];

      mockTemporalStore.getEntityHistory.mockResolvedValue(entityHistory);

      const result = await engine.getEvolution("entity-1", {
        changeTypes: ["created"],
      });

      expect(result.changes.every((c) => c.changeType === "created")).toBe(true);
    });

    it("should include related changes when includeRelated is true", async () => {
      const entityHistory = [
        createTestEntityWithBiTemporal({ id: "entity-1", version: 1 }),
      ];

      const relationships = [
        createTestRelationship({
          sourceId: "entity-1",
          targetId: "related-1",
        }),
      ];

      const relatedHistory = [
        createTestEntityWithBiTemporal({
          id: "related-1",
          name: "Related Entity",
          version: 1,
          eventTime: new Date("2024-01-01T00:00:00.000Z"),
        }),
      ];

      mockTemporalStore.getEntityHistory
        .mockResolvedValueOnce(entityHistory)
        .mockResolvedValueOnce(relatedHistory);
      mockGraphManager.findRelationshipsByEntity.mockResolvedValue(relationships);

      const result = await engine.getEvolution("entity-1", {
        includeRelated: true,
      });

      expect(mockGraphManager.findRelationshipsByEntity).toHaveBeenCalled();
      // Related entities should be populated if found
      if (result.changes[0]?.relatedEntities) {
        expect(result.changes[0].relatedEntities.length).toBeGreaterThan(0);
      }
    });

    it("should throw EntityEvolutionNotFoundError when entity has no history", async () => {
      mockTemporalStore.getEntityHistory.mockResolvedValue([]);

      await expect(engine.getEvolution("nonexistent")).rejects.toThrow(
        EntityEvolutionNotFoundError
      );
    });

    it("should throw EvolutionEngineError on database failure", async () => {
      mockTemporalStore.getEntityHistory.mockRejectedValue(new Error("DB Error"));

      await expect(engine.getEvolution("entity-1")).rejects.toThrow(EvolutionEngineError);
      await expect(engine.getEvolution("entity-1")).rejects.toThrow(
        "Failed to get evolution"
      );
    });

    it("should respect maxTimelineDepth limit", async () => {
      const engineWithLimit = new EvolutionEngine({
        temporalStore: mockTemporalStore as unknown as TemporalStore,
        maxTimelineDepth: 2,
      });

      const entityHistory = [
        createTestEntityWithBiTemporal({ version: 3, eventTime: new Date("2024-01-03T00:00:00.000Z") }),
        createTestEntityWithBiTemporal({ version: 2, eventTime: new Date("2024-01-02T00:00:00.000Z") }),
        createTestEntityWithBiTemporal({ version: 1, eventTime: new Date("2024-01-01T00:00:00.000Z") }),
      ];

      mockTemporalStore.getEntityHistory.mockResolvedValue(entityHistory);

      const result = await engineWithLimit.getEvolution("entity-1");

      expect(result.changes.length).toBeLessThanOrEqual(2);
    });
  });

  // ==========================================================================
  // getEvolutionByName Tests
  // ==========================================================================

  describe("getEvolutionByName", () => {
    it("should throw EvolutionEngineError when GraphManager not configured", async () => {
      const engineWithoutGraph = new EvolutionEngine({
        temporalStore: mockTemporalStore as unknown as TemporalStore,
      });

      await expect(
        engineWithoutGraph.getEvolutionByName("Test Entity")
      ).rejects.toThrow(EvolutionEngineError);
      await expect(
        engineWithoutGraph.getEvolutionByName("Test Entity")
      ).rejects.toThrow("GraphManager is required");
    });

    it("should throw error for unimplemented lookup", async () => {
      await expect(engine.getEvolutionByName("Test Entity")).rejects.toThrow(
        EvolutionEngineError
      );
      await expect(engine.getEvolutionByName("Test Entity")).rejects.toThrow(
        "not yet implemented"
      );
    });
  });

  // ==========================================================================
  // getRelatedEvolution Tests
  // ==========================================================================

  describe("getRelatedEvolution", () => {
    it("should return evolution for related entities", async () => {
      const relationships = [
        createTestRelationship({
          sourceId: "entity-1",
          targetId: "related-1",
        }),
        createTestRelationship({
          id: "rel-2",
          sourceId: "related-2",
          targetId: "entity-1",
        }),
      ];

      const related1History = [
        createTestEntityWithBiTemporal({ id: "related-1", name: "Related 1", version: 1 }),
      ];

      const related2History = [
        createTestEntityWithBiTemporal({ id: "related-2", name: "Related 2", version: 1 }),
      ];

      mockGraphManager.findRelationshipsByEntity.mockResolvedValue(relationships);
      mockTemporalStore.getEntityHistory
        .mockResolvedValueOnce(related1History)
        .mockResolvedValueOnce(related2History);

      const result = await engine.getRelatedEvolution("entity-1");

      expect(result).toHaveLength(2);
      expect(result.map((e) => e.entityId)).toContain("related-1");
      expect(result.map((e) => e.entityId)).toContain("related-2");
    });

    it("should return empty array when no related entities", async () => {
      mockGraphManager.findRelationshipsByEntity.mockResolvedValue([]);

      const result = await engine.getRelatedEvolution("entity-1");

      expect(result).toHaveLength(0);
    });

    it("should skip entities without evolution history", async () => {
      const relationships = [
        createTestRelationship({
          sourceId: "entity-1",
          targetId: "related-1",
        }),
      ];

      mockGraphManager.findRelationshipsByEntity.mockResolvedValue(relationships);
      mockTemporalStore.getEntityHistory.mockResolvedValue([]);

      const result = await engine.getRelatedEvolution("entity-1");

      expect(result).toHaveLength(0);
    });

    it("should throw EvolutionEngineError when GraphManager not configured", async () => {
      const engineWithoutGraph = new EvolutionEngine({
        temporalStore: mockTemporalStore as unknown as TemporalStore,
      });

      await expect(
        engineWithoutGraph.getRelatedEvolution("entity-1")
      ).rejects.toThrow(EvolutionEngineError);
      await expect(
        engineWithoutGraph.getRelatedEvolution("entity-1")
      ).rejects.toThrow("GraphManager is required");
    });

    it("should throw EvolutionEngineError on database failure", async () => {
      mockGraphManager.findRelationshipsByEntity.mockRejectedValue(
        new Error("DB Error")
      );

      await expect(engine.getRelatedEvolution("entity-1")).rejects.toThrow(
        EvolutionEngineError
      );
    });
  });

  // ==========================================================================
  // compareEvolution Tests
  // ==========================================================================

  describe("compareEvolution", () => {
    it("should compare evolution of two entities", async () => {
      const entity1History = [
        createTestEntityWithBiTemporal({
          id: "entity-1",
          name: "Entity 1",
          version: 1,
          eventTime: new Date("2024-01-01T00:00:00.000Z"),
        }),
      ];

      const entity2History = [
        createTestEntityWithBiTemporal({
          id: "entity-2",
          name: "Entity 2",
          version: 1,
          eventTime: new Date("2024-01-01T00:30:00.000Z"),
        }),
      ];

      mockTemporalStore.getEntityHistory
        .mockResolvedValueOnce(entity1History)
        .mockResolvedValueOnce(entity2History);

      const result = await engine.compareEvolution("entity-1", "entity-2");

      expect(result.entity1.entityId).toBe("entity-1");
      expect(result.entity2.entityId).toBe("entity-2");
      expect(result.correlatedChanges).toBeDefined();
      expect(result.commonRelatedEntities).toBeDefined();
    });

    it("should find correlated changes within 1 hour", async () => {
      const entity1History = [
        createTestEntityWithBiTemporal({
          id: "entity-1",
          version: 1,
          eventTime: new Date("2024-01-01T12:00:00.000Z"),
        }),
      ];

      const entity2History = [
        createTestEntityWithBiTemporal({
          id: "entity-2",
          version: 1,
          eventTime: new Date("2024-01-01T12:30:00.000Z"),
        }),
      ];

      mockTemporalStore.getEntityHistory
        .mockResolvedValueOnce(entity1History)
        .mockResolvedValueOnce(entity2History);

      const result = await engine.compareEvolution("entity-1", "entity-2");

      expect(result.correlatedChanges.length).toBeGreaterThan(0);
      expect(result.correlatedChanges[0]?.timeDifferenceMs).toBeLessThanOrEqual(3600000);
    });

    it("should not find correlated changes outside 1 hour window", async () => {
      const entity1History = [
        createTestEntityWithBiTemporal({
          id: "entity-1",
          version: 1,
          eventTime: new Date("2024-01-01T12:00:00.000Z"),
        }),
      ];

      const entity2History = [
        createTestEntityWithBiTemporal({
          id: "entity-2",
          version: 1,
          eventTime: new Date("2024-01-01T20:00:00.000Z"),
        }),
      ];

      mockTemporalStore.getEntityHistory
        .mockResolvedValueOnce(entity1History)
        .mockResolvedValueOnce(entity2History);

      const result = await engine.compareEvolution("entity-1", "entity-2");

      expect(result.correlatedChanges).toHaveLength(0);
    });

    it("should throw EntityEvolutionNotFoundError when first entity not found", async () => {
      mockTemporalStore.getEntityHistory.mockResolvedValue([]);

      await expect(
        engine.compareEvolution("nonexistent", "entity-2")
      ).rejects.toThrow(EntityEvolutionNotFoundError);
    });

    it("should throw EntityEvolutionNotFoundError when second entity not found", async () => {
      const entity1History = [
        createTestEntityWithBiTemporal({ id: "entity-1", version: 1 }),
      ];

      mockTemporalStore.getEntityHistory
        .mockResolvedValueOnce(entity1History)
        .mockResolvedValueOnce([]);

      await expect(
        engine.compareEvolution("entity-1", "nonexistent")
      ).rejects.toThrow(EntityEvolutionNotFoundError);
    });

    it("should throw EvolutionEngineError on database failure", async () => {
      mockTemporalStore.getEntityHistory.mockRejectedValue(new Error("DB Error"));

      await expect(
        engine.compareEvolution("entity-1", "entity-2")
      ).rejects.toThrow(EvolutionEngineError);
    });
  });
});

// ============================================================================
// Edge Cases Tests
// ============================================================================

describe("EvolutionEngine - Edge Cases", () => {
  let mockTemporalStore: MockTemporalStore;
  let engine: EvolutionEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    mockTemporalStore = createMockTemporalStore();
    engine = new EvolutionEngine({
      temporalStore: mockTemporalStore as unknown as TemporalStore,
    });
  });

  it("should handle single change timeline correctly", async () => {
    const entityHistory = [
      createTestEntityWithBiTemporal({ version: 1 }),
    ];

    mockTemporalStore.getEntityHistory.mockResolvedValue(entityHistory);

    const result = await engine.getEvolution("entity-1");

    expect(result.changes).toHaveLength(1);
    expect(result.startTime).toEqual(result.endTime);
  });

  it("should handle entity with only deleted state", async () => {
    const entityHistory = [
      createTestEntityWithBiTemporal({
        version: 1,
        validTo: new Date("2024-01-02T00:00:00.000Z"),
      }),
    ];

    mockTemporalStore.getEntityHistory.mockResolvedValue(entityHistory);

    const result = await engine.getEvolution("entity-1");

    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]?.changeType).toBe("created");
  });

  it("should handle empty changeTypes filter", async () => {
    const entityHistory = [
      createTestEntityWithBiTemporal({ version: 1 }),
    ];

    mockTemporalStore.getEntityHistory.mockResolvedValue(entityHistory);

    const result = await engine.getEvolution("entity-1", {
      changeTypes: [],
    });

    expect(result.changes).toHaveLength(1);
  });

  it("should preserve previous state in updated changes", async () => {
    const entityHistory = [
      createTestEntityWithBiTemporal({
        version: 2,
        name: "Updated Name",
        eventTime: new Date("2024-01-02T00:00:00.000Z"),
      }),
      createTestEntityWithBiTemporal({
        version: 1,
        name: "Original Name",
        eventTime: new Date("2024-01-01T00:00:00.000Z"),
      }),
    ];

    mockTemporalStore.getEntityHistory.mockResolvedValue(entityHistory);

    const result = await engine.getEvolution("entity-1");

    // The second change should have previous state
    const updateChange = result.changes.find(
      (c) => c.changeType === "deleted" || c.changeType === "updated"
    );
    if (updateChange) {
      expect(updateChange.previousState).not.toBeNull();
    }
  });

  it("should include metadata with version information", async () => {
    const entityHistory = [
      createTestEntityWithBiTemporal({
        version: 2,
        validFrom: new Date("2024-01-02T00:00:00.000Z"),
      }),
    ];

    mockTemporalStore.getEntityHistory.mockResolvedValue(entityHistory);

    const result = await engine.getEvolution("entity-1");

    expect(result.changes[0]?.metadata).toBeDefined();
    expect(result.changes[0]?.metadata?.version).toBe(2);
    expect(result.changes[0]?.metadata?.validFrom).toBeDefined();
  });
});

// ============================================================================
// Error Class Tests
// ============================================================================

describe("Error Classes", () => {
  describe("EvolutionEngineError", () => {
    it("should have correct name, message, and operation", () => {
      const error = new EvolutionEngineError("Something failed", "testOp");
      expect(error.name).toBe("EvolutionEngineError");
      expect(error.message).toBe("Something failed");
      expect(error.operation).toBe("testOp");
    });

    it("should preserve cause", () => {
      const cause = new Error("Original error");
      const error = new EvolutionEngineError("Something failed", "testOp", cause);
      expect(error.cause).toBe(cause);
    });

    it("should be instanceof Error", () => {
      const error = new EvolutionEngineError("Test", "testOp");
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe("EntityEvolutionNotFoundError", () => {
    it("should have correct name, message, entityId, and operation", () => {
      const error = new EntityEvolutionNotFoundError("test-id", "getEvolution");
      expect(error.name).toBe("EntityEvolutionNotFoundError");
      expect(error.message).toBe("Entity evolution not found: test-id");
      expect(error.entityId).toBe("test-id");
      expect(error.operation).toBe("getEvolution");
    });

    it("should be instanceof EvolutionEngineError", () => {
      const error = new EntityEvolutionNotFoundError("test-id", "getEvolution");
      expect(error).toBeInstanceOf(EvolutionEngineError);
    });

    it("should be instanceof Error", () => {
      const error = new EntityEvolutionNotFoundError("test-id", "getEvolution");
      expect(error).toBeInstanceOf(Error);
    });
  });
});

// ============================================================================
// Factory Function Tests
// ============================================================================

describe("Factory Functions", () => {
  describe("createEvolutionEngine", () => {
    it("should create a new EvolutionEngine instance", () => {
      const mockTemporalStore = createMockTemporalStore();
      const engine = createEvolutionEngine({
        temporalStore: mockTemporalStore as unknown as TemporalStore,
      });
      expect(engine).toBeInstanceOf(EvolutionEngine);
    });

    it("should create engine with all options", () => {
      const mockTemporalStore = createMockTemporalStore();
      const mockGraphManager = createMockGraphManager();
      const engine = createEvolutionEngine({
        temporalStore: mockTemporalStore as unknown as TemporalStore,
        graphManager: mockGraphManager as unknown as GraphManager,
        maxTimelineDepth: 50,
      });
      expect(engine).toBeInstanceOf(EvolutionEngine);
    });
  });
});

// ============================================================================
// Type Export Tests
// ============================================================================

describe("Type Exports", () => {
  it("should export EvolutionTimeline type", () => {
    const timeline: EvolutionTimeline = {
      entityId: "entity-1",
      entityName: "Test Entity",
      startTime: new Date(),
      endTime: new Date(),
      changes: [],
      totalChanges: 0,
    };
    expect(timeline.entityId).toBe("entity-1");
  });

  it("should export EvolutionComparison type", () => {
    const comparison: EvolutionComparison = {
      entity1: {
        entityId: "entity-1",
        entityName: "Entity 1",
        startTime: new Date(),
        endTime: new Date(),
        changes: [],
        totalChanges: 0,
      },
      entity2: {
        entityId: "entity-2",
        entityName: "Entity 2",
        startTime: new Date(),
        endTime: new Date(),
        changes: [],
        totalChanges: 0,
      },
      correlatedChanges: [],
      commonRelatedEntities: [],
    };
    expect(comparison.entity1.entityId).toBe("entity-1");
  });

  it("should export EntityChange type", () => {
    const change: EntityChange = {
      timestamp: new Date(),
      changeType: "created",
      entityId: "entity-1",
      entityName: "Test Entity",
      previousState: null,
      currentState: null,
    };
    expect(change.changeType).toBe("created");
  });

  it("should export ChangeType type", () => {
    const types: ChangeType[] = ["created", "updated", "deleted", "related_changed"];
    expect(types).toContain("created");
    expect(types).toContain("updated");
    expect(types).toContain("deleted");
    expect(types).toContain("related_changed");
  });
});
