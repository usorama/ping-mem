/**
 * Eval Suite types for search quality measurement
 *
 * @module eval/types
 */

export type QueryType =
  | "code_search"
  | "decision_recall"
  | "cross_project"
  | "causal_chain"
  | "temporal";

export interface EvalQuery {
  id: string;
  type: QueryType;
  query: string;
  expectedResultIds: string[];
  relevanceScores: Record<string, number>;
  metadata: {
    project?: string;
    dateRange?: { from: string; to: string };
    difficulty: "easy" | "medium" | "hard";
  };
}

export interface EvalResult {
  queryId: string;
  retrievedIds: string[];
  scores: {
    recallAt10: number;
    ndcgAt10: number;
    mrrAt10: number;
  };
  latencyMs: number;
  searchMode: string;
}

export interface EvalRunResult {
  runId: string;
  timestamp: string;
  datasetVersion: string;
  engineConfig: Record<string, unknown>;
  results: EvalResult[];
  aggregate: {
    meanRecallAt10: number;
    meanNdcgAt10: number;
    meanMrrAt10: number;
    meanLatencyMs: number;
    p95LatencyMs: number;
  };
}

export interface JudgeScore {
  queryId: string;
  resultId: string;
  primaryRelevance: number;
  secondaryRelevance: number;
  finalScore: number;
  primaryReasoning: string;
  secondaryReasoning: string;
  disagreement: boolean;
}
