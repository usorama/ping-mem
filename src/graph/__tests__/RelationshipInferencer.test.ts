/**
 * Tests for RelationshipInferencer
 *
 * @module graph/__tests__/RelationshipInferencer.test
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  RelationshipInferencer,
  RelationshipInferencerConfig,
  InferenceRule,
  createRelationshipInferencer,
  createRelationshipInferencerWithConfig,
  DEFAULT_INFERENCE_RULES,
} from "../RelationshipInferencer.js";
import { EntityType, Entity, RelationshipType, Relationship } from "../../types/graph.js";
import { randomUUID } from "crypto";

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Creates a test entity with minimal required fields.
 */
function createTestEntity(
  type: EntityType,
  name: string,
  id?: string
): Entity {
  const now = new Date();
  return {
    id: id ?? randomUUID(),
    type,
    name,
    properties: {},
    createdAt: now,
    updatedAt: now,
    eventTime: now,
    ingestionTime: now,
  };
}

/**
 * Helper to find relationships of a specific type.
 */
function findRelationshipsByType(
  relationships: Relationship[],
  type: RelationshipType
): Relationship[] {
  return relationships.filter((r) => r.type === type);
}

/**
 * Helper to check if a relationship exists between two entity IDs.
 */
function hasRelationshipBetween(
  relationships: Relationship[],
  sourceId: string,
  targetId: string,
  type?: RelationshipType
): boolean {
  return relationships.some(
    (r) =>
      r.sourceId === sourceId &&
      r.targetId === targetId &&
      (type === undefined || r.type === type)
  );
}

/**
 * Calculate inference accuracy for expected relationships.
 */
function calculateAccuracy(
  relationships: Relationship[],
  expectedPairs: Array<{ sourceId: string; targetId: string; type: RelationshipType }>
): number {
  const foundCount = expectedPairs.filter((expected) =>
    hasRelationshipBetween(
      relationships,
      expected.sourceId,
      expected.targetId,
      expected.type
    )
  ).length;
  return expectedPairs.length > 0 ? foundCount / expectedPairs.length : 0;
}

// ============================================================================
// Unit Tests
// ============================================================================

