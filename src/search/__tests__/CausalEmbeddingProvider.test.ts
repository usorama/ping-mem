/**
 * Tests for CausalEmbeddingProvider
 *
 * Verifies causal prefix behavior and delegation to base provider.
 *
 * @module search/__tests__/CausalEmbeddingProvider.test
 */

import { describe, it, expect, mock } from "bun:test";
import { CausalEmbeddingProvider } from "../CausalEmbeddingProvider.js";
import type { EmbeddingProvider } from "../EmbeddingService.js";

// ============================================================================
// Test Utilities
// ============================================================================

function createMockBaseProvider(dimensions: number = 768): EmbeddingProvider & { embed: ReturnType<typeof mock> } {
  const embedFn = mock(async (text: string): Promise<Float32Array> => {
    // Deterministic embedding from text length
    const embedding = new Float32Array(dimensions);
    for (let i = 0; i < dimensions; i++) {
      embedding[i] = (text.charCodeAt(i % text.length) + i) / 1000;
    }
    return embedding;
  });

  return {
    embed: embedFn,
    dimensions,
    name: "mock-base",
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("CausalEmbeddingProvider", () => {
  describe("cause side (default)", () => {
    it("should prefix text with 'cause: ' before delegating to base provider", async () => {
      const baseProvider = createMockBaseProvider();
      const causalProvider = new CausalEmbeddingProvider({ baseProvider });

      await causalProvider.embed("memory leak detected");

      expect(baseProvider.embed).toHaveBeenCalledTimes(1);
      expect(baseProvider.embed).toHaveBeenCalledWith("cause: memory leak detected");
    });

    it("should have name 'causal-cause'", () => {
      const baseProvider = createMockBaseProvider();
      const causalProvider = new CausalEmbeddingProvider({ baseProvider });

      expect(causalProvider.name).toBe("causal-cause");
    });
  });

  describe("effect side", () => {
    it("should prefix text with 'effect: ' before delegating to base provider", async () => {
      const baseProvider = createMockBaseProvider();
      const causalProvider = new CausalEmbeddingProvider({
        baseProvider,
        side: "effect",
      });

      await causalProvider.embed("increased latency");

      expect(baseProvider.embed).toHaveBeenCalledTimes(1);
      expect(baseProvider.embed).toHaveBeenCalledWith("effect: increased latency");
    });

    it("should have name 'causal-effect'", () => {
      const baseProvider = createMockBaseProvider();
      const causalProvider = new CausalEmbeddingProvider({
        baseProvider,
        side: "effect",
      });

      expect(causalProvider.name).toBe("causal-effect");
    });
  });

  describe("dimensions", () => {
    it("should match base provider dimensions", () => {
      const baseProvider = createMockBaseProvider(512);
      const causalProvider = new CausalEmbeddingProvider({ baseProvider });

      expect(causalProvider.dimensions).toBe(512);
    });

    it("should match base provider dimensions for 1024", () => {
      const baseProvider = createMockBaseProvider(1024);
      const causalProvider = new CausalEmbeddingProvider({
        baseProvider,
        side: "effect",
      });

      expect(causalProvider.dimensions).toBe(1024);
    });
  });

  describe("embedding delegation", () => {
    it("should return the embedding from the base provider", async () => {
      const baseProvider = createMockBaseProvider(4);
      const causalProvider = new CausalEmbeddingProvider({ baseProvider });

      const result = await causalProvider.embed("test");

      expect(result).toBeInstanceOf(Float32Array);
      expect(result.length).toBe(4);
    });

    it("should propagate errors from the base provider", async () => {
      const baseProvider: EmbeddingProvider = {
        embed: mock(async () => {
          throw new Error("API rate limit exceeded");
        }),
        dimensions: 768,
        name: "failing-provider",
      };

      const causalProvider = new CausalEmbeddingProvider({ baseProvider });

      await expect(causalProvider.embed("test")).rejects.toThrow("API rate limit exceeded");
    });
  });
});
