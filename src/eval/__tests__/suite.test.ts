/**
 * Tests for EvalSuite
 *
 * @module eval/__tests__/suite.test
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { EvalSuite } from "../suite.js";
import type { SearchAdapter } from "../suite.js";
import type { EvalQuery } from "../types.js";
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// ============================================================================
// Helpers
// ============================================================================

const TEST_RUNS_DIR = "/tmp/ping-mem-eval-test-runs";
const TEST_QUERIES_PATH = "/tmp/ping-mem-eval-test-queries.jsonl";

function makeQuery(overrides?: Partial<EvalQuery>): EvalQuery {
  return {
    id: "q-test-1",
    type: "code_search",
    query: "find the BM25 scoring function",
    expectedResultIds: ["file-a", "file-b"],
    relevanceScores: { "file-a": 3, "file-b": 2, "file-c": 1 },
    metadata: { project: "test", difficulty: "easy" },
    ...overrides,
  };
}

function makeSearchAdapter(results: Array<{ id: string; content: string }>): SearchAdapter {
  return {
    search: mock(() => Promise.resolve(results)),
  };
}

function writeLabeledQueries(queries: EvalQuery[]): void {
  const content = queries.map((q) => JSON.stringify(q)).join("\n");
  writeFileSync(TEST_QUERIES_PATH, content, "utf-8");
}

// ============================================================================
// Setup / Teardown
// ============================================================================

beforeEach(() => {
  if (existsSync(TEST_RUNS_DIR)) rmSync(TEST_RUNS_DIR, { recursive: true });
  if (existsSync(TEST_QUERIES_PATH)) rmSync(TEST_QUERIES_PATH);
  mkdirSync(TEST_RUNS_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_RUNS_DIR)) rmSync(TEST_RUNS_DIR, { recursive: true });
  if (existsSync(TEST_QUERIES_PATH)) rmSync(TEST_QUERIES_PATH);
});

// ============================================================================
// Tests
// ============================================================================

describe("EvalSuite", () => {
  describe("loadQueries", () => {
    it("should load queries from JSONL file", () => {
      const queries = [makeQuery({ id: "q1" }), makeQuery({ id: "q2" })];
      writeLabeledQueries(queries);

      const suite = new EvalSuite(makeSearchAdapter([]), undefined, {
        labeledQueriesPath: TEST_QUERIES_PATH,
        runsDir: TEST_RUNS_DIR,
        k: 10,
      });

      const loaded = suite.loadQueries();
      expect(loaded).toHaveLength(2);
      expect(loaded[0]?.id).toBe("q1");
      expect(loaded[1]?.id).toBe("q2");
    });

    it("should throw when file does not exist", () => {
      const suite = new EvalSuite(makeSearchAdapter([]), undefined, {
        labeledQueriesPath: "/tmp/nonexistent.jsonl",
        runsDir: TEST_RUNS_DIR,
        k: 10,
      });

      expect(() => suite.loadQueries()).toThrow("not found");
    });
  });

  describe("run", () => {
    it("should return results for all queries", async () => {
      const adapter = makeSearchAdapter([
        { id: "file-a", content: "matching content" },
        { id: "file-c", content: "other content" },
      ]);

      const suite = new EvalSuite(adapter, undefined, {
        labeledQueriesPath: TEST_QUERIES_PATH,
        runsDir: TEST_RUNS_DIR,
        k: 10,
      });

      const queries = [makeQuery({ id: "q1" }), makeQuery({ id: "q2" })];
      const result = await suite.run(queries);

      expect(result.results).toHaveLength(2);
      expect(result.runId).toBeTruthy();
      expect(result.timestamp).toBeTruthy();
    });

    it("should compute correct recall when some results match", async () => {
      const adapter = makeSearchAdapter([
        { id: "file-a", content: "match" },
        { id: "file-x", content: "no match" },
      ]);

      const suite = new EvalSuite(adapter, undefined, {
        labeledQueriesPath: TEST_QUERIES_PATH,
        runsDir: TEST_RUNS_DIR,
        k: 10,
      });

      const result = await suite.run([makeQuery()]);
      // expectedResultIds = ["file-a", "file-b"], retrieved = ["file-a", "file-x"]
      // recall = 1/2 = 0.5
      expect(result.results[0]?.scores.recallAt10).toBeCloseTo(0.5);
    });

    it("should compute correct MRR when first result is relevant", async () => {
      const adapter = makeSearchAdapter([
        { id: "file-a", content: "match" },
      ]);

      const suite = new EvalSuite(adapter, undefined, {
        labeledQueriesPath: TEST_QUERIES_PATH,
        runsDir: TEST_RUNS_DIR,
        k: 10,
      });

      const result = await suite.run([makeQuery()]);
      expect(result.results[0]?.scores.mrrAt10).toBe(1.0);
    });

    it("should compute aggregate metrics", async () => {
      const adapter = makeSearchAdapter([
        { id: "file-a", content: "match" },
      ]);

      const suite = new EvalSuite(adapter, undefined, {
        labeledQueriesPath: TEST_QUERIES_PATH,
        runsDir: TEST_RUNS_DIR,
        k: 10,
      });

      const result = await suite.run([
        makeQuery({ id: "q1" }),
        makeQuery({ id: "q2" }),
      ]);

      expect(result.aggregate.meanRecallAt10).toBeCloseTo(0.5);
      expect(result.aggregate.meanMrrAt10).toBe(1.0);
      expect(result.aggregate.meanLatencyMs).toBeGreaterThanOrEqual(0);
      expect(result.aggregate.p95LatencyMs).toBeGreaterThanOrEqual(0);
    });

    it("should handle empty query set", async () => {
      const adapter = makeSearchAdapter([]);
      const suite = new EvalSuite(adapter, undefined, {
        labeledQueriesPath: TEST_QUERIES_PATH,
        runsDir: TEST_RUNS_DIR,
        k: 10,
      });

      const result = await suite.run([]);
      expect(result.results).toHaveLength(0);
      expect(result.aggregate.meanRecallAt10).toBe(0);
      expect(result.aggregate.meanNdcgAt10).toBe(0);
      expect(result.aggregate.meanMrrAt10).toBe(0);
    });

    it("should save run results to disk", async () => {
      const adapter = makeSearchAdapter([
        { id: "file-a", content: "match" },
      ]);

      const suite = new EvalSuite(adapter, undefined, {
        labeledQueriesPath: TEST_QUERIES_PATH,
        runsDir: TEST_RUNS_DIR,
        k: 10,
      });

      await suite.run([makeQuery()]);

      const files = readdirSync(TEST_RUNS_DIR);
      expect(files.length).toBe(1);
      expect(files[0]).toMatch(/\.json$/);

      const saved = JSON.parse(readFileSync(join(TEST_RUNS_DIR, files[0]!), "utf-8"));
      expect(saved.runId).toBeTruthy();
      expect(saved.results).toHaveLength(1);
    });

    it("should record latency for each query", async () => {
      const adapter = makeSearchAdapter([]);
      const suite = new EvalSuite(adapter, undefined, {
        labeledQueriesPath: TEST_QUERIES_PATH,
        runsDir: TEST_RUNS_DIR,
        k: 10,
      });

      const result = await suite.run([makeQuery()]);
      expect(result.results[0]?.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it("should set searchMode from query type", async () => {
      const adapter = makeSearchAdapter([]);
      const suite = new EvalSuite(adapter, undefined, {
        labeledQueriesPath: TEST_QUERIES_PATH,
        runsDir: TEST_RUNS_DIR,
        k: 10,
      });

      const result = await suite.run([makeQuery({ type: "causal_chain" })]);
      expect(result.results[0]?.searchMode).toBe("causal_chain");
    });

    it("should pass query type and limit to search adapter", async () => {
      const searchFn = mock(() => Promise.resolve([]));
      const adapter: SearchAdapter = { search: searchFn };

      const suite = new EvalSuite(adapter, undefined, {
        labeledQueriesPath: TEST_QUERIES_PATH,
        runsDir: TEST_RUNS_DIR,
        k: 5,
      });

      await suite.run([makeQuery({ type: "temporal" })]);
      expect(searchFn).toHaveBeenCalledWith(
        "find the BM25 scoring function",
        "temporal",
        5,
      );
    });

    it("should use dataset version v1", async () => {
      const adapter = makeSearchAdapter([]);
      const suite = new EvalSuite(adapter, undefined, {
        labeledQueriesPath: TEST_QUERIES_PATH,
        runsDir: TEST_RUNS_DIR,
        k: 10,
      });

      const result = await suite.run([]);
      expect(result.datasetVersion).toBe("v1");
    });

    it("should compute NDCG based on graded relevance", async () => {
      // Return results in perfect order for maximum NDCG
      const adapter = makeSearchAdapter([
        { id: "file-a", content: "best" },
        { id: "file-b", content: "good" },
        { id: "file-c", content: "ok" },
      ]);

      const suite = new EvalSuite(adapter, undefined, {
        labeledQueriesPath: TEST_QUERIES_PATH,
        runsDir: TEST_RUNS_DIR,
        k: 10,
      });

      const result = await suite.run([makeQuery()]);
      // relevanceScores: file-a=3, file-b=2, file-c=1 — perfect order
      expect(result.results[0]?.scores.ndcgAt10).toBeCloseTo(1.0);
    });

    it("should compute p95 latency in aggregates", async () => {
      const adapter = makeSearchAdapter([]);
      const suite = new EvalSuite(adapter, undefined, {
        labeledQueriesPath: TEST_QUERIES_PATH,
        runsDir: TEST_RUNS_DIR,
        k: 10,
      });

      // Run with multiple queries so p95 is meaningful
      const queries = Array.from({ length: 20 }, (_, i) =>
        makeQuery({ id: `q${i}` })
      );
      const result = await suite.run(queries);

      expect(result.aggregate.p95LatencyMs).toBeGreaterThanOrEqual(0);
      expect(result.aggregate.p95LatencyMs).toBeGreaterThanOrEqual(
        result.aggregate.meanLatencyMs * 0.5,
      );
    });

    it("should create runs directory if it does not exist", async () => {
      const newDir = join(TEST_RUNS_DIR, "nested", "deep");
      if (existsSync(newDir)) rmSync(newDir, { recursive: true });

      const adapter = makeSearchAdapter([]);
      const suite = new EvalSuite(adapter, undefined, {
        labeledQueriesPath: TEST_QUERIES_PATH,
        runsDir: newDir,
        k: 10,
      });

      await suite.run([makeQuery()]);
      expect(existsSync(newDir)).toBe(true);

      const files = readdirSync(newDir);
      expect(files.length).toBe(1);
    });
  });
});