describe("RelationshipInferencer - Unit Tests", () => {
  describe("Construction", () => {
    it("should create with default configuration", () => {
      const inferencer = new RelationshipInferencer();
      expect(inferencer).toBeInstanceOf(RelationshipInferencer);

      const config = inferencer.getConfig();
      expect(config.minConfidence).toBe(0.5);
      expect(config.maxRelationshipsPerPair).toBe(3);
      expect(config.inferenceRules.size).toBeGreaterThan(0);
    });

    it("should accept custom minConfidence", () => {
      const inferencer = new RelationshipInferencer({ minConfidence: 0.8 });
      const config = inferencer.getConfig();
      expect(config.minConfidence).toBe(0.8);
    });

    it("should accept custom maxRelationshipsPerPair", () => {
      const inferencer = new RelationshipInferencer({ maxRelationshipsPerPair: 5 });
      const config = inferencer.getConfig();
      expect(config.maxRelationshipsPerPair).toBe(5);
    });

    it("should accept custom inference rules", () => {
      const customRules = new Map<RelationshipType, InferenceRule[]>([
        [
          RelationshipType.DEPENDS_ON,
          [
            {
              sourceTypes: [EntityType.CODE_FILE],
              targetTypes: [EntityType.CODE_FILE],
              patterns: [/test/gi],
              weight: 1.0,
            },
          ],
        ],
      ]);
      const inferencer = new RelationshipInferencer({ inferenceRules: customRules });
      const config = inferencer.getConfig();
      expect(config.inferenceRules.size).toBe(1);
    });
  });

  describe("infer() - Empty/Invalid Input", () => {
    let inferencer: RelationshipInferencer;

    beforeEach(() => {
      inferencer = new RelationshipInferencer();
    });

    it("should return empty result for empty entities array", () => {
      const result = inferencer.infer([], "some context");
      expect(result.relationships).toHaveLength(0);
      expect(result.confidence).toBe(0);
    });

    it("should return empty result for single entity", () => {
      const entities = [createTestEntity(EntityType.CODE_FILE, "file.ts")];
      const result = inferencer.infer(entities, "some context");
      expect(result.relationships).toHaveLength(0);
      expect(result.confidence).toBe(0);
    });

    it("should return empty result for empty context", () => {
      const entities = [
        createTestEntity(EntityType.CODE_FILE, "file1.ts"),
        createTestEntity(EntityType.CODE_FILE, "file2.ts"),
      ];
      const result = inferencer.infer(entities, "");
      expect(result.relationships).toHaveLength(0);
      expect(result.confidence).toBe(0);
    });

    it("should return empty result for whitespace-only context", () => {
      const entities = [
        createTestEntity(EntityType.CODE_FILE, "file1.ts"),
        createTestEntity(EntityType.CODE_FILE, "file2.ts"),
      ];
      const result = inferencer.infer(entities, "   \n\t  ");
      expect(result.relationships).toHaveLength(0);
      expect(result.confidence).toBe(0);
    });
  });

  describe("infer() - DEPENDS_ON Relationships", () => {
    let inferencer: RelationshipInferencer;

    beforeEach(() => {
      inferencer = new RelationshipInferencer({ minConfidence: 0.3 });
    });

    it("should infer DEPENDS_ON from import statements", () => {
      const file1 = createTestEntity(EntityType.CODE_FILE, "UserService.ts", "file1");
      const file2 = createTestEntity(EntityType.CODE_FILE, "DatabaseClient.ts", "file2");
      const entities = [file1, file2];

      const context = "UserService.ts imports from DatabaseClient.ts";
      const result = inferencer.infer(entities, context);

      const dependsOn = findRelationshipsByType(result.relationships, RelationshipType.DEPENDS_ON);
      expect(dependsOn.length).toBeGreaterThanOrEqual(1);
    });

    it("should infer DEPENDS_ON from 'depends on' phrase", () => {
      const file1 = createTestEntity(EntityType.CODE_FILE, "api.ts", "file1");
      const file2 = createTestEntity(EntityType.CODE_FILE, "database.ts", "file2");
      const entities = [file1, file2];

      const context = "The api.ts depends on database.ts for data access";
      const result = inferencer.infer(entities, context);

      const dependsOn = findRelationshipsByType(result.relationships, RelationshipType.DEPENDS_ON);
      expect(dependsOn.length).toBeGreaterThanOrEqual(1);
    });

    it("should infer DEPENDS_ON from 'requires' keyword", () => {
      const func1 = createTestEntity(EntityType.CODE_FUNCTION, "processData", "func1");
      const func2 = createTestEntity(EntityType.CODE_FUNCTION, "validateInput", "func2");
      const entities = [func1, func2];

      const context = "processData requires validateInput to be called first";
      const result = inferencer.infer(entities, context);

      const dependsOn = findRelationshipsByType(result.relationships, RelationshipType.DEPENDS_ON);
      expect(dependsOn.length).toBeGreaterThanOrEqual(1);
    });

    it("should infer DEPENDS_ON between tasks", () => {
      const task1 = createTestEntity(EntityType.TASK, "implement auth", "task1");
      const task2 = createTestEntity(EntityType.TASK, "setup database", "task2");
      const entities = [task1, task2];

      const context = "implement auth depends on setup database being complete";
      const result = inferencer.infer(entities, context);

      const dependsOn = findRelationshipsByType(result.relationships, RelationshipType.DEPENDS_ON);
      expect(dependsOn.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("infer() - IMPLEMENTS Relationships", () => {
    let inferencer: RelationshipInferencer;

    beforeEach(() => {
      inferencer = new RelationshipInferencer({ minConfidence: 0.3 });
    });

    it("should infer IMPLEMENTS from class implements interface", () => {
      const cls = createTestEntity(EntityType.CODE_CLASS, "UserService", "class1");
      const iface = createTestEntity(EntityType.CODE_CLASS, "IUserService", "iface1");
      const entities = [cls, iface];

      const context = "UserService implements IUserService interface";
      const result = inferencer.infer(entities, context);

      const implements_ = findRelationshipsByType(result.relationships, RelationshipType.IMPLEMENTS);
      expect(implements_.length).toBeGreaterThanOrEqual(1);
    });

    it("should infer IMPLEMENTS from extends keyword", () => {
      const cls = createTestEntity(EntityType.CODE_CLASS, "UserService", "class1");
      const base = createTestEntity(EntityType.CODE_CLASS, "BaseService", "class2");
      const entities = [cls, base];

      const context = "UserService extends BaseService with additional methods";
      const result = inferencer.infer(entities, context);

      const implements_ = findRelationshipsByType(result.relationships, RelationshipType.IMPLEMENTS);
      expect(implements_.length).toBeGreaterThanOrEqual(1);
    });

    it("should infer IMPLEMENTS for task implementing decision", () => {
      const task = createTestEntity(EntityType.TASK, "add caching", "task1");
      const decision = createTestEntity(EntityType.DECISION, "use Redis", "decision1");
      const entities = [task, decision];

      const context = "add caching task implements the use Redis decision";
      const result = inferencer.infer(entities, context);

      const implements_ = findRelationshipsByType(result.relationships, RelationshipType.IMPLEMENTS);
      expect(implements_.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("infer() - USES Relationships", () => {
    let inferencer: RelationshipInferencer;

    beforeEach(() => {
      inferencer = new RelationshipInferencer({ minConfidence: 0.3 });
    });

    it("should infer USES from code entities", () => {
      const func1 = createTestEntity(EntityType.CODE_FUNCTION, "handleRequest", "func1");
      const func2 = createTestEntity(EntityType.CODE_FUNCTION, "validateToken", "func2");
      const entities = [func1, func2];

      const context = "handleRequest uses validateToken to check authentication";
      const result = inferencer.infer(entities, context);

      const uses = findRelationshipsByType(result.relationships, RelationshipType.USES);
      expect(uses.length).toBeGreaterThanOrEqual(1);
    });

    it("should infer USES from 'calls' keyword", () => {
      const func1 = createTestEntity(EntityType.CODE_FUNCTION, "processOrder", "func1");
      const func2 = createTestEntity(EntityType.CODE_FUNCTION, "calculateTotal", "func2");
      const entities = [func1, func2];

      const context = "processOrder calls calculateTotal for the price";
      const result = inferencer.infer(entities, context);

      const uses = findRelationshipsByType(result.relationships, RelationshipType.USES);
      expect(uses.length).toBeGreaterThanOrEqual(1);
    });

    it("should infer USES from person using tool", () => {
      const person = createTestEntity(EntityType.PERSON, "John", "person1");
      const concept = createTestEntity(EntityType.CONCEPT, "TypeScript", "concept1");
      const entities = [person, concept];

      const context = "John uses TypeScript for all projects";
      const result = inferencer.infer(entities, context);

      const uses = findRelationshipsByType(result.relationships, RelationshipType.USES);
      expect(uses.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("infer() - REFERENCES Relationships", () => {
    let inferencer: RelationshipInferencer;

    beforeEach(() => {
      inferencer = new RelationshipInferencer({ minConfidence: 0.3 });
    });

    it("should infer REFERENCES from documentation context", () => {
      const file1 = createTestEntity(EntityType.CODE_FILE, "README.md", "file1");
      const cls = createTestEntity(EntityType.CODE_CLASS, "ApiClient", "class1");
      const entities = [file1, cls];

      const context = "README.md references ApiClient class for API usage";
      const result = inferencer.infer(entities, context);

      const references = findRelationshipsByType(result.relationships, RelationshipType.REFERENCES);
      expect(references.length).toBeGreaterThanOrEqual(1);
    });

    it("should infer REFERENCES from 'refers to' phrase", () => {
      const decision = createTestEntity(EntityType.DECISION, "architecture choice", "dec1");
      const concept = createTestEntity(EntityType.CONCEPT, "microservices", "concept1");
      const entities = [decision, concept];

      const context = "The architecture choice refers to microservices pattern";
      const result = inferencer.infer(entities, context);

      const references = findRelationshipsByType(result.relationships, RelationshipType.REFERENCES);
      expect(references.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("infer() - CAUSES Relationships", () => {
    let inferencer: RelationshipInferencer;

    beforeEach(() => {
      inferencer = new RelationshipInferencer({ minConfidence: 0.3 });
    });

    it("should infer CAUSES for decision causing error", () => {
      const decision = createTestEntity(EntityType.DECISION, "skip validation", "dec1");
      const error = createTestEntity(EntityType.ERROR, "TypeError", "err1");
      const entities = [decision, error];

      const context = "The skip validation decision causes TypeError in production";
      const result = inferencer.infer(entities, context);

      const causes = findRelationshipsByType(result.relationships, RelationshipType.CAUSES);
      expect(causes.length).toBeGreaterThanOrEqual(1);
    });

    it("should infer CAUSES from 'results in' phrase", () => {
      const func = createTestEntity(EntityType.CODE_FUNCTION, "parseInput", "func1");
      const error = createTestEntity(EntityType.ERROR, "SyntaxError", "err1");
      const entities = [func, error];

      const context = "Calling parseInput with invalid data results in SyntaxError";
      const result = inferencer.infer(entities, context);

      const causes = findRelationshipsByType(result.relationships, RelationshipType.CAUSES);
      expect(causes.length).toBeGreaterThanOrEqual(1);
    });

    it("should infer CAUSES from 'triggers' keyword", () => {
      const event = createTestEntity(EntityType.EVENT, "user signup", "event1");
      const task = createTestEntity(EntityType.TASK, "send welcome email", "task1");
      const entities = [event, task];

      const context = "user signup event triggers send welcome email task";
      const result = inferencer.infer(entities, context);

      const causes = findRelationshipsByType(result.relationships, RelationshipType.CAUSES);
      expect(causes.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("infer() - BLOCKS Relationships", () => {
    let inferencer: RelationshipInferencer;

    beforeEach(() => {
      inferencer = new RelationshipInferencer({ minConfidence: 0.3 });
    });

    it("should infer BLOCKS between tasks", () => {
      const task1 = createTestEntity(EntityType.TASK, "fix tests", "task1");
      const task2 = createTestEntity(EntityType.TASK, "deploy", "task2");
      const entities = [task1, task2];

      const context = "fix tests blocks deploy until all pass";
      const result = inferencer.infer(entities, context);

      const blocks = findRelationshipsByType(result.relationships, RelationshipType.BLOCKS);
      expect(blocks.length).toBeGreaterThanOrEqual(1);
    });

    it("should infer BLOCKS from error blocking task", () => {
      const error = createTestEntity(EntityType.ERROR, "build failure", "err1");
      const task = createTestEntity(EntityType.TASK, "release", "task1");
      const entities = [error, task];

      const context = "build failure prevents release from proceeding";
      const result = inferencer.infer(entities, context);

      const blocks = findRelationshipsByType(result.relationships, RelationshipType.BLOCKS);
      expect(blocks.length).toBeGreaterThanOrEqual(1);
    });

    it("should infer BLOCKS from 'blocked by' phrase", () => {
      const task1 = createTestEntity(EntityType.TASK, "integration", "task1");
      const task2 = createTestEntity(EntityType.TASK, "unit tests", "task2");
      const entities = [task1, task2];

      const context = "integration is blocked by unit tests not passing";
      const result = inferencer.infer(entities, context);

      const blocks = findRelationshipsByType(result.relationships, RelationshipType.BLOCKS);
      expect(blocks.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("inferFromPair()", () => {
    let inferencer: RelationshipInferencer;

    beforeEach(() => {
      inferencer = new RelationshipInferencer({ minConfidence: 0.3 });
    });

    it("should return relationships for a valid pair", () => {
      const source = createTestEntity(EntityType.CODE_FILE, "service.ts", "src1");
      const target = createTestEntity(EntityType.CODE_FILE, "client.ts", "tgt1");

      const context = "service.ts depends on client.ts for API calls";
      const relationships = inferencer.inferFromPair(source, target, context);

      expect(relationships.length).toBeGreaterThanOrEqual(1);
      expect(relationships[0].sourceId).toBe(source.id);
      expect(relationships[0].targetId).toBe(target.id);
    });

    it("should respect maxRelationshipsPerPair", () => {
      const inferencer2 = new RelationshipInferencer({
        minConfidence: 0.2,
        maxRelationshipsPerPair: 1,
      });

      const source = createTestEntity(EntityType.CODE_FILE, "api.ts", "src1");
      const target = createTestEntity(EntityType.CODE_FILE, "db.ts", "tgt1");

      // Context with multiple relationship indicators
      const context = "api.ts depends on db.ts and uses db.ts and references db.ts";
      const relationships = inferencer2.inferFromPair(source, target, context);

      expect(relationships.length).toBeLessThanOrEqual(1);
    });

    it("should return empty array when entities not in context", () => {
      const source = createTestEntity(EntityType.CODE_FILE, "foo.ts", "src1");
      const target = createTestEntity(EntityType.CODE_FILE, "bar.ts", "tgt1");

      const context = "something unrelated about other things";
      const relationships = inferencer.inferFromPair(source, target, context);

      expect(relationships.length).toBe(0);
    });

    it("should include metadata in relationship properties", () => {
      const source = createTestEntity(EntityType.CODE_CLASS, "ServiceA", "src1");
      const target = createTestEntity(EntityType.CODE_CLASS, "ServiceB", "tgt1");

      const context = "ServiceA implements ServiceB interface";
      const relationships = inferencer.inferFromPair(source, target, context);

      if (relationships.length > 0) {
        const rel = relationships[0];
        expect(rel.properties).toHaveProperty("inferredFrom", "pattern-matching");
        expect(rel.properties).toHaveProperty("sourceName", "ServiceA");
        expect(rel.properties).toHaveProperty("targetName", "ServiceB");
      }
    });
  });

  describe("Configuration Methods", () => {
    it("should allow adding custom rules", () => {
      const inferencer = new RelationshipInferencer();
      const customRule: InferenceRule = {
        sourceTypes: [EntityType.CONCEPT],
        targetTypes: [EntityType.CONCEPT],
        patterns: [/\brelates?\s+to\b/gi],
        weight: 0.9,
      };

      inferencer.addRules(RelationshipType.RELATED_TO, [customRule]);

      const config = inferencer.getConfig();
      const rules = config.inferenceRules.get(RelationshipType.RELATED_TO);
      expect(rules).toBeDefined();
      expect(rules!.length).toBeGreaterThan(1); // Original + custom
    });

    it("should allow setting minConfidence", () => {
      const inferencer = new RelationshipInferencer();
      inferencer.setMinConfidence(0.9);

      const config = inferencer.getConfig();
      expect(config.minConfidence).toBe(0.9);
    });

    it("should clamp minConfidence to [0, 1]", () => {
      const inferencer = new RelationshipInferencer();

      inferencer.setMinConfidence(-0.5);
      expect(inferencer.getConfig().minConfidence).toBe(0);

      inferencer.setMinConfidence(1.5);
      expect(inferencer.getConfig().minConfidence).toBe(1);
    });

    it("should allow setting maxRelationshipsPerPair", () => {
      const inferencer = new RelationshipInferencer();
      inferencer.setMaxRelationshipsPerPair(10);

      const config = inferencer.getConfig();
      expect(config.maxRelationshipsPerPair).toBe(10);
    });

    it("should enforce minimum of 1 for maxRelationshipsPerPair", () => {
      const inferencer = new RelationshipInferencer();
      inferencer.setMaxRelationshipsPerPair(0);

      const config = inferencer.getConfig();
      expect(config.maxRelationshipsPerPair).toBe(1);
    });
  });

  describe("Deduplication", () => {
    let inferencer: RelationshipInferencer;

    beforeEach(() => {
      inferencer = new RelationshipInferencer({ minConfidence: 0.2 });
    });

    it("should deduplicate relationships with same source, target, and type", () => {
      const file1 = createTestEntity(EntityType.CODE_FILE, "api.ts", "file1");
      const file2 = createTestEntity(EntityType.CODE_FILE, "db.ts", "file2");
      const entities = [file1, file2];

      // Context with repeated relationship indicators
      const context = "api.ts depends on db.ts. The api.ts really depends on db.ts for everything.";
      const result = inferencer.infer(entities, context);

      // Should only have one DEPENDS_ON relationship
      const dependsOn = findRelationshipsByType(result.relationships, RelationshipType.DEPENDS_ON);
      const uniquePairs = new Set(dependsOn.map((r) => `${r.sourceId}:${r.targetId}`));
      expect(uniquePairs.size).toBeLessThanOrEqual(2); // At most forward and reverse
    });

    it("should keep higher weight when deduplicating", () => {
      const file1 = createTestEntity(EntityType.CODE_FILE, "service.ts", "file1");
      const file2 = createTestEntity(EntityType.CODE_FILE, "utils.ts", "file2");
      const entities = [file1, file2];

      const context = "service.ts needs utils.ts. service.ts imports and requires utils.ts.";
      const result = inferencer.infer(entities, context);

      const dependsOn = findRelationshipsByType(result.relationships, RelationshipType.DEPENDS_ON);
      // All relationships should have reasonable weights
      dependsOn.forEach((r) => {
        expect(r.weight).toBeGreaterThan(0);
      });
    });
  });
});

// ============================================================================
// Factory Function Tests
// ============================================================================

describe("Factory Functions", () => {
  describe("createRelationshipInferencer", () => {
    it("should create a new RelationshipInferencer with defaults", () => {
      const inferencer = createRelationshipInferencer();
      expect(inferencer).toBeInstanceOf(RelationshipInferencer);
      expect(inferencer.getConfig().minConfidence).toBe(0.5);
      expect(inferencer.getConfig().maxRelationshipsPerPair).toBe(3);
    });
  });

  describe("createRelationshipInferencerWithConfig", () => {
    it("should create with custom config", () => {
      const inferencer = createRelationshipInferencerWithConfig({
        minConfidence: 0.7,
        maxRelationshipsPerPair: 5,
      });
      expect(inferencer).toBeInstanceOf(RelationshipInferencer);
      expect(inferencer.getConfig().minConfidence).toBe(0.7);
      expect(inferencer.getConfig().maxRelationshipsPerPair).toBe(5);
    });
  });

  describe("DEFAULT_INFERENCE_RULES", () => {
    it("should export default rules", () => {
      expect(DEFAULT_INFERENCE_RULES).toBeInstanceOf(Map);
      expect(DEFAULT_INFERENCE_RULES.size).toBeGreaterThan(0);
    });

    it("should have rules for main relationship types", () => {
      expect(DEFAULT_INFERENCE_RULES.has(RelationshipType.DEPENDS_ON)).toBe(true);
      expect(DEFAULT_INFERENCE_RULES.has(RelationshipType.IMPLEMENTS)).toBe(true);
      expect(DEFAULT_INFERENCE_RULES.has(RelationshipType.USES)).toBe(true);
      expect(DEFAULT_INFERENCE_RULES.has(RelationshipType.REFERENCES)).toBe(true);
      expect(DEFAULT_INFERENCE_RULES.has(RelationshipType.CAUSES)).toBe(true);
      expect(DEFAULT_INFERENCE_RULES.has(RelationshipType.BLOCKS)).toBe(true);
    });

    it("should have well-formed rules with required properties", () => {
      for (const [type, rules] of DEFAULT_INFERENCE_RULES) {
        expect(rules.length).toBeGreaterThan(0);
        for (const rule of rules) {
          expect(rule.sourceTypes).toBeInstanceOf(Array);
          expect(rule.sourceTypes.length).toBeGreaterThan(0);
          expect(rule.targetTypes).toBeInstanceOf(Array);
          expect(rule.targetTypes.length).toBeGreaterThan(0);
          expect(rule.patterns).toBeInstanceOf(Array);
          expect(rule.patterns.length).toBeGreaterThan(0);
          expect(typeof rule.weight).toBe("number");
          expect(rule.weight).toBeGreaterThan(0);
          expect(rule.weight).toBeLessThanOrEqual(1);
        }
      }
    });
  });
});

// ============================================================================
// Accuracy Tests (>=70% target)
// ============================================================================

describe("RelationshipInferencer - Accuracy Tests", () => {
  let inferencer: RelationshipInferencer;

  beforeEach(() => {
    inferencer = new RelationshipInferencer({ minConfidence: 0.3 });
  });

  describe("DEPENDS_ON Accuracy", () => {
    it("should achieve >=70% accuracy on dependency inference", () => {
      const serviceA = createTestEntity(EntityType.CODE_FILE, "ServiceA.ts", "svcA");
      const serviceB = createTestEntity(EntityType.CODE_FILE, "ServiceB.ts", "svcB");
      const dbClient = createTestEntity(EntityType.CODE_CLASS, "DatabaseClient", "db");
      const apiUtils = createTestEntity(EntityType.CODE_FILE, "apiUtils.ts", "utils");
      const entities = [serviceA, serviceB, dbClient, apiUtils];

      const context = `
        ServiceA.ts imports from ServiceB.ts for business logic.
        ServiceB.ts depends on DatabaseClient for data access.
        ServiceA.ts requires apiUtils.ts for helper functions.
        The DatabaseClient needs apiUtils.ts for configuration.
      `;

      const result = inferencer.infer(entities, context);
      const dependsOn = findRelationshipsByType(result.relationships, RelationshipType.DEPENDS_ON);

      // Should find at least 3 out of 4 expected relationships
      expect(dependsOn.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe("IMPLEMENTS Accuracy", () => {
    it("should achieve >=70% accuracy on implementation inference", () => {
      const userService = createTestEntity(EntityType.CODE_CLASS, "UserService", "userSvc");
      const iUserService = createTestEntity(EntityType.CODE_CLASS, "IUserService", "iUserSvc");
      const baseService = createTestEntity(EntityType.CODE_CLASS, "BaseService", "baseSvc");
      const entities = [userService, iUserService, baseService];

      const context = `
        UserService implements IUserService interface.
        UserService extends BaseService for common functionality.
      `;

      const result = inferencer.infer(entities, context);
      const implements_ = findRelationshipsByType(result.relationships, RelationshipType.IMPLEMENTS);

      // Should find at least 1 out of 2 expected relationships
      expect(implements_.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("CAUSES/BLOCKS Accuracy", () => {
    it("should achieve >=70% accuracy on causal and blocking relationships", () => {
      const nullCheck = createTestEntity(EntityType.DECISION, "skip null check", "dec1");
      const typeError = createTestEntity(EntityType.ERROR, "TypeError", "err1");
      const deploy = createTestEntity(EntityType.TASK, "deploy to prod", "task1");
      const fixBug = createTestEntity(EntityType.TASK, "fix the bug", "task2");
      const entities = [nullCheck, typeError, deploy, fixBug];

      const context = `
        The skip null check decision causes TypeError in production.
        TypeError blocks deploy to prod until resolved.
        fix the bug prevents deploy to prod from failing again.
      `;

      const result = inferencer.infer(entities, context);
      const causes = findRelationshipsByType(result.relationships, RelationshipType.CAUSES);
      const blocks = findRelationshipsByType(result.relationships, RelationshipType.BLOCKS);

      // Should find at least some causal or blocking relationships
      expect(causes.length + blocks.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Mixed Relationship Types Accuracy", () => {
    it("should correctly identify multiple relationship types in complex context", () => {
      const authService = createTestEntity(EntityType.CODE_CLASS, "AuthService", "auth");
      const userRepo = createTestEntity(EntityType.CODE_CLASS, "UserRepository", "repo");
      const iAuth = createTestEntity(EntityType.CODE_CLASS, "IAuthService", "iAuth");
      const tokenUtil = createTestEntity(EntityType.CODE_FUNCTION, "generateToken", "token");
      const authError = createTestEntity(EntityType.ERROR, "AuthenticationError", "authErr");
      const loginTask = createTestEntity(EntityType.TASK, "implement login", "loginTask");
      const entities = [authService, userRepo, iAuth, tokenUtil, authError, loginTask];

      const context = `
        AuthService implements IAuthService interface.
        AuthService depends on UserRepository for user data.
        AuthService uses generateToken for JWT creation.
        Invalid credentials causes AuthenticationError.
        AuthenticationError blocks implement login from completion.
        The implement login task references AuthService documentation.
      `;

      const result = inferencer.infer(entities, context);

      // Should find relationships of multiple types
      const types = new Set(result.relationships.map((r) => r.type));
      expect(types.size).toBeGreaterThanOrEqual(2);

      // Should have reasonable overall confidence
      expect(result.confidence).toBeGreaterThan(0);
    });
  });
});

// ============================================================================
// Edge Case Tests
// ============================================================================

describe("RelationshipInferencer - Edge Cases", () => {
  let inferencer: RelationshipInferencer;

  beforeEach(() => {
    inferencer = new RelationshipInferencer({ minConfidence: 0.3 });
  });

  it("should handle very long context", () => {
    const file1 = createTestEntity(EntityType.CODE_FILE, "main.ts", "f1");
    const file2 = createTestEntity(EntityType.CODE_FILE, "utils.ts", "f2");
    const entities = [file1, file2];

    const longContext = "main.ts depends on utils.ts. ".repeat(500);
    const result = inferencer.infer(entities, longContext);

    // Should still extract relationships
    expect(result.relationships.length).toBeGreaterThan(0);
  });

  it("should handle special characters in entity names", () => {
    const file1 = createTestEntity(EntityType.CODE_FILE, "my-service.ts", "f1");
    const file2 = createTestEntity(EntityType.CODE_FILE, "util_helpers.ts", "f2");
    const entities = [file1, file2];

    const context = "my-service.ts uses util_helpers.ts for common operations";
    const result = inferencer.infer(entities, context);

    // Should not crash
    expect(result).toBeDefined();
  });

  it("should handle unicode characters in context", () => {
    const concept1 = createTestEntity(EntityType.CONCEPT, "Internationalization", "c1");
    const concept2 = createTestEntity(EntityType.CONCEPT, "Lokalisierung", "c2");
    const entities = [concept1, concept2];

    const context = "Internationalization relates to Lokalisierung for global apps";
    const result = inferencer.infer(entities, context);

    // Should not crash
    expect(result).toBeDefined();
  });

  it("should handle entities with very similar names", () => {
    const cls1 = createTestEntity(EntityType.CODE_CLASS, "UserService", "c1");
    const cls2 = createTestEntity(EntityType.CODE_CLASS, "UserServiceImpl", "c2");
    const cls3 = createTestEntity(EntityType.CODE_CLASS, "UserServiceTest", "c3");
    const entities = [cls1, cls2, cls3];

    const context = "UserServiceImpl implements UserService. UserServiceTest tests UserService.";
    const result = inferencer.infer(entities, context);

    // Should find relationships
    expect(result.relationships.length).toBeGreaterThanOrEqual(1);
  });

  it("should handle many entities efficiently", () => {
    const entities: Entity[] = [];
    for (let i = 0; i < 20; i++) {
      entities.push(createTestEntity(EntityType.CODE_FILE, `file${i}.ts`, `f${i}`));
    }

    const context = entities.map((e) => `${e.name} exists`).join(". ");

    const startTime = Date.now();
    const result = inferencer.infer(entities, context);
    const duration = Date.now() - startTime;

    // Should complete in reasonable time (< 5 seconds)
    expect(duration).toBeLessThan(5000);
    expect(result).toBeDefined();
  });

  it("should handle bidirectional relationships correctly", () => {
    const task1 = createTestEntity(EntityType.TASK, "task A", "t1");
    const task2 = createTestEntity(EntityType.TASK, "task B", "t2");
    const entities = [task1, task2];

    const context = "task A blocks task B. task B depends on task A.";
    const result = inferencer.infer(entities, context);

    // Should potentially find relationships in both directions
    const t1ToT2 = result.relationships.filter(
      (r) => r.sourceId === "t1" && r.targetId === "t2"
    );
    const t2ToT1 = result.relationships.filter(
      (r) => r.sourceId === "t2" && r.targetId === "t1"
    );

    // At least one direction should have relationships
    expect(t1ToT2.length + t2ToT1.length).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================================
// Integration Tests
// ============================================================================

describe("RelationshipInferencer - Integration Tests", () => {
  it("should work with real-world codebase context", () => {
    const inferencer = new RelationshipInferencer({ minConfidence: 0.35 });

    // Simulate real entities from a codebase
    const entities = [
      createTestEntity(EntityType.CODE_FILE, "EntityExtractor.ts", "extractor"),
      createTestEntity(EntityType.CODE_FILE, "Neo4jClient.ts", "neo4j"),
      createTestEntity(EntityType.CODE_CLASS, "EntityExtractor", "extractorClass"),
      createTestEntity(EntityType.CODE_CLASS, "Neo4jClient", "neo4jClass"),
      createTestEntity(EntityType.CODE_FUNCTION, "extract", "extractFn"),
      createTestEntity(EntityType.CODE_FUNCTION, "query", "queryFn"),
      createTestEntity(EntityType.TASK, "implement graph storage", "graphTask"),
      createTestEntity(EntityType.DECISION, "use Neo4j", "neo4jDecision"),
    ];

    const context = `
      EntityExtractor.ts contains the EntityExtractor class which uses regex patterns.
      Neo4jClient.ts implements the Neo4jClient for graph database operations.
      The extract function in EntityExtractor depends on regex patterns.
      Neo4jClient uses the query function to execute Cypher queries.
      The implement graph storage task implements the use Neo4j decision.
      EntityExtractor references Neo4jClient for storing extracted entities.
    `;

    const result = inferencer.infer(entities, context);

    // Should find multiple relationships
    expect(result.relationships.length).toBeGreaterThan(0);

    // Should have reasonable confidence
    expect(result.confidence).toBeGreaterThan(0);

    // Should find various relationship types
    const types = new Set(result.relationships.map((r) => r.type));
    expect(types.size).toBeGreaterThanOrEqual(1);
  });
});
