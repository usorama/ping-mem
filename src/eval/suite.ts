/**
 * Eval Suite — runs labeled queries against search, scores with LLM judges
 *
 * @module eval/suite
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { LLMJudge } from "./llm-judge.js";
import type {
  EvalQuery,
  EvalResult,
  EvalRunResult,
} from "./types.js";
import { recallAtK, ndcgAtK, mrrAtK } from "./metrics.js";

export interface SearchAdapter {
  search(query: string, mode: string, limit: number): Promise<Array<{ id: string; content: string }>>;
}

export interface EvalSuiteConfig {
  labeledQueriesPath: string;
  runsDir: string;
  k: number;
}

const DEFAULT_CONFIG: EvalSuiteConfig = {
  labeledQueriesPath: ".ai/eval/labeled-queries.jsonl",
  runsDir: ".ai/eval/runs",
  k: 10,
};

export class EvalSuite {
  private readonly config: EvalSuiteConfig;
  private readonly searchAdapter: SearchAdapter;
  private readonly judge: LLMJudge | undefined;

  constructor(
    searchAdapter: SearchAdapter,
    judge?: LLMJudge,
    config?: Partial<EvalSuiteConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.searchAdapter = searchAdapter;
    this.judge = judge;
  }

  loadQueries(): EvalQuery[] {
    const path = this.config.labeledQueriesPath;
    if (!existsSync(path)) {
      throw new Error(`Labeled queries file not found: ${path}`);
    }

    const content = readFileSync(path, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    const queries: EvalQuery[] = [];

    for (const line of lines) {
      const parsed = JSON.parse(line) as EvalQuery;
      queries.push(parsed);
    }

    return queries;
  }

  async run(queries?: EvalQuery[]): Promise<EvalRunResult> {
    const dataset = queries ?? this.loadQueries();
    const results: EvalResult[] = [];
    const k = this.config.k;

    for (const query of dataset) {
      const start = performance.now();
      const searchResults = await this.searchAdapter.search(query.query, query.type, k);
      const latencyMs = performance.now() - start;

      const retrievedIds = searchResults.map((r) => r.id);

      results.push({
        queryId: query.id,
        retrievedIds,
        scores: {
          recallAt10: recallAtK(retrievedIds, query.expectedResultIds, k),
          ndcgAt10: ndcgAtK(retrievedIds, query.relevanceScores, k),
          mrrAt10: mrrAtK(retrievedIds, query.expectedResultIds, k),
        },
        latencyMs,
        searchMode: query.type,
      });
    }

    const runResult: EvalRunResult = {
      runId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      datasetVersion: "v1",
      engineConfig: {},
      results,
      aggregate: computeAggregates(results),
    };

    this.saveRun(runResult);
    return runResult;
  }

  private saveRun(run: EvalRunResult): void {
    const dir = this.config.runsDir;
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const timestamp = run.timestamp.replace(/[:.]/g, "-").slice(0, 16);
    const filePath = join(dir, `${timestamp}.json`);
    writeFileSync(filePath, JSON.stringify(run, null, 2), "utf-8");
  }
}

function computeAggregates(results: EvalResult[]): EvalRunResult["aggregate"] {
  if (results.length === 0) {
    return {
      meanRecallAt10: 0,
      meanNdcgAt10: 0,
      meanMrrAt10: 0,
      meanLatencyMs: 0,
      p95LatencyMs: 0,
    };
  }

  const sum = (arr: number[]): number => arr.reduce((a, b) => a + b, 0);

  const recalls = results.map((r) => r.scores.recallAt10);
  const ndcgs = results.map((r) => r.scores.ndcgAt10);
  const mrrs = results.map((r) => r.scores.mrrAt10);
  const latencies = results.map((r) => r.latencyMs);

  const sortedLatencies = [...latencies].sort((a, b) => a - b);
  const p95Idx = Math.min(
    Math.ceil(sortedLatencies.length * 0.95) - 1,
    sortedLatencies.length - 1,
  );

  return {
    meanRecallAt10: sum(recalls) / results.length,
    meanNdcgAt10: sum(ndcgs) / results.length,
    meanMrrAt10: sum(mrrs) / results.length,
    meanLatencyMs: sum(latencies) / results.length,
    p95LatencyMs: sortedLatencies[p95Idx] ?? 0,
  };
}
