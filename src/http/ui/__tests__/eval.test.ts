/**
 * Tests for Eval Dashboard UI
 *
 * @module http/ui/__tests__/eval.test
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { loadEvalRuns } from "../eval.js";
import { renderLayout } from "../layout.js";
import type { EvalRunResult } from "../../../eval/types.js";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TEST_RUNS_DIR = ".ai/eval/runs/test-ui";

function makeRun(overrides?: Partial<EvalRunResult>): EvalRunResult {
  return {
    runId: "run-001-test",
    timestamp: "2026-03-15T10:00:00.000Z",
    datasetVersion: "v1",
    engineConfig: {},
    results: [
      {
        queryId: "q1",
        retrievedIds: ["file-a", "file-b"],
        scores: { recallAt10: 0.8, ndcgAt10: 0.75, mrrAt10: 1.0 },
        latencyMs: 42,
        searchMode: "code_search",
      },
      {
        queryId: "q2",
        retrievedIds: ["file-c"],
        scores: { recallAt10: 0.5, ndcgAt10: 0.6, mrrAt10: 0.5 },
        latencyMs: 38,
        searchMode: "decision_recall",
      },
    ],
    aggregate: {
      meanRecallAt10: 0.65,
      meanNdcgAt10: 0.675,
      meanMrrAt10: 0.75,
      meanLatencyMs: 40,
      p95LatencyMs: 42,
    },
    ...overrides,
  };
}

beforeEach(() => {
  if (existsSync(TEST_RUNS_DIR)) rmSync(TEST_RUNS_DIR, { recursive: true });
  mkdirSync(TEST_RUNS_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_RUNS_DIR)) rmSync(TEST_RUNS_DIR, { recursive: true });
});

describe("loadEvalRuns", () => {
  test("returns empty array when directory does not exist", () => {
    const runs = loadEvalRuns("/tmp/nonexistent-eval-dir-xyz");
    expect(runs).toEqual([]);
  });

  test("blocks paths outside project root", () => {
    // Create a real dir outside process.cwd() to distinguish traversal block from existsSync
    const outsideDir = "/tmp/ping-mem-traversal-test";
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, "run.json"), JSON.stringify(makeRun()));
    const result = loadEvalRuns(outsideDir);
    expect(result).toEqual([]);
    rmSync(outsideDir, { recursive: true });
  });

  test("returns empty array when directory is empty", () => {
    const runs = loadEvalRuns(TEST_RUNS_DIR);
    expect(runs).toEqual([]);
  });

  test("loads a single run", () => {
    const run = makeRun();
    writeFileSync(join(TEST_RUNS_DIR, "2026-03-15T10-00.json"), JSON.stringify(run), "utf-8");

    const runs = loadEvalRuns(TEST_RUNS_DIR);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.runId).toBe("run-001-test");
  });

  test("loads multiple runs sorted newest first", () => {
    const run1 = makeRun({ runId: "run-old", timestamp: "2026-03-14T10:00:00.000Z" });
    const run2 = makeRun({ runId: "run-new", timestamp: "2026-03-15T10:00:00.000Z" });

    writeFileSync(join(TEST_RUNS_DIR, "2026-03-14T10-00.json"), JSON.stringify(run1), "utf-8");
    writeFileSync(join(TEST_RUNS_DIR, "2026-03-15T10-00.json"), JSON.stringify(run2), "utf-8");

    const runs = loadEvalRuns(TEST_RUNS_DIR);
    expect(runs).toHaveLength(2);
    // Files sorted reverse alphabetically, so 15 comes before 14
    expect(runs[0]?.runId).toBe("run-new");
    expect(runs[1]?.runId).toBe("run-old");
  });

  test("skips non-JSON files", () => {
    writeFileSync(join(TEST_RUNS_DIR, "readme.txt"), "not json", "utf-8");
    writeFileSync(
      join(TEST_RUNS_DIR, "2026-03-15T10-00.json"),
      JSON.stringify(makeRun()),
      "utf-8",
    );

    const runs = loadEvalRuns(TEST_RUNS_DIR);
    expect(runs).toHaveLength(1);
  });

  test("skips malformed JSON files gracefully", () => {
    writeFileSync(join(TEST_RUNS_DIR, "bad.json"), "not valid json{", "utf-8");
    writeFileSync(
      join(TEST_RUNS_DIR, "good.json"),
      JSON.stringify(makeRun()),
      "utf-8",
    );

    const runs = loadEvalRuns(TEST_RUNS_DIR);
    expect(runs).toHaveLength(1);
  });

  test("preserves aggregate metrics from run", () => {
    const run = makeRun();
    writeFileSync(join(TEST_RUNS_DIR, "run.json"), JSON.stringify(run), "utf-8");

    const runs = loadEvalRuns(TEST_RUNS_DIR);
    expect(runs[0]?.aggregate.meanRecallAt10).toBe(0.65);
    expect(runs[0]?.aggregate.meanNdcgAt10).toBe(0.675);
    expect(runs[0]?.aggregate.meanMrrAt10).toBe(0.75);
    expect(runs[0]?.aggregate.meanLatencyMs).toBe(40);
    expect(runs[0]?.aggregate.p95LatencyMs).toBe(42);
  });

  test("preserves per-result scores", () => {
    const run = makeRun();
    writeFileSync(join(TEST_RUNS_DIR, "run.json"), JSON.stringify(run), "utf-8");

    const runs = loadEvalRuns(TEST_RUNS_DIR);
    expect(runs[0]?.results).toHaveLength(2);
    expect(runs[0]?.results[0]?.searchMode).toBe("code_search");
    expect(runs[0]?.results[1]?.searchMode).toBe("decision_recall");
  });
});

describe("Eval Dashboard layout", () => {
  test("renders with eval active route", () => {
    const html = renderLayout({
      title: "Eval Dashboard",
      content: "<p>Eval content</p>",
      activeRoute: "eval",
    });
    expect(html).toContain("Eval Dashboard - ping-mem");
    expect(html).toContain("<p>Eval content</p>");
    expect(html).toContain('href="/ui/eval" class="active"');
  });

  test("includes eval in sidebar navigation", () => {
    const html = renderLayout({
      title: "Dashboard",
      content: "",
      activeRoute: "dashboard",
    });
    expect(html).toContain('href="/ui/eval"');
    expect(html).toContain("Eval");
  });
});
