/**
 * Tests for context_save with entity extraction feature
 *
 * Tests the enhanced context_save tool that can optionally extract
 * entities from memory values and store them in the knowledge graph.
 *
 * @module mcp/__tests__/save-with-entities.test
 */

import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { PingMemServer, PingMemServerConfig } from "../PingMemServer.js";
import { EntityExtractor } from "../../graph/EntityExtractor.js";
import type { GraphManager } from "../../graph/GraphManager.js";
import type { Entity } from "../../types/graph.js";
import { EntityType } from "../../types/graph.js";

// Mock GraphManager for testing
function createMockGraphManager(): GraphManager & {
  batchCreateEntities: jest.MockedFunction<GraphManager["batchCreateEntities"]>;
} {
  const mockBatchCreate = jest.fn<GraphManager["batchCreateEntities"]>();

  return {
    createEntity: jest.fn(),
    getEntity: jest.fn(),
    updateEntity: jest.fn(),
    deleteEntity: jest.fn(),
    createRelationship: jest.fn(),
    getRelationship: jest.fn(),
    deleteRelationship: jest.fn(),
    findEntitiesByType: jest.fn(),
    findRelationshipsByEntity: jest.fn(),
    mergeEntity: jest.fn(),
    batchCreateEntities: mockBatchCreate,
  } as unknown as GraphManager & {
    batchCreateEntities: jest.MockedFunction<GraphManager["batchCreateEntities"]>;
  };
}

