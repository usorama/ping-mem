/**
 * Tests for CausalGraphManager
 *
 * @module graph/__tests__/CausalGraphManager.test
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";
import { CausalGraphManager } from "../CausalGraphManager.js";
import { RelationshipType, EntityType } from "../../types/graph.js";
import type { Entity, Relationship } from "../../types/graph.js";
import type { GraphManager } from "../GraphManager.js";

// ============================================================================
// Mock Helpers
// ============================================================================

const NOW = new Date("2024-01-01T00:00:00Z");

function makeEntity(id: string, name: string): Entity {
  return {
    id,
    type: EntityType.CONCEPT,
    name,
    properties: {},
    createdAt: NOW,
    updatedAt: NOW,
    eventTime: NOW,
    ingestionTime: NOW,
  };
}

function makeRelationship(
  id: string,
  sourceId: string,
  targetId: string,
  type: RelationshipType,
  confidence: number,
  evidence: string,
): Relationship {
  return {
    id,
    type,
    sourceId,
    targetId,
    properties: { confidence, evidence },
    weight: confidence,
    createdAt: NOW,
    updatedAt: NOW,
    eventTime: NOW,
    ingestionTime: NOW,
  };
}

function createMockGraphManager(): {
  createRelationship: ReturnType<typeof mock>;
  getEntity: ReturnType<typeof mock>;
  findRelationshipsByEntity: ReturnType<typeof mock>;
} & Record<string, unknown> {
  return {
    createRelationship: mock(() => Promise.resolve(null)),
    getEntity: mock(() => Promise.resolve(null)),
    findRelationshipsByEntity: mock(() => Promise.resolve([])),
    createEntity: mock(() => Promise.resolve(null)),
    updateEntity: mock(() => Promise.resolve(null)),
    deleteEntity: mock(() => Promise.resolve(false)),
    getRelationship: mock(() => Promise.resolve(null)),
    deleteRelationship: mock(() => Promise.resolve(false)),
    findEntitiesByType: mock(() => Promise.resolve([])),
    mergeEntity: mock(() => Promise.resolve(null)),
    batchCreateEntities: mock(() => Promise.resolve([])),
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("CausalGraphManager", () => {
  let mockGM: ReturnType<typeof createMockGraphManager>;
  let causalManager: CausalGraphManager;

  beforeEach(() => {
    mockGM = createMockGraphManager();
    causalManager = new CausalGraphManager({
      graphManager: mockGM as unknown as GraphManager,
    });
  });

  // ==========================================================================
  // addCausalLink
  // ==========================================================================

  describe("addCausalLink", () => {
    it("should create a CAUSES relationship with correct properties", async () => {
      const expectedRel = makeRelationship(
        "rel-1",
        "cause-id",
        "effect-id",
        RelationshipType.CAUSES,
        0.9,
        "Direct trigger",
      );
      mockGM.createRelationship.mockImplementation(() =>
        Promise.resolve(expectedRel),
      );

      const result = await causalManager.addCausalLink({
        causeEntityId: "cause-id",
        effectEntityId: "effect-id",
        confidence: 0.9,
        evidence: "Direct trigger",
      });

      expect(result).toBe(expectedRel);
      expect(mockGM.createRelationship).toHaveBeenCalledTimes(1);

      const callArg = (mockGM.createRelationship as ReturnType<typeof mock>)
        .mock.calls[0]![0] as Record<string, unknown>;
      expect(callArg.type).toBe(RelationshipType.CAUSES);
      expect(callArg.sourceId).toBe("cause-id");
      expect(callArg.targetId).toBe("effect-id");
      expect(callArg.weight).toBe(0.9);
      expect(
        (callArg.properties as Record<string, unknown>).confidence,
      ).toBe(0.9);
      expect(
        (callArg.properties as Record<string, unknown>).evidence,
      ).toBe("Direct trigger");
    });
  });

  // ==========================================================================
  // getCausesOf
  // ==========================================================================

  describe("getCausesOf", () => {
    it("should return incoming CAUSES relationships for entity", async () => {
      const causeEntity = makeEntity("cause-a", "Cause A");
      const effectEntity = makeEntity("effect-b", "Effect B");

      const causalRel = makeRelationship(
        "rel-1",
        "cause-a",
        "effect-b",
        RelationshipType.CAUSES,
        0.9,
        "A triggers B",
      );
      const unrelatedRel = makeRelationship(
        "rel-2",
        "effect-b",
        "other",
        RelationshipType.RELATED_TO,
        0.8,
        "",
      );

      mockGM.findRelationshipsByEntity.mockImplementation(() =>
        Promise.resolve([causalRel, unrelatedRel]),
      );
      mockGM.getEntity.mockImplementation((id: string) => {
        if (id === "cause-a") return Promise.resolve(causeEntity);
        if (id === "effect-b") return Promise.resolve(effectEntity);
        return Promise.resolve(null);
      });

      const results = await causalManager.getCausesOf("effect-b");

      expect(results).toHaveLength(1);
      expect(results[0]!.causeId).toBe("cause-a");
      expect(results[0]!.causeName).toBe("Cause A");
      expect(results[0]!.effectId).toBe("effect-b");
      expect(results[0]!.effectName).toBe("Effect B");
      expect(results[0]!.confidence).toBe(0.9);
      expect(results[0]!.evidence).toBe("A triggers B");
    });

    it("should sort by confidence descending", async () => {
      const rel1 = makeRelationship(
        "rel-1",
        "c1",
        "target",
        RelationshipType.CAUSES,
        0.6,
        "low",
      );
      const rel2 = makeRelationship(
        "rel-2",
        "c2",
        "target",
        RelationshipType.CAUSES,
        0.95,
        "high",
      );

      mockGM.findRelationshipsByEntity.mockImplementation(() =>
        Promise.resolve([rel1, rel2]),
      );
      mockGM.getEntity.mockImplementation(() =>
        Promise.resolve(makeEntity("x", "X")),
      );

      const results = await causalManager.getCausesOf("target");

      expect(results).toHaveLength(2);
      expect(results[0]!.confidence).toBe(0.95);
      expect(results[1]!.confidence).toBe(0.6);
    });

    it("should respect limit option", async () => {
      const rels = Array.from({ length: 5 }, (_, i) =>
        makeRelationship(
          `rel-${i}`,
          `cause-${i}`,
          "target",
          RelationshipType.CAUSES,
          0.9 - i * 0.05,
          `evidence ${i}`,
        ),
      );

      mockGM.findRelationshipsByEntity.mockImplementation(() =>
        Promise.resolve(rels),
      );
      mockGM.getEntity.mockImplementation(() =>
        Promise.resolve(makeEntity("x", "X")),
      );

      const results = await causalManager.getCausesOf("target", { limit: 2 });

      expect(results).toHaveLength(2);
    });
  });

  // ==========================================================================
  // getEffectsOf
  // ==========================================================================

  describe("getEffectsOf", () => {
    it("should return outgoing CAUSES relationships for entity", async () => {
      const causeEntity = makeEntity("cause-a", "Cause A");
      const effectEntity = makeEntity("effect-b", "Effect B");

      const causalRel = makeRelationship(
        "rel-1",
        "cause-a",
        "effect-b",
        RelationshipType.CAUSES,
        0.85,
        "A causes B",
      );

      mockGM.findRelationshipsByEntity.mockImplementation(() =>
        Promise.resolve([causalRel]),
      );
      mockGM.getEntity.mockImplementation((id: string) => {
        if (id === "cause-a") return Promise.resolve(causeEntity);
        if (id === "effect-b") return Promise.resolve(effectEntity);
        return Promise.resolve(null);
      });

      const results = await causalManager.getEffectsOf("cause-a");

      expect(results).toHaveLength(1);
      expect(results[0]!.causeId).toBe("cause-a");
      expect(results[0]!.causeName).toBe("Cause A");
      expect(results[0]!.effectId).toBe("effect-b");
      expect(results[0]!.effectName).toBe("Effect B");
      expect(results[0]!.confidence).toBe(0.85);
    });

    it("should exclude relationships below minConfidence", async () => {
      const lowConfRel = makeRelationship(
        "rel-low",
        "cause-a",
        "effect-b",
        RelationshipType.CAUSES,
        0.3,
        "weak link",
      );

      mockGM.findRelationshipsByEntity.mockImplementation(() =>
        Promise.resolve([lowConfRel]),
      );

      const results = await causalManager.getEffectsOf("cause-a");

      expect(results).toHaveLength(0);
    });
  });

  // ==========================================================================
  // getCausalChain
  // ==========================================================================

  describe("getCausalChain", () => {
    it("should find a direct causal chain between two entities", async () => {
      const relAB = makeRelationship(
        "rel-ab",
        "a",
        "b",
        RelationshipType.CAUSES,
        0.9,
        "A causes B",
      );

      mockGM.findRelationshipsByEntity.mockImplementation((id: string) => {
        if (id === "a") return Promise.resolve([relAB]);
        return Promise.resolve([]);
      });
      mockGM.getEntity.mockImplementation((id: string) => {
        if (id === "a") return Promise.resolve(makeEntity("a", "Entity A"));
        if (id === "b") return Promise.resolve(makeEntity("b", "Entity B"));
        return Promise.resolve(null);
      });

      const chain = await causalManager.getCausalChain("a", "b");

      expect(chain).toHaveLength(1);
      expect(chain[0]!.causeId).toBe("a");
      expect(chain[0]!.effectId).toBe("b");
      expect(chain[0]!.causeName).toBe("Entity A");
      expect(chain[0]!.effectName).toBe("Entity B");
    });

    it("should find a multi-hop causal chain", async () => {
      const relAB = makeRelationship(
        "rel-ab",
        "a",
        "b",
        RelationshipType.CAUSES,
        0.9,
        "A causes B",
      );
      const relBC = makeRelationship(
        "rel-bc",
        "b",
        "c",
        RelationshipType.CAUSES,
        0.8,
        "B causes C",
      );

      mockGM.findRelationshipsByEntity.mockImplementation((id: string) => {
        if (id === "a") return Promise.resolve([relAB]);
        if (id === "b") return Promise.resolve([relBC]);
        return Promise.resolve([]);
      });
      mockGM.getEntity.mockImplementation((id: string) =>
        Promise.resolve(makeEntity(id, `Entity ${id.toUpperCase()}`)),
      );

      const chain = await causalManager.getCausalChain("a", "c");

      expect(chain).toHaveLength(2);
      expect(chain[0]!.causeId).toBe("a");
      expect(chain[0]!.effectId).toBe("b");
      expect(chain[1]!.causeId).toBe("b");
      expect(chain[1]!.effectId).toBe("c");
    });

    it("should return empty array when no path exists", async () => {
      mockGM.findRelationshipsByEntity.mockImplementation(() =>
        Promise.resolve([]),
      );

      const chain = await causalManager.getCausalChain("a", "z");

      expect(chain).toHaveLength(0);
    });

    it("should return empty array when start equals end", async () => {
      const chain = await causalManager.getCausalChain("a", "a");

      expect(chain).toHaveLength(0);
    });
  });

  // ==========================================================================
  // minConfidence filtering
  // ==========================================================================

  describe("minConfidence filtering", () => {
    it("should use custom minConfidence when specified", async () => {
      const customManager = new CausalGraphManager({
        graphManager: mockGM as unknown as GraphManager,
        minConfidence: 0.8,
      });

      const relHigh = makeRelationship(
        "rel-high",
        "cause",
        "target",
        RelationshipType.CAUSES,
        0.9,
        "strong link",
      );
      const relLow = makeRelationship(
        "rel-low",
        "weak-cause",
        "target",
        RelationshipType.CAUSES,
        0.7,
        "weaker link",
      );

      mockGM.findRelationshipsByEntity.mockImplementation(() =>
        Promise.resolve([relHigh, relLow]),
      );
      mockGM.getEntity.mockImplementation(() =>
        Promise.resolve(makeEntity("x", "X")),
      );

      const results = await customManager.getCausesOf("target");

      // Only the 0.9 confidence link should pass the 0.8 threshold
      expect(results).toHaveLength(1);
      expect(results[0]!.confidence).toBe(0.9);
    });

    it("should use default minConfidence of 0.5", async () => {
      const relAbove = makeRelationship(
        "rel-above",
        "cause",
        "target",
        RelationshipType.CAUSES,
        0.6,
        "above threshold",
      );
      const relBelow = makeRelationship(
        "rel-below",
        "weak",
        "target",
        RelationshipType.CAUSES,
        0.4,
        "below threshold",
      );

      mockGM.findRelationshipsByEntity.mockImplementation(() =>
        Promise.resolve([relAbove, relBelow]),
      );
      mockGM.getEntity.mockImplementation(() =>
        Promise.resolve(makeEntity("x", "X")),
      );

      const results = await causalManager.getCausesOf("target");

      expect(results).toHaveLength(1);
      expect(results[0]!.confidence).toBe(0.6);
    });
  });
});
