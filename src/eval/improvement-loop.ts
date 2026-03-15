/**
 * Improvement Loop: TypeScript wrapper for nightly self-improvement cycle
 *
 * Commands:
 *   check-budget    — verify 20x cost ceiling not exceeded
 *   run-baseline    — run eval suite, save as baseline
 *   run-post        — run eval suite, save as post-improvement
 *   compare         — compare baseline vs post, output KEEP/DISCARD
 *   record-result   — record keep/discard to improvements.tsv
 *
 * @module eval/improvement-loop
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { EvalRunResult } from "./types.js";
import { EvalSuite, type SearchAdapter } from "./suite.js";

// ============================================================================
// Constants
// ============================================================================

/** Minimum improvement in Recall@10 to keep changes */
const MIN_RECALL_IMPROVEMENT = 0.02;

/** Maximum regression allowed for any individual metric */
const MAX_METRIC_REGRESSION = 0.05;

/** Maximum latency increase allowed (20%) */
const MAX_LATENCY_INCREASE_PCT = 20;

/** Cost ceiling multiplier (20x plan cost) */
const COST_CEILING_MULTIPLIER = 20;

/** Estimated cost per improvement run in USD */
const ESTIMATED_RUN_COST_USD = 2.5;

/** Maximum total budget in USD (20x * estimated plan cost of $5) */
const MAX_TOTAL_BUDGET_USD = COST_CEILING_MULTIPLIER * 5;

// ============================================================================
// Types
// ============================================================================

export interface ImprovementResult {
  date: string;
  decision: "keep" | "discard";
  baselineRecall: number;
  postRecall: number;
  delta: number;
  reason: string;
  costUsd: number;
  cumulativeCostUsd: number;
}

export interface CompareResult {
  decision: "keep" | "discard";
  reason: string;
  recallDelta: number;
  ndcgDelta: number;
  mrrDelta: number;
  latencyDeltaPct: number;
}

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Load the latest baseline eval run from the state file.
 */
export function loadBaseline(stateDir: string): EvalRunResult | null {
  const baselinePath = join(stateDir, "baseline.json");
  if (!existsSync(baselinePath)) return null;
  return JSON.parse(readFileSync(baselinePath, "utf-8")) as EvalRunResult;
}

/**
 * Save an eval run as the baseline.
 */
export function saveBaseline(stateDir: string, run: EvalRunResult): void {
  ensureDir(stateDir);
  writeFileSync(join(stateDir, "baseline.json"), JSON.stringify(run, null, 2), "utf-8");
}

/**
 * Load the post-improvement eval run from the state file.
 */
export function loadPostRun(stateDir: string): EvalRunResult | null {
  const postPath = join(stateDir, "post.json");
  if (!existsSync(postPath)) return null;
  return JSON.parse(readFileSync(postPath, "utf-8")) as EvalRunResult;
}

/**
 * Save an eval run as the post-improvement result.
 */
export function savePostRun(stateDir: string, run: EvalRunResult): void {
  ensureDir(stateDir);
  writeFileSync(join(stateDir, "post.json"), JSON.stringify(run, null, 2), "utf-8");
}

/**
 * Compare baseline and post-improvement eval runs.
 * Returns KEEP if:
 *   - aggregate Recall@10 improved by >= MIN_RECALL_IMPROVEMENT
 *   - No individual metric regressed by > MAX_METRIC_REGRESSION
 *   - Latency did not increase by > MAX_LATENCY_INCREASE_PCT
 */
