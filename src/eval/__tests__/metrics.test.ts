/**
 * Tests for eval metrics (Recall@K, NDCG@K, MRR@K)
 *
 * @module eval/__tests__/metrics.test
 */

import { describe, it, expect } from "bun:test";
import { recallAtK, ndcgAtK, mrrAtK } from "../metrics.js";

// ============================================================================
// recallAtK
// ============================================================================

describe("recallAtK", () => {
  it("should return 1.0 when all relevant items are in top K", () => {
    const retrieved = ["a", "b", "c", "d", "e"];
    const relevant = ["a", "c"];
    expect(recallAtK(retrieved, relevant, 5)).toBe(1.0);
  });

  it("should return 0.5 when half of relevant items are in top K", () => {
    const retrieved = ["a", "b", "c", "d", "e"];
    const relevant = ["a", "x"];
    expect(recallAtK(retrieved, relevant, 5)).toBe(0.5);
  });

  it("should return 0 when no relevant items are in top K", () => {
    const retrieved = ["a", "b", "c"];
    const relevant = ["x", "y"];
    expect(recallAtK(retrieved, relevant, 3)).toBe(0);
  });

  it("should return 0 when relevant set is empty", () => {
    const retrieved = ["a", "b", "c"];
    expect(recallAtK(retrieved, [], 3)).toBe(0);
  });

  it("should return 0 when k is 0", () => {
    const retrieved = ["a", "b"];
    const relevant = ["a"];
    expect(recallAtK(retrieved, relevant, 0)).toBe(0);
  });

  it("should truncate retrieved to top K", () => {
    const retrieved = ["a", "b", "c", "d"];
    const relevant = ["d"];
    expect(recallAtK(retrieved, relevant, 2)).toBe(0);
    expect(recallAtK(retrieved, relevant, 4)).toBe(1.0);
  });

  it("should handle retrieved shorter than K", () => {
    const retrieved = ["a", "b"];
    const relevant = ["a", "b", "c"];
    expect(recallAtK(retrieved, relevant, 10)).toBeCloseTo(2 / 3);
  });

  it("should handle duplicate retrieved IDs", () => {
    const retrieved = ["a", "a", "b"];
    const relevant = ["a", "b"];
    expect(recallAtK(retrieved, relevant, 3)).toBe(1.0);
  });

  it("should return 0 when k is negative", () => {
    expect(recallAtK(["a"], ["a"], -1)).toBe(0);
  });
});

// ============================================================================
// ndcgAtK
// ============================================================================

describe("ndcgAtK", () => {
  it("should return 1.0 for perfect ranking", () => {
    const retrieved = ["a", "b", "c"];
    const scores: Record<string, number> = { a: 3, b: 2, c: 1 };
    expect(ndcgAtK(retrieved, scores, 3)).toBeCloseTo(1.0);
  });

  it("should return less than 1.0 for imperfect ranking", () => {
    const retrieved = ["c", "b", "a"];
    const scores: Record<string, number> = { a: 3, b: 2, c: 1 };
    const ndcg = ndcgAtK(retrieved, scores, 3);
    expect(ndcg).toBeLessThan(1.0);
    expect(ndcg).toBeGreaterThan(0);
  });

  it("should return 0 when all relevance scores are 0", () => {
    const retrieved = ["a", "b"];
    const scores: Record<string, number> = { a: 0, b: 0 };
    expect(ndcgAtK(retrieved, scores, 2)).toBe(0);
  });

  it("should return 0 for empty relevance scores", () => {
    const retrieved = ["a", "b"];
    expect(ndcgAtK(retrieved, {}, 2)).toBe(0);
  });

  it("should return 0 when k is 0", () => {
    expect(ndcgAtK(["a"], { a: 3 }, 0)).toBe(0);
  });

  it("should handle single result with perfect relevance", () => {
    expect(ndcgAtK(["a"], { a: 3 }, 1)).toBeCloseTo(1.0);
  });

  it("should handle retrieved items not in relevance scores", () => {
    const retrieved = ["x", "y", "a"];
    const scores: Record<string, number> = { a: 3 };
    const ndcg = ndcgAtK(retrieved, scores, 3);
    expect(ndcg).toBeGreaterThan(0);
    expect(ndcg).toBeLessThan(1.0);
  });

  it("should truncate to top K", () => {
    const retrieved = ["a", "b", "c", "d"];
    const scores: Record<string, number> = { a: 3, b: 2, c: 1, d: 3 };
    const ndcg2 = ndcgAtK(retrieved, scores, 2);
    const ndcg4 = ndcgAtK(retrieved, scores, 4);
    expect(ndcg2).not.toBe(ndcg4);
  });

  it("should return 0 when k is negative", () => {
    expect(ndcgAtK(["a"], { a: 3 }, -1)).toBe(0);
  });
});

// ============================================================================
// mrrAtK
// ============================================================================

describe("mrrAtK", () => {
  it("should return 1.0 when first result is relevant", () => {
    const retrieved = ["a", "b", "c"];
    const relevant = ["a"];
    expect(mrrAtK(retrieved, relevant, 3)).toBe(1.0);
  });

  it("should return 0.5 when second result is first relevant", () => {
    const retrieved = ["x", "a", "b"];
    const relevant = ["a", "b"];
    expect(mrrAtK(retrieved, relevant, 3)).toBe(0.5);
  });

  it("should return 1/3 when third result is first relevant", () => {
    const retrieved = ["x", "y", "a"];
    const relevant = ["a"];
    expect(mrrAtK(retrieved, relevant, 3)).toBeCloseTo(1 / 3);
  });

  it("should return 0 when no relevant items in top K", () => {
    const retrieved = ["x", "y", "z"];
    const relevant = ["a"];
    expect(mrrAtK(retrieved, relevant, 3)).toBe(0);
  });

  it("should return 0 when relevant set is empty", () => {
    expect(mrrAtK(["a", "b"], [], 2)).toBe(0);
  });

  it("should return 0 when k is 0", () => {
    expect(mrrAtK(["a"], ["a"], 0)).toBe(0);
  });

  it("should respect K truncation", () => {
    const retrieved = ["x", "y", "a"];
    const relevant = ["a"];
    expect(mrrAtK(retrieved, relevant, 2)).toBe(0);
    expect(mrrAtK(retrieved, relevant, 3)).toBeCloseTo(1 / 3);
  });
});
