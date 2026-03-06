/**
 * Tests for LLMEntityExtractor
 *
 * @module graph/__tests__/LLMEntityExtractor.test
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";
import { LLMEntityExtractor } from "../LLMEntityExtractor.js";
import { EntityType, RelationshipType } from "../../types/graph.js";
import type { Entity, EntityExtractResult } from "../../types/graph.js";
import type { EntityExtractor } from "../EntityExtractor.js";

// ============================================================================
// Mock Helpers
// ============================================================================

function createMockOpenAI(response: {
  entities: Array<{ name: string; type: string; confidence: number; context: string }>;
  relationships: Array<{ source: string; target: string; type: string; confidence: number; evidence: string }>;
}) {
  return {
    chat: {
      completions: {
        create: mock(async () => ({
          choices: [{
            message: {
              content: JSON.stringify(response),
            },
          }],
        })),
      },
    },
  };
}

function createFailingOpenAI() {
  return {
    chat: {
      completions: {
        create: mock(async () => {
          throw new Error("API down");
        }),
      },
    },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("LLMEntityExtractor", () => {
  const standardResponse = {
    entities: [
      { name: "AuthService", type: "CODE_CLASS", confidence: 0.95, context: "handles authentication" },
      { name: "TokenExpiry", type: "ERROR", confidence: 0.85, context: "token expiration bug" },
    ],
    relationships: [
      { source: "AuthService", target: "TokenExpiry", type: "CAUSES", confidence: 0.8, evidence: "auth service token handling" },
    ],
  };

  describe("LLM extraction", () => {
    it("should extract entities from text using LLM", async () => {
      const mockOpenAI = createMockOpenAI(standardResponse);
      const extractor = new LLMEntityExtractor({ openai: mockOpenAI });
      const result = await extractor.extract("The AuthService causes TokenExpiry errors in production");

      expect(result.entities.length).toBe(2);
      expect(result.entities[0]!.name).toBe("AuthService");
      expect(result.entities[0]!.type).toBe(EntityType.CODE_CLASS);
      expect(result.entities[1]!.name).toBe("TokenExpiry");
      expect(result.entities[1]!.type).toBe(EntityType.ERROR);
    });

    it("should extract relationships from text using LLM", async () => {
      const mockOpenAI = createMockOpenAI(standardResponse);
      const extractor = new LLMEntityExtractor({ openai: mockOpenAI });
      const result = await extractor.extract("The AuthService causes TokenExpiry errors");

      expect(result.relationships.length).toBe(1);
      expect(result.relationships[0]!.type).toBe(RelationshipType.CAUSES);
    });

    it("should map entity source/target IDs in relationships", async () => {
      const mockOpenAI = createMockOpenAI(standardResponse);
      const extractor = new LLMEntityExtractor({ openai: mockOpenAI });
      const result = await extractor.extract("The AuthService causes TokenExpiry errors");

      const authEntity = result.entities.find(e => e.name === "AuthService");
      const tokenEntity = result.entities.find(e => e.name === "TokenExpiry");
      expect(authEntity).toBeDefined();
      expect(tokenEntity).toBeDefined();

      // sourceId/targetId should be the generated entity IDs, not raw names
      expect(result.relationships[0]!.sourceId).toBe(authEntity!.id);
      expect(result.relationships[0]!.targetId).toBe(tokenEntity!.id);
    });

    it("should calculate average confidence from entities", async () => {
      const mockOpenAI = createMockOpenAI(standardResponse);
      const extractor = new LLMEntityExtractor({ openai: mockOpenAI });
      const result = await extractor.extract("text");

      // Average of 0.95 and 0.85 = 0.9
      expect(result.confidence).toBeCloseTo(0.9, 10);
    });

    it("should filter out low-confidence entities (below 0.7)", async () => {
      const mockOpenAI = createMockOpenAI({
        entities: [
          { name: "StrongEntity", type: "CONCEPT", confidence: 0.9, context: "clear" },
          { name: "WeakEntity", type: "CONCEPT", confidence: 0.3, context: "unclear" },
        ],
        relationships: [],
      });
      const extractor = new LLMEntityExtractor({ openai: mockOpenAI });
      const result = await extractor.extract("text");

      expect(result.entities.length).toBe(1);
      expect(result.entities[0]!.name).toBe("StrongEntity");
    });

    it("should filter out low-confidence relationships (below 0.5)", async () => {
      const mockOpenAI = createMockOpenAI({
        entities: [
          { name: "A", type: "CONCEPT", confidence: 0.9, context: "a" },
          { name: "B", type: "CONCEPT", confidence: 0.9, context: "b" },
        ],
        relationships: [
          { source: "A", target: "B", type: "RELATED_TO", confidence: 0.3, evidence: "weak" },
        ],
      });
      const extractor = new LLMEntityExtractor({ openai: mockOpenAI });
      const result = await extractor.extract("text");

      expect(result.relationships.length).toBe(0);
    });

    it("should default unknown entity types to CONCEPT", async () => {
      const mockOpenAI = createMockOpenAI({
        entities: [
          { name: "Unknown", type: "UNKNOWN_TYPE", confidence: 0.9, context: "test" },
        ],
        relationships: [],
      });
      const extractor = new LLMEntityExtractor({ openai: mockOpenAI });
      const result = await extractor.extract("text");

      expect(result.entities[0]!.type).toBe(EntityType.CONCEPT);
    });

    it("should default unknown relationship types to RELATED_TO", async () => {
      const mockOpenAI = createMockOpenAI({
        entities: [
          { name: "A", type: "CONCEPT", confidence: 0.9, context: "a" },
          { name: "B", type: "CONCEPT", confidence: 0.9, context: "b" },
        ],
        relationships: [
          { source: "A", target: "B", type: "INVENTED_TYPE", confidence: 0.8, evidence: "test" },
        ],
      });
      const extractor = new LLMEntityExtractor({ openai: mockOpenAI });
      const result = await extractor.extract("text");

      expect(result.relationships[0]!.type).toBe(RelationshipType.RELATED_TO);
    });

    it("should use the specified model", async () => {
      const mockOpenAI = createMockOpenAI({ entities: [], relationships: [] });
      const extractor = new LLMEntityExtractor({ openai: mockOpenAI, model: "gpt-4o" });
      await extractor.extract("text");

      expect(mockOpenAI.chat.completions.create).toHaveBeenCalledTimes(1);
      const callArg = (mockOpenAI.chat.completions.create as ReturnType<typeof mock>).mock.calls[0]![0] as Record<string, unknown>;
      expect(callArg["model"]).toBe("gpt-4o");
    });

    it("should default to gpt-4o-mini model", async () => {
      const mockOpenAI = createMockOpenAI({ entities: [], relationships: [] });
      const extractor = new LLMEntityExtractor({ openai: mockOpenAI });
      await extractor.extract("text");

      const callArg = (mockOpenAI.chat.completions.create as ReturnType<typeof mock>).mock.calls[0]![0] as Record<string, unknown>;
      expect(callArg["model"]).toBe("gpt-4o-mini");
    });

    it("should handle empty LLM response content", async () => {
      const mockOpenAI = {
        chat: {
          completions: {
            create: mock(async () => ({
              choices: [{ message: { content: null } }],
            })),
          },
        },
      };
      const extractor = new LLMEntityExtractor({ openai: mockOpenAI });
      const result = await extractor.extract("text");

      expect(result.entities.length).toBe(0);
      expect(result.relationships.length).toBe(0);
      expect(result.confidence).toBe(0);
    });

    it("should handle malformed JSON from LLM", async () => {
      const mockOpenAI = {
        chat: {
          completions: {
            create: mock(async () => ({
              choices: [{ message: { content: "not valid json" } }],
            })),
          },
        },
      };
      const extractor = new LLMEntityExtractor({ openai: mockOpenAI });
      const result = await extractor.extract("text");

      expect(result.entities.length).toBe(0);
      expect(result.relationships.length).toBe(0);
    });
  });

  describe("fallback behavior", () => {
    it("should fall back to fallback extractor on LLM failure", async () => {
      const failingOpenAI = createFailingOpenAI();
      const now = new Date();
      const fallbackEntity: Entity = {
        id: "e1",
        name: "fallback",
        type: EntityType.CONCEPT,
        properties: {},
        createdAt: now,
        updatedAt: now,
        eventTime: now,
        ingestionTime: now,
      };
      const fallbackExtractor = {
        extract: mock((_text: string): EntityExtractResult => ({
          entities: [fallbackEntity],
          confidence: 0.5,
        })),
        extractFromContext: mock(() => ({ entities: [], confidence: 0 })),
      } as unknown as EntityExtractor;

      const extractor = new LLMEntityExtractor({
        openai: failingOpenAI,
        fallbackExtractor,
      });

      const result = await extractor.extract("some text");
      expect(result.entities.length).toBeGreaterThan(0);
      expect(result.entities[0]!.name).toBe("fallback");
      expect(result.relationships.length).toBe(0);
    });

    it("should return empty result on LLM failure with no fallback", async () => {
      const failingOpenAI = createFailingOpenAI();
      const extractor = new LLMEntityExtractor({ openai: failingOpenAI });

      const result = await extractor.extract("some text");
      expect(result.entities.length).toBe(0);
      expect(result.relationships.length).toBe(0);
      expect(result.confidence).toBe(0);
    });

    it("should return empty relationships even when fallback provides entities", async () => {
      const failingOpenAI = createFailingOpenAI();
      const now = new Date();
      const fallbackExtractor = {
        extract: mock((_text: string): EntityExtractResult => ({
          entities: [
            { id: "e1", name: "entity1", type: EntityType.CONCEPT, properties: {}, createdAt: now, updatedAt: now, eventTime: now, ingestionTime: now },
            { id: "e2", name: "entity2", type: EntityType.CONCEPT, properties: {}, createdAt: now, updatedAt: now, eventTime: now, ingestionTime: now },
          ],
          confidence: 0.6,
        })),
        extractFromContext: mock(() => ({ entities: [], confidence: 0 })),
      } as unknown as EntityExtractor;

      const extractor = new LLMEntityExtractor({
        openai: failingOpenAI,
        fallbackExtractor,
      });

      const result = await extractor.extract("text about entities");
      expect(result.entities.length).toBe(2);
      expect(result.relationships.length).toBe(0);
      expect(result.confidence).toBe(0.6);
    });
  });

  describe("entity properties", () => {
    it("should populate entity timestamps", async () => {
      const mockOpenAI = createMockOpenAI(standardResponse);
      const extractor = new LLMEntityExtractor({ openai: mockOpenAI });
      const result = await extractor.extract("text");

      for (const entity of result.entities) {
        expect(entity.createdAt).toBeInstanceOf(Date);
        expect(entity.updatedAt).toBeInstanceOf(Date);
        expect(entity.eventTime).toBeInstanceOf(Date);
        expect(entity.ingestionTime).toBeInstanceOf(Date);
      }
    });

    it("should store context and confidence in entity properties", async () => {
      const mockOpenAI = createMockOpenAI(standardResponse);
      const extractor = new LLMEntityExtractor({ openai: mockOpenAI });
      const result = await extractor.extract("text");

      expect(result.entities[0]!.properties["context"]).toBe("handles authentication");
      expect(result.entities[0]!.properties["confidence"]).toBe(0.95);
    });

    it("should populate relationship weight from confidence", async () => {
      const mockOpenAI = createMockOpenAI(standardResponse);
      const extractor = new LLMEntityExtractor({ openai: mockOpenAI });
      const result = await extractor.extract("text");

      expect(result.relationships[0]!.weight).toBe(0.8);
    });

    it("should generate unique IDs for each entity", async () => {
      const mockOpenAI = createMockOpenAI(standardResponse);
      const extractor = new LLMEntityExtractor({ openai: mockOpenAI });
      const result = await extractor.extract("text");

      const ids = result.entities.map(e => e.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });
  });
});
