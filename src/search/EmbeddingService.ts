/**
 * Embedding Service Abstraction for ping-mem
 *
 * Provides a pluggable embedding provider interface with caching support.
 * Uses content-addressable caching via SHA-256 hashes for efficient deduplication.
 *
 * @module search/EmbeddingService
 * @version 1.0.0
 */

import OpenAI from "openai";
import { createHash } from "crypto";

// ============================================================================
// Error Classes
// ============================================================================

/**
 * Base error class for embedding service errors
 */
export class EmbeddingServiceError extends Error {
  public readonly code: string | undefined;
  public override readonly cause: Error | undefined;

  constructor(message: string, code?: string, cause?: Error) {
    super(message);
    this.name = "EmbeddingServiceError";
    this.code = code ?? undefined;
    this.cause = cause ?? undefined;
    Object.setPrototypeOf(this, EmbeddingServiceError.prototype);
  }
}

/**
 * Error thrown when embedding generation fails
 */
export class EmbeddingGenerationError extends EmbeddingServiceError {
  constructor(message: string, code?: string, cause?: Error) {
    super(message, code, cause);
    this.name = "EmbeddingGenerationError";
    Object.setPrototypeOf(this, EmbeddingGenerationError.prototype);
  }
}

/**
 * Error thrown when provider configuration is invalid
 */
export class EmbeddingConfigurationError extends EmbeddingServiceError {
  constructor(message: string, code?: string, cause?: Error) {
    super(message, code, cause);
    this.name = "EmbeddingConfigurationError";
    Object.setPrototypeOf(this, EmbeddingConfigurationError.prototype);
  }
}

// ============================================================================
// Provider Interface
// ============================================================================

/**
 * Interface for embedding providers
 * Allows pluggable implementations (OpenAI, local models, etc.)
 */
export interface EmbeddingProvider {
  /**
   * Generate embedding for text input
   * @param text - Text to embed
   * @returns Float32Array of embedding dimensions
   */
  embed(text: string): Promise<Float32Array>;

  /**
   * Get the dimensions of embeddings produced by this provider
   */
  readonly dimensions: number;

  /**
   * Get the provider name/identifier
   */
  readonly name: string;
}

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * Supported embedding provider types
 */
export type EmbeddingProviderType = "openai" | "custom";

/**
 * Cache configuration options
 */
export interface EmbeddingCacheConfig {
  /** Enable caching (default: true) */
  enabled?: boolean;
  /** Maximum cache entries (default: 1000) */
  maxEntries?: number;
  /** Time-to-live in milliseconds (default: 3600000 = 1 hour) */
  ttlMs?: number;
}

/**
 * Configuration for the embedding service
 */
export interface EmbeddingServiceConfig {
  /** Provider type to use */
  provider: EmbeddingProviderType;
  /** API key for the provider (required for OpenAI) */
  apiKey?: string;
  /** Model to use for embeddings */
  model?: string;
  /** Embedding dimensions (default: 768 for text-embedding-3-small) */
  dimensions?: number;
  /** Cache configuration */
  cache?: EmbeddingCacheConfig;
  /** Custom provider instance (when provider is 'custom') */
  customProvider?: EmbeddingProvider;
  /** OpenAI base URL override (for proxies/alternative endpoints) */
  baseUrl?: string;
}

/**
 * Required cache configuration with all values defined
 */
interface RequiredCacheConfig {
  enabled: boolean;
  maxEntries: number;
  ttlMs: number;
}

/**
 * Default configuration values
 */
const DEFAULT_CONFIG = {
  provider: "openai" as const,
  model: "text-embedding-3-small",
  dimensions: 768,
  cache: {
    enabled: true,
    maxEntries: 1000,
    ttlMs: 3600000, // 1 hour
  } satisfies RequiredCacheConfig,
};

// ============================================================================
// Cache Implementation
// ============================================================================

/**
 * Cache entry with TTL tracking
 */
interface CacheEntry {
  embedding: Float32Array;
  createdAt: number;
}

/**
 * Cache statistics
 */
export interface CacheStats {
  hits: number;
  misses: number;
  entries: number;
  hitRate: number;
}

/**
 * In-memory cache with TTL and LRU eviction
 */
class EmbeddingCache {
  private cache: Map<string, CacheEntry> = new Map();
  private hits = 0;
  private misses = 0;
  private readonly maxEntries: number;
  private readonly ttlMs: number;

  constructor(config: EmbeddingCacheConfig) {
    const defaultCache = DEFAULT_CONFIG.cache;
    this.maxEntries = config.maxEntries !== undefined ? config.maxEntries : defaultCache.maxEntries;
    this.ttlMs = config.ttlMs !== undefined ? config.ttlMs : defaultCache.ttlMs;
  }

