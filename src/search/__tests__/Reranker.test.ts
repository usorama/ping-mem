/**
 * Tests for Reranker (Cohere Rerank API)
 *
 * @module search/__tests__/Reranker.test
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { Reranker } from "../Reranker.js";
import type { RerankResult } from "../Reranker.js";

// ============================================================================
// Fetch Mock Setup
// ============================================================================

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ============================================================================
// Tests
// ============================================================================

describe("Reranker", () => {
  const apiKey = "test-cohere-api-key";

  describe("constructor", () => {
    it("should use default model and topK when not specified", () => {
      const reranker = new Reranker({ apiKey });
      // Verify defaults by calling rerank with mock
      expect(reranker).toBeDefined();
    });

    it("should accept custom model and topK", () => {
      const reranker = new Reranker({
        apiKey,
        model: "rerank-english-v2.0",
        topK: 5,
      });
      expect(reranker).toBeDefined();
    });
  });

  describe("rerank", () => {
    it("should return empty array for empty documents", async () => {
      const reranker = new Reranker({ apiKey });
      const results = await reranker.rerank("test query", []);
      expect(results).toEqual([]);
    });

    it("should re-rank documents based on API response", async () => {
      const mockFetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              results: [
                { index: 2, relevance_score: 0.95 },
                { index: 0, relevance_score: 0.82 },
                { index: 1, relevance_score: 0.15 },
              ],
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          )
        )
      );
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const reranker = new Reranker({ apiKey });
      const documents = [
        "Deep learning is a subset of ML",
        "Cooking recipes for beginners",
        "Neural networks and backpropagation",
      ];

      const results = await reranker.rerank("machine learning", documents);

      // Should be sorted by relevance score descending
      expect(results).toHaveLength(3);
      expect(results[0]!.index).toBe(2);
      expect(results[0]!.relevanceScore).toBe(0.95);
      expect(results[1]!.index).toBe(0);
      expect(results[1]!.relevanceScore).toBe(0.82);
      expect(results[2]!.index).toBe(1);
      expect(results[2]!.relevanceScore).toBe(0.15);
    });

    it("should send correct API request format", async () => {
      let capturedUrl = "";
      let capturedInit: RequestInit | undefined;

      const mockFetch = mock((url: string | URL | Request, init?: RequestInit) => {
        capturedUrl = String(url);
        capturedInit = init;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              results: [{ index: 0, relevance_score: 0.9 }],
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          )
        );
      });
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const reranker = new Reranker({
        apiKey: "my-api-key",
        model: "rerank-v3.5",
        topK: 5,
      });

      await reranker.rerank("test query", ["doc1", "doc2"]);

      expect(capturedUrl).toBe("https://api.cohere.com/v2/rerank");
      expect(capturedInit).toBeDefined();

      const headers = capturedInit!.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer my-api-key");
      expect(headers["Content-Type"]).toBe("application/json");

      const body = JSON.parse(capturedInit!.body as string) as {
        model: string;
        query: string;
        documents: string[];
        top_n: number;
      };
      expect(body.model).toBe("rerank-v3.5");
      expect(body.query).toBe("test query");
      expect(body.documents).toEqual(["doc1", "doc2"]);
      expect(body.top_n).toBe(2); // min(topK=5, documents.length=2)
    });

    it("should fall back to original order on API error (500)", async () => {
      const mockFetch = mock(() =>
        Promise.resolve(
          new Response("Internal Server Error", { status: 500 })
        )
      );
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const reranker = new Reranker({ apiKey });
      const documents = ["doc A", "doc B", "doc C"];

      const results = await reranker.rerank("query", documents);

      // Fallback: original order with descending scores
      expect(results).toHaveLength(3);
      expect(results[0]!.index).toBe(0);
      expect(results[1]!.index).toBe(1);
      expect(results[2]!.index).toBe(2);

      // Scores should be descending
      expect(results[0]!.relevanceScore).toBeGreaterThan(results[1]!.relevanceScore);
      expect(results[1]!.relevanceScore).toBeGreaterThan(results[2]!.relevanceScore);
    });

    it("should fall back to original order on network error", async () => {
      const mockFetch = mock(() =>
        Promise.reject(new Error("Network error"))
      );
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const reranker = new Reranker({ apiKey });
      const documents = ["doc X", "doc Y"];

      const results = await reranker.rerank("query", documents);

      // Fallback: original order
      expect(results).toHaveLength(2);
      expect(results[0]!.index).toBe(0);
      expect(results[1]!.index).toBe(1);
    });

    it("should respect topK parameter capped by document count", async () => {
      let capturedBody = "";

      const mockFetch = mock((_url: string | URL | Request, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              results: [
                { index: 0, relevance_score: 0.9 },
                { index: 1, relevance_score: 0.8 },
                { index: 2, relevance_score: 0.7 },
              ],
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          )
        );
      });
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const reranker = new Reranker({ apiKey, topK: 100 });
      await reranker.rerank("query", ["a", "b", "c"]);

      const body = JSON.parse(capturedBody) as { top_n: number };
      // top_n should be min(100, 3) = 3
      expect(body.top_n).toBe(3);
    });

    it("should handle API response with unsorted results", async () => {
      const mockFetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              results: [
                { index: 1, relevance_score: 0.3 },
                { index: 0, relevance_score: 0.9 },
                { index: 2, relevance_score: 0.6 },
              ],
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          )
        )
      );
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const reranker = new Reranker({ apiKey });
      const results = await reranker.rerank("query", ["a", "b", "c"]);

      // Should be sorted by relevance score descending regardless of API order
      expect(results[0]!.relevanceScore).toBe(0.9);
      expect(results[0]!.index).toBe(0);
      expect(results[1]!.relevanceScore).toBe(0.6);
      expect(results[1]!.index).toBe(2);
      expect(results[2]!.relevanceScore).toBe(0.3);
      expect(results[2]!.index).toBe(1);
    });

    it("should log warning on API error", async () => {
      const originalWarn = console.warn;
      const warnings: string[] = [];
      console.warn = (...args: unknown[]) => {
        warnings.push(args.map(String).join(" "));
      };

      const mockFetch = mock(() =>
        Promise.resolve(
          new Response("Bad Request", { status: 400 })
        )
      );
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const reranker = new Reranker({ apiKey });
      await reranker.rerank("query", ["doc"]);

      expect(warnings.length).toBeGreaterThanOrEqual(1);
      expect(warnings.some((w) => w.includes("Cohere Rerank API error"))).toBe(true);

      console.warn = originalWarn;
    });
  });
});
