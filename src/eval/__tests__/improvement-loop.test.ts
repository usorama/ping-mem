/**
 * Tests for improvement-loop.ts — WS6 Blue-Green Self-Improvement Loop
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  loadBaseline,
  saveBaseline,
  loadPostRun,
  savePostRun,
  compareScores,
  recordResult,
  checkBudget,
  getCumulativeCost,
  type ImprovementResult,
} from "../improvement-loop.js";
import type { EvalRunResult } from "../types.js";

// ============================================================================
// Helpers
// ============================================================================

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "improvement-test-"));
}

function makeEvalRun(overrides: Partial<EvalRunResult["aggregate"]> = {}): EvalRunResult {
  return {
    runId: "test-run-" + crypto.randomUUID().slice(0, 8),
    timestamp: new Date().toISOString(),
    datasetVersion: "v1",
    engineConfig: {},
    results: [],
    aggregate: {
      meanRecallAt10: 0.85,
      meanNdcgAt10: 0.80,
      meanMrrAt10: 0.75,
      meanLatencyMs: 50,
      p95LatencyMs: 100,
      ...overrides,
    },
  };
}

// ============================================================================
// Baseline/Post save/load
// ============================================================================

describe("Baseline save/load", () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test("loadBaseline returns null when no file exists", () => {
    expect(loadBaseline(tmpDir)).toBeNull();
  });

  test("saveBaseline + loadBaseline round-trips correctly", () => {
    const run = makeEvalRun({ meanRecallAt10: 0.92 });
    saveBaseline(tmpDir, run);
    const loaded = loadBaseline(tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.aggregate.meanRecallAt10).toBe(0.92);
    expect(loaded!.runId).toBe(run.runId);
  });

  test("loadPostRun returns null when no file exists", () => {
    expect(loadPostRun(tmpDir)).toBeNull();
  });

  test("savePostRun + loadPostRun round-trips correctly", () => {
    const run = makeEvalRun({ meanRecallAt10: 0.95 });
    savePostRun(tmpDir, run);
    const loaded = loadPostRun(tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.aggregate.meanRecallAt10).toBe(0.95);
  });
});

// ============================================================================
// compareScores
// ============================================================================

describe("compareScores", () => {
  test("KEEP when Recall@10 improves by >= 0.02", () => {
    const baseline = makeEvalRun({ meanRecallAt10: 0.85 });
    const post = makeEvalRun({ meanRecallAt10: 0.88 }); // +0.03

    const result = compareScores(baseline, post);
    expect(result.decision).toBe("keep");
    expect(result.recallDelta).toBeCloseTo(0.03, 4);
  });

  test("DISCARD when Recall@10 improvement below threshold", () => {
    const baseline = makeEvalRun({ meanRecallAt10: 0.85 });
    const post = makeEvalRun({ meanRecallAt10: 0.86 }); // +0.01 < 0.02

    const result = compareScores(baseline, post);
    expect(result.decision).toBe("discard");
    expect(result.reason).toContain("below threshold");
  });

  test("DISCARD when Recall@10 regresses > 0.05", () => {
    const baseline = makeEvalRun({ meanRecallAt10: 0.85 });
    const post = makeEvalRun({ meanRecallAt10: 0.79 }); // -0.06

    const result = compareScores(baseline, post);
    expect(result.decision).toBe("discard");
    expect(result.reason).toContain("regressed");
  });

  test("DISCARD when NDCG@10 regresses > 0.05", () => {
    const baseline = makeEvalRun({ meanRecallAt10: 0.85, meanNdcgAt10: 0.80 });
    const post = makeEvalRun({ meanRecallAt10: 0.90, meanNdcgAt10: 0.70 }); // NDCG -0.10

    const result = compareScores(baseline, post);
    expect(result.decision).toBe("discard");
    expect(result.reason).toContain("NDCG");
  });

  test("DISCARD when MRR@10 regresses > 0.05", () => {
    const baseline = makeEvalRun({ meanRecallAt10: 0.85, meanMrrAt10: 0.75 });
    const post = makeEvalRun({ meanRecallAt10: 0.90, meanMrrAt10: 0.69 }); // MRR -0.06

    const result = compareScores(baseline, post);
    expect(result.decision).toBe("discard");
    expect(result.reason).toContain("MRR");
  });

  test("DISCARD when latency increases > 20%", () => {
    const baseline = makeEvalRun({ meanRecallAt10: 0.85, meanLatencyMs: 50 });
    const post = makeEvalRun({ meanRecallAt10: 0.90, meanLatencyMs: 65 }); // +30%

    const result = compareScores(baseline, post);
    expect(result.decision).toBe("discard");
    expect(result.reason).toContain("Latency");
  });

  test("KEEP with latency increase under 20%", () => {
    const baseline = makeEvalRun({ meanRecallAt10: 0.85, meanLatencyMs: 50 });
    const post = makeEvalRun({ meanRecallAt10: 0.88, meanLatencyMs: 55 }); // +10%

    const result = compareScores(baseline, post);
    expect(result.decision).toBe("keep");
  });

  test("handles zero baseline latency without division by zero", () => {
    const baseline = makeEvalRun({ meanLatencyMs: 0 });
    const post = makeEvalRun({ meanRecallAt10: 0.88, meanLatencyMs: 50 });

    const result = compareScores(baseline, post);
    // Should not throw, latencyDeltaPct should be 0
    expect(result.latencyDeltaPct).toBe(0);
  });

  test("exact threshold values", () => {
    // Exactly 0.02 improvement — should KEEP
    const baseline = makeEvalRun({ meanRecallAt10: 0.85 });
    const post = makeEvalRun({ meanRecallAt10: 0.87 });

    const result = compareScores(baseline, post);
    expect(result.decision).toBe("keep");

    // Exactly -0.05 regression — should NOT discard (boundary)
    const baseline2 = makeEvalRun({ meanRecallAt10: 0.85 });
    const post2 = makeEvalRun({ meanRecallAt10: 0.82 }); // -0.03 < 0.05

    const result2 = compareScores(baseline2, post2);
    // -0.03 doesn't exceed MAX_METRIC_REGRESSION (0.05) but is below MIN_RECALL_IMPROVEMENT
    expect(result2.decision).toBe("discard");
    expect(result2.reason).toContain("below threshold");
  });
});

// ============================================================================
// recordResult
// ============================================================================

describe("recordResult", () => {
  let tmpDir: string;
  let tsvPath: string;
  beforeEach(() => {
    tmpDir = makeTmpDir();
    tsvPath = path.join(tmpDir, "improvements.tsv");
  });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test("creates TSV file with header on first write", () => {
    const result: ImprovementResult = {
      date: "2026-03-15",
      decision: "keep",
      baselineRecall: 0.85,
      postRecall: 0.88,
      delta: 0.03,
      reason: "Recall improved",
      costUsd: 2.5,
      cumulativeCostUsd: 2.5,
    };

    recordResult(tsvPath, result);

    const content = fs.readFileSync(tsvPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(2); // header + 1 data row
    expect(lines[0]).toContain("date\tdecision\tbaseline_recall");
    expect(lines[1]).toContain("2026-03-15\tkeep\t0.8500\t0.8800");
  });

  test("appends to existing TSV without duplicate header", () => {
    const result1: ImprovementResult = {
      date: "2026-03-14",
      decision: "discard",
      baselineRecall: 0.80,
      postRecall: 0.81,
      delta: 0.01,
      reason: "Insufficient improvement",
      costUsd: 2.5,
      cumulativeCostUsd: 2.5,
    };
    const result2: ImprovementResult = {
      date: "2026-03-15",
      decision: "keep",
      baselineRecall: 0.81,
      postRecall: 0.88,
      delta: 0.07,
      reason: "Good improvement",
      costUsd: 2.5,
      cumulativeCostUsd: 5.0,
    };

    recordResult(tsvPath, result1);
    recordResult(tsvPath, result2);

    const content = fs.readFileSync(tsvPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(3); // header + 2 data rows
    expect(lines[2]).toContain("2026-03-15\tkeep");
  });

  test("strips tabs from reason field", () => {
    const result: ImprovementResult = {
      date: "2026-03-15",
      decision: "discard",
      baselineRecall: 0.85,
      postRecall: 0.84,
      delta: -0.01,
      reason: "Reason\twith\ttabs",
      costUsd: 2.5,
      cumulativeCostUsd: 2.5,
    };

    recordResult(tsvPath, result);

    const content = fs.readFileSync(tsvPath, "utf-8");
    expect(content).not.toContain("Reason\twith");
    expect(content).toContain("Reason with tabs");
  });
});

// ============================================================================
// checkBudget
// ============================================================================

describe("checkBudget", () => {
  let tmpDir: string;
  let tsvPath: string;
  beforeEach(() => {
    tmpDir = makeTmpDir();
    tsvPath = path.join(tmpDir, "improvements.tsv");
  });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test("returns full budget when no TSV exists", () => {
    const budget = checkBudget(tsvPath);
    expect(budget.exhausted).toBe(false);
    expect(budget.remaining).toBe(100); // 20 * $5
    expect(budget.cumulative).toBe(0);
  });

  test("returns remaining budget after runs", () => {
    recordResult(tsvPath, {
      date: "2026-03-15",
      decision: "keep",
      baselineRecall: 0.85,
      postRecall: 0.88,
      delta: 0.03,
      reason: "test",
      costUsd: 2.5,
      cumulativeCostUsd: 10,
    });

    const budget = checkBudget(tsvPath);
    expect(budget.exhausted).toBe(false);
    expect(budget.cumulative).toBe(10);
    expect(budget.remaining).toBe(90);
  });

  test("reports exhausted when cumulative >= max - run cost", () => {
    recordResult(tsvPath, {
      date: "2026-03-15",
      decision: "keep",
      baselineRecall: 0.85,
      postRecall: 0.88,
      delta: 0.03,
      reason: "test",
      costUsd: 2.5,
      cumulativeCostUsd: 98, // Only $2 remaining, but run costs $2.50
    });

    const budget = checkBudget(tsvPath);
    expect(budget.exhausted).toBe(true);
    expect(budget.remaining).toBe(2);
  });

  test("getCumulativeCost reads from TSV", () => {
    recordResult(tsvPath, {
      date: "2026-03-15",
      decision: "discard",
      baselineRecall: 0.85,
      postRecall: 0.84,
      delta: -0.01,
      reason: "regression",
      costUsd: 2.5,
      cumulativeCostUsd: 15,
    });

    expect(getCumulativeCost(tsvPath)).toBe(15);
  });

  test("getCumulativeCost returns 0 when no TSV", () => {
    expect(getCumulativeCost(tsvPath)).toBe(0);
  });
});

// ============================================================================
// Docker compose file exists
// ============================================================================

describe("docker-compose.improvement.yml", () => {
  test("improvement compose file exists and contains green service", () => {
    const composePath = path.join(process.cwd(), "docker-compose.improvement.yml");
    expect(fs.existsSync(composePath)).toBe(true);

    const content = fs.readFileSync(composePath, "utf-8");
    expect(content).toContain("ping-mem-green");
    expect(content).toContain("3001:3000");
    expect(content).toContain("PING_MEM_IMPROVEMENT_MODE=true");
    expect(content).toContain("PING_MEM_INSTANCE=green");
    expect(content).toContain("improvement"); // profile name
    expect(content).toContain("/projects:ro"); // READ-ONLY mount
    expect(content).toContain("ping-mem-green-data");
  });

  test("green service does not mount blue data volume", () => {
    const composePath = path.join(process.cwd(), "docker-compose.improvement.yml");
    const content = fs.readFileSync(composePath, "utf-8");
    // Green should use its own volume, not ping-mem-data (Blue's volume)
    expect(content).not.toContain("ping-mem-data:/data");
    expect(content).toContain("ping-mem-green-data:/data");
  });
});

// ============================================================================
// Shell script exists and is executable
// ============================================================================

describe("nightly-improvement.sh", () => {
  test("script exists and is executable", () => {
    const scriptPath = path.join(process.cwd(), "scripts", "nightly-improvement.sh");
    expect(fs.existsSync(scriptPath)).toBe(true);

    const stat = fs.statSync(scriptPath);
    // Check executable bit (owner)
    expect(stat.mode & 0o100).toBeGreaterThan(0);
  });

  test("script contains required orchestration steps", () => {
    const scriptPath = path.join(process.cwd(), "scripts", "nightly-improvement.sh");
    const content = fs.readFileSync(scriptPath, "utf-8");

    expect(content).toContain("check-budget");
    expect(content).toContain("run-baseline");
    expect(content).toContain("claude --headless");
    expect(content).toContain("--max-turns");
    expect(content).toContain("run-post");
    expect(content).toContain("compare");
    expect(content).toContain("KEEP");
    expect(content).toContain("DISCARD");
    expect(content).toContain("bun test");
    expect(content).toContain("bun run typecheck");
    expect(content).toContain("--dry-run");
    expect(content).toContain("docker compose");
    expect(content).toContain("ping-mem-green");
    expect(content).toContain("git stash push");
  });
});
