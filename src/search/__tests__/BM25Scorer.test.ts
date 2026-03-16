import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { BM25Scorer, tokenize } from "../BM25Scorer.js";
import { Database } from "bun:sqlite";

describe("BM25Scorer", () => {
  let db: Database;
  let scorer: BM25Scorer;

  beforeEach(() => {
    db = new Database(":memory:");
    scorer = new BM25Scorer(db);
  });

  afterEach(() => { db.close(); });

  describe("tokenize", () => {
    it("should lowercase and split", () => { expect(tokenize("Hello World")).toEqual(["hello", "world"]); });
    it("should strip punctuation", () => { expect(tokenize("foo.bar(baz)")).toEqual(["foo", "bar", "baz"]); });
    it("should return empty for empty", () => { expect(tokenize("")).toEqual([]); });
  });

  describe("indexDocument", () => {
    it("should index and update count", () => {
      scorer.indexDocument("c1", "hello world test");
      expect(scorer.getDocumentCount()).toBe(1);
    });
    it("should be idempotent", () => {
      scorer.indexDocument("c1", "hello world");
      scorer.indexDocument("c1", "goodbye world");
      expect(scorer.getDocumentCount()).toBe(1);
      expect(scorer.getDocumentFrequency("hello")).toBe(0);
      expect(scorer.getDocumentFrequency("goodbye")).toBe(1);
    });
    it("should handle empty content", () => {
      scorer.indexDocument("c1", "");
      expect(scorer.getDocumentCount()).toBe(0);
    });
  });

  describe("indexDocumentsBatch", () => {
    it("should batch-index", () => {
      scorer.indexDocumentsBatch([
        { chunkId: "c1", content: "typescript function" },
        { chunkId: "c2", content: "python class" },
      ]);
      expect(scorer.getDocumentCount()).toBe(2);
    });
    it("should handle 1000 docs efficiently", () => {
      const docs = Array.from({ length: 1000 }, (_, i) => ({
        chunkId: `chunk-${i}`, content: `document ${i} content topic ${i % 10}`,
      }));
      const start = Date.now();
      scorer.indexDocumentsBatch(docs);
      expect(scorer.getDocumentCount()).toBe(1000);
      expect(Date.now() - start).toBeLessThan(2000);
    });
  });

  describe("removeDocument", () => {
    it("should remove", () => {
      scorer.indexDocument("c1", "hello world");
      scorer.removeDocument("c1");
      expect(scorer.getDocumentCount()).toBe(0);
    });
    it("should not fail on nonexistent", () => {
      expect(() => scorer.removeDocument("x")).not.toThrow();
    });
  });

  describe("search", () => {
    it("should return empty for empty query", () => {
      scorer.indexDocument("c1", "hello world");
      expect(scorer.search("")).toEqual([]);
    });
    it("should return empty for no match", () => {
      scorer.indexDocument("c1", "hello world");
      expect(scorer.search("quantum")).toEqual([]);
    });
    it("should return empty for empty corpus", () => {
      expect(scorer.search("hello")).toEqual([]);
    });
    it("should find matching documents", () => {
      scorer.indexDocumentsBatch([
        { chunkId: "c1", content: "typescript function for computing scores" },
        { chunkId: "c2", content: "python class for data processing" },
      ]);
      const results = scorer.search("typescript function");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.chunkId).toBe("c1");
      expect(results[0]!.score).toBeGreaterThan(0);
    });
    it("should rank by term frequency", () => {
      scorer.indexDocumentsBatch([
        { chunkId: "c1", content: "scoring scoring scoring algorithm" },
        { chunkId: "c2", content: "this uses scoring for ranking" },
      ]);
      const results = scorer.search("scoring");
      expect(results).toHaveLength(2);
      expect(results[0]!.chunkId).toBe("c1");
      expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
    });
    it("should respect limit", () => {
      const docs = Array.from({ length: 20 }, (_, i) => ({
        chunkId: `c${i}`, content: `search function variant ${i}`,
      }));
      scorer.indexDocumentsBatch(docs);
      expect(scorer.search("search function", 5)).toHaveLength(5);
    });
    it("should filter by chunkIds", () => {
      scorer.indexDocumentsBatch([
        { chunkId: "c1", content: "typescript function" },
        { chunkId: "c2", content: "typescript class" },
        { chunkId: "c3", content: "typescript module" },
      ]);
      const filterSet = new Set(["c1", "c3"]);
      const results = scorer.search("typescript", 10, filterSet);
      expect(results.every((r) => filterSet.has(r.chunkId))).toBe(true);
    });
    it("should weight rare terms higher (IDF)", () => {
      scorer.indexDocumentsBatch([
        { chunkId: "c1", content: "common word rare unique" },
        { chunkId: "c2", content: "common word another" },
        { chunkId: "c3", content: "common word yet another" },
      ]);
      const results = scorer.search("rare");
      expect(results).toHaveLength(1);
      expect(results[0]!.chunkId).toBe("c1");
    });
    it("should handle duplicate query terms", () => {
      scorer.indexDocument("c1", "test content for verification");
      const r1 = scorer.search("test test test");
      const r2 = scorer.search("test");
      expect(r1[0]!.score).toBe(r2[0]!.score);
    });
  });

  describe("determinism", () => {
    it("same corpus + query = same scores across instances", () => {
      const docs = [
        { chunkId: "c1", content: "typescript function for BM25 scores" },
        { chunkId: "c2", content: "python class for data processing" },
        { chunkId: "c3", content: "rust struct with generics" },
      ];
      const query = "function data processing";
      const db1 = new Database(":memory:");
      const s1 = new BM25Scorer(db1);
      s1.indexDocumentsBatch(docs);
      const r1 = s1.search(query);
      const db2 = new Database(":memory:");
      const s2 = new BM25Scorer(db2);
      s2.indexDocumentsBatch(docs);
      const r2 = s2.search(query);
      expect(r1.length).toBe(r2.length);
      for (let i = 0; i < r1.length; i++) {
        expect(r1[i]!.chunkId).toBe(r2[i]!.chunkId);
        expect(r1[i]!.score).toBe(r2[i]!.score);
      }
      db1.close(); db2.close();
    });

    it("deterministic across 10 runs", () => {
      const docs = [
        { chunkId: "c1", content: "export class BM25Scorer implements Ranker" },
        { chunkId: "c2", content: "export function tokenize text into terms" },
      ];
      const allRuns: Array<Array<{ chunkId: string; score: number }>> = [];
      for (let run = 0; run < 10; run++) {
        const runDb = new Database(":memory:");
        const runScorer = new BM25Scorer(runDb);
        runScorer.indexDocumentsBatch(docs);
        allRuns.push(runScorer.search("BM25 scorer"));
        runDb.close();
      }
      for (let run = 1; run < allRuns.length; run++) {
        expect(allRuns[run]!.length).toBe(allRuns[0]!.length);
        for (let i = 0; i < allRuns[0]!.length; i++) {
          expect(allRuns[run]![i]!.chunkId).toBe(allRuns[0]![i]!.chunkId);
          expect(allRuns[run]![i]!.score).toBe(allRuns[0]![i]!.score);
        }
      }
    });
  });

  describe("BM25 parameters", () => {
    it("should use custom k1 and b", () => {
      scorer.indexDocumentsBatch([
        { chunkId: "c1", content: "test test test document" },
        { chunkId: "c2", content: "another document testing" },
      ]);
      const db2 = new Database(":memory:");
      const s2 = new BM25Scorer(db2, { k1: 2.0, b: 0.5 });
      s2.indexDocumentsBatch([
        { chunkId: "c1", content: "test test test document" },
        { chunkId: "c2", content: "another document testing" },
      ]);
      const r1 = scorer.search("test");
      const r2 = s2.search("test");
      expect(r1.length).toBe(r2.length);
      expect(r1[0]!.score).not.toBe(r2[0]!.score);
      db2.close();
    });
  });

  describe("corpus statistics", () => {
    it("should track doc count", () => {
      expect(scorer.getDocumentCount()).toBe(0);
      scorer.indexDocument("c1", "hello");
      expect(scorer.getDocumentCount()).toBe(1);
      scorer.removeDocument("c1");
      expect(scorer.getDocumentCount()).toBe(0);
    });
    it("should compute avg doc length", () => {
      scorer.indexDocumentsBatch([
        { chunkId: "c1", content: "one two three" },
        { chunkId: "c2", content: "four five six seven" },
        { chunkId: "c3", content: "eight" },
      ]);
      expect(scorer.getAverageDocLength()).toBeCloseTo(2.667, 2);
    });
    it("should compute df correctly", () => {
      scorer.indexDocumentsBatch([
        { chunkId: "c1", content: "hello world" },
        { chunkId: "c2", content: "hello universe" },
        { chunkId: "c3", content: "goodbye world" },
      ]);
      expect(scorer.getDocumentFrequency("hello")).toBe(2);
      expect(scorer.getDocumentFrequency("world")).toBe(2);
      expect(scorer.getDocumentFrequency("universe")).toBe(1);
      expect(scorer.getDocumentFrequency("nonexistent")).toBe(0);
    });
  });

  describe("search latency", () => {
    it("should search 10k chunks in under 100ms", () => {
      const docs = Array.from({ length: 10000 }, (_, i) => ({
        chunkId: `chunk-${i}`,
        content: `export function handler${i}(req: Request): Response { return new Response("ok ${i % 100}") }`,
      }));
      scorer.indexDocumentsBatch(docs);
      expect(scorer.getDocumentCount()).toBe(10000);
      const start = performance.now();
      const results = scorer.search("function handler request response", 10);
      const elapsed = performance.now() - start;
      expect(results.length).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(100);
    });
  });
});
