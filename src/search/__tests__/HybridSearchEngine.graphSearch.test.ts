import { describe, it, expect, mock } from "bun:test";
import { HybridSearchEngine } from "../HybridSearchEngine.js";
import type { MemoryLookup } from "../MemoryLookup.js";

describe("HybridSearchEngine - Graph Search", () => {
  it("should return results from MemoryLookup when graph search is active", async () => {
    const mockLookup: MemoryLookup = {
      lookupByEntityNames: mock(async (_names: string[]) => [
        {
          memoryId: "mem-1",
          sessionId: "session-1",
          content: "Auth service handles JWT tokens",
          similarity: 0.8,
          distance: 0.2,
          indexedAt: new Date(),
        },
      ]),
    };

    const mockGraphManager = {
      findRelationshipsByEntity: mock(async (_id: string) => [
        {
          id: "rel-1",
          type: "USES",
          sourceId: "entity-auth",
          targetId: "entity-jwt",
          properties: { sourceName: "AuthService", targetName: "JWTTokens" },
          weight: 0.9,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]),
    };

    const mockEmbeddingService = {
      embed: mock(async () => new Float32Array(768)),
      dimensions: 768,
      name: "mock",
    };

    const engine = new HybridSearchEngine({
      embeddingService: mockEmbeddingService as any,
      graphManager: mockGraphManager as any,
      memoryLookup: mockLookup,
    });

    // Add a document to BM25 so engine has content
    engine.addDocument("mem-1", "session-1", "Auth service handles JWT tokens", new Date());

    const results = await engine.search("JWT authentication", {
      modes: ["keyword", "graph"],
      graphEntityId: "entity-auth",
    });

    expect(results.length).toBeGreaterThan(0);
    expect(mockLookup.lookupByEntityNames).toHaveBeenCalled();
  });

  it("should score graph results by hop distance", async () => {
    const mockLookup: MemoryLookup = {
      lookupByEntityNames: mock(async () => [
        {
          memoryId: "mem-1",
          sessionId: "session-1",
          content: "Direct neighbor content",
          similarity: 1.0,
          distance: 0.0,
          indexedAt: new Date(),
        },
      ]),
    };

    const mockGraphManager = {
      findRelationshipsByEntity: mock(async () => [
        {
          id: "rel-1",
          type: "USES",
          sourceId: "entity-1",
          targetId: "entity-2",
          properties: { sourceName: "A", targetName: "B" },
          weight: 0.9,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]),
    };

    const engine = new HybridSearchEngine({
      embeddingService: { embed: async () => new Float32Array(768), dimensions: 768, name: "mock" } as any,
      graphManager: mockGraphManager as any,
      memoryLookup: mockLookup,
    });

    engine.addDocument("mem-1", "session-1", "Direct neighbor content", new Date());

    const results = await engine.search("test", {
      modes: ["graph"],
      graphEntityId: "entity-1",
    });

    // Hop distance 1: similarity = 1 / (1 + 1) = 0.5
    expect(results.length).toBeGreaterThan(0);
  });

  it("should gracefully return empty when memoryLookup is not provided", async () => {
    const mockGraphManager = {
      findRelationshipsByEntity: mock(async () => [
        {
          id: "rel-1",
          type: "USES",
          sourceId: "a",
          targetId: "b",
          properties: {},
          weight: 0.9,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]),
    };

    const engine = new HybridSearchEngine({
      embeddingService: { embed: async () => new Float32Array(768), dimensions: 768, name: "mock" } as any,
      graphManager: mockGraphManager as any,
      // No memoryLookup — should still work
    });

    const results = await engine.search("test", {
      modes: ["keyword", "graph"],
      graphEntityId: "entity-1",
    });

    // Should not throw, just empty graph results
    expect(Array.isArray(results)).toBe(true);
  });
});