  /**
   * Generate SHA-256 hash for cache key
   */
  private hashKey(text: string): string {
    return createHash("sha256").update(text).digest("hex");
  }

  /**
   * Get embedding from cache if available and not expired
   */
  get(text: string): Float32Array | null {
    const key = this.hashKey(text);
    const entry = this.cache.get(key);

    if (!entry) {
      this.misses++;
      return null;
    }

    // Check TTL
    if (Date.now() - entry.createdAt > this.ttlMs) {
      this.cache.delete(key);
      this.misses++;
      return null;
    }

    // Move to end for LRU (delete and re-add)
    this.cache.delete(key);
    this.cache.set(key, entry);

    this.hits++;
    return entry.embedding;
  }

  /**
   * Store embedding in cache
   */
  set(text: string, embedding: Float32Array): void {
    const key = this.hashKey(text);

    // Evict oldest entries if at capacity
    while (this.cache.size >= this.maxEntries) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      } else {
        break;
      }
    }

    this.cache.set(key, {
      embedding,
      createdAt: Date.now(),
    });
  }

  /**
   * Clear all cache entries
   */
  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      entries: this.cache.size,
      hitRate: total > 0 ? this.hits / total : 0,
    };
  }
}

// ============================================================================
// OpenAI Embedding Provider
// ============================================================================

/**
 * OpenAI embedding provider using text-embedding-3-small
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private readonly client: OpenAI;
  private readonly model: string;
  public readonly dimensions: number;
  public readonly name = "openai";

  constructor(apiKey: string, options?: { model?: string; dimensions?: number; baseUrl?: string }) {
    if (!apiKey) {
      throw new EmbeddingConfigurationError(
        "OpenAI API key is required",
        "MISSING_API_KEY"
      );
    }

    this.client = new OpenAI({
      apiKey,
      baseURL: options?.baseUrl,
    });
    this.model = options?.model ?? DEFAULT_CONFIG.model;
    this.dimensions = options?.dimensions ?? DEFAULT_CONFIG.dimensions;
  }

  async embed(text: string): Promise<Float32Array> {
    if (!text || text.trim().length === 0) {
      throw new EmbeddingGenerationError(
        "Cannot embed empty text",
        "EMPTY_TEXT"
      );
    }

    try {
      const response = await this.client.embeddings.create({
        model: this.model,
        input: text,
        dimensions: this.dimensions,
      });

      const embeddingData = response.data[0]?.embedding;
      if (!embeddingData) {
        throw new EmbeddingGenerationError(
          "No embedding returned from OpenAI",
          "NO_EMBEDDING"
        );
      }

      return new Float32Array(embeddingData);
    } catch (error) {
      if (error instanceof EmbeddingServiceError) {
        throw error;
      }

      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new EmbeddingGenerationError(
        `Failed to generate embedding: ${errorMessage}`,
        "GENERATION_FAILED",
        error instanceof Error ? error : undefined
      );
    }
  }
}

// ============================================================================
// Embedding Service Implementation
// ============================================================================

/**
 * Embedding service with caching and provider abstraction
 *
 * @example
 * ```typescript
 * const service = createOpenAIEmbeddingService(process.env.OPENAI_API_KEY!);
 * const embedding = await service.embed("Hello, world!");
 * console.log(`Dimensions: ${embedding.length}`);
 * console.log(`Cache stats: ${JSON.stringify(service.getCacheStats())}`);
 * ```
 */
export class EmbeddingService {
  private readonly provider: EmbeddingProvider;
  private readonly cache: EmbeddingCache | null;
  private readonly cacheEnabled: boolean;

  constructor(config: EmbeddingServiceConfig) {
    // Initialize provider
    if (config.provider === "custom") {
      if (!config.customProvider) {
        throw new EmbeddingConfigurationError(
          "Custom provider instance is required when provider type is 'custom'",
          "MISSING_CUSTOM_PROVIDER"
        );
      }
      this.provider = config.customProvider;
    } else if (config.provider === "openai") {
      if (!config.apiKey) {
        throw new EmbeddingConfigurationError(
          "API key is required for OpenAI provider",
          "MISSING_API_KEY"
        );
      }
      // Build options object, only including defined properties
      const openaiOptions: { model?: string; dimensions?: number; baseUrl?: string } = {};
      if (config.model !== undefined) openaiOptions.model = config.model;
      if (config.dimensions !== undefined) openaiOptions.dimensions = config.dimensions;
      if (config.baseUrl !== undefined) openaiOptions.baseUrl = config.baseUrl;

      this.provider = new OpenAIEmbeddingProvider(config.apiKey, openaiOptions);
    } else {
      throw new EmbeddingConfigurationError(
        `Unknown provider type: ${config.provider}`,
        "UNKNOWN_PROVIDER"
      );
    }

    // Initialize cache
    const cacheConfig = { ...DEFAULT_CONFIG.cache, ...config.cache };
    this.cacheEnabled = cacheConfig.enabled ?? true;
    this.cache = this.cacheEnabled ? new EmbeddingCache(cacheConfig) : null;
  }