export function compareScores(baseline: EvalRunResult, post: EvalRunResult): CompareResult {
  const b = baseline.aggregate;
  const p = post.aggregate;

  const recallDelta = p.meanRecallAt10 - b.meanRecallAt10;
  const ndcgDelta = p.meanNdcgAt10 - b.meanNdcgAt10;
  const mrrDelta = p.meanMrrAt10 - b.meanMrrAt10;
  const latencyDeltaPct = b.meanLatencyMs > 0
    ? ((p.meanLatencyMs - b.meanLatencyMs) / b.meanLatencyMs) * 100
    : 0;

  // Check for regressions
  if (recallDelta < -MAX_METRIC_REGRESSION) {
    return {
      decision: "discard",
      reason: `Recall@10 regressed by ${(-recallDelta).toFixed(4)} (max allowed: ${MAX_METRIC_REGRESSION})`,
      recallDelta, ndcgDelta, mrrDelta, latencyDeltaPct,
    };
  }
  if (ndcgDelta < -MAX_METRIC_REGRESSION) {
    return {
      decision: "discard",
      reason: `NDCG@10 regressed by ${(-ndcgDelta).toFixed(4)} (max allowed: ${MAX_METRIC_REGRESSION})`,
      recallDelta, ndcgDelta, mrrDelta, latencyDeltaPct,
    };
  }
  if (mrrDelta < -MAX_METRIC_REGRESSION) {
    return {
      decision: "discard",
      reason: `MRR@10 regressed by ${(-mrrDelta).toFixed(4)} (max allowed: ${MAX_METRIC_REGRESSION})`,
      recallDelta, ndcgDelta, mrrDelta, latencyDeltaPct,
    };
  }
  if (latencyDeltaPct > MAX_LATENCY_INCREASE_PCT) {
    return {
      decision: "discard",
      reason: `Latency increased by ${latencyDeltaPct.toFixed(1)}% (max allowed: ${MAX_LATENCY_INCREASE_PCT}%)`,
      recallDelta, ndcgDelta, mrrDelta, latencyDeltaPct,
    };
  }

  // Check for sufficient improvement
  if (recallDelta < MIN_RECALL_IMPROVEMENT) {
    return {
      decision: "discard",
      reason: `Recall@10 improvement ${recallDelta.toFixed(4)} below threshold ${MIN_RECALL_IMPROVEMENT}`,
      recallDelta, ndcgDelta, mrrDelta, latencyDeltaPct,
    };
  }

  return {
    decision: "keep",
    reason: `Recall@10 improved by ${recallDelta.toFixed(4)} (threshold: ${MIN_RECALL_IMPROVEMENT})`,
    recallDelta, ndcgDelta, mrrDelta, latencyDeltaPct,
  };
}

/**
 * Record an improvement result to the TSV file.
 */
export function recordResult(tsvPath: string, result: ImprovementResult): void {
  ensureDir(join(tsvPath, ".."));

  // Create header if file doesn't exist
  if (!existsSync(tsvPath)) {
    writeFileSync(tsvPath, [
      "date",
      "decision",
      "baseline_recall",
      "post_recall",
      "delta",
      "reason",
      "cost_usd",
      "cumulative_cost_usd",
    ].join("\t") + "\n", "utf-8");
  }

  const row = [
    result.date,
    result.decision,
    result.baselineRecall.toFixed(4),
    result.postRecall.toFixed(4),
    result.delta.toFixed(4),
    result.reason.replace(/\t/g, " "),
    result.costUsd.toFixed(2),
    result.cumulativeCostUsd.toFixed(2),
  ].join("\t") + "\n";

  appendFileSync(tsvPath, row, "utf-8");
}

/**
 * Check if budget is exhausted by reading cumulative cost from TSV.
 */
export function checkBudget(tsvPath: string): { exhausted: boolean; remaining: number; cumulative: number } {
  if (!existsSync(tsvPath)) {
    return { exhausted: false, remaining: MAX_TOTAL_BUDGET_USD, cumulative: 0 };
  }

  const content = readFileSync(tsvPath, "utf-8");
  const lines = content.trim().split("\n");
  // Skip header
  if (lines.length <= 1) {
    return { exhausted: false, remaining: MAX_TOTAL_BUDGET_USD, cumulative: 0 };
  }

  // Get cumulative cost from last row
  const lastLine = lines[lines.length - 1];
  if (!lastLine) {
    return { exhausted: false, remaining: MAX_TOTAL_BUDGET_USD, cumulative: 0 };
  }

  const cols = lastLine.split("\t");
  const cumulative = parseFloat(cols[7] ?? "0");
  const remaining = MAX_TOTAL_BUDGET_USD - cumulative;

  return {
    exhausted: remaining < ESTIMATED_RUN_COST_USD,
    remaining: Math.max(0, remaining),
    cumulative,
  };
}

/**
 * Get the cumulative cost from the TSV for recording the next result.
 */
export function getCumulativeCost(tsvPath: string): number {
  const budget = checkBudget(tsvPath);
  return budget.cumulative;
}

// ============================================================================
// Helpers
// ============================================================================