describe("context_save with entity extraction", () => {
  let server: PingMemServer;
  let mockGraphManager: ReturnType<typeof createMockGraphManager>;

  // Helper to call tool handlers through the server
  async function callTool(
    server: PingMemServer,
    name: string,
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    // Access private handleToolCall method via type assertion
    const serverAny = server as unknown as {
      handleToolCall: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
    return serverAny.handleToolCall(name, args);
  }

  describe("without graphManager configured", () => {
    beforeEach(() => {
      server = new PingMemServer({
        dbPath: ":memory:",
        enableVectorSearch: false,
      });
    });

    afterEach(async () => {
      await server.close();
    });

    it("should save memory without extractEntities parameter (extraction is default-on)", async () => {
      // Start a session first
      await callTool(server, "context_session_start", { name: "test-session" });

      const result = await callTool(server, "context_save", {
        key: "test-key",
        value: "Dr. Smith created the UserService class for authentication.",
      });

      expect(result.success).toBe(true);
      expect(result.memoryId).toBeDefined();
      expect(result.key).toBe("test-key");
      // entityIds should be empty array — extraction attempted but no graphManager
      expect(result.entityIds).toEqual([]);
    });

    it("should save memory with extractEntities: false (no extraction)", async () => {
      await callTool(server, "context_session_start", { name: "test-session" });

      const result = await callTool(server, "context_save", {
        key: "test-key",
        value: "Dr. Smith created the UserService class.",
        extractEntities: false,
      });

      expect(result.success).toBe(true);
      expect(result.memoryId).toBeDefined();
      // entityIds should NOT be present when extractEntities is false
      expect(result.entityIds).toBeUndefined();
    });

    it("should return empty entityIds when extractEntities: true but no graphManager", async () => {
      await callTool(server, "context_session_start", { name: "test-session" });

      const result = await callTool(server, "context_save", {
        key: "test-key",
        value: "Dr. Smith created the UserService class.",
        extractEntities: true,
      });

      expect(result.success).toBe(true);
      expect(result.memoryId).toBeDefined();
      // entityIds should be empty array when requested but no graphManager
      expect(result.entityIds).toEqual([]);
    });
  });

  describe("with graphManager configured", () => {
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

    it("should extract entities and store them when extractEntities: true", async () => {
      const now = new Date();
      const mockEntities: Entity[] = [
        {
          id: "entity-1",
          type: EntityType.PERSON,
          name: "Dr. Smith",
          properties: { confidence: 0.8 },
          createdAt: now,
          updatedAt: now,
          eventTime: now,
          ingestionTime: now,
        },
        {
          id: "entity-2",
          type: EntityType.CODE_CLASS,
          name: "UserService",
          properties: { confidence: 0.85 },
          createdAt: now,
          updatedAt: now,
          eventTime: now,
          ingestionTime: now,
        },
      ];

      mockGraphManager.batchCreateEntities.mockResolvedValue(mockEntities);

      await callTool(server, "context_session_start", { name: "test-session" });

      const result = await callTool(server, "context_save", {
        key: "test-key",
        value: "Dr. Smith created the UserService class for authentication.",
        extractEntities: true,
      });

      expect(result.success).toBe(true);
      expect(result.memoryId).toBeDefined();
      expect(result.entityIds).toEqual(["entity-1", "entity-2"]);

      // Verify batchCreateEntities was called with extracted entities
      expect(mockGraphManager.batchCreateEntities).toHaveBeenCalledTimes(1);
      const calledEntities = mockGraphManager.batchCreateEntities.mock.calls[0]?.[0];
      expect(calledEntities).toBeDefined();
      expect(calledEntities?.length).toBeGreaterThan(0);
    });

    it("should return empty entityIds when no entities extracted", async () => {
      // Value with no extractable entities (must pass JunkFilter — 10+ chars, not filler)
      mockGraphManager.batchCreateEntities.mockResolvedValue([]);

      await callTool(server, "context_session_start", { name: "test-session" });

      const result = await callTool(server, "context_save", {
        key: "test-key",
        value: "The system performed a routine maintenance check yesterday afternoon.",
        extractEntities: true,
      });

      expect(result.success).toBe(true);
      expect(result.entityIds).toEqual([]);
      // batchCreateEntities should NOT be called when no entities extracted
      expect(mockGraphManager.batchCreateEntities).not.toHaveBeenCalled();
    });

    it("should use category for extraction prioritization", async () => {
      const now = new Date();
      const mockEntities: Entity[] = [
        {
          id: "entity-error-1",
          type: EntityType.ERROR,
          name: "ConnectionTimeout",
          properties: { confidence: 0.9 },
          createdAt: now,
          updatedAt: now,
          eventTime: now,
          ingestionTime: now,
        },
      ];

      mockGraphManager.batchCreateEntities.mockResolvedValue(mockEntities);

      await callTool(server, "context_session_start", { name: "test-session" });

      const result = await callTool(server, "context_save", {
        key: "error-log",
        value: "Error: ConnectionTimeout failed to connect to database.",
        category: "error",
        extractEntities: true,
      });

      expect(result.success).toBe(true);
      expect(result.entityIds).toEqual(["entity-error-1"]);
    });

    it("should not call graphManager when extractEntities is false", async () => {
      await callTool(server, "context_session_start", { name: "test-session" });

      const result = await callTool(server, "context_save", {
        key: "test-key",
        value: "Dr. Smith created the UserService class.",
        extractEntities: false,
      });

      expect(result.success).toBe(true);
      expect(result.entityIds).toBeUndefined();
      expect(mockGraphManager.batchCreateEntities).not.toHaveBeenCalled();
    });

    it("should fall back to regex extraction when graph write fails after LLM extraction", async () => {
      // Simulate: LLM extraction succeeds but batchCreateEntities throws (Neo4j down)
      // The regex fallback should then trigger with its own batchCreateEntities call
      const mockLlmExtractor = {
        extract: jest.fn().mockResolvedValue({
          entities: [{ type: "PERSON", name: "AuthUser", properties: { confidence: 0.9 } }],
          relationships: [],
        }),
      };

      const localMockGm = createMockGraphManager();
      let callCount = 0;
      localMockGm.batchCreateEntities.mockImplementation(async (entities) => {
        callCount++;
        if (callCount === 1) {
          throw new Error("Neo4j connection refused");
        }
          const now = new Date();
          return entities.map((e, i) => ({
            ...e,
            id: `regex-fallback-${i}`,
            createdAt: now,
            updatedAt: now,
          }));
        });

      const serverWithFallback = new PingMemServer({
        dbPath: ":memory:",
        enableVectorSearch: false,
        graphManager: localMockGm,
        entityExtractor: new EntityExtractor({ minConfidence: 0.3 }),
        llmEntityExtractor: mockLlmExtractor as never,
      });

      const callToolLocal = async (name: string, args: Record<string, unknown>) => {
        const s = serverWithFallback as unknown as {
          handleToolCall: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
        };
        return s.handleToolCall(name, args);
      };

      await callToolLocal("context_session_start", { name: "fallback-session" });

      const result = await callToolLocal("context_save", {
        key: "fallback-test",
        // category "decision" triggers LLM extraction path (shouldUseLlmExtraction returns true)
        category: "decision",
        value: "class AuthService handles user authentication with JWT tokens.",
        extractEntities: true,
      });

      expect(result.success).toBe(true);
      // LLM extract was called
      expect(mockLlmExtractor.extract).toHaveBeenCalledTimes(1);
      // batchCreateEntities called twice: first fails (LLM graph write), second succeeds (regex fallback)
      expect(localMockGm.batchCreateEntities).toHaveBeenCalledTimes(2);
      // entityIds should come from the regex fallback path
      expect(Array.isArray(result.entityIds)).toBe(true);
      expect((result.entityIds as string[]).length).toBeGreaterThan(0);
      expect((result.entityIds as string[])[0]).toMatch(/^regex-fallback-/);

      await serverWithFallback.close();
    });

    it("should extract entities by default when extractEntities not specified", async () => {
      const now = new Date();
      mockGraphManager.batchCreateEntities.mockImplementation(async (entities) => {
        return entities.map((e, i) => ({
          ...e,
          id: `default-extract-${i}`,
          createdAt: now,
          updatedAt: now,
        }));
      });

      await callTool(server, "context_session_start", { name: "test-session" });

      const result = await callTool(server, "context_save", {
        key: "test-key",
        value: "Dr. Smith created the UserService class.",
      });

      expect(result.success).toBe(true);
      // Extraction is now default-on (issue #54) — entityIds should be present
      expect(Array.isArray(result.entityIds)).toBe(true);
      expect(mockGraphManager.batchCreateEntities).toHaveBeenCalled();
    });
  });

  describe("with custom entityExtractor", () => {
    let customExtractor: EntityExtractor;

    beforeEach(() => {
      mockGraphManager = createMockGraphManager();
      // Use lower minConfidence to ensure entities pass through
      customExtractor = new EntityExtractor({ minConfidence: 0.3 });

      server = new PingMemServer({
        dbPath: ":memory:",
        enableVectorSearch: false,
        graphManager: mockGraphManager,
        entityExtractor: customExtractor,
      });
    });

    afterEach(async () => {
      await server.close();
    });

    it("should use custom entityExtractor when provided", async () => {
      const now = new Date();

      // Mock returns what was passed in, with generated IDs
      mockGraphManager.batchCreateEntities.mockImplementation(async (entities) => {
        return entities.map((e, i) => ({
          ...e,
          id: `custom-entity-${i}`,
          createdAt: now,
          updatedAt: now,
        }));
      });

      await callTool(server, "context_session_start", { name: "test-session" });

      const result = await callTool(server, "context_save", {
        key: "code-review",
        value: "class AuthService handles user authentication with JWT tokens.",
        extractEntities: true,
      });

      expect(result.success).toBe(true);
      // Should have extracted at least one entity (AuthService class)
      expect(Array.isArray(result.entityIds)).toBe(true);
      expect((result.entityIds as string[]).length).toBeGreaterThan(0);

      // Verify custom extractor was used (batchCreateEntities was called)
      expect(mockGraphManager.batchCreateEntities).toHaveBeenCalled();
    });
  });
});

describe("Entity extraction integration", () => {
  let server: PingMemServer;
  let mockGraphManager: ReturnType<typeof createMockGraphManager>;

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

  it("should extract code-related entities from technical content", async () => {
    const now = new Date();
    mockGraphManager.batchCreateEntities.mockImplementation(async (entities) => {
      return entities.map((e, i) => ({
        ...e,
        id: `generated-${i}`,
        createdAt: now,
        updatedAt: now,
      }));
    });

    await callTool(server, "context_session_start", { name: "code-session" });

    const result = await callTool(server, "context_save", {
      key: "implementation-note",
      value: "Implemented useAuthContext hook in src/hooks/useAuth.ts that calls the AuthService.authenticate() method.",
      category: "progress",
      extractEntities: true,
    });

    expect(result.success).toBe(true);
    expect(Array.isArray(result.entityIds)).toBe(true);
    expect((result.entityIds as string[]).length).toBeGreaterThan(0);

    // Verify entities were passed to graphManager
    expect(mockGraphManager.batchCreateEntities).toHaveBeenCalled();
    const passedEntities = mockGraphManager.batchCreateEntities.mock.calls[0]?.[0];
    expect(passedEntities).toBeDefined();

    // Should have extracted at least one code-related entity
    const entityTypes = passedEntities?.map((e) => e.type) ?? [];
    const hasCodeEntity = entityTypes.some(
      (t) => t === EntityType.CODE_FILE || t === EntityType.CODE_FUNCTION || t === EntityType.CODE_CLASS
    );
    expect(hasCodeEntity).toBe(true);
  });

  it("should extract person and organization entities", async () => {
    const now = new Date();
    mockGraphManager.batchCreateEntities.mockImplementation(async (entities) => {
      return entities.map((e, i) => ({
        ...e,
        id: `person-org-${i}`,
        createdAt: now,
        updatedAt: now,
      }));
    });

    await callTool(server, "context_session_start", { name: "people-session" });

    const result = await callTool(server, "context_save", {
      key: "meeting-notes",
      value: "Dr. Johnson from Microsoft presented the new authentication architecture.",
      extractEntities: true,
    });

    expect(result.success).toBe(true);
    expect(Array.isArray(result.entityIds)).toBe(true);

    const passedEntities = mockGraphManager.batchCreateEntities.mock.calls[0]?.[0] ?? [];
    const entityTypes = passedEntities.map((e) => e.type);

    // Should have extracted organization entity (Microsoft)
    expect(entityTypes).toContain(EntityType.ORGANIZATION);
  });
});
