/**
 * Tests for SemanticCompressor (heuristic mode only — no LLM in tests)
 *
 * @module memory/__tests__/SemanticCompressor.test
 */

import { describe, it, expect, beforeEach } from "@jest/globals";
import { SemanticCompressor } from "../SemanticCompressor.js";
import type { Memory } from "../../types/index.js";

/**
 * Build a minimal Memory object for testing.
 */
function makeMemory(
  key: string,
  value: string,
  overrides: Partial<Memory> = {}
): Memory {
  return {
    id: `mem-${key}`,
    key,
    value,
    sessionId: "test-session",
    priority: "normal",
    privacy: "session",
    createdAt: new Date(),
    updatedAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

describe("SemanticCompressor", () => {
  // All tests use heuristic mode (no API key)
  let compressor: SemanticCompressor;

  beforeEach(() => {
    compressor = new SemanticCompressor({ apiKey: undefined });
  });

  describe("compress with empty array", () => {
    it("should return empty result", async () => {
      const result = await compressor.compress([]);

      expect(result.facts).toEqual([]);
      expect(result.sourceCount).toBe(0);
      expect(result.compressionRatio).toBe(1);
      expect(result.strategy).toBe("heuristic");
      expect(result.costEstimate).toBeUndefined();
    });
  });

  describe("heuristic compression", () => {
    it("should deduplicate similar memories", async () => {
      const memories = [
        makeMemory("auth-1", "Use JWT for authentication"),
        makeMemory("auth-2", "Use JWT for authentication"), // exact dup
        makeMemory("auth-3", "use jwt for authentication"), // case-normalized dup
        makeMemory("db-1", "PostgreSQL for production database"),
      ];

      const result = await compressor.compress(memories);

      expect(result.strategy).toBe("heuristic");
      // At most 2 unique facts (JWT + PostgreSQL), deduplication removes exact dups
      expect(result.facts.length).toBeLessThanOrEqual(2);
      expect(result.sourceCount).toBe(4);
    });

    it("should preserve unique facts", async () => {
      const memories = [
        makeMemory("fact-1", "The server runs on port 3000"),
        makeMemory("fact-2", "Database uses SQLite for core storage"),
        makeMemory("fact-3", "Neo4j stores temporal code graph"),
      ];

      const result = await compressor.compress(memories);

      expect(result.facts).toHaveLength(3);
      expect(result.sourceCount).toBe(3);

      // Verify all facts are preserved
      const factsText = result.facts.join(" ");
      expect(factsText).toContain("3000");
      expect(factsText).toContain("SQLite");
      expect(factsText).toContain("Neo4j");
    });

    it("should use heuristic strategy when no API key", async () => {
      const memories = [makeMemory("k1", "Value one")];
      const result = await compressor.compress(memories);

      expect(result.strategy).toBe("heuristic");
    });
  });

  describe("compressionRatio", () => {
    it("should be calculated correctly", async () => {
      // 4 input memories, 2 will survive dedup (pairs are identical)
      const memories = [
        makeMemory("a", "Alpha fact here"),
        makeMemory("b", "Alpha fact here"), // normalized dup
        makeMemory("c", "Beta fact is different"),
        makeMemory("d", "Beta fact is different"), // normalized dup
      ];

      const result = await compressor.compress(memories);

      // compressionRatio = facts.length / sourceCount
      expect(result.compressionRatio).toBe(result.facts.length / 4);
      // Should be 0.5 (2 unique / 4 input)
      expect(result.compressionRatio).toBe(0.5);
    });

    it("should be 1 for all-unique input", async () => {
      const memories = [
        makeMemory("x", "Unique value X is quite distinct"),
        makeMemory("y", "Unique value Y is completely different"),
      ];

      const result = await compressor.compress(memories);

      expect(result.compressionRatio).toBe(1);
    });
  });

  describe("isLLMAvailable", () => {
    it("should return false when no API key", () => {
      const comp = new SemanticCompressor({ apiKey: undefined });
      expect(comp.isLLMAvailable).toBe(false);
    });

    it("should return true when API key is provided", () => {
      const comp = new SemanticCompressor({ apiKey: "sk-test-key" });
      expect(comp.isLLMAvailable).toBe(true);
    });

    it("should return false for empty string API key", () => {
      const comp = new SemanticCompressor({ apiKey: "" });
      expect(comp.isLLMAvailable).toBe(false);
    });
  });

  describe("fact format", () => {
    it("should format facts as key: value", async () => {
      const memories = [makeMemory("my-key", "my value content")];
      const result = await compressor.compress(memories);

      expect(result.facts).toHaveLength(1);
      expect(result.facts[0]).toBe("my-key: my value content");
    });

    it("should truncate long facts to 200 chars", async () => {
      const longValue = "x".repeat(300);
      const memories = [makeMemory("k", longValue)];
      const result = await compressor.compress(memories);

      expect(result.facts[0].length).toBeLessThanOrEqual(200);
    });
  });
});
