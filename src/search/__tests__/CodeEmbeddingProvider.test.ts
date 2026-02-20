/**
 * Tests for CodeEmbeddingProvider (Voyage AI voyage-code-3)
 *
 * Tests code embedding generation via mocked fetch against the Voyage AI API.
 *
 * @module search/__tests__/CodeEmbeddingProvider.test
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { CodeEmbeddingProvider } from "../CodeEmbeddingProvider.js";
import { EmbeddingGenerationError } from "../EmbeddingService.js";

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
// CodeEmbeddingProvider Tests
// ============================================================================

describe("CodeEmbeddingProvider", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // --------------------------------------------------------------------------
  // Construction
  // --------------------------------------------------------------------------

  describe("Construction", () => {
    it("should create provider with default options", () => {
      const provider = new CodeEmbeddingProvider({ apiKey: "test-voyage-key" });

      expect(provider.name).toBe("voyage-code");
      expect(provider.dimensions).toBe(1024);
    });

    it("should create provider with custom model and dimensions", () => {
      const provider = new CodeEmbeddingProvider({
        apiKey: "test-voyage-key",
        model: "voyage-code-2",
        dimensions: 512,
      });

      expect(provider.dimensions).toBe(512);
    });
  });

  // --------------------------------------------------------------------------
  // Embedding Generation
  // --------------------------------------------------------------------------

  describe("Embedding Generation", () => {
    it("should generate 1024D Float32Array via mocked fetch", async () => {
      const mockValues = createMockEmbedding(1024, 42);
      const mockFetch = mock(() =>
        Promise.resolve(
          createMockResponse({ data: [{ embedding: mockValues }] })
        )
      );
      globalThis.fetch = mockFetch;

      const provider = new CodeEmbeddingProvider({ apiKey: "test-voyage-key" });
      const embedding = await provider.embed("function hello() { return 'world'; }");

      expect(embedding).toBeInstanceOf(Float32Array);
      expect(embedding.length).toBe(1024);
      expect(Array.from(embedding)).toEqual(mockValues.map((v) => Math.fround(v)));
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("should send correct API request format", async () => {
      const mockValues = createMockEmbedding(1024);
      const mockFetch = mock(() =>
        Promise.resolve(
          createMockResponse({ data: [{ embedding: mockValues }] })
        )
      );
      globalThis.fetch = mockFetch;

      const provider = new CodeEmbeddingProvider({ apiKey: "test-voyage-key" });
      await provider.embed("const x = 42;");

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];

      // Verify URL
      expect(url).toBe("https://api.voyageai.com/v1/embeddings");

      // Verify headers
      const headers = options.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/json");
      expect(headers["Authorization"]).toBe("Bearer test-voyage-key");

      // Verify body
      const body = JSON.parse(options.body as string) as Record<string, unknown>;
      expect(body).toEqual({
        input: ["const x = 42;"],
        model: "voyage-code-3",
        output_dimension: 1024,
      });
    });

    it("should use custom model in request when specified", async () => {
      const mockValues = createMockEmbedding(1024);
      const mockFetch = mock(() =>
        Promise.resolve(
          createMockResponse({ data: [{ embedding: mockValues }] })
        )
      );
      globalThis.fetch = mockFetch;

      const provider = new CodeEmbeddingProvider({
        apiKey: "test-voyage-key",
        model: "voyage-code-2",
      });
      await provider.embed("test code");

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string) as Record<string, unknown>;
      expect(body.model).toBe("voyage-code-2");
    });
  });

  // --------------------------------------------------------------------------
  // Error Handling
  // --------------------------------------------------------------------------

  describe("Error Handling", () => {
    it("should throw EmbeddingGenerationError for empty text", async () => {
      const provider = new CodeEmbeddingProvider({ apiKey: "test-voyage-key" });

      try {
        await provider.embed("");
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expect(error).toBeInstanceOf(EmbeddingGenerationError);
        expect((error as EmbeddingGenerationError).message).toMatch(/Cannot embed empty text/);
        expect((error as EmbeddingGenerationError).code).toBe("EMPTY_TEXT");
      }
    });

    it("should throw EmbeddingGenerationError for whitespace-only text", async () => {
      const provider = new CodeEmbeddingProvider({ apiKey: "test-voyage-key" });

      try {
        await provider.embed("   ");
        expect(true).toBe(false);
      } catch (error) {
        expect(error).toBeInstanceOf(EmbeddingGenerationError);
        expect((error as EmbeddingGenerationError).code).toBe("EMPTY_TEXT");
      }
    });

    it("should throw EmbeddingGenerationError on API error (500)", async () => {
      const mockFetch = mock(() =>
        Promise.resolve(
          createMockResponse({ error: "Internal Server Error" }, 500)
        )
      );
      globalThis.fetch = mockFetch;

      const provider = new CodeEmbeddingProvider({ apiKey: "test-voyage-key" });

      try {
        await provider.embed("function test() {}");
        expect(true).toBe(false);
      } catch (error) {
        expect(error).toBeInstanceOf(EmbeddingGenerationError);
        expect((error as EmbeddingGenerationError).message).toMatch(/Voyage AI API error \(500\)/);
        expect((error as EmbeddingGenerationError).code).toBe("API_ERROR");
      }
    });

    it("should throw EmbeddingGenerationError when no embedding in response", async () => {
      const mockFetch = mock(() =>
        Promise.resolve(
          createMockResponse({ data: [] })
        )
      );
      globalThis.fetch = mockFetch;

      const provider = new CodeEmbeddingProvider({ apiKey: "test-voyage-key" });

      try {
        await provider.embed("some code");
        expect(true).toBe(false);
      } catch (error) {
        expect(error).toBeInstanceOf(EmbeddingGenerationError);
        expect((error as EmbeddingGenerationError).message).toMatch(/No embedding returned from Voyage AI/);
        expect((error as EmbeddingGenerationError).code).toBe("NO_EMBEDDING");
      }
    });

    it("should throw EmbeddingGenerationError on network failure", async () => {
      const mockFetch = mock(() =>
        Promise.reject(new Error("Network timeout"))
      );
      globalThis.fetch = mockFetch;

      const provider = new CodeEmbeddingProvider({ apiKey: "test-voyage-key" });

      try {
        await provider.embed("some code");
        expect(true).toBe(false);
      } catch (error) {
        expect(error).toBeInstanceOf(EmbeddingGenerationError);
        expect((error as EmbeddingGenerationError).message).toMatch(/Failed to generate Voyage AI embedding/);
        expect((error as EmbeddingGenerationError).code).toBe("GENERATION_FAILED");
      }
    });
  });
});
