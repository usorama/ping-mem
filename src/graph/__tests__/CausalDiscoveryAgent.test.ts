/**
 * Tests for CausalDiscoveryAgent
 *
 * @module graph/__tests__/CausalDiscoveryAgent.test
 */

import { describe, it, expect, mock } from "bun:test";
import { CausalDiscoveryAgent } from "../CausalDiscoveryAgent.js";
import type { CausalGraphManager } from "../CausalGraphManager.js";
import type { GraphManager } from "../GraphManager.js";

// ============================================================================
// Mock Helpers
// ============================================================================

function createMockOpenAI(response: {
  causal_links: Array<{
    cause: string;
    effect: string;
    confidence: number;
    evidence: string;
  }>;
}) {
  return {
    chat: {
      completions: {
        create: mock(async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify(response),
              },
            },
          ],
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
          throw new Error("LLM API failure");
        }),
      },
    },
  };
}

function createMalformedOpenAI(content: string) {
  return {
    chat: {
      completions: {
        create: mock(async () => ({
          choices: [
            {
              message: {
                content,
              },
            },
          ],
        })),
      },
    },
  };
}

function createNullContentOpenAI() {
  return {
    chat: {
      completions: {
        create: mock(async () => ({
          choices: [
            {
              message: {
                content: null,
              },
            },
          ],
        })),
      },
    },
  };
}

function createMockCausalGraphManager(): Record<string, unknown> {
  return {
    addCausalLink: mock(() => Promise.resolve(null)),
    getCausesOf: mock(() => Promise.resolve([])),
    getEffectsOf: mock(() => Promise.resolve([])),
    getCausalChain: mock(() => Promise.resolve([])),
  };
}

