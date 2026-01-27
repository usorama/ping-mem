/**
 * Tests for EmbeddingService
 *
 * Tests embedding generation and caching behavior using custom providers
 * to avoid OpenAI API calls in tests.
 *
 * @module search/__tests__/EmbeddingService.test
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  EmbeddingService,
  EmbeddingServiceError,
  EmbeddingGenerationError,
  EmbeddingConfigurationError,
  createEmbeddingService,
  type EmbeddingProvider,
} from "../EmbeddingService.js";

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Create a mock embedding provider for testing
 */
function createMockProvider(options?: {
  dimensions?: number;
  name?: string;
  embedFn?: (text: string) => Promise<Float32Array>;
}): EmbeddingProvider {
  const dimensions = options?.dimensions ?? 768;
  const name = options?.name ?? "mock-provider";

  const defaultEmbedFn = async (text: string): Promise<Float32Array> => {
    // Create a deterministic embedding based on text hash
    const embedding = new Float32Array(dimensions);
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash + text.charCodeAt(i)) & 0xffffffff;
    }
    for (let i = 0; i < dimensions; i++) {
      embedding[i] = Math.sin(hash + i) * 0.5;
    }
    return embedding;
  };

  const embedFn = options?.embedFn ?? defaultEmbedFn;

  return {
    dimensions,
    name,
    embed: vi.fn().mockImplementation(embedFn),
  };
}

/**
 * Create a failing mock provider for error testing
 */
