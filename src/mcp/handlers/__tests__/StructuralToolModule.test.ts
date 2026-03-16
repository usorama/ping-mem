/**
 * Tests for StructuralToolModule: MCP tool definitions and handler routing.
 */

import { describe, test, expect } from "bun:test";
import { StructuralToolModule, STRUCTURAL_TOOLS } from "../StructuralToolModule.js";

describe("StructuralToolModule", () => {
  describe("tool definitions", () => {
    test("exports exactly 3 tools", () => {
      expect(STRUCTURAL_TOOLS.length).toBe(3);
    });

    test("defines codebase_impact tool", () => {
      const tool = STRUCTURAL_TOOLS.find((t) => t.name === "codebase_impact");
      expect(tool).toBeDefined();
      expect(tool?.inputSchema.required).toContain("projectId");
      expect(tool?.inputSchema.required).toContain("filePath");
      expect(tool?.inputSchema.properties).toHaveProperty("maxDepth");
    });

    test("defines codebase_blast_radius tool", () => {
      const tool = STRUCTURAL_TOOLS.find((t) => t.name === "codebase_blast_radius");
      expect(tool).toBeDefined();
      expect(tool?.inputSchema.required).toContain("projectId");
      expect(tool?.inputSchema.required).toContain("filePath");
    });

    test("defines codebase_dependency_map tool", () => {
      const tool = STRUCTURAL_TOOLS.find((t) => t.name === "codebase_dependency_map");
      expect(tool).toBeDefined();
      expect(tool?.inputSchema.required).toContain("projectId");
      expect(tool?.inputSchema.properties).toHaveProperty("includeExternal");
    });
  });

  describe("handler routing", () => {
    test("returns undefined for unknown tool name", () => {
      // Create module with minimal mock state
      const module = new StructuralToolModule({
        currentSessionId: null,
        memoryManagers: new Map(),
        sessionManager: {} as never,
        eventStore: {} as never,
        vectorIndex: null,
        graphManager: null,
        entityExtractor: null,
        llmEntityExtractor: null,
        hybridSearchEngine: null,
        lineageEngine: null,
        evolutionEngine: null,
        ingestionService: null,
        diagnosticsStore: null,
        summaryGenerator: null,
        relevanceEngine: null,
        causalGraphManager: null,
        causalDiscoveryAgent: null,
        pubsub: null,
        knowledgeStore: null,
        qdrantClient: null,
        ccMemoryBridge: null,
      });

      const result = module.handle("unknown_tool", {});
      expect(result).toBeUndefined();
    });

    test("throws when ingestionService is not configured", async () => {
      const module = new StructuralToolModule({
        currentSessionId: null,
        memoryManagers: new Map(),
        sessionManager: {} as never,
        eventStore: {} as never,
        vectorIndex: null,
        graphManager: null,
        entityExtractor: null,
        llmEntityExtractor: null,
        hybridSearchEngine: null,
        lineageEngine: null,
        evolutionEngine: null,
        ingestionService: null,
        diagnosticsStore: null,
        summaryGenerator: null,
        relevanceEngine: null,
        causalGraphManager: null,
        causalDiscoveryAgent: null,
        pubsub: null,
        knowledgeStore: null,
        qdrantClient: null,
        ccMemoryBridge: null,
      });

      const promise = module.handle("codebase_impact", { projectId: "test", filePath: "src/index.ts" });
      expect(promise).toBeDefined();
      await expect(promise!).rejects.toThrow("IngestionService not configured");
    });
  });
});
