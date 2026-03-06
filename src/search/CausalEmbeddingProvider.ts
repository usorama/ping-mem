/**
 * Causal Embedding Provider for ping-mem
 *
 * Wraps a base embedding provider to produce causal embeddings by
 * prefixing text with "cause: " or "effect: " before delegation.
 * This enables asymmetric search where causes find effects and vice versa.
 *
 * @module search/CausalEmbeddingProvider
 * @version 1.0.0
 */

import type { EmbeddingProvider } from "./EmbeddingService.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Causal side: cause or effect
 */
export type CausalSide = "cause" | "effect";

/**
 * Configuration for the CausalEmbeddingProvider
 */
export interface CausalEmbeddingProviderConfig {
  /** Base embedding provider to delegate to */
  baseProvider: EmbeddingProvider;
  /** Which causal side to embed as (default: "cause") */
  side?: CausalSide;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Embedding provider that prefixes text with a causal direction
 * before delegating to a base provider.
 *
 * This enables asymmetric causal search: queries prefixed with "cause: "
 * will match documents prefixed with "effect: " when the base model
 * has learned causal relationships.
 *
 * @example
 * ```typescript
 * const causeProvider = new CausalEmbeddingProvider({
 *   baseProvider: openaiProvider,
 *   side: "cause",
 * });
 * const effectProvider = new CausalEmbeddingProvider({
 *   baseProvider: openaiProvider,
 *   side: "effect",
 * });
 *
 * // Embed a cause query
 * const causeVec = await causeProvider.embed("memory leak in auth service");
 * // Embed an effect document
 * const effectVec = await effectProvider.embed("increased latency on login endpoint");
 * ```
 */
export class CausalEmbeddingProvider implements EmbeddingProvider {
  private readonly baseProvider: EmbeddingProvider;
  private readonly side: CausalSide;

  public readonly dimensions: number;
  public readonly name: string;

  constructor(config: CausalEmbeddingProviderConfig) {
    this.baseProvider = config.baseProvider;
    this.side = config.side ?? "cause";
    this.dimensions = this.baseProvider.dimensions;
    this.name = `causal-${this.side}`;
  }

  /**
   * Embed text with causal prefix.
   * Prepends "cause: " or "effect: " to the text before delegating.
   */
  async embed(text: string): Promise<Float32Array> {
    const prefixedText = `${this.side}: ${text}`;
    return this.baseProvider.embed(prefixedText);
  }
}