function ensureDir(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

// ============================================================================
// HTTP Search Adapter
// ============================================================================

/**
 * SearchAdapter that calls the ping-mem REST API for code search.
 * Used by the CLI to run real eval against a running instance.
 */
export class HttpSearchAdapter implements SearchAdapter {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async search(query: string, _mode: string, limit: number): Promise<Array<{ id: string; content: string }>> {
    const params = new URLSearchParams({
      query,
      limit: String(limit),
    });
    const url = `${this.baseUrl}/api/v1/codebase/search?${params.toString()}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Search request failed: ${response.status} ${response.statusText}`);
    }
    const body = (await response.json()) as {
      data: { results: Array<{ chunkId: string; content: string; filePath: string }> };
    };
    return body.data.results.map((r) => ({
      id: r.filePath ?? r.chunkId,
      content: r.content,
    }));
  }
}

// ============================================================================
// CLI Entry Point
// ============================================================================

const command = process.argv[2];
const IMPROVEMENTS_DIR = join(process.cwd(), ".ai", "eval", "improvements");
const TSV_PATH = join(IMPROVEMENTS_DIR, "improvements.tsv");

function parseSearchUrl(): string {
  const idx = process.argv.indexOf("--search-url");
  if (idx !== -1 && process.argv[idx + 1]) {
    return process.argv[idx + 1]!;
  }
  return "http://localhost:3000";
}

async function runEvalAndSave(phase: "baseline" | "post"): Promise<void> {
  const searchUrl = parseSearchUrl();
  const adapter = new HttpSearchAdapter(searchUrl);
  const labeledQueriesPath = join(process.cwd(), ".ai", "eval", "labeled-queries.jsonl");
  const suite = new EvalSuite(adapter, undefined, {
    labeledQueriesPath,
    runsDir: join(process.cwd(), ".ai", "eval", "runs"),
    k: 10,
  });
  const result = await suite.run();

  if (phase === "baseline") {
    saveBaseline(IMPROVEMENTS_DIR, result);
  } else {
    savePostRun(IMPROVEMENTS_DIR, result);
  }

  console.log(`meanRecallAt10: ${result.aggregate.meanRecallAt10.toFixed(4)}`);
  console.log(`meanNdcgAt10: ${result.aggregate.meanNdcgAt10.toFixed(4)}`);
  console.log(`meanMrrAt10: ${result.aggregate.meanMrrAt10.toFixed(4)}`);
  console.log(`meanLatencyMs: ${result.aggregate.meanLatencyMs.toFixed(1)}`);
  console.log(`${phase === "baseline" ? "Baseline" : "Post-improvement"} eval saved`);
}

if (command === "check-budget") {
  const budget = checkBudget(TSV_PATH);
  if (budget.exhausted) {
    console.log("BUDGET_EXHAUSTED");
    console.log(`Cumulative: $${budget.cumulative.toFixed(2)} / $${MAX_TOTAL_BUDGET_USD.toFixed(2)}`);
  } else {
    console.log(`Budget OK: $${budget.remaining.toFixed(2)} remaining`);
  }
} else if (command === "run-baseline") {
  await runEvalAndSave("baseline");
} else if (command === "run-post") {
  await runEvalAndSave("post");
} else if (command === "compare") {
  const baseline = loadBaseline(IMPROVEMENTS_DIR);
  const post = loadPostRun(IMPROVEMENTS_DIR);
  if (!baseline || !post) {
    console.log("DISCARD: Missing baseline or post-improvement eval run");
  } else {
    const result = compareScores(baseline, post);
    console.log(result.decision === "keep" ? "KEEP" : "DISCARD");
    console.log(`Reason: ${result.reason}`);
    console.log(`Recall delta: ${result.recallDelta.toFixed(4)}`);
  }
} else if (command === "record-result") {
  const decision = process.argv[3] as "keep" | "discard";
  const reason = process.argv[4] ?? "manual";
  const cumulative = getCumulativeCost(TSV_PATH);
  recordResult(TSV_PATH, {
    date: new Date().toISOString().slice(0, 10),
    decision,
    baselineRecall: 0,
    postRecall: 0,
    delta: 0,
    reason,
    costUsd: ESTIMATED_RUN_COST_USD,
    cumulativeCostUsd: cumulative + ESTIMATED_RUN_COST_USD,
  });
  console.log(`Recorded: ${decision} — ${reason}`);
}
