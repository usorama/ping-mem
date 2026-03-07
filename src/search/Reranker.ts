/**
 * Reranker using Cohere Rerank API
 *
 * Re-ranks search results using Cohere's neural reranking model
 * for improved relevance ordering after initial retrieval.
 *
 * @module search/Reranker
 * @version 1.0.0
 */

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Configuration for the Reranker
 */
export interface RerankerConfig {
  /** Cohere API key */
  apiKey: string;
  /** Rerank model to use (default: "rerank-v3.5") */
  model?: string;
  /** Maximum number of top results to return (default: 10) */
  topK?: number;
}

/**
 * A single re-ranked result with its index and relevance score
 */
export interface RerankResult {
  /** Original index in the input documents array */
  index: number;
  /** Relevance score from the reranker (higher is more relevant) */
  relevanceScore: number;
}

// ============================================================================
// Cohere API Response Types
// ============================================================================

interface CohereRerankResponseResult {
  index: number;
  relevance_score: number;
}

interface CohereRerankResponse {
  results: CohereRerankResponseResult[];
}

// ============================================================================
// Reranker Implementation
// ============================================================================

/**
 * Reranker that uses Cohere's Rerank API to re-order search results
 * by semantic relevance to the query.
 *
 * @example
 * ```typescript
 * const reranker = new Reranker({ apiKey: "your-cohere-api-key" });
 * const results = await reranker.rerank("machine learning", [
 *   "Deep learning is a subset of ML",
 *   "Cooking recipes for beginners",
 *   "Neural networks and backpropagation",
 * ]);
 * // results sorted by relevance: index 0 and 2 ranked higher than 1
 * ```
 */
import { createLogger } from "../util/logger.js";

const log = createLogger("Reranker");

export class Reranker {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly topK: number;

  constructor(config: RerankerConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? "rerank-v3.5";
    this.topK = config.topK ?? 10;
  }

  /**
   * Re-rank results using Cohere Rerank API.
   * Returns null on failure instead of fabricating scores.
   *
   * @param query - Original search query
   * @param documents - Array of document texts to re-rank
   * @returns Re-ranked indices with relevance scores sorted by relevance descending, or null on failure
   */
  async rerank(query: string, documents: string[]): Promise<RerankResult[] | null> {
    if (documents.length === 0) {
      return [];
    }

    try {
      const response = await fetch("https://api.cohere.com/v2/rerank", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          query,
          documents,
          top_n: Math.min(this.topK, documents.length),
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        log.error("Reranking failed, returning un-reranked results", { status: response.status, error: errorText });
        return null;
      }

      const data = (await response.json()) as CohereRerankResponse;

      return data.results
        .map((r) => ({
          index: r.index,
          relevanceScore: r.relevance_score,
        }))
        .sort((a, b) => b.relevanceScore - a.relevanceScore);
    } catch (error) {
      log.error("Reranking failed, returning un-reranked results", { error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }
}
