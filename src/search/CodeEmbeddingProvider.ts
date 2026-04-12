/**
 * Voyage AI Code Embedding Provider for ping-mem
 *
 * Implements the EmbeddingProvider interface using Voyage AI's voyage-code-3 model,
 * optimized for code embedding with 1024-dimensional output.
 *
 * @module search/CodeEmbeddingProvider
 * @version 1.0.0
 */

import {
  EmbeddingGenerationError,
  type EmbeddingProvider,
} from "./EmbeddingService.js";

// ============================================================================
// Constants
// ============================================================================

const VOYAGE_API_URL = "https://api.voyageai.com/v1/embeddings";
const DEFAULT_MODEL = "voyage-code-3";
const DEFAULT_DIMENSIONS = 1024;

// ============================================================================
// Types
// ============================================================================

/**
 * Configuration options for CodeEmbeddingProvider
 */
export interface CodeEmbeddingProviderConfig {
  /** Voyage AI API key */
  apiKey: string;
  /** Model to use (default: voyage-code-3) */
  model?: string;
  /** Embedding dimensions (default: 1024) */
  dimensions?: number;
}

/**
 * Shape of the Voyage AI embeddings API response
 */
interface VoyageEmbeddingResponse {
  data: Array<{ embedding: number[] }>;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Voyage AI code embedding provider using voyage-code-3
 *
 * Generates 1024-dimensional embeddings optimized for code search and retrieval.
 *
 * @example
 * ```typescript
 * const provider = new CodeEmbeddingProvider({ apiKey: process.env.VOYAGE_API_KEY! });
 * const embedding = await provider.embed("function hello() { return 'world'; }");
 * console.log(embedding.length); // 1024
 * ```
 */
export class CodeEmbeddingProvider implements EmbeddingProvider {
  private readonly apiKey: string;
  private readonly model: string;
  public readonly dimensions: number;
  public readonly name = "voyage-code";

  constructor(config: CodeEmbeddingProviderConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? DEFAULT_MODEL;
    this.dimensions = config.dimensions ?? DEFAULT_DIMENSIONS;
  }

  async embed(text: string): Promise<Float32Array> {
    if (!text || text.trim().length === 0) {
      throw new EmbeddingGenerationError(
        "Cannot embed empty text",
        "EMPTY_TEXT"
      );
    }

    try {
      const response = await fetch(VOYAGE_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          input: [text],
          model: this.model,
          output_dimension: this.dimensions,
        }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new EmbeddingGenerationError(
          `Voyage AI API error (${response.status}): ${errorBody}`,
          "API_ERROR"
        );
      }

      const data = (await response.json()) as VoyageEmbeddingResponse;
      const embeddingData = data?.data?.[0]?.embedding;

      if (!embeddingData || !Array.isArray(embeddingData)) {
        throw new EmbeddingGenerationError(
          "No embedding returned from Voyage AI",
          "NO_EMBEDDING"
        );
      }

      return new Float32Array(embeddingData);
    } catch (error) {
      if (error instanceof EmbeddingGenerationError) {
        throw error;
      }

      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new EmbeddingGenerationError(
        `Failed to generate Voyage AI embedding: ${errorMessage}`,
        "GENERATION_FAILED",
        error instanceof Error ? error : undefined
      );
    }
  }
}