function createMockGraphManager(): Record<string, unknown> {
  return {
    createEntity: mock(() => Promise.resolve(null)),
    getEntity: mock(() => Promise.resolve(null)),
    findRelationshipsByEntity: mock(() => Promise.resolve([])),
    createRelationship: mock(() => Promise.resolve(null)),
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("CausalDiscoveryAgent", () => {
  const standardResponse = {
    causal_links: [
      {
        cause: "database migration",
        effect: "auth service failure",
        confidence: 0.95,
        evidence: "Migration altered the users table schema",
      },
      {
        cause: "auth service failure",
        effect: "user login errors",
        confidence: 0.9,
        evidence: "Auth service is a dependency of login flow",
      },
      {
        cause: "network latency",
        effect: "timeout errors",
        confidence: 0.5,
        evidence: "Possible but not confirmed",
      },
    ],
  };

  // ==========================================================================
  // discover
  // ==========================================================================

  describe("discover", () => {
    it("should extract causal links from text", async () => {
      const mockOpenAI = createMockOpenAI(standardResponse);
      const agent = new CausalDiscoveryAgent({
        openai: mockOpenAI,
        causalGraphManager:
          createMockCausalGraphManager() as unknown as CausalGraphManager,
        graphManager: createMockGraphManager() as unknown as GraphManager,
      });

      const results = await agent.discover(
        "The database migration caused the auth service to fail, leading to user login errors.",
      );

      // Only links >= 0.7 confidence (default threshold)
      expect(results).toHaveLength(2);
      expect(results[0]!.causeName).toBe("database migration");
      expect(results[0]!.effectName).toBe("auth service failure");
      expect(results[0]!.confidence).toBe(0.95);
      expect(results[0]!.evidence).toBe(
        "Migration altered the users table schema",
      );
      expect(results[1]!.causeName).toBe("auth service failure");
      expect(results[1]!.effectName).toBe("user login errors");
    });

    it("should filter by custom confidence threshold", async () => {
      const mockOpenAI = createMockOpenAI(standardResponse);
      const agent = new CausalDiscoveryAgent({
        openai: mockOpenAI,
        causalGraphManager:
          createMockCausalGraphManager() as unknown as CausalGraphManager,
        graphManager: createMockGraphManager() as unknown as GraphManager,
        confidenceThreshold: 0.92,
      });

      const results = await agent.discover("Some causal text");

      // Only links >= 0.92 (just the 0.95 one)
      expect(results).toHaveLength(1);
      expect(results[0]!.confidence).toBe(0.95);
    });

    it("should handle LLM failure gracefully and return empty", async () => {
      const mockOpenAI = createFailingOpenAI();
      const agent = new CausalDiscoveryAgent({
        openai: mockOpenAI,
        causalGraphManager:
          createMockCausalGraphManager() as unknown as CausalGraphManager,
        graphManager: createMockGraphManager() as unknown as GraphManager,
      });

      const results = await agent.discover("Some text");

      expect(results).toHaveLength(0);
    });

    it("should handle malformed JSON gracefully and return empty", async () => {
      const mockOpenAI = createMalformedOpenAI("not valid json {{{");
      const agent = new CausalDiscoveryAgent({
        openai: mockOpenAI,
        causalGraphManager:
          createMockCausalGraphManager() as unknown as CausalGraphManager,
        graphManager: createMockGraphManager() as unknown as GraphManager,
      });

      const results = await agent.discover("Some text");

      expect(results).toHaveLength(0);
    });

    it("should handle null content from LLM", async () => {
      const mockOpenAI = createNullContentOpenAI();
      const agent = new CausalDiscoveryAgent({
        openai: mockOpenAI,
        causalGraphManager:
          createMockCausalGraphManager() as unknown as CausalGraphManager,
        graphManager: createMockGraphManager() as unknown as GraphManager,
      });

      const results = await agent.discover("Some text");

      expect(results).toHaveLength(0);
    });

    it("should handle JSON missing causal_links field", async () => {
      const mockOpenAI = createMalformedOpenAI(
        JSON.stringify({ other_field: "value" }),
      );
      const agent = new CausalDiscoveryAgent({
        openai: mockOpenAI,
        causalGraphManager:
          createMockCausalGraphManager() as unknown as CausalGraphManager,
        graphManager: createMockGraphManager() as unknown as GraphManager,
      });

      const results = await agent.discover("Some text");

      expect(results).toHaveLength(0);
    });

    it("should use default model gpt-4o-mini", async () => {
      const mockOpenAI = createMockOpenAI({ causal_links: [] });
      const agent = new CausalDiscoveryAgent({
        openai: mockOpenAI,
        causalGraphManager:
          createMockCausalGraphManager() as unknown as CausalGraphManager,
        graphManager: createMockGraphManager() as unknown as GraphManager,
      });

      await agent.discover("test text");

      const callArg = (mockOpenAI.chat.completions.create as ReturnType<typeof mock>)
        .mock.calls[0]![0] as Record<string, unknown>;
      expect(callArg.model).toBe("gpt-4o-mini");
    });
  });

  // ==========================================================================
  // discoverCount
  // ==========================================================================

  describe("discoverCount", () => {
    it("should return count of discovered links", async () => {
      const mockOpenAI = createMockOpenAI(standardResponse);
      const agent = new CausalDiscoveryAgent({
        openai: mockOpenAI,
        causalGraphManager:
          createMockCausalGraphManager() as unknown as CausalGraphManager,
        graphManager: createMockGraphManager() as unknown as GraphManager,
      });

      const count = await agent.discoverCount(
        "The database migration caused auth failure which led to login errors.",
      );

      // 2 links above default 0.7 threshold
      expect(count).toBe(2);
    });

    it("should return 0 when LLM fails", async () => {
      const mockOpenAI = createFailingOpenAI();
      const agent = new CausalDiscoveryAgent({
        openai: mockOpenAI,
        causalGraphManager:
          createMockCausalGraphManager() as unknown as CausalGraphManager,
        graphManager: createMockGraphManager() as unknown as GraphManager,
      });

      const count = await agent.discoverCount("Some text");

      expect(count).toBe(0);
    });
  });
});