function createFailingProvider(error: Error): EmbeddingProvider {
  return {
    dimensions: 768,
    name: "failing-provider",
    embed: vi.fn().mockRejectedValue(error),
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("EmbeddingService", () => {
  describe("Configuration", () => {
    it("should create service with custom provider", () => {
      const customProvider = createMockProvider({ dimensions: 512, name: "custom" });
      const service = createEmbeddingService({
        provider: "custom",
        customProvider,
      });

      expect(service).toBeInstanceOf(EmbeddingService);
      expect(service.providerName).toBe("custom");
      expect(service.dimensions).toBe(512);
    });

    it("should create service with default dimensions", () => {
      const customProvider = createMockProvider();
      const service = createEmbeddingService({
        provider: "custom",
        customProvider,
      });

      expect(service.dimensions).toBe(768);
    });

    it("should throw error when API key is missing for OpenAI provider", () => {
      expect(() => {
        createEmbeddingService({
          provider: "openai",
        });
      }).toThrow(EmbeddingConfigurationError);
      expect(() => {
        createEmbeddingService({
          provider: "openai",
        });
      }).toThrow(/API key is required/);
    });

    it("should throw error when custom provider is missing", () => {
      expect(() => {
        createEmbeddingService({
          provider: "custom",
        });
      }).toThrow(EmbeddingConfigurationError);
      expect(() => {
        createEmbeddingService({
          provider: "custom",
        });
      }).toThrow(/Custom provider instance is required/);
    });

    it("should throw error for unknown provider type", () => {
      expect(() => {
        createEmbeddingService({
          provider: "unknown" as "openai",
          apiKey: "test-key",
        });
      }).toThrow(EmbeddingConfigurationError);
      expect(() => {
        createEmbeddingService({
          provider: "unknown" as "openai",
          apiKey: "test-key",
        });
      }).toThrow(/Unknown provider type/);
    });

    it("should enable caching by default", () => {
      const customProvider = createMockProvider();
      const service = createEmbeddingService({
        provider: "custom",
        customProvider,
      });
      expect(service.isCacheEnabled()).toBe(true);
    });

    it("should allow disabling cache", () => {
      const customProvider = createMockProvider();
      const service = createEmbeddingService({
        provider: "custom",
        customProvider,
        cache: { enabled: false },
      });
      expect(service.isCacheEnabled()).toBe(false);
    });
  });

  describe("Embedding Generation", () => {
    it("should generate embedding for text", async () => {
      const customProvider = createMockProvider();
      const service = createEmbeddingService({
        provider: "custom",
        customProvider,
      });

      const embedding = await service.embed("Hello, world!");

      expect(embedding).toBeInstanceOf(Float32Array);
      expect(embedding.length).toBe(768);
      expect(customProvider.embed).toHaveBeenCalledWith("Hello, world!");
    });

    it("should generate embeddings with custom dimensions", async () => {
      const customProvider = createMockProvider({ dimensions: 1536 });
      const service = createEmbeddingService({
        provider: "custom",
        customProvider,
      });

      const embedding = await service.embed("Test text");

      expect(embedding.length).toBe(1536);
    });

    it("should handle batch embedding", async () => {
      const customProvider = createMockProvider();
      const service = createEmbeddingService({
        provider: "custom",
        customProvider,
      });

      const texts = ["Text one", "Text two", "Text three"];
      const embeddings = await service.embedBatch(texts);

      expect(embeddings).toHaveLength(3);
      embeddings.forEach((embedding) => {
        expect(embedding).toBeInstanceOf(Float32Array);
        expect(embedding.length).toBe(768);
      });
      expect(customProvider.embed).toHaveBeenCalledTimes(3);
    });

    it("should use custom provider for embedding", async () => {
      const customProvider = createMockProvider();
      const service = createEmbeddingService({
        provider: "custom",
        customProvider,
      });

      const embedding = await service.embed("Test text");

      expect(embedding).toBeInstanceOf(Float32Array);
      expect(embedding.length).toBe(768);
      expect(customProvider.embed).toHaveBeenCalledWith("Test text");
    });
  });

  describe("Caching Behavior", () => {
    it("should cache embeddings and return cached value on second call", async () => {
      const customProvider = createMockProvider();
      const service = createEmbeddingService({
        provider: "custom",
        customProvider,
        cache: { enabled: true },
      });

      // First call - should hit the provider
      const embedding1 = await service.embed("Test text");
      expect(customProvider.embed).toHaveBeenCalledTimes(1);

      // Second call - should return cached value
      const embedding2 = await service.embed("Test text");
      expect(customProvider.embed).toHaveBeenCalledTimes(1); // Still 1

      // Embeddings should be identical
      expect(embedding1).toEqual(embedding2);
    });

    it("should track cache hits and misses", async () => {
      const customProvider = createMockProvider();
      const service = createEmbeddingService({
        provider: "custom",
        customProvider,
        cache: { enabled: true },
      });

      // Initial stats
      const stats1 = service.getCacheStats();
      expect(stats1?.hits).toBe(0);
      expect(stats1?.misses).toBe(0);

      // First call - cache miss
      await service.embed("Text 1");
      const stats2 = service.getCacheStats();
      expect(stats2?.misses).toBe(1);
      expect(stats2?.hits).toBe(0);
      expect(stats2?.entries).toBe(1);

      // Second call same text - cache hit
      await service.embed("Text 1");
      const stats3 = service.getCacheStats();
      expect(stats3?.misses).toBe(1);
      expect(stats3?.hits).toBe(1);
      expect(stats3?.hitRate).toBe(0.5);

      // Third call different text - cache miss
      await service.embed("Text 2");
      const stats4 = service.getCacheStats();
      expect(stats4?.misses).toBe(2);
      expect(stats4?.hits).toBe(1);
      expect(stats4?.entries).toBe(2);
    });

    it("should clear cache when requested", async () => {
      const customProvider = createMockProvider();
      const service = createEmbeddingService({
        provider: "custom",
        customProvider,
        cache: { enabled: true },
      });

      await service.embed("Test text");
      expect(service.getCacheStats()?.entries).toBe(1);

      service.clearCache();

      const stats = service.getCacheStats();
      expect(stats?.entries).toBe(0);
      expect(stats?.hits).toBe(0);
      expect(stats?.misses).toBe(0);
    });

    it("should evict oldest entries when cache is full", async () => {
      const customProvider = createMockProvider();
      const service = createEmbeddingService({
        provider: "custom",
        customProvider,
        cache: {
          enabled: true,
          maxEntries: 3,
        },
      });

      // Fill the cache
      await service.embed("Text 1");
      await service.embed("Text 2");
      await service.embed("Text 3");
      expect(service.getCacheStats()?.entries).toBe(3);

      // Add one more - should evict the oldest
      await service.embed("Text 4");
      expect(service.getCacheStats()?.entries).toBe(3);

      // Text 1 should have been evicted (cache miss on re-request)
      (customProvider.embed as ReturnType<typeof vi.fn>).mockClear();
      await service.embed("Text 1");
      expect(customProvider.embed).toHaveBeenCalledTimes(1);
    });

    it("should return null stats when cache is disabled", () => {
      const customProvider = createMockProvider();
      const service = createEmbeddingService({
        provider: "custom",
        customProvider,
        cache: { enabled: false },
      });

      expect(service.getCacheStats()).toBeNull();
    });

    it("should not cache when cache is disabled", async () => {
      const customProvider = createMockProvider();
      const service = createEmbeddingService({
        provider: "custom",
        customProvider,
        cache: { enabled: false },
      });

      await service.embed("Test text");
      await service.embed("Test text");

      // Provider should be called twice (no caching)
      expect(customProvider.embed).toHaveBeenCalledTimes(2);
    });

    it("should use SHA-256 hash for cache keys (different texts have different keys)", async () => {
      const customProvider = createMockProvider();
      const service = createEmbeddingService({
        provider: "custom",
        customProvider,
        cache: { enabled: true },
      });

      await service.embed("Text A");
      await service.embed("Text B");
      await service.embed("Text A"); // Should hit cache

      // Only 2 calls (Text A cached)
      expect(customProvider.embed).toHaveBeenCalledTimes(2);
      expect(service.getCacheStats()?.hits).toBe(1);
    });
  });

  describe("Error Handling", () => {
    it("should propagate provider errors", async () => {
      const originalError = new Error("Provider failed");
      const failingProvider = createFailingProvider(originalError);
      const service = createEmbeddingService({
        provider: "custom",
        customProvider: failingProvider,
      });

      await expect(service.embed("Test text")).rejects.toThrow("Provider failed");
    });

    it("should handle provider returning correct error types", async () => {
      const generationError = new EmbeddingGenerationError("Generation failed", "GEN_FAILED");
      const failingProvider = createFailingProvider(generationError);
      const service = createEmbeddingService({
        provider: "custom",
        customProvider: failingProvider,
      });

      await expect(service.embed("Test text")).rejects.toThrow(EmbeddingGenerationError);
    });
  });
});

describe("EmbeddingServiceError Classes", () => {
  it("EmbeddingServiceError should have correct properties", () => {
    const cause = new Error("Original error");
    const error = new EmbeddingServiceError("Test error", "TEST_CODE", cause);

    expect(error.message).toBe("Test error");
    expect(error.code).toBe("TEST_CODE");
    expect(error.cause).toBe(cause);
    expect(error.name).toBe("EmbeddingServiceError");
    expect(error instanceof Error).toBe(true);
  });

  it("EmbeddingGenerationError should be instance of EmbeddingServiceError", () => {
    const error = new EmbeddingGenerationError("Generation failed", "GEN_FAILED");

    expect(error.name).toBe("EmbeddingGenerationError");
    expect(error instanceof EmbeddingServiceError).toBe(true);
    expect(error instanceof Error).toBe(true);
  });

  it("EmbeddingConfigurationError should be instance of EmbeddingServiceError", () => {
    const error = new EmbeddingConfigurationError("Config invalid", "CONFIG_INVALID");

    expect(error.name).toBe("EmbeddingConfigurationError");
    expect(error instanceof EmbeddingServiceError).toBe(true);
    expect(error instanceof Error).toBe(true);
  });

  it("should handle undefined code and cause", () => {
    const error = new EmbeddingServiceError("Test error");

    expect(error.code).toBeUndefined();
    expect(error.cause).toBeUndefined();
  });

  it("should maintain error prototype chain for instanceof checks", () => {
    const serviceError = new EmbeddingServiceError("Service error");
    const genError = new EmbeddingGenerationError("Gen error");
    const configError = new EmbeddingConfigurationError("Config error");

    expect(serviceError instanceof EmbeddingServiceError).toBe(true);
    expect(genError instanceof EmbeddingServiceError).toBe(true);
    expect(configError instanceof EmbeddingServiceError).toBe(true);

    expect(serviceError instanceof EmbeddingGenerationError).toBe(false);
    expect(genError instanceof EmbeddingConfigurationError).toBe(false);
  });
});

describe("Factory Functions", () => {
  describe("createEmbeddingService", () => {
    it("should create service with full config", () => {
      const customProvider = createMockProvider();
      const service = createEmbeddingService({
        provider: "custom",
        customProvider,
        cache: {
          enabled: true,
          maxEntries: 500,
          ttlMs: 1800000,
        },
      });

      expect(service).toBeInstanceOf(EmbeddingService);
      expect(service.dimensions).toBe(768);
      expect(service.isCacheEnabled()).toBe(true);
    });

    it("should create service with custom provider dimensions", () => {
      const customProvider = createMockProvider({ dimensions: 1536 });
      const service = createEmbeddingService({
        provider: "custom",
        customProvider,
      });

      expect(service.dimensions).toBe(1536);
    });
  });
});

describe("EmbeddingProvider Interface", () => {
  it("should allow creating custom providers with required interface", async () => {
    // Custom provider implementation
    const customProvider: EmbeddingProvider = {
      dimensions: 256,
      name: "tiny-provider",
      embed: async (text: string) => {
        const embedding = new Float32Array(256);
        for (let i = 0; i < 256; i++) {
          embedding[i] = text.length * 0.01 + i * 0.001;
        }
        return embedding;
      },
    };

    const service = createEmbeddingService({
      provider: "custom",
      customProvider,
    });

    const embedding = await service.embed("Test");

    expect(service.providerName).toBe("tiny-provider");
    expect(embedding.length).toBe(256);
  });

  it("should support async embedding generation", async () => {
    let resolveEmbedding: (value: Float32Array) => void;
    const embeddingPromise = new Promise<Float32Array>((resolve) => {
      resolveEmbedding = resolve;
    });

    const asyncProvider: EmbeddingProvider = {
      dimensions: 768,
      name: "async-provider",
      embed: vi.fn().mockReturnValue(embeddingPromise),
    };

    const service = createEmbeddingService({
      provider: "custom",
      customProvider: asyncProvider,
    });

    const embedPromise = service.embed("Test");

    // Resolve after a short delay to simulate async behavior
    setTimeout(() => {
      resolveEmbedding(new Float32Array(768).fill(0.5));
    }, 10);

    const embedding = await embedPromise;

    expect(embedding.length).toBe(768);
    expect(embedding[0]).toBe(0.5);
  });
});
