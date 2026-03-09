/**
 * Tests for GeminiEmbeddingProvider and FallbackEmbeddingProvider
 *
 * Tests Gemini embedding generation via mocked fetch and fallback behavior
 * between primary/fallback providers.
 *
 * @module search/__tests__/GeminiEmbeddingProvider.test
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import {
  GeminiEmbeddingProvider,
  FallbackEmbeddingProvider,
  EmbeddingConfigurationError,
  EmbeddingGenerationError,
  type EmbeddingProvider,
} from "../EmbeddingService.js";

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Create a deterministic embedding array of given dimensions
 */
function createMockEmbedding(dimensions: number, seed = 1): number[] {
  const values: number[] = [];
  for (let i = 0; i < dimensions; i++) {
    values.push(Math.sin(seed + i) * 0.5);
  }
  return values;
}

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

  const defaultEmbedFn = async (_text: string): Promise<Float32Array> => {
    return new Float32Array(createMockEmbedding(dimensions));
  };

  return {
    dimensions,
    name,
    embed: vi.fn().mockImplementation(options?.embedFn ?? defaultEmbedFn),
  };
}

/**
 * Create a mock Response for fetch
 */
function createMockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers(),
    redirected: false,
    statusText: status === 200 ? "OK" : "Error",
    type: "basic" as ResponseType,
    url: "",
    clone: () => createMockResponse(body, status),
    body: null,
    bodyUsed: false,
    arrayBuffer: async () => new ArrayBuffer(0),
    blob: async () => new Blob(),
    formData: async () => new FormData(),
  } as Response;
}

// ============================================================================
// GeminiEmbeddingProvider Tests
// ============================================================================

describe("GeminiEmbeddingProvider", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe("Construction", () => {
    it("should create provider with default options", () => {
      const provider = new GeminiEmbeddingProvider("test-gemini-key");

      expect(provider.name).toBe("gemini");
      expect(provider.dimensions).toBe(768);
    });

    it("should create provider with custom model and dimensions", () => {
      const provider = new GeminiEmbeddingProvider("test-gemini-key", {
        model: "text-embedding-005",
        dimensions: 512,
      });

      expect(provider.dimensions).toBe(512);
    });

    it("should throw EmbeddingConfigurationError when API key is empty", () => {
      expect(() => new GeminiEmbeddingProvider("")).toThrow(EmbeddingConfigurationError);
      expect(() => new GeminiEmbeddingProvider("")).toThrow(/Gemini API key is required/);
    });
  });

  describe("Embedding Generation", () => {
    it("should generate embeddings via mocked fetch", async () => {
      const mockValues = createMockEmbedding(768, 42);
      const mockFetch = vi.fn().mockResolvedValue(
        createMockResponse({ embedding: { values: mockValues } })
      );
      globalThis.fetch = mockFetch;

      const provider = new GeminiEmbeddingProvider("test-gemini-key");
      const embedding = await provider.embed("Hello, world!");

      expect(embedding).toBeInstanceOf(Float32Array);
      expect(embedding.length).toBe(768);
      expect(Array.from(embedding)).toEqual(mockValues.map((v) => Math.fround(v)));

      // Verify correct API call
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("generativelanguage.googleapis.com");
      expect(url).toContain("text-embedding-004");
      // API key should NOT be in the URL — it must be sent via header
      expect(url).not.toContain("key=");
      expect((options.headers as Record<string, string>)["x-goog-api-key"]).toBe("test-gemini-key");

      const body = JSON.parse(options.body as string) as Record<string, unknown>;
      expect(body).toEqual({
        model: "models/text-embedding-004",
        content: { parts: [{ text: "Hello, world!" }] },
        outputDimensionality: 768,
      });
    });

    it("should throw EmbeddingGenerationError for empty text", async () => {
      const provider = new GeminiEmbeddingProvider("test-gemini-key");

      await expect(provider.embed("")).rejects.toThrow(EmbeddingGenerationError);
      await expect(provider.embed("  ")).rejects.toThrow(/Cannot embed empty text/);
    });

    it("should throw EmbeddingGenerationError on API error response", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        createMockResponse({ error: { message: "Quota exceeded" } }, 429)
      );
      globalThis.fetch = mockFetch;

      const provider = new GeminiEmbeddingProvider("test-gemini-key");

      await expect(provider.embed("Test text")).rejects.toThrow(EmbeddingGenerationError);
      await expect(provider.embed("Test text")).rejects.toThrow(/Gemini API error \(429\)/);
    });

    it("should throw EmbeddingGenerationError when no embedding in response", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        createMockResponse({ embedding: {} })
      );
      globalThis.fetch = mockFetch;

      const provider = new GeminiEmbeddingProvider("test-gemini-key");

      await expect(provider.embed("Test text")).rejects.toThrow(EmbeddingGenerationError);
      await expect(provider.embed("Test text")).rejects.toThrow(/No embedding returned from Gemini/);
    });

    it("should throw EmbeddingGenerationError on network failure", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error("Network timeout"));
      globalThis.fetch = mockFetch;

      const provider = new GeminiEmbeddingProvider("test-gemini-key");

      await expect(provider.embed("Test text")).rejects.toThrow(EmbeddingGenerationError);
      await expect(provider.embed("Test text")).rejects.toThrow(/Failed to generate Gemini embedding/);
    });

    it("should use custom model when specified", async () => {
      const mockValues = createMockEmbedding(768);
      const mockFetch = vi.fn().mockResolvedValue(
        createMockResponse({ embedding: { values: mockValues } })
      );
      globalThis.fetch = mockFetch;

      const provider = new GeminiEmbeddingProvider("test-gemini-key", {
        model: "text-embedding-005",
      });
      await provider.embed("Test");

      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toContain("text-embedding-005");
    });
  });
});