  /**
   * Generate embedding for text, using cache if available
   */
  async embed(text: string): Promise<Float32Array> {
    // Check cache first
    if (this.cache) {
      const cached = this.cache.get(text);
      if (cached) {
        return cached;
      }
    }

    // Generate embedding
    const embedding = await this.provider.embed(text);

    // Store in cache
    if (this.cache) {
      this.cache.set(text, embedding);
    }

    return embedding;
  }

  /**
   * Generate embeddings for multiple texts
   */
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((text) => this.embed(text)));
  }

  /**
   * Get the dimensions of embeddings produced by this service
   */
  get dimensions(): number {
    return this.provider.dimensions;
  }

  /**
   * Get the provider name
   */
  get providerName(): string {
    return this.provider.name;
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): CacheStats | null {
    return this.cache?.getStats() ?? null;
  }

  /**
   * Clear the embedding cache
   */
  clearCache(): void {
    this.cache?.clear();
  }

  /**
   * Check if caching is enabled
   */
  isCacheEnabled(): boolean {
    return this.cacheEnabled;
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create an embedding service with the given configuration
 *
 * @param config - Service configuration
 * @returns Configured EmbeddingService instance
 */
export function createEmbeddingService(config: EmbeddingServiceConfig): EmbeddingService {
  return new EmbeddingService(config);
}

/**
 * Create an OpenAI embedding service
 *
 * @param apiKey - OpenAI API key
 * @param options - Optional configuration overrides
 * @returns Configured EmbeddingService instance
 *
 * @example
 * ```typescript
 * const service = createOpenAIEmbeddingService(process.env.OPENAI_API_KEY!, {
 *   dimensions: 768,
 *   cache: { maxEntries: 500 }
 * });
 * ```
 */
export function createOpenAIEmbeddingService(
  apiKey: string,
  options?: {
    model?: string;
    dimensions?: number;
    baseUrl?: string;
    cache?: EmbeddingCacheConfig;
  }
): EmbeddingService {
  // Build config object, only including defined properties
  const config: EmbeddingServiceConfig = {
    provider: "openai",
    apiKey,
  };
  if (options?.model !== undefined) config.model = options.model;
  if (options?.dimensions !== undefined) config.dimensions = options.dimensions;
  if (options?.baseUrl !== undefined) config.baseUrl = options.baseUrl;
  if (options?.cache !== undefined) config.cache = options.cache;

  return new EmbeddingService(config);
}

/**
 * Create an embedding service from environment variables
 *
 * Environment variables:
 * - OPENAI_API_KEY: OpenAI API key (required)
 * - OPENAI_BASE_URL: Optional base URL override
 * - EMBEDDING_MODEL: Model to use (default: text-embedding-3-small)
 * - EMBEDDING_DIMENSIONS: Embedding dimensions (default: 768)
 *
 * @returns Configured EmbeddingService instance
 * @throws {EmbeddingConfigurationError} If required environment variables are missing
 */
export function createEmbeddingServiceFromEnv(): EmbeddingService {
  const apiKey = process.env["OPENAI_API_KEY"];

  if (!apiKey) {
    throw new EmbeddingConfigurationError(
      "Missing required environment variable: OPENAI_API_KEY",
      "MISSING_ENV_VAR"
    );
  }

  const baseUrl = process.env["OPENAI_BASE_URL"];
  const model = process.env["EMBEDDING_MODEL"];
  const dimensionsStr = process.env["EMBEDDING_DIMENSIONS"];
  const dimensions = dimensionsStr ? parseInt(dimensionsStr, 10) : undefined;

  // Build options object, only including defined properties
  const options: {
    model?: string;
    dimensions?: number;
    baseUrl?: string;
  } = {};
  if (baseUrl !== undefined) options.baseUrl = baseUrl;
  if (model !== undefined) options.model = model;
  if (dimensions !== undefined) options.dimensions = dimensions;

  return createOpenAIEmbeddingService(apiKey, options);
}