// ============================================================================
// FallbackEmbeddingProvider Tests
// ============================================================================

describe("FallbackEmbeddingProvider", () => {
  describe("Construction", () => {
    it("should create provider with matching dimensions", () => {
      const primary = createMockProvider({ name: "primary", dimensions: 768 });
      const fallback = createMockProvider({ name: "fallback", dimensions: 768 });

      const provider = new FallbackEmbeddingProvider(primary, fallback);

      expect(provider.name).toBe("primary+fallback");
      expect(provider.dimensions).toBe(768);
    });

    it("should throw EmbeddingConfigurationError on dimension mismatch", () => {
      const primary = createMockProvider({ name: "primary", dimensions: 768 });
      const fallback = createMockProvider({ name: "fallback", dimensions: 1536 });

      expect(() => new FallbackEmbeddingProvider(primary, fallback)).toThrow(
        EmbeddingConfigurationError
      );
      expect(() => new FallbackEmbeddingProvider(primary, fallback)).toThrow(
        /Dimension mismatch/
      );
    });
  });

  describe("Embedding Generation", () => {
    it("should use primary provider when it succeeds", async () => {
      const primaryEmbedding = new Float32Array(768).fill(0.1);
      const fallbackEmbedding = new Float32Array(768).fill(0.9);

      const primary = createMockProvider({
        name: "primary",
        dimensions: 768,
        embedFn: async () => primaryEmbedding,
      });
      const fallback = createMockProvider({
        name: "fallback",
        dimensions: 768,
        embedFn: async () => fallbackEmbedding,
      });

      const provider = new FallbackEmbeddingProvider(primary, fallback);
      const result = await provider.embed("Test text");

      expect(result).toBe(primaryEmbedding);
      expect(primary.embed).toHaveBeenCalledWith("Test text");
      expect(fallback.embed).not.toHaveBeenCalled();
    });

    it("should fall back when primary fails", async () => {
      const fallbackEmbedding = new Float32Array(768).fill(0.9);

      const primary = createMockProvider({
        name: "primary",
        dimensions: 768,
        embedFn: async () => {
          throw new Error("Primary provider down");
        },
      });
      const fallback = createMockProvider({
        name: "fallback",
        dimensions: 768,
        embedFn: async () => fallbackEmbedding,
      });

      // Suppress expected console.warn
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const provider = new FallbackEmbeddingProvider(primary, fallback);
      const result = await provider.embed("Test text");

      expect(result).toBe(fallbackEmbedding);
      expect(primary.embed).toHaveBeenCalledWith("Test text");
      expect(fallback.embed).toHaveBeenCalledWith("Test text");

      // Verify warning was logged
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]![0]).toContain("Primary provider");
      expect(warnSpy.mock.calls[0]![0]).toContain("primary");
      expect(warnSpy.mock.calls[0]![0]).toContain("Falling back");

      warnSpy.mockRestore();
    });

    it("should propagate fallback error when both providers fail", async () => {
      const primary = createMockProvider({
        name: "primary",
        dimensions: 768,
        embedFn: async () => {
          throw new Error("Primary failed");
        },
      });
      const fallback = createMockProvider({
        name: "fallback",
        dimensions: 768,
        embedFn: async () => {
          throw new EmbeddingGenerationError("Fallback also failed", "FALLBACK_FAILED");
        },
      });

      // Suppress expected console.warn
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const provider = new FallbackEmbeddingProvider(primary, fallback);

      await expect(provider.embed("Test text")).rejects.toThrow(EmbeddingGenerationError);
      await expect(provider.embed("Test text")).rejects.toThrow(/Fallback also failed/);

      warnSpy.mockRestore();
    });

    it("should fall back on any error type including EmbeddingServiceError", async () => {
      const fallbackEmbedding = new Float32Array(768).fill(0.5);

      const primary = createMockProvider({
        name: "primary",
        dimensions: 768,
        embedFn: async () => {
          throw new EmbeddingGenerationError("Rate limited", "RATE_LIMIT");
        },
      });
      const fallback = createMockProvider({
        name: "fallback",
        dimensions: 768,
        embedFn: async () => fallbackEmbedding,
      });

      // Suppress expected console.warn
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const provider = new FallbackEmbeddingProvider(primary, fallback);
      const result = await provider.embed("Test text");

      expect(result).toBe(fallbackEmbedding);

      warnSpy.mockRestore();
    });
  });
});
